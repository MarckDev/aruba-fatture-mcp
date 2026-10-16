import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ArubaPanelClient,
  PanelError,
  classificaRispostaLogin,
  verificaLoginPannello,
} from "../../dist/panel-client.js";

const fixture = (nome) => readFileSync(new URL(`./fixtures/${nome}`, import.meta.url), "utf8");
const cred = { username: "mario.rossi", password: "pà$$-segreta" };
const CODE_URL = "https://fatturazioneelettronica.aruba.it/api/login/oauth2/code/gateway?state=s&code=abc";

const fetchOriginale = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginale;
});

/**
 * Simula il flusso OpenID Connect del pannello: gateway → Keycloak → POST
 * credenziali (risposta scelta dal test) → ritorno al gateway → servizi.
 */
function simulaPannello(rispostaPost) {
  const chiamate = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    chiamate.push({ url: u, method: init.method ?? "GET", body: init.body });
    if (u.endsWith("/api/oauth2/authorization/gateway")) {
      return new Response(null, { status: 302, headers: { location: "https://auth.example.test/realms/aruba/auth?client_id=gateway" } });
    }
    if (u.startsWith("https://auth.example.test/realms/aruba/auth")) {
      return new Response(fixture("login-pagina.html"), { status: 200 });
    }
    if (u.includes("login-actions/authenticate")) return rispostaPost();
    if (u === CODE_URL) return new Response(null, { status: 302, headers: { location: "/" } });
    if (u === "https://fatturazioneelettronica.aruba.it/") return new Response("<html>pannello</html>", { status: 200 });
    if (u.includes("/services/")) return new Response("{}", { status: 200 });
    throw new Error(`URL inattesa nel test: ${u}`);
  };
  return chiamate;
}

const ok = () => new Response(null, { status: 302, headers: { location: CODE_URL } });
const rifiutata = () => new Response(fixture("login-errore.html"), { status: 200 });
const otp = () => new Response(fixture("login-otp.html"), { status: 200 });
const troppi = () => new Response("Too Many Requests", { status: 429 });

function fonteFinta(suggerimento = " Alla prossima richiesta potrai reinserirla.") {
  return {
    rifiuti: [],
    suggerimentoRifiuto: suggerimento,
    async ottieni() {
      return cred;
    },
    segnalaRifiuto(c) {
      this.rifiuti.push(c);
    },
  };
}

test("classifica il 302 con code come accesso riuscito", () => {
  assert.equal(classificaRispostaLogin(302, CODE_URL, ""), "ok");
});

test("classifica la pagina del codice monouso come otp", () => {
  assert.equal(classificaRispostaLogin(200, null, fixture("login-otp.html")), "otp");
});

test("classifica il form di login riproposto come password rifiutata", () => {
  assert.equal(classificaRispostaLogin(200, null, fixture("login-errore.html")), "rifiutata");
  assert.equal(classificaRispostaLogin(401, null, fixture("login-errore.html")), "rifiutata");
});

test("non riconosce pagine diverse né errori del server", () => {
  assert.equal(classificaRispostaLogin(200, null, fixture("pagina-strana.html")), "sconosciuto");
  assert.equal(classificaRispostaLogin(302, "https://altrove.example.test/", ""), "sconosciuto");
  assert.equal(classificaRispostaLogin(429, null, fixture("login-errore.html")), "sconosciuto");
  assert.equal(classificaRispostaLogin(503, null, fixture("login-errore.html")), "sconosciuto");
});

test("il client invia le credenziali della fonte e usa la sessione", async () => {
  const chiamate = simulaPannello(ok);
  const client = new ArubaPanelClient(fonteFinta());
  assert.deepEqual(await client.service("FatturaFrontEnd/advancedSearch"), {});
  const post = chiamate.find((c) => c.method === "POST" && c.url.includes("login-actions"));
  assert.match(post.body, /username=mario.rossi/);
});

test("password rifiutata: segnala il rifiuto e aggiunge il suggerimento", async () => {
  simulaPannello(rifiutata);
  const fonte = fonteFinta();
  const client = new ArubaPanelClient(fonte);
  await assert.rejects(client.service("x"), (e) => {
    assert.ok(e instanceof PanelError);
    assert.match(e.message, /Credenziali rifiutate/);
    assert.match(e.message, /Alla prossima richiesta potrai reinserirla\./);
    assert.equal(e.message.includes(cred.password), false);
    assert.equal(e.body.includes(cred.password), false);
    return true;
  });
  assert.deepEqual(fonte.rifiuti, [cred]);
});

test("pagina otp: errore sulla verifica in due passaggi, nessun rifiuto segnalato", async () => {
  simulaPannello(otp);
  const fonte = fonteFinta();
  await assert.rejects(new ArubaPanelClient(fonte).service("x"), (e) => {
    assert.ok(e instanceof PanelError);
    assert.match(e.message, /verifica in due passaggi/);
    return true;
  });
  assert.deepEqual(fonte.rifiuti, []);
});

test("429 al login: errore senza segnalare rifiuti", async () => {
  simulaPannello(troppi);
  const fonte = fonteFinta();
  await assert.rejects(new ArubaPanelClient(fonte).service("x"), PanelError);
  assert.deepEqual(fonte.rifiuti, []);
});

test("verificaLoginPannello riconosce accesso, otp e password rifiutata", async () => {
  simulaPannello(ok);
  assert.equal(await verificaLoginPannello(cred), "ok");
  simulaPannello(otp);
  assert.equal(await verificaLoginPannello(cred), "otp");
  simulaPannello(rifiutata);
  assert.equal(await verificaLoginPannello(cred), "rifiutata");
});

test("verificaLoginPannello lancia PanelError su 429 e pagine sconosciute", async () => {
  simulaPannello(troppi);
  await assert.rejects(verificaLoginPannello(cred), PanelError);
  simulaPannello(() => new Response(fixture("pagina-strana.html"), { status: 200 }));
  await assert.rejects(verificaLoginPannello(cred), PanelError);
});
