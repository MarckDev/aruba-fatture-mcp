/**
 * Vault su file delle credenziali Aruba.
 *
 * Username e password sono cifrati con una chiave AES-256-GCM casuale; la
 * chiave AES è a sua volta cifrata con la chiave pubblica di una chiave
 * Windows Hello. Il file contiene tutto il necessario per decifrare tranne la
 * chiave privata, che resta nel TPM e si usa solo dopo la conferma
 * dell'utente.
 *
 * Il file è anche firmato con la stessa chiave Hello. Cifrare con la chiave
 * pubblica non richiede conferma, quindi senza firma un programma che gira con
 * l'utente potrebbe sostituire il file con credenziali di un altro account
 * Aruba; firmare invece richiede Windows Hello. La firma si verifica prima di
 * chiedere la conferma per decifrare.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FirmaNonValidaError, VaultIllegibileError, type Credenziali } from "./tipi.js";

export interface ChiaveHello {
  esiste(): Promise<boolean>;
  /** Chiede Windows Hello; non fallisce se la chiave esiste già. */
  crea(): Promise<void>;
  /** Usa la chiave pubblica: nessuna conferma richiesta. */
  cifra(dati: Buffer): Promise<Buffer>;
  /** Chiede Windows Hello. Lancia ChiaveHelloMancanteError o SbloccoAnnullatoError. */
  decifra(dati: Buffer): Promise<Buffer>;
  /** Chiede Windows Hello (testo diverso dallo sblocco). Lancia SbloccoAnnullatoError. */
  firma(dati: Buffer): Promise<Buffer>;
  /** Usa la chiave pubblica: nessuna conferma richiesta. */
  verificaFirma(dati: Buffer, firma: Buffer): Promise<boolean>;
  /** false se la chiave non esisteva. */
  elimina(): Promise<boolean>;
}

export const VERSIONE_VAULT = 2;

// Lega il testo cifrato a questo formato: un blob preso da un altro contesto
// non supera la verifica del tag.
const AAD = Buffer.from("aruba-fatture-mcp/vault/v1");

interface FileVault {
  versione: number;
  chiaveCifrata: string;
  iv: string;
  tag: string;
  dati: string;
  firma: string;
}

const CAMPI_FIRMATI = ["chiaveCifrata", "iv", "tag", "dati"] as const;

/** Byte firmati: tutti i campi tranne la firma, in un ordine fisso. */
function contenutoFirmato(contenuto: Omit<FileVault, "firma">): Buffer {
  return Buffer.from(
    JSON.stringify([contenuto.versione, ...CAMPI_FIRMATI.map((campo) => contenuto[campo])]),
    "utf8",
  );
}

/**
 * Fuori da AppData di proposito: Claude Desktop è un pacchetto MSIX e Windows
 * può reindirizzare le scritture in AppData dei processi che avvia in una
 * cartella privata, invisibile al terminale da cui si lancia il reset.
 */
export function percorsoVault(home: string = homedir()): string {
  return join(home, ".aruba-fatture-mcp", "credenziali.json");
}

export async function salvaCredenziali(
  percorso: string,
  cred: Credenziali,
  chiave: ChiaveHello,
): Promise<void> {
  const chiaveAes = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chiaveAes, iv);
  cipher.setAAD(AAD);
  const dati = Buffer.concat([
    cipher.update(JSON.stringify({ username: cred.username, password: cred.password }), "utf8"),
    cipher.final(),
  ]);
  const daFirmare = {
    versione: VERSIONE_VAULT,
    chiaveCifrata: (await chiave.cifra(chiaveAes)).toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    dati: dati.toString("base64"),
  };
  chiaveAes.fill(0);
  const contenuto: FileVault = {
    ...daFirmare,
    firma: (await chiave.firma(contenutoFirmato(daFirmare))).toString("base64"),
  };

  // Scrittura atomica: due processi del server possono salvare insieme al
  // primo avvio, e nessuno dei due deve mai leggere un file a metà.
  await mkdir(dirname(percorso), { recursive: true });
  const temporaneo = `${percorso}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporaneo, JSON.stringify(contenuto), { mode: 0o600 });
    await rename(temporaneo, percorso);
  } catch (errore) {
    await rm(temporaneo, { force: true });
    throw errore;
  }
}

export async function leggiCredenziali(
  percorso: string,
  chiave: ChiaveHello,
): Promise<Credenziali | null> {
  let testo: string;
  try {
    testo = await readFile(percorso, "utf8");
  } catch (errore) {
    if ((errore as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw errore;
  }

  const contenuto = analizza(testo);
  const firmaValida = await chiave.verificaFirma(
    contenutoFirmato(contenuto),
    Buffer.from(contenuto.firma, "base64"),
  );
  if (!firmaValida) throw new FirmaNonValidaError();

  const chiaveAes = await chiave.decifra(Buffer.from(contenuto.chiaveCifrata, "base64"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", chiaveAes, Buffer.from(contenuto.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(contenuto.tag, "base64"));
    const chiaro = Buffer.concat([
      decipher.update(Buffer.from(contenuto.dati, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const cred = JSON.parse(chiaro) as Partial<Credenziali>;
    if (typeof cred.username !== "string" || typeof cred.password !== "string") {
      throw new Error("contenuto inatteso");
    }
    return { username: cred.username, password: cred.password };
  } catch {
    // Non si riporta il motivo: potrebbe contenere frammenti del testo in chiaro.
    throw new VaultIllegibileError("dati alterati o chiave errata");
  } finally {
    chiaveAes.fill(0);
  }
}

export async function cancellaVault(
  percorso: string,
  chiave: ChiaveHello,
): Promise<{ fileRimosso: boolean; chiaveRimossa: boolean }> {
  let fileRimosso = true;
  try {
    await rm(percorso);
  } catch (errore) {
    if ((errore as NodeJS.ErrnoException).code !== "ENOENT") throw errore;
    fileRimosso = false;
  }
  const chiaveRimossa = await chiave.elimina();
  return { fileRimosso, chiaveRimossa };
}

function analizza(testo: string): FileVault {
  let contenuto: Partial<FileVault>;
  try {
    contenuto = JSON.parse(testo);
  } catch {
    throw new VaultIllegibileError("JSON non valido");
  }
  // Il formato 1 non era firmato: accettarlo anche una sola volta per migrarlo
  // vanificherebbe la firma, perché chiunque potrebbe scriverne uno.
  if (contenuto.versione === 1) throw new FirmaNonValidaError();
  if (contenuto.versione !== VERSIONE_VAULT) {
    throw new VaultIllegibileError(`versione del formato non supportata: ${String(contenuto.versione)}`);
  }
  for (const campo of CAMPI_FIRMATI) {
    if (typeof contenuto[campo] !== "string") {
      throw new VaultIllegibileError(`campo mancante: ${campo}`);
    }
  }
  if (typeof contenuto.firma !== "string") throw new FirmaNonValidaError();
  return contenuto as FileVault;
}
