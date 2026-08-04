/**
 * Generazione di una fattura elettronica FatturaPA da dati strutturati, pronta
 * per l'upload al pannello Aruba.
 *
 * Il blocco `CedentePrestatore` (i dati fiscali del titolare) non viene
 * ricostruito: si riusa verbatim quello di una fattura già emessa, così i dati
 * anagrafici, il regime fiscale e l'iscrizione REA sono per definizione corretti
 * e non serve tenerli hardcoded. Il `CessionarioCommittente` è costruito dai
 * campi del registro clienti Aruba.
 */

export interface ClienteRegistro {
  AnagraficaCliente?: string;
  PartitaIva?: string | null;
  CodiceFiscale?: string | null;
  CodiceDestinatario?: string | null;
  IndirizzoSede?: string | null;
  CapSede?: string | null;
  ComuneSede?: string | null;
  ProvinciaSede?: string | null;
  NazioneSede?: string | null;
  PersonaFisica?: boolean;
  Pec?: string | null;
}

export interface RigaInput {
  descrizione: string;
  quantita?: number;
  prezzoUnitario: number;
  aliquotaIva: number;
  /** Codice natura (N1…N7) per righe senza IVA (aliquota 0). */
  natura?: string;
  unitaMisura?: string;
}

export interface DatiFatturaInput {
  numero: string;
  data: string; // YYYY-MM-DD
  tipoDocumento?: string; // default TD01
  divisa?: string; // default EUR
  causale?: string;
  progressivoInvio?: string;
  righe: RigaInput[];
}

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function euro(n: number): string {
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** Estrae il blocco `<CedentePrestatore>…</CedentePrestatore>` da un XML esistente. */
export function estraiCedente(xml: string): string | null {
  const match = xml.match(/<CedentePrestatore>[\s\S]*?<\/CedentePrestatore>/);
  return match ? match[0] : null;
}

function codiceDestinatario(cliente: ClienteRegistro): string {
  const codice = cliente.CodiceDestinatario?.trim();
  if (codice && codice.length === 7) return codice;
  // Senza codice SDI valido si usa "0000000" e, se c'è, la PEC come recapito.
  return "0000000";
}

function bloccoCessionario(cliente: ClienteRegistro): string {
  const paese = (cliente.NazioneSede ?? "IT").toUpperCase();
  const piva = cliente.PartitaIva?.replace(/^IT/i, "");
  const cf = cliente.CodiceFiscale?.trim();

  const idFiscale = piva
    ? `        <IdFiscaleIVA>
          <IdPaese>${esc(paese)}</IdPaese>
          <IdCodice>${esc(piva)}</IdCodice>
        </IdFiscaleIVA>\n`
    : "";
  const codFiscale = cf ? `        <CodiceFiscale>${esc(cf)}</CodiceFiscale>\n` : "";

  // Persona fisica → Nome/Cognome; azienda → Denominazione. Il registro Aruba
  // non separa nome e cognome, quindi per le persone fisiche si divide alla
  // prima parola, mantenendo il resto come cognome.
  const nome = cliente.AnagraficaCliente?.trim() || "CLIENTE";
  let anagrafica: string;
  if (cliente.PersonaFisica) {
    const parti = nome.split(/\s+/);
    const primo = parti.shift() ?? nome;
    const resto = parti.join(" ") || primo;
    anagrafica = `          <Nome>${esc(primo)}</Nome>
          <Cognome>${esc(resto)}</Cognome>`;
  } else {
    anagrafica = `          <Denominazione>${esc(nome)}</Denominazione>`;
  }

  const sede = `      <Sede>
        <Indirizzo>${esc(cliente.IndirizzoSede ?? "-")}</Indirizzo>
        <CAP>${esc(cliente.CapSede ?? "00000")}</CAP>
        <Comune>${esc(cliente.ComuneSede ?? "-")}</Comune>${
    cliente.ProvinciaSede ? `\n        <Provincia>${esc(cliente.ProvinciaSede)}</Provincia>` : ""
  }
        <Nazione>${esc(paese)}</Nazione>
      </Sede>`;

  return `    <CessionarioCommittente>
      <DatiAnagrafici>
${idFiscale}${codFiscale}        <Anagrafica>
${anagrafica}
        </Anagrafica>
      </DatiAnagrafici>
${sede}
    </CessionarioCommittente>`;
}

interface Riepilogo {
  aliquota: number;
  natura?: string;
  imponibile: number;
  imposta: number;
}

/**
 * Costruisce l'XML della fattura. Restituisce anche i totali calcolati, così il
 * chiamante può mostrarli per conferma prima dell'invio.
 */
export function generaFatturaXml(input: {
  cedenteBlock: string;
  cliente: ClienteRegistro;
  dati: DatiFatturaInput;
}): { xml: string; imponibile: number; imposta: number; totale: number } {
  const { cedenteBlock, cliente, dati } = input;
  if (!dati.righe.length) {
    throw new Error("La fattura deve avere almeno una riga.");
  }

  const riepiloghi = new Map<string, Riepilogo>();
  const righeXml = dati.righe
    .map((riga, i) => {
      const quantita = riga.quantita ?? 1;
      const totaleRiga = quantita * riga.prezzoUnitario;
      const chiave = `${riga.aliquotaIva}|${riga.natura ?? ""}`;
      const r = riepiloghi.get(chiave) ?? {
        aliquota: riga.aliquotaIva,
        natura: riga.natura,
        imponibile: 0,
        imposta: 0,
      };
      r.imponibile += totaleRiga;
      r.imposta += totaleRiga * (riga.aliquotaIva / 100);
      riepiloghi.set(chiave, r);

      return `      <DettaglioLinee>
        <NumeroLinea>${i + 1}</NumeroLinea>
        <Descrizione>${esc(riga.descrizione)}</Descrizione>
        <Quantita>${euro(quantita)}</Quantita>${
        riga.unitaMisura ? `\n        <UnitaMisura>${esc(riga.unitaMisura)}</UnitaMisura>` : ""
      }
        <PrezzoUnitario>${euro(riga.prezzoUnitario)}</PrezzoUnitario>
        <PrezzoTotale>${euro(totaleRiga)}</PrezzoTotale>
        <AliquotaIVA>${euro(riga.aliquotaIva)}</AliquotaIVA>${
        riga.natura ? `\n        <Natura>${esc(riga.natura)}</Natura>` : ""
      }
      </DettaglioLinee>`;
    })
    .join("\n");

  const riepilogoXml = [...riepiloghi.values()]
    .map(
      (r) => `      <DatiRiepilogo>
        <AliquotaIVA>${euro(r.aliquota)}</AliquotaIVA>${
        r.natura ? `\n        <Natura>${esc(r.natura)}</Natura>` : ""
      }
        <ImponibileImporto>${euro(r.imponibile)}</ImponibileImporto>
        <Imposta>${euro(r.imposta)}</Imposta>
      </DatiRiepilogo>`,
    )
    .join("\n");

  const imponibile = [...riepiloghi.values()].reduce((s, r) => s + r.imponibile, 0);
  const imposta = [...riepiloghi.values()].reduce((s, r) => s + r.imposta, 0);
  const totale = imponibile + imposta;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>IT</IdPaese>
        <IdCodice>01879020517</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${esc(dati.progressivoInvio ?? "1")}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>${esc(codiceDestinatario(cliente))}</CodiceDestinatario>
    </DatiTrasmissione>
${cedenteBlock}
${bloccoCessionario(cliente)}
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${esc(dati.tipoDocumento ?? "TD01")}</TipoDocumento>
        <Divisa>${esc(dati.divisa ?? "EUR")}</Divisa>
        <Data>${esc(dati.data)}</Data>
        <Numero>${esc(dati.numero)}</Numero>${
    dati.causale ? `\n        <Causale>${esc(dati.causale)}</Causale>` : ""
  }
        <ImportoTotaleDocumento>${euro(totale)}</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
${righeXml}
${riepilogoXml}
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;

  return {
    xml,
    imponibile: Math.round(imponibile * 100) / 100,
    imposta: Math.round(imposta * 100) / 100,
    totale: Math.round(totale * 100) / 100,
  };
}
