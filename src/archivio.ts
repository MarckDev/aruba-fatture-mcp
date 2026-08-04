/**
 * Caricamento di un archivio locale di fatture elettroniche.
 *
 * Accetta i formati con cui Aruba (e i portali SDI in genere) esportano i
 * documenti: XML nudo, XML firmato CAdES (.p7m) e archivi ZIP che li
 * contengono, anche annidati in sottocartelle.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  parseFatturaXml,
  type Fattura,
  type FatturaClassificata,
} from "./fatturapa.js";

export interface Titolare {
  partitaIva: string | null;
  codiceFiscale: string | null;
}

export interface EsitoCaricamento {
  fatture: FatturaClassificata[];
  /** File ignorati o illeggibili, con il motivo: utile per non perdere dati in silenzio. */
  scartati: { file: string; motivo: string }[];
  fileEsaminati: number;
}

// ---------------------------------------------------------------------------
// Estrazione dai contenitori
// ---------------------------------------------------------------------------

/**
 * Estrae l'XML da un file .p7m (busta CAdES, DER o base64).
 *
 * Non si verifica la firma: qui interessa solo il contenuto fatturale, e una
 * verifica crittografica richiederebbe la catena dei certificati. Il payload
 * viene individuato per delimitatori XML, approccio robusto rispetto alle
 * varianti di codifica ASN.1 prodotte dai diversi firmatari.
 */
function estraiDaP7m(buffer: Buffer): string | null {
  let dati = buffer;

  // Alcune buste arrivano codificate in base64 (spesso con intestazione PEM).
  const inizio = buffer.subarray(0, 64).toString("ascii");
  if (/^\s*(-----BEGIN|MI[A-Za-z0-9+/])/.test(inizio)) {
    const testo = buffer.toString("ascii").replace(/-----[^-]+-----/g, "");
    if (/^[\sA-Za-z0-9+/=]+$/.test(testo)) {
      const decodificato = Buffer.from(testo.replace(/\s+/g, ""), "base64");
      if (decodificato.length > 0) dati = decodificato;
    }
  }

  for (const codifica of ["utf8", "latin1"] as const) {
    const testo = dati.toString(codifica);
    const apertura = testo.search(/<\?xml[\s\S]{0,400}?FatturaElettronica|<[A-Za-z0-9]*:?FatturaElettronica[\s>]/);
    if (apertura === -1) continue;
    const chiusura = testo.lastIndexOf("FatturaElettronica>");
    if (chiusura === -1 || chiusura < apertura) continue;
    return testo.slice(apertura, chiusura + "FatturaElettronica>".length);
  }
  return null;
}

/**
 * Elenca i file contenuti in uno ZIP.
 *
 * Implementazione minimale del formato (central directory + deflate) per non
 * introdurre una dipendenza: gli ZIP degli export SDI usano solo i metodi
 * "stored" e "deflate".
 */
function leggiZip(buffer: Buffer): { nome: string; dati: Buffer }[] {
  const risultati: { nome: string; dati: Buffer }[] = [];

  // End of central directory: firma 0x06054b50, cercata dal fondo perché può
  // essere seguita da un commento di lunghezza variabile.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return risultati;

  const totaleVoci = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < totaleVoci; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const metodo = buffer.readUInt16LE(offset + 10);
    const dimensioneCompressa = buffer.readUInt32LE(offset + 20);
    const lunghezzaNome = buffer.readUInt16LE(offset + 28);
    const lunghezzaExtra = buffer.readUInt16LE(offset + 30);
    const lunghezzaCommento = buffer.readUInt16LE(offset + 32);
    const offsetLocale = buffer.readUInt32LE(offset + 42);
    const nome = buffer
      .subarray(offset + 46, offset + 46 + lunghezzaNome)
      .toString("utf8");
    offset += 46 + lunghezzaNome + lunghezzaExtra + lunghezzaCommento;

    if (nome.endsWith("/")) continue; // directory

    // I campi "extra" e "nome" del local header possono differire da quelli
    // della central directory: vanno riletti da lì per trovare i dati.
    if (offsetLocale + 30 > buffer.length) continue;
    if (buffer.readUInt32LE(offsetLocale) !== 0x04034b50) continue;
    const nomeLocale = buffer.readUInt16LE(offsetLocale + 26);
    const extraLocale = buffer.readUInt16LE(offsetLocale + 28);
    const inizioDati = offsetLocale + 30 + nomeLocale + extraLocale;
    const compressi = buffer.subarray(inizioDati, inizioDati + dimensioneCompressa);

    try {
      if (metodo === 0) {
        risultati.push({ nome, dati: compressi });
      } else if (metodo === 8) {
        risultati.push({ nome, dati: inflateRawSync(compressi) });
      }
    } catch {
      // Voce corrotta o metodo non supportato: si prosegue con le altre.
    }
  }
  return risultati;
}

// ---------------------------------------------------------------------------
// Classificazione
// ---------------------------------------------------------------------------

function normalizzaCodice(codice: string | null | undefined): string | null {
  if (!codice) return null;
  return codice.trim().toUpperCase().replace(/^IT/, "");
}

/**
 * Determina se la fattura è emessa o ricevuta dal titolare dell'archivio.
 *
 * Se il titolare non è noto, il confronto non è possibile: si assume "ricevuta"
 * solo quando il cedente non coincide, altrimenti il chiamante deve fornire
 * partita IVA o codice fiscale per una classificazione affidabile.
 */
function classifica(fattura: Fattura, titolare: Titolare): FatturaClassificata {
  const codiciTitolare = new Set(
    [normalizzaCodice(titolare.partitaIva), normalizzaCodice(titolare.codiceFiscale)].filter(
      (c): c is string => !!c,
    ),
  );

  const codiciCedente = [
    normalizzaCodice(fattura.cedente.partitaIva),
    normalizzaCodice(fattura.cedente.codiceFiscale),
  ].filter((c): c is string => !!c);

  const emessa = codiciCedente.some((c) => codiciTitolare.has(c));
  return {
    ...fattura,
    direzione: emessa ? "emessa" : "ricevuta",
    controparte: emessa ? fattura.cessionario : fattura.cedente,
  };
}

// ---------------------------------------------------------------------------
// Scansione
// ---------------------------------------------------------------------------

const ESTENSIONI_FATTURA = new Set([".xml", ".p7m"]);

async function elencaFile(percorso: string): Promise<string[]> {
  const info = await stat(percorso);
  if (info.isFile()) return [percorso];

  const trovati: string[] = [];
  const voci = await readdir(percorso, { withFileTypes: true });
  for (const voce of voci) {
    const completo = join(percorso, voce.name);
    if (voce.isDirectory()) {
      trovati.push(...(await elencaFile(completo)));
    } else if (voce.isFile()) {
      trovati.push(completo);
    }
  }
  return trovati;
}

/**
 * Carica tutte le fatture presenti in un file o in una cartella (ricorsiva).
 *
 * Le fatture duplicate — stesso emittente, numero e data, tipiche quando lo
 * stesso documento compare sia come XML sia dentro uno ZIP — vengono unificate.
 */
export async function caricaArchivio(
  percorso: string,
  titolare: Titolare,
): Promise<EsitoCaricamento> {
  const file = await elencaFile(percorso);
  const fatture: FatturaClassificata[] = [];
  const scartati: { file: string; motivo: string }[] = [];
  const viste = new Set<string>();

  const aggiungi = (estratte: Fattura[], nomeFile: string) => {
    for (const fattura of estratte) {
      const impronta = [
        fattura.cedente.chiave,
        fattura.tipoDocumento,
        fattura.numero,
        fattura.data,
      ].join("|");
      if (viste.has(impronta)) continue;
      viste.add(impronta);
      fatture.push(classifica({ ...fattura, file: nomeFile }, titolare));
    }
  };

  for (const percorsoFile of file) {
    const estensione = extname(percorsoFile).toLowerCase();
    const nome = basename(percorsoFile);
    try {
      if (estensione === ".zip") {
        const contenuti = leggiZip(await readFile(percorsoFile));
        let trovate = 0;
        for (const voce of contenuti) {
          const estensioneVoce = extname(voce.nome).toLowerCase();
          if (!ESTENSIONI_FATTURA.has(estensioneVoce)) continue;
          const xml =
            estensioneVoce === ".p7m"
              ? estraiDaP7m(voce.dati)
              : voce.dati.toString("utf8");
          if (!xml) continue;
          try {
            aggiungi(parseFatturaXml(xml, `${nome}:${voce.nome}`), `${nome}:${voce.nome}`);
            trovate++;
          } catch {
            // Il file dentro lo ZIP non è una fattura (es. metadati, notifiche).
          }
        }
        if (trovate === 0) {
          scartati.push({ file: nome, motivo: "ZIP senza fatture riconoscibili" });
        }
      } else if (ESTENSIONI_FATTURA.has(estensione)) {
        const dati = await readFile(percorsoFile);
        const xml = estensione === ".p7m" ? estraiDaP7m(dati) : dati.toString("utf8");
        if (!xml) {
          scartati.push({ file: nome, motivo: "impossibile estrarre l'XML dalla busta firmata" });
          continue;
        }
        aggiungi(parseFatturaXml(xml, nome), nome);
      }
      // Gli altri file (PDF, notifiche, metadati) non sono errori: si ignorano.
    } catch (errore) {
      scartati.push({
        file: nome,
        motivo: errore instanceof Error ? errore.message : String(errore),
      });
    }
  }

  fatture.sort((a, b) => a.data.localeCompare(b.data) || a.numero.localeCompare(b.numero));
  return { fatture, scartati, fileEsaminati: file.length };
}
