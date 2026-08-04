/**
 * Normalizzazione e aggregazione dei dati del pannello Aruba.
 *
 * Le fatture inviate (ciclo attivo) e ricevute (ciclo passivo) restano sempre
 * distinte: hanno campi diversi nel JSON del pannello e non vanno mai mischiate
 * nei totali.
 */

export type Ciclo = "inviate" | "ricevute";

/** Fattura normalizzata, comune ai due cicli ma con la direzione esplicita. */
export interface FatturaPannello {
  ciclo: Ciclo;
  id: string | null;
  numero: string;
  data: string; // ISO YYYY-MM-DD
  /** Cliente per le inviate, fornitore per le ricevute. */
  controparte: string;
  imponibile: number;
  imposta: number;
  totale: number;
  statoCodice: number | null;
  statoDescrizione: string | null;
  idSdi: string | null;
  fileName: string | null;
}

// Stati SDI delle fatture inviate (dal pannello Aruba).
const STATI_INVIATE: Record<number, string> = {
  1: "Presa in carico",
  2: "Errore di elaborazione",
  3: "Inviata a SDI",
  4: "Scartata da SDI",
  5: "In elaborazione",
  6: "Mancata consegna",
  7: "Consegnata",
  8: "Accettata dal destinatario",
  9: "Rifiutata dal destinatario",
  10: "Decorrenza termini",
};

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Le date del pannello arrivano come `2026/08/03 00:00:00.0000+02:00`: se ne
 * estrae la sola parte calendario in formato ISO.
 */
function isoDate(value: unknown): string {
  const s = str(value);
  if (!s) return "";
  const m = s.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s.slice(0, 10);
}

type ItemPannello = Record<string, unknown>;

export function normalizzaInviata(item: ItemPannello): FatturaPannello {
  const stato = item.Stato === null || item.Stato === undefined ? null : num(item.Stato);
  return {
    ciclo: "inviate",
    id: str(item.Id),
    numero: str(item.Numero) ?? "",
    data: isoDate(item.Data),
    controparte: str(item.Destinatario) ?? "(sconosciuto)",
    imponibile: num(item.TotaleImponibile),
    imposta: num(item.TotaleIva),
    totale: num(item.ImportoTotaleDocumento),
    statoCodice: stato,
    statoDescrizione: stato !== null ? (STATI_INVIATE[stato] ?? `Stato ${stato}`) : null,
    idSdi: str(item.IdSdI),
    fileName: str(item.FileName) ?? str(item.UploadFileName),
  };
}

export function normalizzaRicevuta(item: ItemPannello): FatturaPannello {
  return {
    ciclo: "ricevute",
    id: str(item.Id),
    numero: str(item.Numero) ?? "",
    data: isoDate(item.Data),
    controparte: str(item.Mittente) ?? "(sconosciuto)",
    imponibile: num(item.TotaleImponibile),
    imposta: num(item.TotaleIva),
    totale: num(item.TotaleDocumento),
    // Le ricevute non hanno lo stato SDI del ciclo attivo.
    statoCodice: null,
    statoDescrizione: null,
    idSdi: str(item.SdiFileName),
    fileName: str(item.FileName),
  };
}

// ---------------------------------------------------------------------------
// Filtri e aggregazioni (per singolo ciclo)
// ---------------------------------------------------------------------------

export interface FiltriPannello {
  dataDa?: string;
  dataA?: string;
  controparte?: string;
}

function arrotonda(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function filtra(
  fatture: FatturaPannello[],
  filtri: FiltriPannello,
): FatturaPannello[] {
  const ricerca = filtri.controparte?.trim().toLowerCase();
  return fatture.filter((f) => {
    if (filtri.dataDa && f.data < filtri.dataDa) return false;
    if (filtri.dataA && f.data > filtri.dataA) return false;
    if (ricerca && !f.controparte.toLowerCase().includes(ricerca)) return false;
    return true;
  });
}

export interface Totali {
  numero: number;
  imponibile: number;
  imposta: number;
  totale: number;
}

export function totali(fatture: FatturaPannello[]): Totali {
  return fatture.reduce<Totali>(
    (acc, f) => ({
      numero: acc.numero + 1,
      imponibile: arrotonda(acc.imponibile + f.imponibile),
      imposta: arrotonda(acc.imposta + f.imposta),
      totale: arrotonda(acc.totale + f.totale),
    }),
    { numero: 0, imponibile: 0, imposta: 0, totale: 0 },
  );
}

export interface SchedaControparte {
  denominazione: string;
  numeroFatture: number;
  imponibile: number;
  imposta: number;
  totale: number;
  primaFattura: string;
  ultimaFattura: string;
}

/**
 * Anagrafica delle controparti di un singolo ciclo: i clienti (dalle inviate) e
 * i fornitori (dalle ricevute) restano insiemi separati per costruzione.
 */
export function controparti(fatture: FatturaPannello[]): SchedaControparte[] {
  const mappa = new Map<string, SchedaControparte>();
  for (const f of fatture) {
    const chiave = f.controparte.toUpperCase();
    const scheda = mappa.get(chiave);
    if (!scheda) {
      mappa.set(chiave, {
        denominazione: f.controparte,
        numeroFatture: 1,
        imponibile: f.imponibile,
        imposta: f.imposta,
        totale: f.totale,
        primaFattura: f.data,
        ultimaFattura: f.data,
      });
    } else {
      scheda.numeroFatture++;
      scheda.imponibile += f.imponibile;
      scheda.imposta += f.imposta;
      scheda.totale += f.totale;
      if (f.data && f.data < scheda.primaFattura) scheda.primaFattura = f.data;
      if (f.data && f.data > scheda.ultimaFattura) scheda.ultimaFattura = f.data;
    }
  }
  return [...mappa.values()]
    .map((s) => ({
      ...s,
      imponibile: arrotonda(s.imponibile),
      imposta: arrotonda(s.imposta),
      totale: arrotonda(s.totale),
    }))
    .sort((a, b) => b.imponibile - a.imponibile);
}

export interface VocePeriodo {
  periodo: string;
  numero: number;
  imponibile: number;
  imposta: number;
  totale: number;
}

/** Andamento di un singolo ciclo per mese/trimestre/anno. */
export function andamento(
  fatture: FatturaPannello[],
  granularita: "mese" | "trimestre" | "anno",
): VocePeriodo[] {
  const etichetta = (data: string): string => {
    const anno = data.slice(0, 4);
    if (granularita === "anno") return anno;
    if (granularita === "mese") return data.slice(0, 7);
    const mese = Number(data.slice(5, 7));
    return `${anno}-T${Math.floor((mese - 1) / 3) + 1}`;
  };

  const mappa = new Map<string, VocePeriodo>();
  for (const f of fatture) {
    if (!f.data) continue;
    const chiave = etichetta(f.data);
    const voce = mappa.get(chiave);
    if (!voce) {
      mappa.set(chiave, {
        periodo: chiave,
        numero: 1,
        imponibile: f.imponibile,
        imposta: f.imposta,
        totale: f.totale,
      });
    } else {
      voce.numero++;
      voce.imponibile += f.imponibile;
      voce.imposta += f.imposta;
      voce.totale += f.totale;
    }
  }
  return [...mappa.values()]
    .map((v) => ({
      ...v,
      imponibile: arrotonda(v.imponibile),
      imposta: arrotonda(v.imposta),
      totale: arrotonda(v.totale),
    }))
    .sort((a, b) => a.periodo.localeCompare(b.periodo));
}
