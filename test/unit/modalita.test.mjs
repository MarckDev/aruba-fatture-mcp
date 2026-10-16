import { test } from "node:test";
import assert from "node:assert/strict";
import { scegliModalita } from "../../dist/credenziali/modalita.js";
import {
  FonteStatica,
  HelloNonDisponibileError,
  SbloccoAnnullatoError,
  SbloccoInCorsoError,
  TroppiTentativiError,
  VaultIllegibileError,
} from "../../dist/credenziali/tipi.js";

const credenziali = { ARUBA_USERNAME: "mario", ARUBA_PASSWORD: "segreta" };

test("--reset-windows-hello sceglie il reset su Windows", () => {
  assert.deepEqual(scegliModalita(["--reset-windows-hello"], {}, "win32"), { tipo: "reset" });
});

test("--reset-windows-hello vince anche con le variabili presenti e su altri sistemi", () => {
  assert.deepEqual(scegliModalita(["--reset-windows-hello"], credenziali, "win32"), { tipo: "reset" });
  assert.deepEqual(scegliModalita(["--reset-windows-hello"], {}, "linux"), { tipo: "reset" });
});

test("entrambe le variabili scelgono la modalità env su qualunque sistema", () => {
  for (const piattaforma of ["linux", "win32"]) {
    assert.deepEqual(scegliModalita([], credenziali, piattaforma), {
      tipo: "env",
      credenziali: { username: "mario", password: "segreta" },
    });
  }
});

test("nessuna variabile su Windows sceglie Windows Hello", () => {
  assert.deepEqual(scegliModalita([], {}, "win32"), { tipo: "hello" });
});

test("nessuna variabile su altri sistemi dà l'errore di oggi", () => {
  const m = scegliModalita([], {}, "linux");
  assert.equal(m.tipo, "errore");
  assert.match(m.messaggio, /ARUBA_USERNAME e ARUBA_PASSWORD/);
});

test("una sola variabile è un errore di configurazione che nomina quella mancante", () => {
  const soloUser = scegliModalita([], { ARUBA_USERNAME: "mario" }, "win32");
  assert.equal(soloUser.tipo, "errore");
  assert.match(soloUser.messaggio, /manca ARUBA_PASSWORD/);
  const soloPassword = scegliModalita([], { ARUBA_PASSWORD: "segreta" }, "win32");
  assert.equal(soloPassword.tipo, "errore");
  assert.match(soloPassword.messaggio, /manca ARUBA_USERNAME/);
});

test("una variabile vuota conta come assente", () => {
  assert.deepEqual(scegliModalita([], { ARUBA_USERNAME: "", ARUBA_PASSWORD: "" }, "win32"), { tipo: "hello" });
  assert.equal(scegliModalita([], { ARUBA_USERNAME: "mario", ARUBA_PASSWORD: "" }, "win32").tipo, "errore");
});

test("FonteStatica restituisce le credenziali date e non ha suggerimenti", async () => {
  const c = { username: "mario", password: "segreta" };
  const fonte = new FonteStatica(c);
  assert.deepEqual(await fonte.ottieni(), c);
  assert.equal(fonte.suggerimentoRifiuto, "");
  fonte.segnalaRifiuto(c);
  assert.deepEqual(await fonte.ottieni(), c);
});

test("i messaggi degli errori di sblocco citano il comando di reset", () => {
  for (const Errore of [
    SbloccoInCorsoError,
    SbloccoAnnullatoError,
    TroppiTentativiError,
    VaultIllegibileError,
    HelloNonDisponibileError,
  ]) {
    assert.match(new Errore().message, /--reset-windows-hello/, Errore.name);
  }
  assert.match(new HelloNonDisponibileError().message, /Opzioni di accesso/);
});

import { scegliAmbiente } from "../../dist/credenziali/modalita.js";

test("in modalità Hello senza ARUBA_ENVIRONMENT l'ambiente è production", () => {
  assert.equal(scegliAmbiente({}, true), "production");
  assert.equal(scegliAmbiente({ ARUBA_ENVIRONMENT: "" }, true), "production");
});

test("ARUBA_ENVIRONMENT esplicito vince; senza Hello il predefinito resta demo", () => {
  assert.equal(scegliAmbiente({ ARUBA_ENVIRONMENT: "demo" }, true), "demo");
  assert.equal(scegliAmbiente({}, false), "demo");
  assert.equal(scegliAmbiente({ ARUBA_ENVIRONMENT: "production" }, false), "production");
});
