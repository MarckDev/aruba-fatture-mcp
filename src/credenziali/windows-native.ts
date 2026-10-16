/**
 * Chiamate native a Windows tramite koffi: chiave Windows Hello (Microsoft
 * Passport Key Storage Provider, via NCrypt) e finestra credenziali (CredUI).
 *
 * È l'unico modulo che usa koffi, e lo importa dinamicamente: il server parte
 * anche dove koffi non c'è o non serve (Linux, macOS, modalità variabili
 * d'ambiente). I valori (formato del nome chiave, proprietà, padding, codici
 * d'errore) vengono dalla prova reale annotata in
 * docs/superpowers/notes/2026-10-16-spike-windows-hello.md.
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import {
  ChiaveHelloMancanteError,
  HelloNonDisponibileError,
  SbloccoAnnullatoError,
  VaultIllegibileError,
  type Credenziali,
} from "./tipi.js";
import type { ChiaveHello } from "./vault.js";

type Koffi = typeof import("koffi");
type Funzione = ((...args: any[]) => any) & { async: (...args: any[]) => void };

const PROVIDER_PASSPORT = "Microsoft Passport Key Storage Provider";
const NOME_CHIAVE = "aruba-fatture-mcp/credenziali/v1";

const NTE_NO_KEY = 0x8009000d;
const NTE_NOT_FOUND = 0x80090011;
const NTE_BAD_KEYSET = 0x80090016;
const NTE_EXISTS = 0x8009000f;
const NTE_USER_CANCELLED = 0x80090036;
const SCARD_W_CANCELLED_BY_USER = 0x8010006e;
const NCRYPT_PAD_PKCS1_FLAG = 0x2;
const NCRYPT_ALLOW_ALL_USAGES = 0x00ffffff;
const NCRYPT_NGC_CACHE_TYPE_AUTH_MANDATORY = 1;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const CREDUIWIN_GENERIC = 0x1;
const CRED_PACK_GENERIC_CREDENTIALS = 0x4;
const ERROR_CANCELLED = 1223;
const ERROR_LOGON_FAILURE = 1326;

/** Esegue la funzione nativa su un worker thread: il ciclo degli eventi non si blocca. */
function asincrona<T>(fn: Funzione, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (errore: unknown, risultato: T) => (errore ? reject(errore) : resolve(risultato)));
  });
}

const esadecimale = (hr: number) => "0x" + (hr >>> 0).toString(16).padStart(8, "0");
const annullato = (hr: number) =>
  hr >>> 0 === NTE_USER_CANCELLED || hr >>> 0 === SCARD_W_CANCELLED_BY_USER;

/**
 * La prova ha mostrato NTE_NO_KEY dopo l'eliminazione della chiave; dopo una
 * reimpostazione del PIN di Windows il contenitore Hello viene ricreato e può
 * rispondere anche con gli altri due codici.
 */
export function chiaveMancante(hr: number): boolean {
  const codice = hr >>> 0;
  return codice === NTE_NO_KEY || codice === NTE_NOT_FOUND || codice === NTE_BAD_KEYSET;
}

/**
 * Verifica una firma RSA SHA-256 PKCS#1 v1.5 con la chiave pubblica esportata
 * da Windows come BCRYPT_RSAPUBLIC_BLOB. Il Passport KSP non supporta
 * NCryptVerifySignature (risponde 0x80090029), ma esporta la chiave pubblica
 * senza chiedere conferma.
 */
export function verificaFirmaConBlob(blob: Buffer, dati: Buffer, firma: Buffer): boolean {
  // Intestazione: Magic "RSA1", BitLength, cbPublicExp, cbModulus, cbPrime1,
  // cbPrime2; seguono esponente e modulo big-endian.
  const lunghezzaEsponente = blob.length >= 24 ? blob.readUInt32LE(8) : 0;
  const lunghezzaModulo = blob.length >= 24 ? blob.readUInt32LE(12) : 0;
  if (
    blob.subarray(0, 4).toString("ascii") !== "RSA1" ||
    lunghezzaEsponente === 0 ||
    lunghezzaModulo === 0 ||
    blob.length < 24 + lunghezzaEsponente + lunghezzaModulo
  ) {
    throw new Error("Windows Hello: la chiave esportata non è una chiave pubblica RSA.");
  }
  const e = blob.subarray(24, 24 + lunghezzaEsponente);
  const n = blob.subarray(24 + lunghezzaEsponente, 24 + lunghezzaEsponente + lunghezzaModulo);
  const chiave = createPublicKey({
    key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") },
    format: "jwk",
  });
  return verify("sha256", dati, chiave, firma);
}

/** null se la firma è riuscita, altrimenti l'errore da mostrare. */
export function erroreFirma(hr: number): Error | null {
  if (hr === 0) return null;
  if (annullato(hr)) return new SbloccoAnnullatoError();
  if (chiaveMancante(hr)) return new ChiaveHelloMancanteError();
  return new Error(`Windows Hello: firma delle credenziali non riuscita (${esadecimale(hr)}).`);
}

/** null se la decifratura è riuscita, altrimenti l'errore da mostrare. */
export function erroreDecifratura(hr: number): Error | null {
  if (hr === 0) return null;
  if (annullato(hr)) return new SbloccoAnnullatoError();
  if (chiaveMancante(hr)) return new ChiaveHelloMancanteError();
  // Ad esempio un vault cifrato con una chiave diversa da quella attuale:
  // senza reset non se ne esce, quindi va indicato come farlo.
  return new VaultIllegibileError(`decifratura non riuscita ${esadecimale(hr)}`);
}

interface Binding {
  koffi: Koffi;
  NCryptOpenStorageProvider: Funzione;
  NCryptCreatePersistedKey: Funzione;
  NCryptOpenKey: Funzione;
  NCryptSetProperty: Funzione;
  NCryptFinalizeKey: Funzione;
  NCryptEncrypt: Funzione;
  NCryptDecrypt: Funzione;
  NCryptSignHash: Funzione;
  NCryptExportKey: Funzione;
  NCryptDeleteKey: Funzione;
  NCryptFreeObject: Funzione;
  OpenProcessToken: Funzione;
  GetTokenInformation: Funzione;
  ConvertSidToStringSidW: Funzione;
  LocalFree: Funzione;
  CloseHandle: Funzione;
  GetForegroundWindow: Funzione;
  CredUIPromptForWindowsCredentialsW: Funzione;
  CredPackAuthenticationBufferW: Funzione;
  CredUnPackAuthenticationBufferW: Funzione;
  CoTaskMemFree: Funzione;
}

let binding: Promise<Binding> | null = null;

/** Carica koffi e dichiara le funzioni una sola volta per processo. */
function caricaBinding(): Promise<Binding> {
  binding ??= (async () => {
    if (process.platform !== "win32") {
      throw new HelloNonDisponibileError("Windows Hello è disponibile solo su Windows");
    }
    let koffi: Koffi;
    try {
      const modulo = (await import("koffi")) as Koffi & { default?: Koffi };
      koffi = modulo.default ?? modulo;
    } catch (errore) {
      throw new HelloNonDisponibileError(
        `libreria koffi non caricabile: ${errore instanceof Error ? errore.message : String(errore)}`,
      );
    }
    const ncrypt = koffi.load("ncrypt.dll");
    const advapi = koffi.load("advapi32.dll");
    const kernel = koffi.load("kernel32.dll");
    const user32 = koffi.load("user32.dll");
    const credui = koffi.load("credui.dll");
    const ole32 = koffi.load("ole32.dll");

    koffi.struct("BCRYPT_PKCS1_PADDING_INFO", { pszAlgId: "const char16_t *" });
    koffi.struct("CREDUI_INFOW", {
      cbSize: "uint32_t",
      hwndParent: "void *",
      pszMessageText: "const char16_t *",
      pszCaptionText: "const char16_t *",
      hbmBanner: "void *",
    });

    const crypt = "int32_t __stdcall";
    const f = (lib: ReturnType<Koffi["load"]>, firma: string) => lib.func(firma) as Funzione;
    return {
      koffi,
      NCryptOpenStorageProvider: f(ncrypt, `${crypt} NCryptOpenStorageProvider(_Out_ uintptr_t *ph, const char16_t *name, uint32_t flags)`),
      NCryptCreatePersistedKey: f(ncrypt, `${crypt} NCryptCreatePersistedKey(uintptr_t hProv, _Out_ uintptr_t *phKey, const char16_t *alg, const char16_t *name, uint32_t spec, uint32_t flags)`),
      NCryptOpenKey: f(ncrypt, `${crypt} NCryptOpenKey(uintptr_t hProv, _Out_ uintptr_t *phKey, const char16_t *name, uint32_t spec, uint32_t flags)`),
      NCryptSetProperty: f(ncrypt, `${crypt} NCryptSetProperty(uintptr_t h, const char16_t *prop, const uint8_t *buf, uint32_t len, uint32_t flags)`),
      NCryptFinalizeKey: f(ncrypt, `${crypt} NCryptFinalizeKey(uintptr_t hKey, uint32_t flags)`),
      NCryptEncrypt: f(ncrypt, `${crypt} NCryptEncrypt(uintptr_t hKey, const uint8_t *in, uint32_t cbIn, void *pad, _Out_ uint8_t *out, uint32_t cbOut, _Out_ uint32_t *pcb, uint32_t flags)`),
      NCryptDecrypt: f(ncrypt, `${crypt} NCryptDecrypt(uintptr_t hKey, const uint8_t *in, uint32_t cbIn, void *pad, _Out_ uint8_t *out, uint32_t cbOut, _Out_ uint32_t *pcb, uint32_t flags)`),
      NCryptSignHash: f(ncrypt, `${crypt} NCryptSignHash(uintptr_t hKey, BCRYPT_PKCS1_PADDING_INFO *pad, const uint8_t *hash, uint32_t cbHash, _Out_ uint8_t *sig, uint32_t cbSig, _Out_ uint32_t *pcb, uint32_t flags)`),
      NCryptExportKey: f(ncrypt, `${crypt} NCryptExportKey(uintptr_t hKey, uintptr_t hExportKey, const char16_t *type, void *params, _Out_ uint8_t *out, uint32_t cbOut, _Out_ uint32_t *pcb, uint32_t flags)`),
      NCryptDeleteKey: f(ncrypt, `${crypt} NCryptDeleteKey(uintptr_t hKey, uint32_t flags)`),
      NCryptFreeObject: f(ncrypt, `${crypt} NCryptFreeObject(uintptr_t h)`),
      OpenProcessToken: f(advapi, "bool __stdcall OpenProcessToken(uintptr_t proc, uint32_t access, _Out_ uintptr_t *tok)"),
      GetTokenInformation: f(advapi, "bool __stdcall GetTokenInformation(uintptr_t tok, int cls, _Out_ uint8_t *buf, uint32_t len, _Out_ uint32_t *ret)"),
      ConvertSidToStringSidW: f(advapi, "bool __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **str)"),
      LocalFree: f(kernel, "void * __stdcall LocalFree(void *p)"),
      CloseHandle: f(kernel, "bool __stdcall CloseHandle(uintptr_t h)"),
      GetForegroundWindow: f(user32, "void * __stdcall GetForegroundWindow()"),
      CredUIPromptForWindowsCredentialsW: f(credui, "uint32_t __stdcall CredUIPromptForWindowsCredentialsW(CREDUI_INFOW *info, uint32_t authError, _Inout_ uint32_t *authPackage, const uint8_t *inBuf, uint32_t inSize, _Out_ void **outBuf, _Out_ uint32_t *outSize, _Inout_ int *save, uint32_t flags)"),
      CredPackAuthenticationBufferW: f(credui, "bool __stdcall CredPackAuthenticationBufferW(uint32_t flags, const char16_t *user, const char16_t *password, _Out_ uint8_t *packed, _Inout_ uint32_t *size)"),
      CredUnPackAuthenticationBufferW: f(credui, "bool __stdcall CredUnPackAuthenticationBufferW(uint32_t flags, void *buf, uint32_t size, _Out_ uint8_t *user, _Inout_ uint32_t *maxUser, _Out_ uint8_t *domain, _Inout_ uint32_t *maxDomain, _Out_ uint8_t *password, _Inout_ uint32_t *maxPassword)"),
      CoTaskMemFree: f(ole32, "void __stdcall CoTaskMemFree(void *p)"),
    };
  })();
  // Un fallimento non va memorizzato per sempre: al prossimo tentativo si riprova.
  binding.catch(() => {
    binding = null;
  });
  return binding;
}

function sidUtente(b: Binding): string {
  const token = [0];
  if (!b.OpenProcessToken(-1, TOKEN_QUERY, token)) throw new HelloNonDisponibileError("OpenProcessToken");
  try {
    const buf = Buffer.alloc(256);
    const lunghezza = [0];
    if (!b.GetTokenInformation(token[0], TOKEN_USER, buf, buf.length, lunghezza)) {
      throw new HelloNonDisponibileError("GetTokenInformation");
    }
    // TOKEN_USER inizia con il puntatore al SID.
    const sid = buf.readBigUInt64LE(0);
    const testo = [null];
    if (!b.ConvertSidToStringSidW(sid, testo)) throw new HelloNonDisponibileError("ConvertSidToStringSidW");
    const risultato = b.koffi.decode.string16(testo[0]);
    b.LocalFree(testo[0]);
    return risultato;
  } finally {
    b.CloseHandle(token[0]);
  }
}

const utf16z = (testo: string) => Buffer.from(testo + "\0", "utf16le");

function dword(valore: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(valore);
  return b;
}

class ChiaveHelloWindows implements ChiaveHello {
  constructor(
    private readonly b: Binding,
    private readonly provider: number,
    private readonly nome: string,
    private readonly contesto: string,
    private readonly contestoFirma: string,
  ) {}

  /** Apre la chiave; null se non esiste. */
  private apri(): number | null {
    const chiave = [0];
    const hr = this.b.NCryptOpenKey(this.provider, chiave, this.nome, 0, 0);
    if (chiaveMancante(hr)) return null;
    if (hr !== 0) throw new HelloNonDisponibileError(`apertura chiave ${esadecimale(hr)}`);
    return chiave[0];
  }

  /** Finestra di Hello davanti a quella attiva, con un testo che spiega cosa si sblocca. */
  private preparaFinestra(chiave: number, contesto = this.contesto): void {
    const hwnd = Buffer.alloc(8);
    hwnd.writeBigUInt64LE(BigInt(this.b.GetForegroundWindow() ?? 0));
    this.b.NCryptSetProperty(chiave, "HWND Handle", hwnd, hwnd.length, 0);
    const testo = utf16z(contesto);
    this.b.NCryptSetProperty(chiave, "Use Context", testo, testo.length, 0);
  }

  async esiste(): Promise<boolean> {
    const chiave = this.apri();
    if (chiave === null) return false;
    this.b.NCryptFreeObject(chiave);
    return true;
  }

  async crea(): Promise<void> {
    if (await this.esiste()) return;
    const chiave = [0];
    const hr = this.b.NCryptCreatePersistedKey(this.provider, chiave, "RSA", this.nome, 0, 0);
    if (hr >>> 0 === NTE_EXISTS) return;
    if (hr !== 0) throw new HelloNonDisponibileError(`creazione chiave ${esadecimale(hr)}`);
    try {
      this.b.NCryptSetProperty(chiave[0], "Length", dword(2048), 4, 0);
      this.b.NCryptSetProperty(chiave[0], "Key Usage", dword(NCRYPT_ALLOW_ALL_USAGES), 4, 0);
      // Conferma a ogni uso: senza, Windows può riusare uno sblocco recente.
      const cache = dword(NCRYPT_NGC_CACHE_TYPE_AUTH_MANDATORY);
      if (this.b.NCryptSetProperty(chiave[0], "NgcCacheType", cache, 4, 0) !== 0) {
        this.b.NCryptSetProperty(chiave[0], "NgcCacheTypeProperty_Deprecated", cache, 4, 0);
      }
      this.preparaFinestra(chiave[0]);
      const fin = await asincrona<number>(this.b.NCryptFinalizeKey, chiave[0], 0);
      if (annullato(fin)) throw new SbloccoAnnullatoError();
      if (fin >>> 0 === NTE_EXISTS) return;
      if (fin !== 0) throw new HelloNonDisponibileError(`finalizzazione chiave ${esadecimale(fin)}`);
    } finally {
      this.b.NCryptFreeObject(chiave[0]);
    }
  }

  async cifra(dati: Buffer): Promise<Buffer> {
    const chiave = this.apri();
    if (chiave === null) throw new ChiaveHelloMancanteError();
    try {
      const uscita = Buffer.alloc(512);
      const n = [0];
      const hr = this.b.NCryptEncrypt(chiave, dati, dati.length, null, uscita, uscita.length, n, NCRYPT_PAD_PKCS1_FLAG);
      if (hr !== 0) throw new Error(`Windows Hello: cifratura non riuscita (${esadecimale(hr)}).`);
      return Buffer.from(uscita.subarray(0, n[0]));
    } finally {
      this.b.NCryptFreeObject(chiave);
    }
  }

  async decifra(dati: Buffer): Promise<Buffer> {
    const chiave = this.apri();
    if (chiave === null) throw new ChiaveHelloMancanteError();
    const uscita = Buffer.alloc(512);
    try {
      this.preparaFinestra(chiave);
      const n = [0];
      const hr = await asincrona<number>(
        this.b.NCryptDecrypt,
        chiave, dati, dati.length, null, uscita, uscita.length, n, NCRYPT_PAD_PKCS1_FLAG,
      );
      const errore = erroreDecifratura(hr);
      if (errore) throw errore;
      return Buffer.from(uscita.subarray(0, n[0]));
    } finally {
      uscita.fill(0);
      this.b.NCryptFreeObject(chiave);
    }
  }

  async firma(dati: Buffer): Promise<Buffer> {
    const chiave = this.apri();
    if (chiave === null) throw new ChiaveHelloMancanteError();
    try {
      // Testo diverso dallo sblocco: una richiesta di salvataggio inattesa si riconosce.
      this.preparaFinestra(chiave, this.contestoFirma);
      const hash = createHash("sha256").update(dati).digest();
      const firma = Buffer.alloc(512);
      const n = [0];
      const hr = await asincrona<number>(
        this.b.NCryptSignHash,
        chiave, { pszAlgId: "SHA256" }, hash, hash.length, firma, firma.length, n, NCRYPT_PAD_PKCS1_FLAG,
      );
      const errore = erroreFirma(hr);
      if (errore) throw errore;
      return Buffer.from(firma.subarray(0, n[0]));
    } finally {
      this.b.NCryptFreeObject(chiave);
    }
  }

  async verificaFirma(dati: Buffer, firma: Buffer): Promise<boolean> {
    const chiave = this.apri();
    if (chiave === null) throw new ChiaveHelloMancanteError();
    try {
      const blob = Buffer.alloc(1024);
      const n = [0];
      const hr = this.b.NCryptExportKey(chiave, 0, "RSAPUBLICBLOB", null, blob, blob.length, n, 0);
      if (chiaveMancante(hr)) throw new ChiaveHelloMancanteError();
      if (hr !== 0) throw new Error(`Windows Hello: esportazione della chiave pubblica non riuscita (${esadecimale(hr)}).`);
      return verificaFirmaConBlob(blob.subarray(0, n[0]), dati, firma);
    } finally {
      this.b.NCryptFreeObject(chiave);
    }
  }

  async elimina(): Promise<boolean> {
    const chiave = this.apri();
    if (chiave === null) return false;
    // NCryptDeleteKey libera anche l'handle.
    const hr = this.b.NCryptDeleteKey(chiave, 0);
    if (hr !== 0) throw new Error(`Windows Hello: eliminazione della chiave non riuscita (${esadecimale(hr)}).`);
    return true;
  }
}

/** `contesto` e `contestoFirma` sono i testi mostrati da Windows Hello per sblocco e salvataggio. */
export async function creaChiaveHelloWindows(opz: {
  contesto: string;
  contestoFirma: string;
}): Promise<ChiaveHello> {
  const b = await caricaBinding();
  const provider = [0];
  const hr = b.NCryptOpenStorageProvider(provider, PROVIDER_PASSPORT, 0);
  if (hr !== 0) throw new HelloNonDisponibileError(`provider ${esadecimale(hr)}`);
  // Il formato "<SID>//dominio/nome" è quello richiesto per le chiavi Hello.
  return new ChiaveHelloWindows(
    b,
    provider[0],
    `${sidUtente(b)}//${NOME_CHIAVE}`,
    opz.contesto,
    opz.contestoFirma,
  );
}

/** Finestra credenziali nativa di Windows. null = annullata. */
export async function chiediCredenzialiWindows(opz: {
  titolo: string;
  messaggio: string;
  messaggioErrore?: string;
  usernameSuggerito?: string;
}): Promise<Credenziali | null> {
  const b = await caricaBinding();

  // Lo username suggerito si passa come buffer di credenziali "impacchettato".
  let ingresso: Buffer | null = null;
  if (opz.usernameSuggerito) {
    const dimensione = [0];
    b.CredPackAuthenticationBufferW(CRED_PACK_GENERIC_CREDENTIALS, opz.usernameSuggerito, "", null, dimensione);
    ingresso = Buffer.alloc(dimensione[0]);
    if (!b.CredPackAuthenticationBufferW(CRED_PACK_GENERIC_CREDENTIALS, opz.usernameSuggerito, "", ingresso, dimensione)) {
      ingresso = null;
    }
  }

  const info = {
    cbSize: b.koffi.sizeof("CREDUI_INFOW"),
    hwndParent: b.GetForegroundWindow(),
    pszMessageText: opz.messaggioErrore ? `${opz.messaggioErrore}\n\n${opz.messaggio}` : opz.messaggio,
    pszCaptionText: opz.titolo,
    hbmBanner: null,
  };
  const pacchetto = [0];
  const uscita: unknown[] = [null];
  const dimensioneUscita = [0];
  const salva = [0];
  const esito = await asincrona<number>(
    b.CredUIPromptForWindowsCredentialsW,
    info,
    opz.messaggioErrore ? ERROR_LOGON_FAILURE : 0,
    pacchetto,
    ingresso,
    ingresso?.length ?? 0,
    uscita,
    dimensioneUscita,
    salva,
    CREDUIWIN_GENERIC,
  );
  if (esito === ERROR_CANCELLED) return null;
  if (esito !== 0) throw new Error(`Finestra delle credenziali non riuscita (errore ${esito}).`);

  const utente = Buffer.alloc(1028);
  const dominio = Buffer.alloc(1028);
  const password = Buffer.alloc(1028);
  try {
    const maxUtente = [utente.length / 2];
    const maxDominio = [dominio.length / 2];
    const maxPassword = [password.length / 2];
    const ok = b.CredUnPackAuthenticationBufferW(
      0, uscita[0], dimensioneUscita[0], utente, maxUtente, dominio, maxDominio, password, maxPassword,
    );
    if (!ok) throw new Error("Lettura delle credenziali inserite non riuscita.");
    const testo = (buf: Buffer, caratteri: number) =>
      buf.toString("utf16le", 0, caratteri * 2).replace(/\0.*$/s, "");
    return { username: testo(utente, maxUtente[0]), password: testo(password, maxPassword[0]) };
  } finally {
    // Il buffer restituito da CredUI contiene la password in chiaro.
    b.koffi.encode(uscita[0], b.koffi.array("uint8_t", dimensioneUscita[0]), Buffer.alloc(dimensioneUscita[0]));
    b.CoTaskMemFree(uscita[0]);
    utente.fill(0);
    dominio.fill(0);
    password.fill(0);
  }
}
