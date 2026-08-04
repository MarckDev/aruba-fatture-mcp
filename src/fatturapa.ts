/**
 * Parser per fatture elettroniche in formato FatturaPA v1.2.x.
 *
 * Trasforma l'XML ministeriale in una struttura piatta e tipizzata, adatta ad
 * aggregazioni (fatturato, riepiloghi IVA, anagrafiche controparti).
 */

import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Tipi del modello normalizzato
// ---------------------------------------------------------------------------

export interface Controparte {
  /** Denominazione, oppure "Nome Cognome" per le persone fisiche. */
  denominazione: string;
  partitaIva: string | null;
  codiceFiscale: string | null;
  paese: string | null;
  indirizzo: string | null;
  cap: string | null;
  comune: string | null;
  provincia: string | null;
  /** Chiave di raggruppamento anagrafico: P.IVA, altrimenti CF, altrimenti nome. */
  chiave: string;
}

export interface RigaFattura {
  numeroLinea: number | null;
  descrizione: string;
  quantita: number | null;
  unitaMisura: string | null;
  prezzoUnitario: number | null;
  prezzoTotale: number;
  aliquotaIva: number;
  natura: string | null;
}

export interface RiepilogoIva {
  aliquotaIva: number;
  /** Codice natura per le operazioni senza IVA (N1…N7), se presente. */
  natura: string | null;
  imponibile: number;
  imposta: number;
  esigibilita: string | null;
  riferimentoNormativo: string | null;
}

export interface Fattura {
  /** Nome del file di origine, quando disponibile. */
  file: string | null;
  formatoTrasmissione: string | null;
  tipoDocumento: string;
  numero: string;
  data: string;
  divisa: string;
  cedente: Controparte;
  cessionario: Controparte;
  righe: RigaFattura[];
  riepilogoIva: RiepilogoIva[];
  imponibileTotale: number;
  impostaTotale: number;
  /** `ImportoTotaleDocumento` se presente in XML, altrimenti imponibile+imposta. */
  totaleDocumento: number;
  /** Presente in XML (`ImportoTotaleDocumento`) oppure ricostruito dai riepiloghi. */
  totaleDichiarato: boolean;
  ritenuta: number;
  bollo: number;
  modalitaPagamento: string[];
  dataScadenza: string | null;
  causale: string[];
}

/** Fattura arricchita con la direzione rispetto al soggetto titolare dell'archivio. */
export interface FatturaClassificata extends Fattura {
  direzione: "emessa" | "ricevuta";
  /** La controparte: cessionario per le emesse, cedente per le ricevute. */
  controparte: Controparte;
}

// ---------------------------------------------------------------------------
// Helper di lettura dell'albero XML
// ---------------------------------------------------------------------------

type Nodo = Record<string, any>;

/**
 * FatturaPA ammette prefissi di namespace arbitrari (`p:`, `ns2:`, nessuno…):
 * la ricerca dei tag ignora quindi il prefisso.
 */
function campo(nodo: Nodo | undefined, nome: string): any {
  if (!nodo || typeof nodo !== "object") return undefined;
  if (nodo[nome] !== undefined) return nodo[nome];
  const chiave = Object.keys(nodo).find((k) => k.replace(/^.*:/, "") === nome);
  return chiave ? nodo[chiave] : undefined;
}

function testo(nodo: Nodo | undefined, nome: string): string | null {
  const valore = campo(nodo, nome);
  if (valore === undefined || valore === null) return null;
  if (typeof valore === "object") return null;
  const s = String(valore).trim();
  return s === "" ? null : s;
}

/**
 * I numeri FatturaPA usano il punto decimale. Il parser è configurato per non
 * convertire i valori, così codici come `0012` restano stringhe: la conversione
 * numerica avviene solo dove serve davvero.
 */
function numero(nodo: Nodo | undefined, nome: string): number | null {
  const s = testo(nodo, nome);
  if (s === null) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Normalizza a array i nodi che l'XML può ripetere (righe, riepiloghi, body). */
function lista(valore: any): Nodo[] {
  if (valore === undefined || valore === null) return [];
  return Array.isArray(valore) ? valore : [valore];
}

function arrotonda(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Estrazione dei blocchi
// ---------------------------------------------------------------------------

function leggiControparte(nodo: Nodo | undefined): Controparte {
  const anagrafici = campo(nodo, "DatiAnagrafici");
  const anagrafica = campo(anagrafici, "Anagrafica");
  const idIva = campo(anagrafici, "IdFiscaleIVA");
  const sede = campo(nodo, "Sede");

  const denominazione =
    testo(anagrafica, "Denominazione") ??
    ([testo(anagrafica, "Nome"), testo(anagrafica, "Cognome")]
      .filter(Boolean)
      .join(" ") ||
      null);

  const paese = testo(idIva, "IdPaese");
  const codice = testo(idIva, "IdCodice");
  // La P.IVA completa include il prefisso paese solo se non è italiana: la
  // chiave anagrafica resta così stabile tra fatture dello stesso soggetto.
  const partitaIva = codice ? (paese && paese !== "IT" ? `${paese}${codice}` : codice) : null;
  const codiceFiscale = testo(anagrafici, "CodiceFiscale");

  const nome = denominazione ?? "(anonimo)";
  return {
    denominazione: nome,
    partitaIva,
    codiceFiscale,
    paese: paese ?? testo(sede, "Nazione"),
    indirizzo: testo(sede, "Indirizzo"),
    cap: testo(sede, "CAP"),
    comune: testo(sede, "Comune"),
    provincia: testo(sede, "Provincia"),
    chiave: partitaIva ?? codiceFiscale ?? nome.toUpperCase(),
  };
}

function leggiRighe(beniServizi: Nodo | undefined): RigaFattura[] {
  return lista(campo(beniServizi, "DettaglioLinee")).map((riga) => ({
    numeroLinea: numero(riga, "NumeroLinea"),
    descrizione: testo(riga, "Descrizione") ?? "",
    quantita: numero(riga, "Quantita"),
    unitaMisura: testo(riga, "UnitaMisura"),
    prezzoUnitario: numero(riga, "PrezzoUnitario"),
    prezzoTotale: numero(riga, "PrezzoTotale") ?? 0,
    aliquotaIva: numero(riga, "AliquotaIVA") ?? 0,
    natura: testo(riga, "Natura"),
  }));
}

function leggiRiepiloghi(beniServizi: Nodo | undefined): RiepilogoIva[] {
  return lista(campo(beniServizi, "DatiRiepilogo")).map((r) => ({
    aliquotaIva: numero(r, "AliquotaIVA") ?? 0,
    natura: testo(r, "Natura"),
    imponibile: numero(r, "ImponibileImporto") ?? 0,
    imposta: numero(r, "Imposta") ?? 0,
    esigibilita: testo(r, "EsigibilitaIVA"),
    riferimentoNormativo: testo(r, "RiferimentoNormativo"),
  }));
}

function leggiPagamento(datiPagamento: Nodo[]): {
  modalita: string[];
  scadenza: string | null;
} {
  const modalita = new Set<string>();
  const scadenze: string[] = [];
  for (const pagamento of datiPagamento) {
    for (const dettaglio of lista(campo(pagamento, "DettaglioPagamento"))) {
      const modo = testo(dettaglio, "ModalitaPagamento");
      if (modo) modalita.add(modo);
      const scadenza = testo(dettaglio, "DataScadenzaPagamento");
      if (scadenza) scadenze.push(scadenza);
    }
  }
  scadenze.sort();
  return { modalita: [...modalita], scadenza: scadenze[0] ?? null };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // I codici FatturaPA sono stringhe con zeri iniziali significativi
  // (TipoDocumento, CAP, ModalitaPagamento): niente coercizione automatica.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/**
 * Estrae le fatture da un XML FatturaPA.
 *
 * Un singolo file può contenere più `FatturaElettronicaBody` (lotto di
 * fatture che condividono lo stesso header): ognuno diventa una `Fattura`.
 */
export function parseFatturaXml(xml: string, file: string | null = null): Fattura[] {
  const albero = parser.parse(xml);

  // La radice ha un prefisso di namespace variabile: si prende il primo nodo
  // oggetto che contenga un header di fattura.
  let radice: Nodo | undefined;
  for (const valore of Object.values(albero as Nodo)) {
    if (valore && typeof valore === "object" && campo(valore, "FatturaElettronicaHeader")) {
      radice = valore;
      break;
    }
  }
  if (!radice) {
    throw new Error("XML non riconosciuto come FatturaPA: manca FatturaElettronicaHeader.");
  }

  const header = campo(radice, "FatturaElettronicaHeader");
  const trasmissione = campo(header, "DatiTrasmissione");
  const cedente = leggiControparte(campo(header, "CedentePrestatore"));
  const cessionario = leggiControparte(campo(header, "CessionarioCommittente"));
  const formatoTrasmissione =
    testo(trasmissione, "FormatoTrasmissione") ??
    (typeof radice["@_versione"] === "string" ? radice["@_versione"] : null);

  const corpi = lista(campo(radice, "FatturaElettronicaBody"));
  return corpi.map((body) => {
    const generali = campo(body, "DatiGenerali");
    const documento = campo(generali, "DatiGeneraliDocumento");
    const beniServizi = campo(body, "DatiBeniServizi");

    const riepilogoIva = leggiRiepiloghi(beniServizi);
    const imponibileTotale = arrotonda(
      riepilogoIva.reduce((somma, r) => somma + r.imponibile, 0),
    );
    const impostaTotale = arrotonda(
      riepilogoIva.reduce((somma, r) => somma + r.imposta, 0),
    );

    const ritenuta = lista(campo(documento, "DatiRitenuta")).reduce(
      (somma, r) => somma + (numero(r, "ImportoRitenuta") ?? 0),
      0,
    );
    const bollo = numero(campo(documento, "DatiBollo"), "ImportoBollo") ?? 0;

    const dichiarato = numero(documento, "ImportoTotaleDocumento");
    const { modalita, scadenza } = leggiPagamento(lista(campo(body, "DatiPagamento")));

    return {
      file,
      formatoTrasmissione,
      tipoDocumento: testo(documento, "TipoDocumento") ?? "TD01",
      numero: testo(documento, "Numero") ?? "",
      data: testo(documento, "Data") ?? "",
      divisa: testo(documento, "Divisa") ?? "EUR",
      cedente,
      cessionario,
      righe: leggiRighe(beniServizi),
      riepilogoIva,
      imponibileTotale,
      impostaTotale,
      totaleDocumento:
        dichiarato ?? arrotonda(imponibileTotale + impostaTotale + bollo - ritenuta),
      totaleDichiarato: dichiarato !== null,
      ritenuta: arrotonda(ritenuta),
      bollo: arrotonda(bollo),
      modalitaPagamento: modalita,
      dataScadenza: scadenza,
      causale: lista(campo(documento, "Causale"))
        .map((c) => (typeof c === "object" ? null : String(c).trim()))
        .filter((c): c is string => !!c),
    };
  });
}
