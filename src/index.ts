#!/usr/bin/env node
/**
 * Server MCP per le API di Aruba Fatturazione Elettronica.
 *
 * Variabili d'ambiente richieste:
 *  - ARUBA_USERNAME     username del servizio Fatturazione Elettronica Aruba
 *  - ARUBA_PASSWORD     password del servizio
 *  - ARUBA_ENVIRONMENT  "demo" (default) oppure "production"
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ArubaApiError,
  ArubaClient,
  type ArubaEnvironment,
  type QueryParams,
} from "./aruba-client.js";

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

const username = process.env.ARUBA_USERNAME;
const password = process.env.ARUBA_PASSWORD;
const environment = (process.env.ARUBA_ENVIRONMENT ?? "demo") as ArubaEnvironment;

if (!username || !password) {
  console.error(
    "Errore: impostare le variabili d'ambiente ARUBA_USERNAME e ARUBA_PASSWORD.",
  );
  process.exit(1);
}
if (environment !== "demo" && environment !== "production") {
  console.error(
    `Errore: ARUBA_ENVIRONMENT deve essere "demo" o "production" (valore attuale: "${environment}").`,
  );
  process.exit(1);
}

const client = new ArubaClient(username, password, environment);

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

const MAX_INLINE_STRING = 2000;

/**
 * Sostituisce ricorsivamente le stringhe molto lunghe (file base64) per non
 * saturare il contesto della conversazione: per i file c'è download_invoice.
 */
function truncateLargeStrings(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_INLINE_STRING) {
    return `[contenuto omesso: ${value.length} caratteri — usa il tool download_invoice per salvarlo su file]`;
  }
  if (Array.isArray(value)) return value.map(truncateLargeStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        truncateLargeStrings(v),
      ]),
    );
  }
  return value;
}

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(truncateLargeStrings(data), null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  let message: string;
  if (error instanceof ArubaApiError) {
    message = `${error.message}\nRisposta del server: ${error.body.slice(0, MAX_INLINE_STRING)}`;
  } else {
    message = error instanceof Error ? error.message : String(error);
  }
  return {
    content: [{ type: "text" as const, text: `Errore: ${message}` }],
    isError: true,
  };
}

type InvoiceDirection = "sent" | "received";

function invoicesBasePath(direction: InvoiceDirection): string {
  return direction === "sent" ? "/api/v2/invoices-out" : "/api/v2/invoices-in";
}

// ---------------------------------------------------------------------------
// Schemi condivisi
// ---------------------------------------------------------------------------

const directionSchema = z
  .enum(["sent", "received"])
  .describe('"sent" = fatture inviate (ciclo attivo), "received" = fatture ricevute (ciclo passivo)');

const invoiceIdentifierSchema = {
  id: z.string().optional().describe("ID interno Aruba della fattura"),
  filename: z.string().optional().describe("Nome file della fattura (es. IT01234567890_00001.xml)"),
  idSdi: z.string().optional().describe("Identificativo SDI della fattura"),
};

const searchFiltersSchema = {
  creationStartDate: z
    .string()
    .describe("Data/ora inizio ricezione su piattaforma, ISO 8601 (es. 2026-08-01 o 2026-08-01T00:00:00)"),
  creationEndDate: z
    .string()
    .describe("Data/ora fine ricezione su piattaforma, ISO 8601. Massimo 10 giorni di differenza da creationStartDate: per periodi più lunghi eseguire più ricerche in finestre da 10 giorni"),
  senderCountry: z.string().optional().describe("Paese del cedente/prestatore (es. IT). Obbligatorio per utenze Premium"),
  senderVatcode: z.string().optional().describe("Partita IVA del cedente/prestatore. Obbligatoria per utenze Premium"),
  receiverCountry: z.string().optional().describe("Paese del cessionario/committente"),
  receiverVatcode: z.string().optional().describe("Partita IVA del cessionario/committente"),
  receiverFiscalcode: z.string().optional().describe("Codice fiscale del cessionario/committente"),
  status: z
    .string()
    .optional()
    .describe("Filtro stato fattura (per le inviate: 1=presa in carico, 2=errore elaborazione, 3=inviata a SDI, 4=scartata da SDI, 7=consegnata, 8=accettata, 9=rifiutata)"),
  documentType: z.string().optional().describe("Tipo documento (TD01, TD04, TD24, ...)"),
  modifiedStartDate: z.string().optional().describe("Data inizio ultima modifica, ISO 8601"),
  modifiedEndDate: z.string().optional().describe("Data fine ultima modifica, ISO 8601"),
  page: z.number().int().min(1).optional().describe("Pagina dei risultati (default 1)"),
  size: z.number().int().min(1).max(100).optional().describe("Risultati per pagina (default 10, max 100)"),
};

function requireIdentifier(args: {
  id?: string;
  filename?: string;
  idSdi?: string;
}): QueryParams {
  if (!args.id && !args.filename && !args.idSdi) {
    throw new Error(
      "Specificare almeno uno tra: id, filename o idSdi per identificare la fattura.",
    );
  }
  return { id: args.id, filename: args.filename, idSdi: args.idSdi };
}

// ---------------------------------------------------------------------------
// Server MCP e tool
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "aruba-fatture",
  version: "1.0.0",
});

server.registerTool(
  "get_user_info",
  {
    title: "Info account Aruba",
    description:
      "Restituisce le informazioni dell'account Aruba Fatturazione Elettronica: partita IVA, codice fiscale, stato del servizio, spazio di conservazione utilizzato.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return jsonResult(await client.userInfo());
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "search_invoices",
  {
    title: "Ricerca fatture",
    description:
      "Cerca fatture elettroniche inviate (ciclo attivo) o ricevute (ciclo passivo) su Aruba Fatturazione Elettronica, filtrando per periodo, stato, tipo documento e controparte. Risultati paginati. " +
      "NOTA: richiede un'utenza Premium (o delega da Premium); con utenza base risponde 401 per mancanza di deleghe.",
    inputSchema: {
      direction: directionSchema,
      ...searchFiltersSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ direction, ...filters }) => {
    try {
      const data = await client.apiJson(invoicesBasePath(direction), {
        query: filters as QueryParams,
      });
      return jsonResult(data);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "get_invoice_detail",
  {
    title: "Dettaglio fattura",
    description:
      "Restituisce i metadati completi di una singola fattura (mittente, destinatario, stato, notifiche SDI). Identificarla con uno tra id, filename o idSdi. Per scaricare XML/PDF/ZIP usare download_invoice.",
    inputSchema: {
      direction: directionSchema,
      ...invoiceIdentifierSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ direction, ...ident }) => {
    try {
      const query = requireIdentifier(ident);
      const data = await client.apiJson(
        `${invoicesBasePath(direction)}/detail`,
        { query: { ...query, includeFile: false, includePdf: false } },
      );
      return jsonResult(data);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "download_invoice",
  {
    title: "Scarica fattura su file",
    description:
      "Scarica una fattura su disco nel formato scelto: xml (il file fattura originale), pdf (versione leggibile), zip (fattura + notifiche SDI), pdd (pacchetto di distribuzione della conservazione, disponibile solo se pddAvailable=true nel dettaglio).",
    inputSchema: {
      direction: directionSchema,
      ...invoiceIdentifierSchema,
      format: z.enum(["xml", "pdf", "zip", "pdd"]).describe("Formato da scaricare"),
      outputPath: z
        .string()
        .describe("Percorso assoluto del file di destinazione (es. C:\\fatture\\fattura.pdf)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ direction, format, outputPath, ...ident }) => {
    try {
      const query = requireIdentifier(ident);
      const base = invoicesBasePath(direction);
      const target = resolve(outputPath);
      await mkdir(dirname(target), { recursive: true });

      let bytes: Buffer;
      if (format === "zip" || format === "pdd") {
        bytes = await client.apiBinary(`${base}/${format}`, query);
      } else {
        const data = await client.apiJson<{ file?: string; pdfFile?: string }>(
          `${base}/detail`,
          {
            query: {
              ...query,
              includeFile: format === "xml",
              includePdf: format === "pdf",
            },
          },
        );
        const base64 = format === "xml" ? data.file : data.pdfFile;
        if (!base64) {
          throw new Error(
            `Il server non ha restituito il contenuto ${format.toUpperCase()} per questa fattura.`,
          );
        }
        bytes = Buffer.from(base64, "base64");
      }

      await writeFile(target, bytes);
      return jsonResult({
        saved: true,
        path: target,
        format,
        sizeBytes: bytes.length,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "send_invoice",
  {
    title: "Invia fattura a SDI",
    description:
      "Carica una fattura elettronica XML su Aruba per l'invio al Sistema di Interscambio (SDI). " +
      "ATTENZIONE: con dryRun=false la fattura viene inviata realmente a SDI. " +
      "Per default dryRun=true: il file viene solo validato, senza invio. " +
      "Il file XML deve indicare come trasmittente l'intermediario Aruba (IdTrasmittente 01879020517). " +
      "Fornire il file tramite xmlFilePath (consigliato) oppure xmlContent.",
    inputSchema: {
      xmlFilePath: z
        .string()
        .optional()
        .describe("Percorso assoluto del file XML (o .p7m se signed=true) da inviare"),
      xmlContent: z
        .string()
        .optional()
        .describe("In alternativa al percorso: contenuto XML della fattura come testo"),
      signed: z
        .boolean()
        .default(false)
        .describe("true se il file è firmato digitalmente (CAdES .p7m o XAdES): usa l'endpoint uploadSigned"),
      dryRun: z
        .boolean()
        .default(true)
        .describe("true (default) = solo validazione, nessun invio a SDI. Impostare esplicitamente false per l'invio reale"),
      senderPIVA: z
        .string()
        .optional()
        .describe("Partita IVA del mittente, necessaria solo per documenti TD26 o casi multi-azienda"),
    },
  },
  async ({ xmlFilePath, xmlContent, signed, dryRun, senderPIVA }) => {
    try {
      let dataFile: string;
      if (xmlFilePath) {
        dataFile = (await readFile(resolve(xmlFilePath))).toString("base64");
      } else if (xmlContent) {
        dataFile = Buffer.from(xmlContent, "utf8").toString("base64");
      } else {
        throw new Error("Specificare xmlFilePath oppure xmlContent.");
      }

      const endpoint = signed
        ? "/services/invoice/uploadSigned"
        : "/services/invoice/upload";
      const data = await client.apiJson<{
        errorCode?: string;
        errorDescription?: string;
        uploadFileName?: string;
      }>(endpoint, {
        method: "POST",
        jsonBody: { dataFile, dryRun, ...(senderPIVA ? { senderPIVA } : {}) },
      });

      return jsonResult({
        ...data,
        esito:
          data.errorCode === "0000"
            ? dryRun
              ? "Validazione superata (nessun invio effettuato: dryRun attivo)"
              : "Fattura presa in carico da Aruba per l'invio a SDI"
            : "Operazione non riuscita, vedi errorCode/errorDescription",
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "get_invoice_notifications",
  {
    title: "Notifiche SDI di una fattura",
    description:
      "Restituisce le notifiche SDI di una singola fattura a partire dal nome file (es. ricevuta di consegna, scarto, mancata consegna). " +
      "Funziona anche con utenza base: è il modo per tracciare lo stato di una fattura inviata via API (il filename è restituito da send_invoice come uploadFileName).",
    inputSchema: {
      direction: directionSchema,
      invoiceFilename: z
        .string()
        .describe("Nome file della fattura (es. IT01307730869_00001.xml), come restituito da send_invoice"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ direction, invoiceFilename }) => {
    try {
      const data = await client.apiJson(
        `/services/notification/${direction === "sent" ? "out" : "in"}/getByInvoiceFilename`,
        { query: { invoiceFilename } },
      );
      return jsonResult(data);
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `Server MCP aruba-fatture avviato (ambiente: ${environment}).`,
);
