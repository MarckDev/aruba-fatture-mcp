import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArubaApiError, ArubaClient } from "../../dist/aruba-client.js";

const cred = { username: "mario.rossi", password: "pà$$-segreta" };
const fetchOriginale = globalThis.fetch;
const tmpOriginale = process.env.TMPDIR;
const tmpBase = tmpdir();

afterEach(() => {
  globalThis.fetch = fetchOriginale;
  // Assegnare undefined a process.env lo trasformerebbe nella stringa "undefined".
  if (tmpOriginale === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tmpOriginale;
});

async function tmpIsolata() {
  const dir = await mkdtemp(join(tmpBase, "aruba-client-test-"));
  process.env.TMPDIR = dir;
  return dir;
}

function fonteFinta() {
  return {
    rifiuti: [],
    suggerimentoRifiuto: " Alla prossima richiesta potrai reinserirla.",
    async ottieni() {
      return cred;
    },
    segnalaRifiuto(c) {
      this.rifiuti.push(c);
    },
  };
}

/** `signin` decide la risposta di /auth/signin in base al grant_type. */
function simulaAruba(signin) {
  const grants = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/auth/signin") {
      const grant = new URLSearchParams(init.body).get("grant_type");
      grants.push(grant);
      return signin(grant, grants.length);
    }
    if (u.pathname === "/auth/userInfo") return Response.json({ vatCode: "01234567890" });
    throw new Error(`URL inattesa nel test: ${u}`);
  };
  return grants;
}

const tokenOk = (expires_in = 1800) =>
  Response.json({ access_token: "acc", token_type: "bearer", expires_in, refresh_token: "ref", userName: cred.username });

test("con persistiToken false nessun token finisce nella cartella temporanea", async () => {
  const dir = await tmpIsolata();
  simulaAruba(() => tokenOk());
  const client = new ArubaClient(fonteFinta(), "production", { persistiToken: false });
  await client.userInfo();
  assert.deepEqual(await readdir(dir), []);
});

test("con persistiToken true il token si salva con il nome di oggi", async () => {
  const dir = await tmpIsolata();
  simulaAruba(() => tokenOk());
  const client = new ArubaClient(fonteFinta(), "production", { persistiToken: true });
  await client.userInfo();
  const hash = createHash("sha256").update(cred.username).digest("hex").slice(0, 12);
  assert.deepEqual(await readdir(dir), [`aruba-fatture-mcp-token-production-${hash}.json`]);
});

for (const status of [400, 401]) {
  test(`password rifiutata (HTTP ${status}) segnala il rifiuto e aggiunge il suggerimento`, async () => {
    await tmpIsolata();
    simulaAruba(() => new Response('{"error":"invalid_grant"}', { status }));
    const fonte = fonteFinta();
    const client = new ArubaClient(fonte, "production", { persistiToken: false });
    await assert.rejects(client.userInfo(), (e) => {
      assert.ok(e instanceof ArubaApiError);
      assert.match(e.message, /Autenticazione Aruba fallita/);
      assert.match(e.message, /Alla prossima richiesta potrai reinserirla\./);
      assert.equal(e.message.includes(cred.password), false);
      return true;
    });
    assert.deepEqual(fonte.rifiuti, [cred]);
  });
}

for (const status of [429, 500]) {
  test(`HTTP ${status} al login non segnala rifiuti`, async () => {
    await tmpIsolata();
    simulaAruba(() => new Response("errore", { status }));
    const fonte = fonteFinta();
    await assert.rejects(new ArubaClient(fonte, "production", { persistiToken: false }).userInfo(), ArubaApiError);
    assert.deepEqual(fonte.rifiuti, []);
  });
}

test("un refresh fallito non è un rifiuto della password", async () => {
  await tmpIsolata();
  // Primo login con token già scaduto: la chiamata successiva usa il refresh,
  // che fallisce, e ripiega sul login con password.
  const grants = simulaAruba((grant, n) => {
    if (grant === "refresh_token") return new Response('{"error":"invalid_grant"}', { status: 400 });
    return tokenOk(n === 1 ? 0 : 1800);
  });
  const fonte = fonteFinta();
  const client = new ArubaClient(fonte, "production", { persistiToken: false });
  await client.userInfo();
  await client.userInfo();
  assert.deepEqual(grants, ["password", "refresh_token", "password"]);
  assert.deepEqual(fonte.rifiuti, []);
});

test("in ambiente demo un rifiuto non viene segnalato: le credenziali del pannello sono di produzione", async () => {
  await tmpIsolata();
  simulaAruba(() => new Response('{"error":"invalid_grant"}', { status: 401 }));
  const fonte = fonteFinta();
  await assert.rejects(new ArubaClient(fonte, "demo", { persistiToken: false }).userInfo(), (e) => {
    assert.ok(e instanceof ArubaApiError);
    assert.equal(e.message.includes("Alla prossima richiesta"), false);
    return true;
  });
  assert.deepEqual(fonte.rifiuti, []);
});
