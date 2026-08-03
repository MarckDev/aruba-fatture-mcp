// Verifica quali endpoint sono accessibili con l'utenza corrente.
import { ArubaClient } from "../dist/aruba-client.js";

const client = new ArubaClient(
  process.env.ARUBA_USERNAME,
  process.env.ARUBA_PASSWORD,
  process.env.ARUBA_ENVIRONMENT ?? "production",
);

const pause = () => new Promise((r) => setTimeout(r, 5200));
const user = process.env.ARUBA_USERNAME;

const probes = [
  ["userInfo", () => client.userInfo()],
  ["v2 ricerca fatture inviate", () => client.apiJson("/api/v2/invoices-out", { query: { creationStartDate: "2026-07-24", creationEndDate: "2026-08-03", size: 1 } })],
  ["v2 ricerca fatture ricevute", () => client.apiJson("/api/v2/invoices-in", { query: { creationStartDate: "2026-07-24", creationEndDate: "2026-08-03", size: 1 } })],
  ["v2 notifiche fatture inviate", () => client.apiJson("/api/v2/notifications-out", { query: { size: 1 } })],
  ["v2 notifiche fatture ricevute", () => client.apiJson("/api/v2/notifications-in", { query: { size: 1 } })],
  ["v1 ricerca fatture inviate", () => client.apiJson("/services/invoice/out/findByUsername", { query: { username: user, size: 1 } })],
  ["v1 ricerca fatture ricevute", () => client.apiJson("/services/invoice/in/findByUsername", { query: { username: user, size: 1 } })],
  ["upload (dryRun, xml di test)", () => client.apiJson("/services/invoice/upload", { method: "POST", jsonBody: { dataFile: Buffer.from('<?xml version="1.0"?><test/>').toString("base64"), dryRun: true } })],
];

for (const [name, fn] of probes) {
  try {
    const data = await fn();
    const errCode = data?.errorCode;
    if (errCode && errCode !== "0000") {
      console.log(`⚠️  ${name}: risponde ma con errore applicativo ${errCode} — ${data.errorDescription}`);
    } else {
      const summary = JSON.stringify(data).slice(0, 200);
      console.log(`✅ ${name}: OK — ${summary}`);
    }
  } catch (e) {
    console.log(`❌ ${name}: HTTP ${e.status ?? "?"} — ${(e.body ?? e.message).slice(0, 160)}`);
  }
  await pause();
}
