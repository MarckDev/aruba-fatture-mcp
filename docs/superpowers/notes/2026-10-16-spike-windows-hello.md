# Spike Windows Hello con koffi — esito

Data: 2026-10-16. Macchina: Windows 11 (build 26300), Node 22.23.1 per Windows,
koffi 3.3.2 (`@koromix/koffi-win32-x64`). Conferme fatte dall'utente al PC.

**Esito: il Microsoft Passport KSP funziona da Node via koffi.** La chiave creata
da un processo è usata da processi successivi (ogni comando era un processo
separato).

## Valori per il Task 7

- **Provider:** `NCryptOpenStorageProvider(..., "Microsoft Passport Key Storage Provider", 0)`.
- **Nome chiave:** `<SID>//aruba-fatture-mcp/credenziali/v1`. Il formato
  `<SID>//dominio/sotto/nome` è accettato.
  - SID ottenuto con `OpenProcessToken(-1, TOKEN_QUERY=0x8)`,
    `GetTokenInformation(TokenUser=1)` (puntatore al SID nei primi 8 byte del
    buffer), `ConvertSidToStringSidW`, `koffi.decode.string16`, `LocalFree`.
- **Creazione:**
  - `NCryptCreatePersistedKey(prov, out, "RSA", nome, 0, 0)`;
  - proprietà:
    - `"Length"` = 2048 (DWORD);
    - `"Key Usage"` = `0x00ffffff`;
    - `"NgcCacheType"` = 1 (autenticazione obbligatoria a ogni uso; accettata con
      `0x0`);
    - `"HWND Handle"` = `GetForegroundWindow()` (8 byte);
    - `"Use Context"` = testo UTF-16 con terminatore;
  - poi `NCryptFinalizeKey` asincrona: compare Hello, circa 6,5 s con conferma.
- **Padding:**
  - **OAEP SHA-256 rifiutato** da `NCryptEncrypt` con `0x80090027`
    (NTE_INVALID_PARAMETER);
  - **PKCS#1 (`NCRYPT_PAD_PKCS1_FLAG` = 0x2, padding info `null`) funziona**:
    256 byte di output per 32 byte di chiave AES.
- **`NCryptEncrypt` con la chiave pubblica non mostra finestre** (97 ms).
- **`NCryptDecrypt`:**
  - asincrona; prima vanno impostati `"HWND Handle"` e `"Use Context"` sulla
    chiave aperta;
  - compare Hello e restituisce la chiave identica all'originale;
  - Windows non tiene in memoria lo sblocco: una seconda decifratura subito
    dopo ripropone Hello.
- **Codici HRESULT osservati:**
  - `0x8009000D` NTE_NO_KEY: `NCryptOpenKey` su chiave inesistente o eliminata,
    → `ChiaveHelloMancanteError`;
  - `0x80090036` NTE_USER_CANCELLED: Hello annullato in `NCryptDecrypt`,
    → `SbloccoAnnullatoError`. Va trattato allo stesso modo anche in
    `NCryptFinalizeKey`;
  - `0x80090027` NTE_INVALID_PARAMETER: padding OAEP.
- **Codici NON osservati** (non riproducibili senza disattivare Hello o creare
  una chiave doppia):
  - `0x8009000F` NTE_EXISTS: atteso da `NCryptCreatePersistedKey` su un nome
    esistente; `crea()` deve trattarlo come successo, oppure controllare prima
    `esiste()`;
  - Hello non configurato: probabile errore all'apertura del provider o alla
    creazione (es. `0x80090029` NTE_NOT_SUPPORTED, `0x80090030`
    NTE_DEVICE_NOT_READY). Ogni errore diverso da quelli sopra, durante apertura
    provider o creazione, diventa `HelloNonDisponibileError` con il codice nel
    messaggio.
- **Eliminazione:** `NCryptOpenKey` + `NCryptDeleteKey(hKey, 0)` → `0x0` (la
  funzione libera anche l'handle).

## Binding koffi che hanno funzionato

```js
ncrypt.func("int32_t __stdcall NCryptOpenStorageProvider(_Out_ uintptr_t *ph, const char16_t *name, uint32_t flags)");
ncrypt.func("int32_t __stdcall NCryptCreatePersistedKey(uintptr_t hProv, _Out_ uintptr_t *phKey, const char16_t *alg, const char16_t *name, uint32_t spec, uint32_t flags)");
ncrypt.func("int32_t __stdcall NCryptOpenKey(uintptr_t hProv, _Out_ uintptr_t *phKey, const char16_t *name, uint32_t spec, uint32_t flags)");
ncrypt.func("int32_t __stdcall NCryptSetProperty(uintptr_t h, const char16_t *prop, const uint8_t *buf, uint32_t len, uint32_t flags)");
ncrypt.func("int32_t __stdcall NCryptFinalizeKey(uintptr_t hKey, uint32_t flags)");
ncrypt.func("int32_t __stdcall NCryptEncrypt(uintptr_t hKey, const uint8_t *in, uint32_t cbIn, void *pad, _Out_ uint8_t *out, uint32_t cbOut, _Out_ uint32_t *pcb, uint32_t flags)");
ncrypt.func("int32_t __stdcall NCryptDecrypt(...stessa firma...)");
ncrypt.func("int32_t __stdcall NCryptDeleteKey(uintptr_t hKey, uint32_t flags)");
ncrypt.func("int32_t __stdcall NCryptFreeObject(uintptr_t h)");
// Parametri di uscita primitivi: array di un elemento, es. const out = [0]; f(out); out[0]
// Chiamate asincrone: promisify(fn.async)(...args)
```

## Ancora da verificare

- **Finestra in primo piano:** il padre usato è `GetForegroundWindow()`, cioè il
  terminale. Da verificare con Claude Desktop nel Task 9.
- **Chiave usabile da un processo avviato da Claude Desktop (MSIX):** Task 9.
- **Account Aruba:** l'utente ha disattivato la 2FA il 2026-10-16, quindi la
  pagina OTP del pannello non è più osservabile sull'account reale. Il suo
  riconoscimento resta coperto dalle fixture del Task 4.

## Prova manuale del Task 7 (moduli compilati, copia Windows)

Eseguita il 2026-10-16 con l'utente al PC, da terminale, con lo script
`prova-task7.mjs` (fuori dal repository).

- **`chiediCredenzialiWindows`:** username suggerito `mario.rossi` restituito
  intatto, password `pà$$ wörd €` restituita identica (11 caratteri).
- **`creaChiaveHelloWindows`:**
  - `esiste()` false, poi `crea()` con conferma Hello, poi `esiste()` true;
  - `cifra` dà 256 byte senza finestre;
  - `decifra` con conferma restituisce i byte identici;
  - `crea()` su una chiave esistente non dà errore;
  - `decifra` annullata dà `SbloccoAnnullatoError`.
- **Eliminazione:** `elimina()` true, poi `decifra` dà
  `ChiaveHelloMancanteError`, poi `elimina()` false.
- **Primo piano delle finestre con Claude Desktop:** da verificare nel Task 9.

## Prova completa con Claude Desktop (Task 9)

Eseguita il 2026-10-16 su Windows 11. Claude Desktop è un pacchetto MSIX dello
Store, la copia di prova è `C:\Users\Simone\aruba-fatture-mcp-dev`, configurata
senza credenziali e con `ARUBA_ENVIRONMENT=production`.

- **Primo inserimento:** la finestra credenziali compare **davanti** a Claude
  Desktop.
  - Una password sbagliata fa riaprire la finestra con il messaggio d'errore e lo
    username già compilato.
  - Con la password corretta compare Windows Hello (creazione della chiave), poi
    le fatture vengono elencate.
- **Riavvio di Claude Desktop:** compare solo Windows Hello; tutto funziona.
- **Annullamento di Hello:** il tool lo segnala; alla richiesta successiva Hello
  ricompare e, confermato, il tool prosegue.
- **Conferma lenta (oltre 45 s):** il tool risponde di completare la finestra e
  riprovare; dopo la conferma la richiesta ripetuta prosegue.
- **Vault e chiave tra contesti diversi:**
  - il vault è in `C:\Users\Simone\.aruba-fatture-mcp\credenziali.json`, non
    reindirizzato nella cartella del pacchetto;
  - la chiave creata dal processo avviato da Claude Desktop è visibile anche al
    terminale (il reset senza credenziali risponde correttamente).
- **Nessun segreto in chiaro:**
  - nessun file `aruba-fatture-mcp-token-*` in `%TEMP%`;
  - nessuna occorrenza di token o password in `%USERPROFILE%\.aruba-fatture-mcp`,
    `%LOCALAPPDATA%\Claude` e `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc`;
  - le 61 corrispondenze in `%TEMP%` sono file temporanei di Office, precedenti e
    non legati ad Aruba;
  - il log MCP contiene solo le righe di avvio.
- **Modalità variabili d'ambiente su Windows:** invariata (avvio senza riga
  Hello).
- **Non eseguito:**
  - reset con credenziali vere (lasciato all'utente);
  - account con 2FA (disattivata dall'utente);
  - Windows Hello non configurato;
  - Windows 10 (lo farà l'utente).

## Firma del file (aggiunta)

Esito delle prove del 2026-10-16 con Claude Desktop, utente al PC.

- **Firma con il Passport KSP:** funziona.
  - Usa `NCryptSignHash` con `BCRYPT_PKCS1_PADDING_INFO { "SHA256" }` e flag
    0x2, in modo asincrono.
  - Mostra Windows Hello con il testo `Use Context` impostato per il
    salvataggio.
- **`NCryptVerifySignature` NON è supportata dal Passport KSP:** risponde
  `0x80090029` (NTE_NOT_SUPPORTED) sia con il padding info sia senza.
  - `NCryptExportKey(..., "RSAPUBLICBLOB", ...)` invece funziona senza
    conferma: 283 byte, magic `RSA1`, 2048 bit.
  - La firma si verifica in Node (`crypto.verify("sha256", ...)`) con la
    chiave pubblica ricavata dal blob.
- **Prove con Claude Desktop:**
  - file del formato 1: finestra credenziali con il messaggio "non è firmato o
    è stato modificato", una conferma Hello (firma), file del formato 2 salvato;
  - riavvio: una sola conferma Hello (sblocco);
  - file manomesso (un byte di `dati`): nessuna richiesta di sblocco, finestra
    credenziali con il messaggio, conferma Hello per il salvataggio, file
    firmato nuovo; poi tutto funziona.
