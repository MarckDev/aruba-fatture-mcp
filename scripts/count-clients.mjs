// Conta i clienti distinti (cessionari/committenti) dalle fatture inviate.
// L'API limita la ricerca a finestre di max 10 giorni: si scandisce il periodo.
// Uso: node scripts/count-clients.mjs <dataInizio> <dataFine>
import { ArubaClient } from "../dist/aruba-client.js";

const [start = "2025-01-01", end = "2026-08-03"] = process.argv.slice(2);

const client = new ArubaClient(
  process.env.ARUBA_USERNAME,
  process.env.ARUBA_PASSWORD,
  process.env.ARUBA_ENVIRONMENT ?? "production",
);

const WINDOW_DAYS = 10;
const PAUSE_MS = 5200; // 12 richieste/minuto max
const pause = () => new Promise((res) => setTimeout(res, PAUSE_MS));
const fmt = (d) => d.toISOString().slice(0, 10);

const clients = new Map();
let totalInvoices = 0;
let earliestInvoice = null;
let requests = 0;

let windowStart = new Date(`${start}T00:00:00Z`);
const rangeEnd = new Date(`${end}T00:00:00Z`);

while (windowStart <= rangeEnd) {
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + WINDOW_DAYS);
  const effectiveEnd = windowEnd > rangeEnd ? rangeEnd : windowEnd;

  let page = 1;
  for (;;) {
    if (requests > 0) await pause();
    const data = await client.apiJson("/api/v2/invoices-out", {
      query: {
        creationStartDate: fmt(windowStart),
        creationEndDate: fmt(effectiveEnd),
        page,
        size: 100,
      },
    });
    requests += 1;
    const items = data.content ?? [];
    for (const item of items) {
      totalInvoices += 1;
      if (!earliestInvoice || item.creationDate < earliestInvoice) {
        earliestInvoice = item.creationDate;
      }
      const r = item.receiver ?? {};
      const key = r.vatCode || r.fiscalCode || r.description || "sconosciuto";
      const entry = clients.get(key) ?? {
        descrizione: r.description ?? null,
        partitaIva: r.vatCode ?? null,
        codiceFiscale: r.fiscalCode ?? null,
        fatture: 0,
      };
      entry.fatture += 1;
      if (!entry.descrizione && r.description) entry.descrizione = r.description;
      clients.set(key, entry);
    }
    if (data.last !== false || items.length === 0) break;
    page += 1;
  }
  console.error(
    `Finestra ${fmt(windowStart)} → ${fmt(effectiveEnd)}: totale parziale ${totalInvoices} fatture, ${clients.size} clienti`,
  );
  windowStart = windowEnd;
}

console.log(
  JSON.stringify(
    {
      periodo: { da: start, a: end },
      richiesteEffettuate: requests,
      fattureInviate: totalInvoices,
      primaFatturaTrovata: earliestInvoice,
      clientiDistinti: clients.size,
      clienti: [...clients.values()].sort((a, b) => b.fatture - a.fatture),
    },
    null,
    2,
  ),
);
