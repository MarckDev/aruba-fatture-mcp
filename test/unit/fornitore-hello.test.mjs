import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as attendi } from "node:timers/promises";
import { FornitoreHello } from "../../dist/credenziali/fornitore-hello.js";
import { leggiCredenziali, salvaCredenziali } from "../../dist/credenziali/vault.js";
import {
  ChiaveHelloMancanteError,
  SbloccoAnnullatoError,
  SbloccoInCorsoError,
  TroppiTentativiError,
} from "../../dist/credenziali/tipi.js";

const salvate = { username: "mario.rossi", password: "vecchia-pà$$" };
const nuove = { username: "mario.rossi", password: "nuova-pà$$" };

/**
 * Chiave Hello finta: XOR per cifrare; `decifra` esegue, in ordine, i
 * comportamenti in coda (ritardo e/o errore) e conta le chiamate.
 */
function chiaveFinta({ esiste = true } = {}) {
  const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
  return {
    esisteChiave: esiste,
    decifrature: 0,
    creazioni: 0,
    cifrature: 0,
    coda: [],
    async esiste() {
      return this.esisteChiave;
    },
    async crea() {
      this.creazioni++;
      this.esisteChiave = true;
    },
    async cifra(dati) {
      this.cifrature++;
      return xor(dati);
    },
    async decifra(dati) {
      this.decifrature++;
      const passo = this.coda.shift() ?? {};
      if (passo.ritardo) await attendi(passo.ritardo);
      if (passo.errore) throw passo.errore;
      return xor(dati);
    },
    firme: 0,
    async firma(dati) {
      this.firme++;
      return createHash("sha256").update("segreto").update(dati).digest();
    },
    async verificaFirma(dati, firma) {
      return createHash("sha256").update("segreto").update(dati).digest().equals(firma);
    },
    async elimina() {
      return true;
    },
  };
}

/** Finestra credenziali finta: restituisce le risposte in coda e registra le richieste. */
function finestraFinta(risposte) {
  const richieste = [];
  const chiedi = async (opz) => {
    richieste.push(opz);
    return risposte.length ? risposte.shift() : null;
  };
  return { chiedi, richieste };
}

async function prepara({ conVault = true, esiti = [], risposte = [], chiave = chiaveFinta(), ...altro } = {}) {
  const percorso = join(await mkdtemp(join(tmpdir(), "fornitore-test-")), "credenziali.json");
  if (conVault) {
    await salvaCredenziali(percorso, salvate, chiave);
    chiave.cifrature = 0;
    chiave.firme = 0;
  }
  const finestra = finestraFinta(risposte);
  const verifiche = [];
  const fornitore = new FornitoreHello({
    chiave,
    percorso,
    chiediCredenziali: finestra.chiedi,
    async verifica(cred) {
      verifiche.push(cred);
      const esito = esiti.shift() ?? "ok";
      if (esito instanceof Error) throw esito;
      return esito;
    },
    ...altro,
  });
  return { fornitore, chiave, finestra, verifiche, percorso };
}

const esiste = async (p) => stat(p).then(() => true, () => false);

test("vault presente: restituisce le credenziali e decifra una volta sola", async () => {
  const { fornitore, chiave, finestra } = await prepara();
  assert.deepEqual(await fornitore.ottieni(), salvate);
  assert.deepEqual(await fornitore.ottieni(), salvate);
  assert.equal(chiave.decifrature, 1);
  assert.equal(finestra.richieste.length, 0);
});

test("chiamate concorrenti condividono un solo sblocco", async () => {
  const { fornitore, chiave } = await prepara();
  chiave.coda.push({ ritardo: 20 });
  const [a, b] = await Promise.all([fornitore.ottieni(), fornitore.ottieni()]);
  assert.deepEqual(a, salvate);
  assert.deepEqual(b, salvate);
  assert.equal(chiave.decifrature, 1);
});

test("sblocco lento: risponde 'in corso' senza aprire una seconda finestra", async () => {
  const { fornitore, chiave } = await prepara({ attesaMassimaMs: 50 });
  chiave.coda.push({ ritardo: 200 });
  await assert.rejects(fornitore.ottieni(), SbloccoInCorsoError);
  await assert.rejects(fornitore.ottieni(), SbloccoInCorsoError);
  assert.equal(chiave.decifrature, 1);
  await attendi(250);
  assert.deepEqual(await fornitore.ottieni(), salvate);
  assert.equal(chiave.decifrature, 1);
});

test("annullamento mentre si aspetta: errore di annullamento", async () => {
  const { fornitore, chiave } = await prepara();
  chiave.coda.push({ errore: new SbloccoAnnullatoError() });
  await assert.rejects(fornitore.ottieni(), SbloccoAnnullatoError);
  assert.deepEqual(await fornitore.ottieni(), salvate);
  assert.equal(chiave.decifrature, 2);
});

test("annullamento dopo il timeout: consegnato una volta alla chiamata successiva", async () => {
  const { fornitore, chiave } = await prepara({ attesaMassimaMs: 50 });
  chiave.coda.push({ ritardo: 100, errore: new SbloccoAnnullatoError() });
  await assert.rejects(fornitore.ottieni(), SbloccoInCorsoError);
  await attendi(150);
  await assert.rejects(fornitore.ottieni(), SbloccoAnnullatoError);
  assert.equal(chiave.decifrature, 1);
  assert.deepEqual(await fornitore.ottieni(), salvate);
  assert.equal(chiave.decifrature, 2);
});

for (const esito of ["ok", "otp"]) {
  test(`primo inserimento con verifica '${esito}': crea la chiave e salva`, async () => {
    const chiave = chiaveFinta({ esiste: false });
    const { fornitore, percorso, verifiche } = await prepara({ conVault: false, chiave, risposte: [nuove], esiti: [esito] });
    assert.deepEqual(await fornitore.ottieni(), nuove);
    assert.deepEqual(verifiche, [nuove]);
    assert.equal(chiave.creazioni, 1);
    assert.deepEqual(await leggiCredenziali(percorso, chiave), nuove);
  });
}

test("password rifiutata al primo inserimento: richiede di nuovo con username precompilato", async () => {
  const sbagliate = { username: "mario.rossi", password: "sbagliata" };
  const { fornitore, finestra } = await prepara({
    conVault: false,
    risposte: [sbagliate, nuove],
    esiti: ["rifiutata", "ok"],
  });
  assert.deepEqual(await fornitore.ottieni(), nuove);
  assert.equal(finestra.richieste.length, 2);
  assert.ok(finestra.richieste[1].messaggioErrore);
  assert.equal(finestra.richieste[1].usernameSuggerito, "mario.rossi");
});

test("alla terza password rifiutata si ferma e non riapre più la finestra", async () => {
  const sbagliate = { username: "mario.rossi", password: "sbagliata" };
  const { fornitore, finestra, percorso } = await prepara({
    conVault: false,
    risposte: [sbagliate, sbagliate, sbagliate, nuove],
    esiti: ["rifiutata", "rifiutata", "rifiutata"],
  });
  await assert.rejects(fornitore.ottieni(), TroppiTentativiError);
  await assert.rejects(fornitore.ottieni(), TroppiTentativiError);
  assert.equal(finestra.richieste.length, 3);
  assert.equal(await esiste(percorso), false);
});

test("finestra annullata al primo inserimento: errore di annullamento, nulla salvato", async () => {
  const { fornitore, percorso } = await prepara({ conVault: false, risposte: [] });
  await assert.rejects(fornitore.ottieni(), SbloccoAnnullatoError);
  assert.equal(await esiste(percorso), false);
});

test("verifica in errore: si propaga, nessun tentativo contato, la finestra si riapre", async () => {
  const limite = new Error("HTTP 429");
  const { fornitore, finestra, percorso } = await prepara({
    conVault: false,
    risposte: [nuove, nuove],
    esiti: [limite, "ok"],
    tentativiMassimi: 1,
  });
  await assert.rejects(fornitore.ottieni(), (e) => e === limite);
  assert.equal(await esiste(percorso), false);
  assert.deepEqual(await fornitore.ottieni(), nuove);
  assert.equal(finestra.richieste.length, 2);
});

test("chiave Hello mancante: riparte dal primo inserimento spiegando il motivo", async () => {
  const chiave = chiaveFinta();
  const { fornitore, finestra, percorso } = await prepara({ chiave, risposte: [nuove] });
  chiave.coda.push({ errore: new ChiaveHelloMancanteError() });
  chiave.esisteChiave = false;
  assert.deepEqual(await fornitore.ottieni(), nuove);
  assert.match(finestra.richieste[0].messaggioErrore, /Windows Hello/);
  assert.equal(chiave.creazioni, 1);
  assert.deepEqual(await leggiCredenziali(percorso, chiave), nuove);
});

test("rifiuto segnalato da un client: chiede la nuova password e la salva senza Hello", async () => {
  const { fornitore, chiave, finestra, percorso } = await prepara({ risposte: [nuove] });
  const usate = await fornitore.ottieni();
  fornitore.segnalaRifiuto(usate);
  assert.deepEqual(await fornitore.ottieni(), nuove);
  assert.ok(finestra.richieste[0].messaggioErrore);
  assert.equal(finestra.richieste[0].usernameSuggerito, "mario.rossi");
  assert.equal(chiave.decifrature, 1);
  assert.equal(chiave.creazioni, 0);
  assert.equal(chiave.cifrature, 1);
  assert.deepEqual(await leggiCredenziali(percorso, chiave), nuove);
});

test("i rifiuti segnalati dai client contano come tentativi", async () => {
  const { fornitore, finestra } = await prepara({ tentativiMassimi: 2, risposte: [nuove], esiti: ["rifiutata"] });
  fornitore.segnalaRifiuto(await fornitore.ottieni());
  await assert.rejects(fornitore.ottieni(), TroppiTentativiError);
  assert.equal(finestra.richieste.length, 1);
});

test("un rifiuto di credenziali vecchie non tocca quelle correnti", async () => {
  const { fornitore, finestra } = await prepara();
  await fornitore.ottieni();
  fornitore.segnalaRifiuto({ username: "mario.rossi", password: "ancora-più-vecchia" });
  assert.deepEqual(await fornitore.ottieni(), salvate);
  assert.equal(finestra.richieste.length, 0);
});

test("il suggerimento per i rifiuti non è vuoto e non contiene la password", async () => {
  const { fornitore } = await prepara();
  await fornitore.ottieni();
  assert.ok(fornitore.suggerimentoRifiuto.trim().length > 0);
  assert.equal(fornitore.suggerimentoRifiuto.includes(salvate.password), false);
});

test("file non firmato o modificato: non chiede Hello per decifrare, richiede le credenziali e risalva firmando", async () => {
  const { fornitore, chiave, finestra, percorso } = await prepara({ risposte: [nuove] });
  const contenuto = JSON.parse(await readFile(percorso, "utf8"));
  const dati = Buffer.from(contenuto.dati, "base64");
  dati[0] ^= 1;
  await writeFile(percorso, JSON.stringify({ ...contenuto, dati: dati.toString("base64") }));

  assert.deepEqual(await fornitore.ottieni(), nuove);
  assert.equal(chiave.decifrature, 0);
  assert.match(finestra.richieste[0].messaggioErrore, /firmato o è stato modificato/);
  assert.equal(chiave.firme, 1);
  assert.deepEqual(await leggiCredenziali(percorso, chiave), nuove);
});
