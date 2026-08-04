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
import { caricaArchivio, type EsitoCaricamento } from "./archivio.js";
import {
  andamento,
  anagraficaControparti,
  applicaFiltri,
  prospettoIva,
  type Filtri,
} from "./analisi.js";
import { ArubaPanelClient, PanelError } from "./panel-client.js";
import {
  andamento as andamentoPannello,
  controparti as contropartiPannello,
  filtra as filtraPannello,
  normalizzaInviata,
  normalizzaRicevuta,
  totali as totaliPannello,
  type FatturaPannello,
  type FiltriPannello,
} from "./panel.js";

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
  if (error instanceof ArubaApiError || error instanceof PanelError) {
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

// ---------------------------------------------------------------------------
// Archivio locale di fatture
// ---------------------------------------------------------------------------

const archivioPredefinito = process.env.ARUBA_ARCHIVE_DIR;

/**
 * Parsare l'archivio a ogni chiamata sarebbe sprecato: i tool di analisi ne
 * fanno molte di seguito sugli stessi file. La cache è per percorso e si
 * invalida solo su richiesta esplicita (`ricarica`).
 */
const cacheArchivio = new Map<string, EsitoCaricamento>();

let titolareCache: { partitaIva: string | null; codiceFiscale: string | null } | null = null;

/**
 * Partita IVA e codice fiscale del titolare, necessari per distinguere le
 * fatture emesse da quelle ricevute. Si leggono da `userInfo`, con fallback
 * alle variabili d'ambiente se l'account non è raggiungibile (archivio
 * utilizzabile anche offline).
 */
async function titolare() {
  if (titolareCache) return titolareCache;
  const daEnv = {
    partitaIva: process.env.ARUBA_VAT_CODE ?? null,
    codiceFiscale: process.env.ARUBA_FISCAL_CODE ?? null,
  };
  try {
    const info = (await client.userInfo()) as {
      vatCode?: string;
      fiscalCode?: string;
    };
    titolareCache = {
      partitaIva: info.vatCode ?? daEnv.partitaIva,
      codiceFiscale: info.fiscalCode ?? daEnv.codiceFiscale,
    };
  } catch {
    titolareCache = daEnv;
  }
  return titolareCache;
}

async function archivio(percorso: string | undefined, ricarica = false) {
  const cartella = percorso ?? archivioPredefinito;
  if (!cartella) {
    throw new Error(
      "Nessun archivio indicato: passare 'archivePath' oppure impostare la variabile d'ambiente ARUBA_ARCHIVE_DIR con la cartella che contiene gli XML/ZIP delle fatture.",
    );
  }
  const target = resolve(cartella);
  const inCache = cacheArchivio.get(target);
  if (inCache && !ricarica) return inCache;

  const esito = await caricaArchivio(target, await titolare());
  cacheArchivio.set(target, esito);
  return esito;
}

const archivioSchema = {
  archivePath: z
    .string()
    .optional()
    .describe(
      "Cartella (o singolo file) con gli XML/P7M/ZIP delle fatture. Se omesso usa ARUBA_ARCHIVE_DIR",
    ),
  ricarica: z
    .boolean()
    .default(false)
    .describe("true per rileggere i file da disco ignorando la cache in memoria"),
};

const filtriSchema = {
  direzione: z
    .enum(["emessa", "ricevuta"])
    .optional()
    .describe('"emessa" = ciclo attivo (vendite), "ricevuta" = ciclo passivo (acquisti)'),
  dataDa: z.string().optional().describe("Data minima del documento, YYYY-MM-DD (inclusa)"),
  dataA: z.string().optional().describe("Data massima del documento, YYYY-MM-DD (inclusa)"),
  controparte: z
    .string()
    .optional()
    .describe("Ricerca parziale su denominazione, partita IVA o codice fiscale della controparte"),
  tipoDocumento: z.string().optional().describe("Tipo documento FatturaPA (TD01, TD04, ...)"),
  importoMinimo: z.number().optional().describe("Totale documento minimo"),
  importoMassimo: z.number().optional().describe("Totale documento massimo"),
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
// Pannello Aruba (API privata del pannello web)
// ---------------------------------------------------------------------------

const panelClient = new ArubaPanelClient(username, password);

const ENDPOINT_RICERCA = {
  inviate: "FatturaFrontEnd/advancedSearch",
  ricevute: "FatturaRicevutaFrontEnd/advancedSearch",
} as const;

/**
 * Le fatture scaricate dal pannello, per anno e ciclo. Il pannello non filtra
 * per data lato server, quindi si scarica l'anno intero una volta sola e si
 * riusa per tutte le aggregazioni successive.
 */
const cachePannello = new Map<string, FatturaPannello[]>();

async function fattureP(
  ciclo: "inviate" | "ricevute",
  anno: number,
  ricarica: boolean,
): Promise<FatturaPannello[]> {
  const chiave = `${ciclo}-${anno}`;
  const inCache = cachePannello.get(chiave);
  if (inCache && !ricarica) return inCache;

  const grezze = await panelClient.serviceAll<Record<string, unknown>>(
    ENDPOINT_RICERCA[ciclo],
    { AnnoFiscale: anno },
  );
  const normalizza = ciclo === "inviate" ? normalizzaInviata : normalizzaRicevuta;
  const fatture = grezze.map(normalizza);
  cachePannello.set(chiave, fatture);
  return fatture;
}

const annoCorrente = new Date().getFullYear();

const cicloSchema = z
  .enum(["inviate", "ricevute"])
  .describe('"inviate" = ciclo attivo (vendite), "ricevute" = ciclo passivo (acquisti). Inviate e ricevute sono sempre tenute separate');

const annoSchema = z
  .number()
  .int()
  .min(2015)
  .max(annoCorrente + 1)
  .default(annoCorrente)
  .describe("Anno fiscale delle fatture");

const ricaricaPannelloSchema = z
  .boolean()
  .default(false)
  .describe("true per riscaricare i dati dal pannello ignorando la cache");

server.registerTool(
  "panel_list_invoices",
  {
    title: "Elenco fatture dal pannello Aruba (live)",
    description:
      "Scarica le fatture direttamente dal pannello web di Aruba (dati in tempo reale, nessuna utenza Premium richiesta) e le elenca. " +
      "Il parametro 'ciclo' sceglie SE inviate O ricevute: i due cicli sono sempre restituiti separatamente, mai insieme. " +
      "Filtri opzionali per periodo e controparte; include i totali del sottoinsieme.",
    inputSchema: {
      ciclo: cicloSchema,
      anno: annoSchema,
      dataDa: z.string().optional().describe("Data minima YYYY-MM-DD (inclusa)"),
      dataA: z.string().optional().describe("Data massima YYYY-MM-DD (inclusa)"),
      controparte: z.string().optional().describe("Ricerca parziale su cliente (inviate) o fornitore (ricevute)"),
      limite: z.number().int().min(1).default(100).describe("Numero massimo di fatture da restituire"),
      ricarica: ricaricaPannelloSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ ciclo, anno, dataDa, dataA, controparte, limite, ricarica }) => {
    try {
      const tutte = await fattureP(ciclo, anno, ricarica);
      const selezionate = filtraPannello(tutte, { dataDa, dataA, controparte } as FiltriPannello);
      return jsonResult({
        ciclo,
        anno,
        fattureNelPeriodo: selezionate.length,
        fattureNellAnno: tutte.length,
        totali: totaliPannello(selezionate),
        fatture: selezionate.slice(0, limite),
        ...(selezionate.length > limite
          ? { nota: `Mostrate ${limite} di ${selezionate.length}: alzare 'limite' o restringere i filtri.` }
          : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "panel_counterparties",
  {
    title: "Clienti o fornitori dal pannello Aruba (live)",
    description:
      "Ricostruisce l'anagrafica delle controparti dalle fatture del pannello, con totali e periodo di attività. " +
      "Con ciclo='inviate' restituisce i CLIENTI, con ciclo='ricevute' i FORNITORI: i due elenchi sono sempre separati.",
    inputSchema: {
      ciclo: cicloSchema,
      anno: annoSchema,
      dataDa: z.string().optional().describe("Considera solo le fatture da questa data, YYYY-MM-DD"),
      dataA: z.string().optional().describe("Considera solo le fatture fino a questa data, YYYY-MM-DD"),
      ricarica: ricaricaPannelloSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ ciclo, anno, dataDa, dataA, ricarica }) => {
    try {
      const tutte = await fattureP(ciclo, anno, ricarica);
      const selezionate = filtraPannello(tutte, { dataDa, dataA } as FiltriPannello);
      const schede = contropartiPannello(selezionate);
      return jsonResult({
        ciclo,
        tipo: ciclo === "inviate" ? "clienti" : "fornitori",
        anno,
        numero: schede.length,
        controparti: schede,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "panel_vat_report",
  {
    title: "Prospetto IVA dal pannello Aruba (live)",
    description:
      "Calcola i totali IVA dell'anno dal pannello, tenendo separate IVA sulle vendite (fatture inviate) e IVA sugli acquisti (fatture ricevute), con il saldo tra le due. " +
      "È un prospetto contabile di supporto, non una liquidazione IVA ufficiale.",
    inputSchema: {
      anno: annoSchema,
      dataDa: z.string().optional().describe("Inizio periodo YYYY-MM-DD (inclusa)"),
      dataA: z.string().optional().describe("Fine periodo YYYY-MM-DD (inclusa)"),
      ricarica: ricaricaPannelloSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ anno, dataDa, dataA, ricarica }) => {
    try {
      const [inviate, ricevute] = await Promise.all([
        fattureP("inviate", anno, ricarica),
        fattureP("ricevute", anno, ricarica),
      ]);
      const filtro = { dataDa, dataA } as FiltriPannello;
      const venditeTot = totaliPannello(filtraPannello(inviate, filtro));
      const acquistiTot = totaliPannello(filtraPannello(ricevute, filtro));
      return jsonResult({
        anno,
        periodo: { da: dataDa ?? null, a: dataA ?? null },
        ivaVendite: { imponibile: venditeTot.imponibile, imposta: venditeTot.imposta, numeroFatture: venditeTot.numero },
        ivaAcquisti: { imponibile: acquistiTot.imponibile, imposta: acquistiTot.imposta, numeroFatture: acquistiTot.numero },
        saldoIva: Math.round((venditeTot.imposta - acquistiTot.imposta) * 100) / 100,
        avvertenza:
          "Saldo = IVA a debito (vendite) meno IVA sugli acquisti, sulle fatture del pannello. " +
          "Non è una liquidazione IVA: non tiene conto di detraibilità parziale, reverse charge, split payment o crediti pregressi.",
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "panel_revenue_trend",
  {
    title: "Andamento fatturato/acquisti dal pannello Aruba (live)",
    description:
      "Andamento per mese, trimestre o anno dal pannello, con inviate e ricevute riportate separatamente in due serie distinte.",
    inputSchema: {
      anno: annoSchema,
      granularita: z.enum(["mese", "trimestre", "anno"]).default("mese").describe("Livello di aggregazione temporale"),
      ricarica: ricaricaPannelloSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ anno, granularita, ricarica }) => {
    try {
      const [inviate, ricevute] = await Promise.all([
        fattureP("inviate", anno, ricarica),
        fattureP("ricevute", anno, ricarica),
      ]);
      return jsonResult({
        anno,
        granularita,
        inviate: andamentoPannello(inviate, granularita),
        ricevute: andamentoPannello(ricevute, granularita),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool di analisi sull'archivio locale
// ---------------------------------------------------------------------------

server.registerTool(
  "list_invoices",
  {
    title: "Elenco fatture (archivio locale)",
    description:
      "Elenca le fatture presenti nell'archivio locale di XML/P7M/ZIP, filtrando per direzione (emesse/ricevute), periodo, controparte, tipo documento e importo. " +
      "Non richiede utenza Premium: legge i file esportati dal pannello Aruba. Restituisce anche i totali del sottoinsieme filtrato.",
    inputSchema: {
      ...archivioSchema,
      ...filtriSchema,
      dettaglioRighe: z
        .boolean()
        .default(false)
        .describe("true per includere le righe di dettaglio di ogni fattura (output molto più lungo)"),
      limite: z
        .number()
        .int()
        .min(1)
        .default(100)
        .describe("Numero massimo di fatture da restituire"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ archivePath, ricarica, dettaglioRighe, limite, ...filtri }) => {
    try {
      const { fatture, scartati, fileEsaminati } = await archivio(archivePath, ricarica);
      const selezionate = applicaFiltri(fatture, filtri as Filtri);

      const totali = selezionate.reduce(
        (acc, f) => ({
          imponibile: acc.imponibile + f.imponibileTotale,
          imposta: acc.imposta + f.impostaTotale,
          totale: acc.totale + f.totaleDocumento,
        }),
        { imponibile: 0, imposta: 0, totale: 0 },
      );

      return jsonResult({
        fileEsaminati,
        fattureInArchivio: fatture.length,
        fattureFiltrate: selezionate.length,
        totali: {
          imponibile: Math.round(totali.imponibile * 100) / 100,
          imposta: Math.round(totali.imposta * 100) / 100,
          totaleDocumenti: Math.round(totali.totale * 100) / 100,
        },
        fatture: selezionate.slice(0, limite).map((f) => ({
          data: f.data,
          numero: f.numero,
          tipoDocumento: f.tipoDocumento,
          direzione: f.direzione,
          controparte: f.controparte.denominazione,
          partitaIvaControparte: f.controparte.partitaIva,
          imponibile: f.imponibileTotale,
          imposta: f.impostaTotale,
          totale: f.totaleDocumento,
          dataScadenza: f.dataScadenza,
          file: f.file,
          ...(dettaglioRighe ? { righe: f.righe, riepilogoIva: f.riepilogoIva } : {}),
        })),
        ...(selezionate.length > limite
          ? { nota: `Mostrate ${limite} di ${selezionate.length} fatture: alzare 'limite' o restringere i filtri.` }
          : {}),
        ...(scartati.length ? { fileScartati: scartati } : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "list_counterparties",
  {
    title: "Anagrafica clienti e fornitori",
    description:
      "Ricostruisce l'anagrafica di clienti e fornitori dalle fatture dell'archivio locale, con numero di documenti, totali e periodo di attività di ciascuno. " +
      "I clienti sono le controparti delle fatture emesse, i fornitori quelle delle fatture ricevute. Ordinati per imponibile decrescente.",
    inputSchema: {
      ...archivioSchema,
      ruolo: z
        .enum(["cliente", "fornitore", "tutti"])
        .default("tutti")
        .describe("Filtra per ruolo della controparte"),
      dataDa: z.string().optional().describe("Considera solo le fatture da questa data, YYYY-MM-DD"),
      dataA: z.string().optional().describe("Considera solo le fatture fino a questa data, YYYY-MM-DD"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ archivePath, ricarica, ruolo, dataDa, dataA }) => {
    try {
      const { fatture } = await archivio(archivePath, ricarica);
      const selezionate = applicaFiltri(fatture, { dataDa, dataA });
      const schede = anagraficaControparti(selezionate).filter(
        (s) => ruolo === "tutti" || s.ruolo === ruolo || s.ruolo === "cliente e fornitore",
      );
      return jsonResult({
        periodo: { da: dataDa ?? null, a: dataA ?? null },
        numeroControparti: schede.length,
        controparti: schede,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "vat_report",
  {
    title: "Prospetto IVA",
    description:
      "Calcola il riepilogo IVA del periodo dall'archivio locale: imponibile e imposta suddivisi per aliquota e natura, separando IVA sulle vendite (fatture emesse) e sugli acquisti (fatture ricevute), con il saldo tra le due. " +
      "È un prospetto contabile di supporto, non una liquidazione IVA ufficiale.",
    inputSchema: {
      ...archivioSchema,
      dataDa: z.string().optional().describe("Inizio del periodo, YYYY-MM-DD (inclusa)"),
      dataA: z.string().optional().describe("Fine del periodo, YYYY-MM-DD (inclusa)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ archivePath, ricarica, dataDa, dataA }) => {
    try {
      const { fatture } = await archivio(archivePath, ricarica);
      const selezionate = applicaFiltri(fatture, { dataDa, dataA });
      return jsonResult(prospettoIva(selezionate, { da: dataDa, a: dataA }));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "revenue_trend",
  {
    title: "Andamento per periodo",
    description:
      "Andamento di fatturato e acquisti aggregato per mese, trimestre o anno, a partire dall'archivio locale. Utile per confronti tra periodi e per l'IVA trimestrale.",
    inputSchema: {
      ...archivioSchema,
      granularita: z
        .enum(["mese", "trimestre", "anno"])
        .default("mese")
        .describe("Livello di aggregazione temporale"),
      dataDa: z.string().optional().describe("Inizio del periodo, YYYY-MM-DD"),
      dataA: z.string().optional().describe("Fine del periodo, YYYY-MM-DD"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ archivePath, ricarica, granularita, dataDa, dataA }) => {
    try {
      const { fatture } = await archivio(archivePath, ricarica);
      const selezionate = applicaFiltri(fatture, { dataDa, dataA });
      return jsonResult({
        granularita,
        periodi: andamento(selezionate, granularita),
      });
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
