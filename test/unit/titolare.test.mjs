import { test } from "node:test";
import assert from "node:assert/strict";
import { creaTitolare } from "../../dist/titolare.js";
import { SbloccoAnnullatoError, SbloccoInCorsoError } from "../../dist/credenziali/tipi.js";

const nessuno = { partitaIva: null, codiceFiscale: null };
const daEnv = { partitaIva: "01234567890", codiceFiscale: null };

/** userInfo finto: esegue in ordine le risposte in coda (valore o errore). */
function userInfoFinto(...risposte) {
  const f = async () => {
    f.chiamate++;
    const r = risposte.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  f.chiamate = 0;
  return f;
}

test("Hello con partita IVA nell'ambiente: non chiede lo sblocco", async () => {
  const userInfo = userInfoFinto();
  const titolare = creaTitolare({ daEnv, modalitaHello: true, userInfo });
  assert.deepEqual(await titolare(), daEnv);
  assert.equal(userInfo.chiamate, 0);
});

for (const Errore of [SbloccoAnnullatoError, SbloccoInCorsoError]) {
  test(`Hello senza variabili: ${Errore.name} si propaga e non resta in memoria`, async () => {
    const userInfo = userInfoFinto(new Errore(), { vatCode: "09876543210", fiscalCode: "RSSMRA80A01H501U" });
    const titolare = creaTitolare({ daEnv: nessuno, modalitaHello: true, userInfo });
    await assert.rejects(titolare(), Errore);
    assert.deepEqual(await titolare(), { partitaIva: "09876543210", codiceFiscale: "RSSMRA80A01H501U" });
    assert.equal(userInfo.chiamate, 2);
  });
}

test("Hello senza variabili: un errore di rete ripiega sull'ambiente", async () => {
  const userInfo = userInfoFinto(new Error("fetch failed"));
  const titolare = creaTitolare({ daEnv: nessuno, modalitaHello: true, userInfo });
  assert.deepEqual(await titolare(), nessuno);
});

test("modalità env: userInfo prima, ripiego in caso di errore, risultato memorizzato", async () => {
  const userInfo = userInfoFinto({ vatCode: "09876543210" });
  const titolare = creaTitolare({ daEnv, modalitaHello: false, userInfo });
  assert.deepEqual(await titolare(), { partitaIva: "09876543210", codiceFiscale: null });
  assert.deepEqual(await titolare(), { partitaIva: "09876543210", codiceFiscale: null });
  assert.equal(userInfo.chiamate, 1);

  const inErrore = userInfoFinto(new Error("fetch failed"), { vatCode: "x" });
  const titolare2 = creaTitolare({ daEnv, modalitaHello: false, userInfo: inErrore });
  assert.deepEqual(await titolare2(), daEnv);
  assert.deepEqual(await titolare2(), daEnv);
  assert.equal(inErrore.chiamate, 1);
});
