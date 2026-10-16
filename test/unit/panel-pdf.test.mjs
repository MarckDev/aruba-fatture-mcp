import { test } from "node:test";
import assert from "node:assert/strict";
import { parametriPdfPannello } from "../../dist/panel.js";

test("il PDF si chiede con Id, Posizione e AnnoFiscale, come fa il pannello web", () => {
  const record = { Id: "6ad20a6e1d0ed28878732285", Posizione: 1, Mittente: "GARAGE 2000 SRL" };
  assert.deepEqual(parametriPdfPannello(record, 2026), {
    Id: "6ad20a6e1d0ed28878732285",
    Posizione: 1,
    AnnoFiscale: 2026,
  });
});

test("la posizione di una fattura dentro un lotto viene passata così com'è", () => {
  assert.equal(parametriPdfPannello({ Id: "x", Posizione: 3 }, 2025).Posizione, 3);
});

test("senza Posizione nel record l'errore lo dice chiaramente", () => {
  assert.throws(() => parametriPdfPannello({ Id: "x" }, 2026), /Posizione/);
});
