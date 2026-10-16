import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  cancellaVault,
  leggiCredenziali,
  percorsoVault,
  salvaCredenziali,
} from "../../dist/credenziali/vault.js";
import {
  FirmaNonValidaError,
  SbloccoAnnullatoError,
  VaultIllegibileError,
} from "../../dist/credenziali/tipi.js";

/**
 * Chiave Hello finta: "cifra" con uno XOR e "firma" con un hash che include un
 * segreto, così un file scritto da altri non ha una firma valida.
 */
function chiaveFinta() {
  const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
  const firma = (dati) => createHash("sha256").update("segreto-hello").update(dati).digest();
  return {
    decifrature: 0,
    firme: 0,
    annullaFirma: false,
    eliminata: false,
    async firma(dati) {
      if (this.annullaFirma) throw new SbloccoAnnullatoError();
      this.firme++;
      return firma(dati);
    },
    async verificaFirma(dati, f) {
      return firma(dati).equals(f);
    },
    async esiste() {
      return !this.eliminata;
    },
    async crea() {},
    async cifra(dati) {
      return xor(dati);
    },
    async decifra(dati) {
      this.decifrature++;
      return xor(dati);
    },
    async elimina() {
      const esisteva = !this.eliminata;
      this.eliminata = true;
      return esisteva;
    },
  };
}

const cred = { username: "mario.rossi", password: "pà$$ wörd €\"' " };

async function cartella() {
  return mkdtemp(join(tmpdir(), "vault-test-"));
}

test("andata e ritorno conserva esattamente username e password", async () => {
  const percorso = join(await cartella(), "credenziali.json");
  const chiave = chiaveFinta();
  await salvaCredenziali(percorso, cred, chiave);
  assert.deepEqual(await leggiCredenziali(percorso, chiave), cred);
  assert.equal(chiave.decifrature, 1);
});

test("il file non contiene username né password in chiaro", async () => {
  const percorso = join(await cartella(), "credenziali.json");
  await salvaCredenziali(percorso, cred, chiaveFinta());
  const testo = await readFile(percorso, "utf8");
  assert.equal(testo.includes(cred.username), false);
  assert.equal(testo.includes("pà$$"), false);
  assert.equal(JSON.parse(testo).versione, 2);
});

test("senza file restituisce null senza chiedere Windows Hello", async () => {
  const chiave = chiaveFinta();
  assert.equal(await leggiCredenziali(join(await cartella(), "credenziali.json"), chiave), null);
  assert.equal(chiave.decifrature, 0);
});

test("JSON non valido o versione sconosciuta danno VaultIllegibileError", async () => {
  const dir = await cartella();
  const chiave = chiaveFinta();
  const percorso = join(dir, "credenziali.json");

  await writeFile(percorso, "{ non è json");
  await assert.rejects(leggiCredenziali(percorso, chiave), VaultIllegibileError);

  await salvaCredenziali(percorso, cred, chiave);
  const buono = JSON.parse(await readFile(percorso, "utf8"));
  await writeFile(percorso, JSON.stringify({ ...buono, versione: 3 }));
  await assert.rejects(leggiCredenziali(percorso, chiave), VaultIllegibileError);
});

test("il salvataggio firma il file con la chiave Hello", async () => {
  const percorso = join(await cartella(), "credenziali.json");
  const chiave = chiaveFinta();
  await salvaCredenziali(percorso, cred, chiave);
  assert.equal(chiave.firme, 1);
  assert.equal(typeof JSON.parse(await readFile(percorso, "utf8")).firma, "string");
});

test("un campo alterato invalida la firma e non chiede Windows Hello", async () => {
  const percorso = join(await cartella(), "credenziali.json");
  const chiave = chiaveFinta();
  await salvaCredenziali(percorso, cred, chiave);
  const buono = JSON.parse(await readFile(percorso, "utf8"));
  for (const campo of ["chiaveCifrata", "iv", "tag", "dati"]) {
    const b = Buffer.from(buono[campo], "base64");
    b[0] ^= 1;
    await writeFile(percorso, JSON.stringify({ ...buono, [campo]: b.toString("base64") }));
    await assert.rejects(leggiCredenziali(percorso, chiave), FirmaNonValidaError, campo);
  }
  assert.equal(chiave.decifrature, 0);
});

test("un file senza firma (formato 1) viene rifiutato senza chiedere Windows Hello", async () => {
  const percorso = join(await cartella(), "credenziali.json");
  const chiave = chiaveFinta();
  await salvaCredenziali(percorso, cred, chiave);
  const { firma, ...senzaFirma } = JSON.parse(await readFile(percorso, "utf8"));
  await writeFile(percorso, JSON.stringify({ ...senzaFirma, versione: 1 }));
  await assert.rejects(leggiCredenziali(percorso, chiave), FirmaNonValidaError);
  assert.equal(chiave.decifrature, 0);
});

test("un file cifrato da altri con la chiave pubblica viene rifiutato", async () => {
  // Chi può scrivere il file può cifrare con la chiave pubblica, ma non firmare.
  const percorso = join(await cartella(), "credenziali.json");
  const chiave = chiaveFinta();
  const intruso = { ...chiaveFinta(), firma: async () => Buffer.alloc(32, 7) };
  intruso.cifra = chiave.cifra;
  await salvaCredenziali(percorso, { username: "intruso", password: "x" }, intruso);
  await assert.rejects(leggiCredenziali(percorso, chiave), FirmaNonValidaError);
  assert.equal(chiave.decifrature, 0);
});

test("se la firma viene annullata non si scrive nulla", async () => {
  const dir = await cartella();
  const chiave = chiaveFinta();
  chiave.annullaFirma = true;
  await assert.rejects(salvaCredenziali(join(dir, "credenziali.json"), cred, chiave), SbloccoAnnullatoError);
  assert.deepEqual(await readdir(dir), []);
});

test("la scrittura non lascia file temporanei", async () => {
  const dir = await cartella();
  await salvaCredenziali(join(dir, "credenziali.json"), cred, chiaveFinta());
  assert.deepEqual(await readdir(dir), ["credenziali.json"]);
});

test("due salvataggi concorrenti lasciano un file valido", async () => {
  const dir = await cartella();
  const percorso = join(dir, "credenziali.json");
  const chiave = chiaveFinta();
  const altre = { username: "luigi", password: "altra" };
  await Promise.all([salvaCredenziali(percorso, cred, chiave), salvaCredenziali(percorso, altre, chiave)]);
  const letto = await leggiCredenziali(percorso, chiave);
  assert.ok([cred.username, altre.username].includes(letto.username));
  assert.deepEqual(await readdir(dir), ["credenziali.json"]);
});

test("crea la cartella del vault se manca", async () => {
  const percorso = join(await cartella(), "nuova", "sotto", "credenziali.json");
  await salvaCredenziali(percorso, cred, chiaveFinta());
  assert.deepEqual(await leggiCredenziali(percorso, chiaveFinta()), cred);
});

test("cancellaVault rimuove file e chiave", async () => {
  const percorso = join(await cartella(), "credenziali.json");
  const chiave = chiaveFinta();
  await salvaCredenziali(percorso, cred, chiave);
  assert.deepEqual(await cancellaVault(percorso, chiave), { fileRimosso: true, chiaveRimossa: true });
  assert.equal(await leggiCredenziali(percorso, chiave), null);
});

test("cancellaVault su vault inesistente non dà errore", async () => {
  const chiave = chiaveFinta();
  chiave.eliminata = true;
  assert.deepEqual(await cancellaVault(join(await cartella(), "credenziali.json"), chiave), {
    fileRimosso: false,
    chiaveRimossa: false,
  });
});

test("il vault sta in .aruba-fatture-mcp dentro la home", () => {
  assert.ok(percorsoVault("C:\\Users\\X").endsWith(`.aruba-fatture-mcp${sep}credenziali.json`));
});
