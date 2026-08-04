/**
 * Aggregazioni sulle fatture: elenchi filtrati, anagrafiche controparti,
 * riepiloghi IVA e andamento per periodo.
 */

import type { FatturaClassificata } from "./fatturapa.js";

export type Direzione = "emessa" | "ricevuta";

export interface Filtri {
  direzione?: Direzione;
  /** Estremi inclusi, formato ISO `YYYY-MM-DD`. */
  dataDa?: string;
  dataA?: string;
  /** Ricerca parziale case-insensitive su denominazione, P.IVA o codice fiscale. */
  controparte?: string;
  tipoDocumento?: string;
  importoMinimo?: number;
  importoMassimo?: number;
}

function arrotonda(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function applicaFiltri(
  fatture: FatturaClassificata[],
  filtri: Filtri,
): FatturaClassificata[] {
  const ricerca = filtri.controparte?.trim().toLowerCase();

  return fatture.filter((f) => {
    if (filtri.direzione && f.direzione !== filtri.direzione) return false;
    // Le date FatturaPA sono ISO `YYYY-MM-DD`: il confronto lessicografico
    // equivale a quello cronologico.
    if (filtri.dataDa && f.data < filtri.dataDa) return false;
    if (filtri.dataA && f.data > filtri.dataA) return false;
    if (filtri.tipoDocumento && f.tipoDocumento !== filtri.tipoDocumento) return false;
    if (filtri.importoMinimo !== undefined && f.totaleDocumento < filtri.importoMinimo)
      return false;
    if (filtri.importoMassimo !== undefined && f.totaleDocumento > filtri.importoMassimo)
      return false;
    if (ricerca) {
      const campi = [
        f.controparte.denominazione,
        f.controparte.partitaIva,
        f.controparte.codiceFiscale,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!campi.includes(ricerca)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Anagrafiche
// ---------------------------------------------------------------------------

export interface SchedaControparte {
  denominazione: string;
  partitaIva: string | null;
  codiceFiscale: string | null;
  comune: string | null;
  provincia: string | null;
  paese: string | null;
  ruolo: "cliente" | "fornitore" | "cliente e fornitore";
  numeroFatture: number;
  totaleImponibile: number;
  totaleImposta: number;
  totaleDocumenti: number;
  primaFattura: string;
  ultimaFattura: string;
}

/**
 * Costruisce l'anagrafica delle controparti aggregando per partita IVA
 * (o codice fiscale, o denominazione come ultima risorsa).
 */
export function anagraficaControparti(
  fatture: FatturaClassificata[],
): SchedaControparte[] {
  const mappa = new Map<
    string,
    SchedaControparte & { emesse: number; ricevute: number }
  >();

  for (const f of fatture) {
    const chiave = f.controparte.chiave;
    let scheda = mappa.get(chiave);
    if (!scheda) {
      scheda = {
        denominazione: f.controparte.denominazione,
        partitaIva: f.controparte.partitaIva,
        codiceFiscale: f.controparte.codiceFiscale,
        comune: f.controparte.comune,
        provincia: f.controparte.provincia,
        paese: f.controparte.paese,
        ruolo: "cliente",
        numeroFatture: 0,
        totaleImponibile: 0,
        totaleImposta: 0,
        totaleDocumenti: 0,
        primaFattura: f.data,
        ultimaFattura: f.data,
        emesse: 0,
        ricevute: 0,
      };
      mappa.set(chiave, scheda);
    }

    scheda.numeroFatture++;
    scheda.totaleImponibile += f.imponibileTotale;
    scheda.totaleImposta += f.impostaTotale;
    scheda.totaleDocumenti += f.totaleDocumento;
    if (f.data && f.data < scheda.primaFattura) scheda.primaFattura = f.data;
    if (f.data && f.data > scheda.ultimaFattura) scheda.ultimaFattura = f.data;
    // Chi riceve le mie fatture è un cliente; chi me le emette è un fornitore.
    if (f.direzione === "emessa") scheda.emesse++;
    else scheda.ricevute++;
    // I dati anagrafici della fattura più recente prevalgono (ragioni sociali
    // e sedi cambiano nel tempo).
    if (f.data >= scheda.ultimaFattura) {
      scheda.denominazione = f.controparte.denominazione;
      scheda.comune = f.controparte.comune;
      scheda.provincia = f.controparte.provincia;
    }
  }

  return [...mappa.values()]
    .map(({ emesse, ricevute, ...scheda }) => ({
      ...scheda,
      ruolo:
        emesse > 0 && ricevute > 0
          ? ("cliente e fornitore" as const)
          : emesse > 0
            ? ("cliente" as const)
            : ("fornitore" as const),
      totaleImponibile: arrotonda(scheda.totaleImponibile),
      totaleImposta: arrotonda(scheda.totaleImposta),
      totaleDocumenti: arrotonda(scheda.totaleDocumenti),
    }))
    .sort((a, b) => b.totaleImponibile - a.totaleImponibile);
}

// ---------------------------------------------------------------------------
// Statistiche IVA
// ---------------------------------------------------------------------------

export interface VoceAliquota {
  aliquotaIva: number;
  natura: string | null;
  imponibile: number;
  imposta: number;
  numeroFatture: number;
}

export interface ProspettoIva {
  periodo: { da: string | null; a: string | null };
  ivaVendite: { totaleImponibile: number; totaleImposta: number; aliquote: VoceAliquota[] };
  ivaAcquisti: { totaleImponibile: number; totaleImposta: number; aliquote: VoceAliquota[] };
  /** Positivo = IVA da versare; negativo = credito IVA. */
  saldoIva: number;
  numeroFattureEmesse: number;
  numeroFattureRicevute: number;
  /**
   * L'IVA sugli acquisti è detraibile solo in base al regime fiscale e alla
   * natura dei beni: il saldo qui è un'indicazione contabile, non una
   * liquidazione IVA.
   */
  avvertenza: string;
}

function aggregaAliquote(fatture: FatturaClassificata[]): {
  totaleImponibile: number;
  totaleImposta: number;
  aliquote: VoceAliquota[];
} {
  const mappa = new Map<string, VoceAliquota & { fattureViste: Set<string> }>();

  for (const f of fatture) {
    for (const r of f.riepilogoIva) {
      // Aliquota e natura insieme: 0% con natura N2.2 e 0% con N4 sono
      // fattispecie fiscali distinte e vanno tenute separate.
      const chiave = `${r.aliquotaIva}|${r.natura ?? ""}`;
      let voce = mappa.get(chiave);
      if (!voce) {
        voce = {
          aliquotaIva: r.aliquotaIva,
          natura: r.natura,
          imponibile: 0,
          imposta: 0,
          numeroFatture: 0,
          fattureViste: new Set(),
        };
        mappa.set(chiave, voce);
      }
      voce.imponibile += r.imponibile;
      voce.imposta += r.imposta;
      // Una fattura con più righe alla stessa aliquota conta una volta sola.
      const idFattura = `${f.cedente.chiave}|${f.numero}|${f.data}`;
      if (!voce.fattureViste.has(idFattura)) {
        voce.fattureViste.add(idFattura);
        voce.numeroFatture++;
      }
    }
  }

  const aliquote = [...mappa.values()]
    .map(({ fattureViste, ...voce }) => ({
      ...voce,
      imponibile: arrotonda(voce.imponibile),
      imposta: arrotonda(voce.imposta),
    }))
    .sort((a, b) => b.aliquotaIva - a.aliquotaIva);

  return {
    totaleImponibile: arrotonda(aliquote.reduce((s, v) => s + v.imponibile, 0)),
    totaleImposta: arrotonda(aliquote.reduce((s, v) => s + v.imposta, 0)),
    aliquote,
  };
}

export function prospettoIva(
  fatture: FatturaClassificata[],
  periodo: { da?: string; a?: string } = {},
): ProspettoIva {
  const emesse = fatture.filter((f) => f.direzione === "emessa");
  const ricevute = fatture.filter((f) => f.direzione === "ricevuta");

  const vendite = aggregaAliquote(emesse);
  const acquisti = aggregaAliquote(ricevute);

  return {
    periodo: { da: periodo.da ?? null, a: periodo.a ?? null },
    ivaVendite: vendite,
    ivaAcquisti: acquisti,
    saldoIva: arrotonda(vendite.totaleImposta - acquisti.totaleImposta),
    numeroFattureEmesse: emesse.length,
    numeroFattureRicevute: ricevute.length,
    avvertenza:
      "Il saldo è la differenza tra IVA a debito e IVA sugli acquisti sulle fatture presenti nell'archivio. " +
      "Non è una liquidazione IVA: non tiene conto di detraibilità parziale, reverse charge, split payment, " +
      "crediti pregressi né di documenti non inclusi nell'archivio.",
  };
}

// ---------------------------------------------------------------------------
// Andamento temporale
// ---------------------------------------------------------------------------

export interface VocePeriodo {
  periodo: string;
  emesse: { numero: number; imponibile: number; imposta: number; totale: number };
  ricevute: { numero: number; imponibile: number; imposta: number; totale: number };
}

/** Raggruppa per mese (`YYYY-MM`), trimestre (`YYYY-Tn`) o anno (`YYYY`). */
export function andamento(
  fatture: FatturaClassificata[],
  granularita: "mese" | "trimestre" | "anno",
): VocePeriodo[] {
  const etichetta = (data: string): string => {
    const anno = data.slice(0, 4);
    if (granularita === "anno") return anno;
    const mese = Number(data.slice(5, 7));
    if (granularita === "mese") return data.slice(0, 7);
    return `${anno}-T${Math.floor((mese - 1) / 3) + 1}`;
  };

  const mappa = new Map<string, VocePeriodo>();
  for (const f of fatture) {
    if (!f.data) continue;
    const chiave = etichetta(f.data);
    let voce = mappa.get(chiave);
    if (!voce) {
      voce = {
        periodo: chiave,
        emesse: { numero: 0, imponibile: 0, imposta: 0, totale: 0 },
        ricevute: { numero: 0, imponibile: 0, imposta: 0, totale: 0 },
      };
      mappa.set(chiave, voce);
    }
    const lato = f.direzione === "emessa" ? voce.emesse : voce.ricevute;
    lato.numero++;
    lato.imponibile += f.imponibileTotale;
    lato.imposta += f.impostaTotale;
    lato.totale += f.totaleDocumento;
  }

  return [...mappa.values()]
    .map((v) => ({
      periodo: v.periodo,
      emesse: {
        numero: v.emesse.numero,
        imponibile: arrotonda(v.emesse.imponibile),
        imposta: arrotonda(v.emesse.imposta),
        totale: arrotonda(v.emesse.totale),
      },
      ricevute: {
        numero: v.ricevute.numero,
        imponibile: arrotonda(v.ricevute.imponibile),
        imposta: arrotonda(v.ricevute.imposta),
        totale: arrotonda(v.ricevute.totale),
      },
    }))
    .sort((a, b) => a.periodo.localeCompare(b.periodo));
}
