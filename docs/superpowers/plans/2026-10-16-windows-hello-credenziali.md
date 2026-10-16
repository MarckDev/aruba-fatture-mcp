# Credenziali protette da Windows Hello — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** su Windows, senza `ARUBA_USERNAME`/`ARUBA_PASSWORD` nell'ambiente, il
server MCP legge le credenziali Aruba da un file cifrato con una chiave Windows
Hello, chiedendole all'utente con una finestra nativa al primo uso.

**Architecture:** i due client (`ArubaClient`, `ArubaPanelClient`) non ricevono
più username e password, ma una `FonteCredenziali`. In modalità variabili
d'ambiente è una fonte statica, cioè il comportamento di oggi. In modalità Hello
è un `FornitoreHello`, che:
- decifra il vault con una chiave RSA del Microsoft Passport KSP;
- chiede le credenziali con CredUI, le verifica con il login del pannello e le
  salva;
- rispetta il limite di 45 secondi per chiamata.

Le API Windows si chiamano con koffi da un unico modulo, caricato dinamicamente.

**Tech Stack:** TypeScript 7 (`tsc`), Node ≥ 18 (sviluppo su Node 22),
`node:test`, `node:crypto` (AES-256-GCM), koffi 3.3.2 (NCrypt, CredUI,
advapi32, user32).

**Spec:** `docs/superpowers/specs/2026-10-16-windows-hello-credenziali-design.md`

## Global Constraints

- Una sola dipendenza nuova: `koffi` alla versione esatta `3.3.2` (niente `^`),
  bloccata nel `package-lock.json`. Nessuna dipendenza di test.
- koffi si importa solo con `await import("koffi")`, dentro
  `src/credenziali/windows-native.ts`, e solo su Windows in modalità Hello o
  reset.
- Nessun processo esterno: niente `child_process`, niente PowerShell.
- Password e token non vanno mai su disco in chiaro, nei log (stderr), negli
  argomenti o nell'output dei tool. In modalità Hello niente cache dei token in
  `%TEMP%`.
- Vault in `%USERPROFILE%\.aruba-fatture-mcp\credenziali.json`, cioè
  `join(os.homedir(), ".aruba-fatture-mcp", "credenziali.json")`.
- Attesa massima di un tool sullo sblocco: `45_000` ms.
- Massimo `3` password rifiutate per processo, contando insieme pannello e API.
- Le chiamate native bloccanti (finestre, decifratura) usano le chiamate
  asincrone di koffi (`fn.async(...)`): il ciclo degli eventi non si blocca mai.
- Con `ARUBA_USERNAME` e `ARUBA_PASSWORD` presenti il comportamento resta
  identico a oggi, compresa la cache dei token in `%TEMP%`.
- Testi utente in italiano, come il resto del progetto.
- I messaggi di commit terminano con le righe di attribuzione indicate dalla
  sessione (`Co-Authored-By`, `Claude-Session`).
- Commenti e stile come il codice esistente: commenti in italiano che spiegano
  il perché, nomi di dominio in italiano.
- Test: file `.mjs` in `test/unit/` che importano da `dist/`; si eseguono con
  `npm test`, che fa `tsc && node --test "test/unit/*.test.mjs"`.

## Review Focus

1. **Finestre dietro Claude Desktop:** CredUI e Hello devono comparire in primo
   piano. Si verifica a mano nel Task 9. Il Task 7 passa come finestra padre il
   risultato di `GetForegroundWindow()`.
2. **Password con caratteri non ASCII** (`è`, `€`, virgolette, spazi finali):
   devono sopravvivere al giro finestra → vault → login senza alterazioni. Test
   nel Task 3 (vault), verifica a mano nel Task 7 (conversione UTF-16).
3. **PIN di Windows reimpostato:** cancella le chiavi Hello mentre il vault
   resta. Va riconosciuto come "chiave mancante" e si ripete il primo
   inserimento, senza crash. Test nel Task 6.
4. **Password cambiata sul sito Aruba a server avviato:** un solo rifiuto e poi
   una nuova richiesta, mai un ciclo di login. Test nel Task 6, sul rifiuto
   segnalato dai client.
5. **Due processi del server al primo avvio insieme** (due finestre di Claude):
   il vault non deve mai risultare troncato. La scrittura è atomica
   (file temporaneo + `rename`), test nel Task 3; `crea()` su una chiave già
   esistente non deve fallire, Task 7.

---

### Task 1: Prova reale di Windows Hello con koffi (spike, serve l'utente al PC)

Esito vincolante: se il Passport KSP non funziona, **fermarsi e riportare
all'utente** (spec, "Lasciato al builder").

**Files:**
- Create: `docs/superpowers/notes/2026-10-16-spike-windows-hello.md`.
  Lo script di prova resta fuori dal repository, nella scratchpad.

**Interfaces:**
- Produces: le note con i valori che userà il Task 7:
  - formato del nome chiave (candidato: `<SID>//aruba-fatture-mcp/credenziali/v1`);
  - proprietà da impostare prima di `NCryptFinalizeKey`;
  - padding funzionante (prima OAEP SHA-256, poi PKCS#1);
  - se `NCryptEncrypt` con la chiave pubblica chiede conferma;
  - codici HRESULT per: annullamento, chiave inesistente, Hello non
    configurato, chiave già esistente.

- [ ] **Step 1: Installare koffi in una cartella Windows usa-e-getta**

  ```bash
  cmd.exe /c "mkdir %TEMP%\hello-spike & cd /d %TEMP%\hello-spike & npm init -y >nul & npm install koffi@3.3.2 --save-exact"
  ```

  Expected: `node_modules\@koromix\koffi-win32-x64` presente.
- [ ] **Step 2: Scrivere lo script di prova** `spike.mjs` nella stessa cartella.
  Deve:
  - ottenere il SID utente (`OpenProcessToken`, `GetTokenInformation(TokenUser)`,
    `ConvertSidToStringSidW`);
  - aprire `"Microsoft Passport Key Storage Provider"`;
  - con l'argomento `crea`:
    - `NCryptCreatePersistedKey` RSA 2048;
    - impostare `NCRYPT_WINDOW_HANDLE_PROPERTY` = `GetForegroundWindow()` e
      `NCRYPT_USE_CONTEXT_PROPERTY` = testo di prova;
    - `NCryptFinalizeKey`;
  - con l'argomento `cifra`: `NCryptEncrypt` di 32 byte casuali e scrittura su
    `blob.bin`;
  - con l'argomento `decifra`: `NCryptOpenKey`, poi `NCryptDecrypt` di
    `blob.bin`, e confronto con i byte originali salvati;
  - con l'argomento `elimina`: `NCryptDeleteKey`.

  Usare `fn.async` per `NCryptFinalizeKey` e `NCryptDecrypt`.
- [ ] **Step 3: Eseguire con l'utente al PC**, in sequenza, ogni comando in un
  processo separato (verifica anche l'uso della chiave tra processi diversi):
  `node spike.mjs crea`, `cifra`, `decifra` (confermare con impronta), di nuovo
  `decifra` annullando la finestra, `elimina`, infine `decifra` a chiave
  eliminata.
  Expected:
  - `decifra` confermato stampa `OK: chiave AES identica`;
  - i casi di errore stampano un HRESULT, da annotare.
- [ ] **Step 4: Scrivere le note** con tutti i valori elencati in "Produces" e il
  codice di binding koffi che ha funzionato.
- [ ] **Step 5: Commit**

  ```bash
  git add docs/superpowers/notes/2026-10-16-spike-windows-hello.md
  git commit -m "Annota l'esito della prova di Windows Hello con koffi"
  ```

### Task 2: Tipi comuni, scelta della modalità e infrastruttura di test

**Files:**
- Create: `src/credenziali/tipi.ts`, `src/credenziali/modalita.ts`,
  `test/unit/modalita.test.mjs`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces (`tipi.ts`):

  ```ts
  export interface Credenziali { username: string; password: string }
  export interface FonteCredenziali {
    ottieni(): Promise<Credenziali>;
    /** Aruba ha rifiutato queste credenziali (password errata o cambiata). */
    segnalaRifiuto(cred: Credenziali): void;
    /** Frase da aggiungere al messaggio d'errore di un rifiuto ("" se nessuna). */
    readonly suggerimentoRifiuto: string;
  }
  export class FonteStatica implements FonteCredenziali  // constructor(cred: Credenziali)
  export class SbloccoInCorsoError extends Error {}
  export class SbloccoAnnullatoError extends Error {}
  export class TroppiTentativiError extends Error {}
  export class HelloNonDisponibileError extends Error {}
  export class ChiaveHelloMancanteError extends Error {}
  export class VaultIllegibileError extends Error {}
  export const COMANDO_RESET = "--reset-windows-hello";
  ```

  Ogni errore ha un messaggio predefinito in italiano. Quello di
  `HelloNonDisponibileError` spiega come attivare Hello (Impostazioni → Account
  → Opzioni di accesso). I messaggi di
  `SbloccoInCorsoError`, `SbloccoAnnullatoError`, `TroppiTentativiError`,
  `VaultIllegibileError` e `HelloNonDisponibileError` citano
  `--reset-windows-hello` (decisione 5 della spec).
- Produces (`modalita.ts`):

  ```ts
  export type Modalita =
    | { tipo: "env"; credenziali: Credenziali }
    | { tipo: "hello" }
    | { tipo: "reset" }
    | { tipo: "errore"; messaggio: string };
  export function scegliModalita(argv: string[], env: Record<string, string | undefined>, piattaforma: string): Modalita
  ```

- [ ] **Step 1: Aggiungere lo script** `"test": "tsc && node --test \"test/unit/*.test.mjs\""`
  in `package.json`.
- [ ] **Step 2: Scrivere i test** in `test/unit/modalita.test.mjs`:
  - `scegliModalita(["--reset-windows-hello"], {}, "win32")` → `{ tipo: "reset" }`.
    Vale anche con le variabili presenti e su `"linux"`; il rifiuto su non
    Windows lo gestisce `index.ts`.
  - Entrambe le variabili su `"linux"` e su `"win32"` → `tipo: "env"` con quelle
    credenziali.
  - Nessuna variabile su `"win32"` → `{ tipo: "hello" }`.
  - Nessuna variabile su `"linux"` → `tipo: "errore"`, messaggio che contiene
    `ARUBA_USERNAME e ARUBA_PASSWORD` (il testo di oggi).
  - Solo `ARUBA_USERNAME` (o solo `ARUBA_PASSWORD`) su `"win32"` → `tipo:
    "errore"`, messaggio che nomina la variabile mancante.
  - Variabile presente ma stringa vuota → trattata come assente.
  - `new FonteStatica(c).ottieni()` risolve `c`, e `suggerimentoRifiuto === ""`.
- [ ] **Step 3: Verificare che falliscano**

  Run: `npm test`
  Expected: FAIL, modulo `dist/credenziali/modalita.js` non trovato.
- [ ] **Step 4: Implementare** `tipi.ts` e `modalita.ts`.
- [ ] **Step 5: Verificare che passino**

  Run: `npm test`
  Expected: PASS
- [ ] **Step 6: Commit**

  ```bash
  git add package.json src/credenziali test/unit
  git commit -m "Aggiunge la scelta della modalità credenziali e i test"
  ```

### Task 3: Vault cifrato su file

**Files:**
- Create: `src/credenziali/vault.ts`, `test/unit/vault.test.mjs`

**Interfaces:**
- Consumes: `Credenziali`, `VaultIllegibileError` (Task 2).
- Produces:

  ```ts
  export interface ChiaveHello {
    esiste(): Promise<boolean>;
    crea(): Promise<void>;                    // chiede Hello; ok se esiste già
    cifra(dati: Buffer): Promise<Buffer>;     // chiave pubblica, nessuna conferma
    decifra(dati: Buffer): Promise<Buffer>;   // chiede Hello; ChiaveHelloMancanteError / SbloccoAnnullatoError
    elimina(): Promise<boolean>;              // false se non esisteva
  }
  export const VERSIONE_VAULT = 1;
  export function percorsoVault(home?: string): string
  export async function salvaCredenziali(percorso: string, cred: Credenziali, chiave: ChiaveHello): Promise<void>
  export async function leggiCredenziali(percorso: string, chiave: ChiaveHello): Promise<Credenziali | null>
  export async function cancellaVault(percorso: string, chiave: ChiaveHello): Promise<{ fileRimosso: boolean; chiaveRimossa: boolean }>
  ```

  Formato JSON:

  ```json
  { "versione": 1, "chiaveCifrata": "<b64>", "iv": "<b64>", "tag": "<b64>", "dati": "<b64>" }
  ```

  - `dati` è AES-256-GCM di `JSON.stringify({ username, password })`.
  - AAD `"aruba-fatture-mcp/vault/v1"`.
  - `iv` di 12 byte casuali.
  - `chiaveCifrata` è `chiave.cifra(aesKey)`.

- [ ] **Step 1: Scrivere i test** con una `ChiaveHello` finta (XOR con un byte
  fisso, `decifra` che conta le chiamate):
  - **Andata e ritorno:** `salvaCredenziali` poi `leggiCredenziali` restituisce
    esattamente `{ username: "mario.rossi", password: "pà$$ wörd €\"' " }`
    (Review Focus 2).
  - **Nessun segreto in chiaro:** il file non contiene né lo username né la
    password in chiaro (`readFile` + `includes` falso).
  - **File assente:** `leggiCredenziali` → `null`, e `decifra` non viene chiamata.
  - **File illeggibile:** JSON non valido, `versione: 2` o tag alterato →
    `VaultIllegibileError`.
  - **Scrittura atomica:** dopo `salvaCredenziali` nella cartella c'è solo
    `credenziali.json` (nessun `.tmp` residuo); due `salvaCredenziali`
    concorrenti lasciano un file valido (Review Focus 5).
  - **Cartella mancante:** `salvaCredenziali` crea la cartella se non esiste.
  - **Cancellazione:** `cancellaVault` rimuove il file e chiama
    `chiave.elimina()`; su vault inesistente restituisce
    `{ fileRimosso: false, ... }` senza errore.
  - **Percorso:** `percorsoVault("C:\\Users\\X")` termina con
    `.aruba-fatture-mcp` + separatore + `credenziali.json`.
- [ ] **Step 2: Verificare che falliscano**

  Run: `npm test`
  Expected: FAIL sui test del vault.
- [ ] **Step 3: Implementare** `vault.ts`. Scrittura su
  `credenziali.json.<pid>.<random>.tmp` con `mode: 0o600`, poi `rename`.
- [ ] **Step 4: Verificare che passino**

  Run: `npm test`
  Expected: PASS
- [ ] **Step 5: Commit**

  ```bash
  git add src/credenziali/vault.ts test/unit/vault.test.mjs
  git commit -m "Aggiunge il vault cifrato delle credenziali"
  ```

### Task 4: Login del pannello con fonte di credenziali e riconoscimento OTP

**Files:**
- Modify: `src/panel-client.ts`. Vanno toccati il costruttore (righe 90-93) e
  `doLogin` (righe 130-189); i passi del login vanno estratti in una funzione
  riusabile.
- Create: `test/unit/panel-login.test.mjs`, `test/unit/fixtures/` (HTML minimi
  scritti a mano sul modello dei template Keycloak standard)

**Interfaces:**
- Consumes: `FonteCredenziali`, `Credenziali` (Task 2).
- Produces:

  ```ts
  export type EsitoLogin = "ok" | "otp" | "rifiutata";
  export function classificaRispostaLogin(status: number, location: string | null, html: string): EsitoLogin | "sconosciuto"
  export async function verificaLoginPannello(cred: Credenziali): Promise<EsitoLogin>   // lancia PanelError su 429/5xx/rete
  // ArubaPanelClient: constructor(fonte: FonteCredenziali)
  ```

  Regole di `classificaRispostaLogin`:
  - 302 con `code=` nella `location` → `"ok"`;
  - risposta 200 con un form che contiene un input `name="otp"` o `name="totp"`
    → `"otp"`;
  - risposta 200 che ripropone il form di login (input `name="password"`) →
    `"rifiutata"`;
  - altrimenti → `"sconosciuto"`.

- [ ] **Step 1: Scrivere i test**
  - **Classificazione:** casi con fixture `login-ok` (302), `login-otp.html`,
    `login-errore.html`, `pagina-strana.html`.
  - **`doLogin` con `fetch` simulato** (`globalThis.fetch` sostituito con una
    sequenza di risposte):
    - esito `"rifiutata"`: chiama `fonte.segnalaRifiuto` con le credenziali
      usate, lancia `PanelError` con il messaggio di oggi ("Credenziali
      rifiutate...") più `fonte.suggerimentoRifiuto`;
    - esito `"otp"`: lancia `PanelError` il cui messaggio contiene `verifica in
      due passaggi`, e **non** chiama `segnalaRifiuto`;
    - risposta 429 al POST: `PanelError` e nessun `segnalaRifiuto`.
  - **`verificaLoginPannello`:** restituisce `"otp"` e `"ok"` sulle stesse
    sequenze, e non tocca nessuna `FonteCredenziali`.
  - **Nessun segreto:** nessun messaggio d'errore contiene la password.
- [ ] **Step 2: Verificare che falliscano**

  Run: `npm test`
  Expected: FAIL
- [ ] **Step 3: Implementare**
  - `ArubaPanelClient` chiede le credenziali a `fonte.ottieni()` a ogni login.
    Gli header `aru-sub`/`aru-delegator` usano lo username delle credenziali
    della sessione corrente.
  - I passi 1–4 di `doLogin` diventano una funzione interna condivisa con
    `verificaLoginPannello`, che usa un cookie jar nuovo.
- [ ] **Step 4: Verificare che passino**

  Run: `npm test`
  Expected: PASS
- [ ] **Step 5: Commit**

  ```bash
  git add src/panel-client.ts test/unit/panel-login.test.mjs test/unit/fixtures
  git commit -m "Il pannello usa una fonte di credenziali e riconosce la verifica in due passaggi"
  ```

### Task 5: `ArubaClient` con fonte di credenziali e cache dei token facoltativa

**Files:**
- Modify: `src/aruba-client.ts`. Vanno toccati il costruttore (righe 53-65), la
  cache (righe 67-96) e `signin`/`acquireToken` (righe 102-168).
- Create: `test/unit/aruba-client.test.mjs`

**Interfaces:**
- Consumes: `FonteCredenziali` (Task 2).
- Produces:
  `constructor(fonte: FonteCredenziali, environment: ArubaEnvironment, opzioni: { persistiToken: boolean })`.
  Il resto dell'API pubblica resta invariato.

- [ ] **Step 1: Scrivere i test** con `fetch` simulato e `process.env.TMPDIR`
  puntato a una cartella temporanea:
  - **`persistiToken: false`:** dopo un login riuscito, nella cartella
    temporanea non c'è nessun file `aruba-fatture-mcp-token-*`.
  - **`persistiToken: true`:** il file c'è, con lo stesso nome di oggi (hash
    sha256 dello username, 12 caratteri).
  - **Rifiuto della password:** `/auth/signin` con `grant_type=password` che
    risponde 400 o 401 chiama `fonte.segnalaRifiuto` e lancia `ArubaApiError`.
    Il messaggio è quello di oggi, più `suggerimentoRifiuto`.
  - **Altri errori:** 429 e 500 non chiamano `segnalaRifiuto`.
  - **Refresh fallito:** un `grant_type=refresh_token` fallito non chiama
    `segnalaRifiuto`.
- [ ] **Step 2: Verificare che falliscano**

  Run: `npm test`
  Expected: FAIL
- [ ] **Step 3: Implementare.**
  - Le credenziali si ottengono da `fonte.ottieni()` in `acquireToken`.
  - Il percorso della cache si calcola al primo login (serve lo username).
  - Con `persistiToken: false`, `loadCachedToken` e `saveCachedToken` non fanno
    nulla.
- [ ] **Step 4: Verificare che passino**

  Run: `npm test`
  Expected: PASS
- [ ] **Step 5: Commit**

  ```bash
  git add src/aruba-client.ts test/unit/aruba-client.test.mjs
  git commit -m "ArubaClient usa una fonte di credenziali e può non salvare i token"
  ```

### Task 6: Fornitore Hello (sblocco, primo inserimento, nuove richieste)

**Files:**
- Create: `src/credenziali/fornitore-hello.ts`,
  `test/unit/fornitore-hello.test.mjs`

**Interfaces:**
- Consumes: `ChiaveHello`, `salvaCredenziali`, `leggiCredenziali` (Task 3);
  `EsitoLogin` (Task 4); i tipi e gli errori del Task 2.
- Produces:

  ```ts
  export interface DipendenzeHello {
    chiave: ChiaveHello;
    percorso: string;
    /** null = finestra annullata dall'utente. */
    chiediCredenziali(opz: { messaggioErrore?: string; usernameSuggerito?: string }): Promise<Credenziali | null>;
    /** Lancia per 429, rete, risposte inattese: niente salvataggio, nessun tentativo contato. */
    verifica(cred: Credenziali): Promise<EsitoLogin>;
    attesaMassimaMs?: number;   // default 45_000
    tentativiMassimi?: number;  // default 3
  }
  export class FornitoreHello implements FonteCredenziali { constructor(dip: DipendenzeHello) }
  ```

- [ ] **Step 1: Scrivere i test.** Usare dipendenze finte e
  `attesaMassimaMs: 50` per i casi di tempo.
  - **Vault presente:** `ottieni()` restituisce le credenziali; una seconda
    chiamata non chiama di nuovo `decifra`; due chiamate concorrenti fanno una
    sola `decifra`.
  - **Sblocco lento** (`decifra` che risolve dopo 200 ms):
    - la prima `ottieni()` rifiuta con `SbloccoInCorsoError`;
    - una seconda chiamata immediata non avvia una nuova `decifra`;
    - dopo 250 ms `ottieni()` risolve.
  - **Annullamento:** `decifra` lancia `SbloccoAnnullatoError`.
    - La chiamata in attesa rifiuta con `SbloccoAnnullatoError`.
    - Se la chiamata era già scaduta, la successiva riceve
      `SbloccoAnnullatoError` una sola volta.
    - Quella dopo ancora richiama `decifra`.
  - **Primo inserimento** (nessun vault):
    - `chiediCredenziali` → `verifica` `"ok"` → `chiave.crea()` → vault salvato
      → credenziali restituite;
    - con `verifica` `"otp"` succede lo stesso.
  - **Password rifiutata al primo inserimento:**
    - `verifica` `"rifiutata"` → `chiediCredenziali` richiamata con un
      `messaggioErrore` non vuoto e `usernameSuggerito` uguale allo username
      inserito;
    - alla terza `"rifiutata"` → `TroppiTentativiError`, anche nelle chiamate
      successive, senza riaprire la finestra;
    - nessun salvataggio.
  - **Finestra annullata** (`chiediCredenziali` → `null`):
    `SbloccoAnnullatoError`, nessun salvataggio.
  - **Verifica in errore** (lancia, es. 429): l'errore si propaga, nessun
    tentativo contato, nessun salvataggio; la chiamata successiva riapre la
    finestra.
  - **Chiave mancante** (`decifra` lancia `ChiaveHelloMancanteError`, Review
    Focus 3): si passa al primo inserimento, con un `messaggioErrore` che
    menziona la chiave Windows Hello.
  - **Rifiuto segnalato da un client** (Review Focus 4):
    - dopo `segnalaRifiuto(cred)` la prossima `ottieni()` apre la finestra con
      `messaggioErrore` e lo username precompilato;
    - dopo la verifica salva con `chiave.cifra`, senza chiamare `decifra` né
      `crea`;
    - il rifiuto conta come tentativo;
    - `segnalaRifiuto` con credenziali diverse da quelle correnti (vecchie) non
      fa nulla.
  - **Suggerimento:** `suggerimentoRifiuto` non è vuoto e non contiene la
    password.
- [ ] **Step 2: Verificare che falliscano**

  Run: `npm test`
  Expected: FAIL
- [ ] **Step 3: Implementare** `FornitoreHello`.
  - Una sola promessa di sblocco "in volo" alla volta.
  - Ogni `ottieni()` fa `Promise.race` tra quella promessa e un timer di
    `attesaMassimaMs`, cancellato a fine attesa.
  - Un errore di sblocco arrivato quando nessuno stava aspettando va conservato
    e consegnato alla chiamata successiva.
- [ ] **Step 4: Verificare che passino**

  Run: `npm test`
  Expected: PASS
- [ ] **Step 5: Commit**

  ```bash
  git add src/credenziali/fornitore-hello.ts test/unit/fornitore-hello.test.mjs
  git commit -m "Aggiunge il fornitore di credenziali Windows Hello"
  ```

### Task 7: Binding nativi Windows con koffi (serve l'utente al PC)

**Files:**
- Create: `src/credenziali/windows-native.ts`
- Modify: `package.json` e `package-lock.json` (`koffi` `3.3.2` esatta)

**Interfaces:**
- Consumes: `ChiaveHello` (Task 3); gli errori del Task 2; le note del Task 1.
- Produces:

  ```ts
  export async function creaChiaveHelloWindows(opz: { contesto: string }): Promise<ChiaveHello>
  export async function chiediCredenzialiWindows(opz: {
    titolo: string; messaggio: string; messaggioErrore?: string; usernameSuggerito?: string;
  }): Promise<Credenziali | null>
  ```

  - Entrambe fanno `await import("koffi")`. Un fallimento dell'import diventa
    `HelloNonDisponibileError`.
  - `contesto` è il testo mostrato nella finestra di Hello
    (`NCRYPT_USE_CONTEXT_PROPERTY`).
  - Nome della chiave, flag e padding sono quelli delle note del Task 1.
  - Mappatura HRESULT (dalle note) verso `SbloccoAnnullatoError`,
    `ChiaveHelloMancanteError` e `HelloNonDisponibileError`. `crea()` su una
    chiave già esistente è un successo.
  - Credenziali: `CredUIPromptForWindowsCredentialsW` con `CREDUIWIN_GENERIC`, e
    `CREDUI_INFOW` con `hwndParent = GetForegroundWindow()`.
    - `messaggioErrore` va in `dwAuthError`, o nel testo se il codice non basta.
    - Il nome suggerito si passa con `CredPackAuthenticationBufferW`.
    - Lo spacchettamento usa `CredUnPackAuthenticationBufferW`.
    - Il buffer restituito va azzerato (`SecureZeroMemory`) e liberato
      (`CoTaskMemFree`).
    - `ERROR_CANCELLED` (1223) → `null`.
  - Tutte le chiamate che possono mostrare una finestra usano `fn.async`.

- [ ] **Step 1: Aggiungere la dipendenza**

  Run: `npm install koffi@3.3.2 --save-exact`
  Expected:
  - `package.json` contiene `"koffi": "3.3.2"`;
  - il lockfile contiene le voci `@koromix/koffi-win32-x64` e
    `@koromix/koffi-win32-arm64`.
- [ ] **Step 2: Implementare** `windows-native.ts`.
- [ ] **Step 3: Compilare**

  Run: `npm test`
  Expected: PASS (nessun test nuovo, la compilazione deve riuscire).
- [ ] **Step 4: Preparare la copia di prova su Windows** (la prima volta va
  clonata, poi basta il `git pull`):

  ```bash
  cmd.exe /c "git -c safe.directory=* clone -b feature/windows-hello \\wsl.localhost\Ubuntu-22.04\home\simonea\aruba_fatture_mcp C:\Users\Simone\aruba-fatture-mcp-dev"
  ```

  Poi, a ogni aggiornamento:

  ```bash
  cmd.exe /c "cd /d C:\Users\Simone\aruba-fatture-mcp-dev && git pull && npm ci && npm run build"
  ```

  Expected: build riuscita.
- [ ] **Step 5: Prova manuale con l'utente al PC.** Usare uno script nella
  scratchpad, fuori dal repository, che importa `dist/credenziali/*.js` della
  copia Windows. Verificare:
  - la finestra credenziali compare davanti, accetta `pà$$ wörd €` e la
    restituisce identica;
  - `crea`, `cifra` e `decifra` funzionano con impronta;
  - annullare dà `SbloccoAnnullatoError`;
  - dopo `elimina`, `decifra` dà `ChiaveHelloMancanteError`.

  Expected: tutti i casi come descritto. Annotare gli esiti nelle note del
  Task 1.
- [ ] **Step 6: Commit**

  ```bash
  git add package.json package-lock.json src/credenziali/windows-native.ts docs/superpowers/notes
  git commit -m "Aggiunge i binding Windows Hello e CredUI con koffi"
  ```

### Task 8: Collegamento in `index.ts`, comando di reset, titolare

**Files:**
- Create: `src/titolare.ts`, `test/unit/titolare.test.mjs`
- Modify: `src/index.ts`. Vanno toccate la configurazione (righe 48-69),
  `titolare()` (righe 177-204) e la creazione di `panelClient` (riga 504).

**Interfaces:**
- Consumes: tutto quanto prodotto dai Task 2–7.
- Produces:

  ```ts
  // riusa `Titolare` esportato da src/archivio.ts
  export function creaTitolare(opz: {
    daEnv: Titolare; modalitaHello: boolean; userInfo: () => Promise<unknown>;
  }): () => Promise<Titolare>
  ```

- [ ] **Step 1: Scrivere i test di `creaTitolare`**
  - **Hello, con `ARUBA_VAT_CODE` impostata:** restituisce i dati dall'ambiente
    e **non** chiama `userInfo`.
  - **Hello, senza variabili:** chiama `userInfo`.
    - Se lancia `SbloccoAnnullatoError` o `SbloccoInCorsoError`, l'errore si
      propaga e niente viene memorizzato: la chiamata dopo richiama `userInfo`.
    - Se lancia un errore di rete, si ripiega sull'ambiente come oggi.
  - **Modalità env:** comportamento identico a oggi (`userInfo` prima, ripiego
    sull'ambiente in caso di errore, risultato memorizzato).
- [ ] **Step 2: Verificare che falliscano**

  Run: `npm test`
  Expected: FAIL
- [ ] **Step 3: Implementare** `titolare.ts`, poi collegare `index.ts`.
  - **Modalità:** `scegliModalita(process.argv.slice(2), process.env,
    process.platform)` prima di tutto.
  - **`errore`:** `console.error(messaggio)` ed `exit(1)`.
  - **`reset`:**
    - su sistemi non Windows, messaggio ed `exit(1)`;
    - su Windows, `cancellaVault(percorsoVault(), await
      creaChiaveHelloWindows(...))`;
    - stampa su stdout cosa è stato rimosso (o "nessuna credenziale salvata")
      ed esce con 0.
  - **`env`:** `FonteStatica` e `persistiToken: true`.
  - **`hello`:**
    - creare `FornitoreHello` con `chiediCredenzialiWindows`,
      `creaChiaveHelloWindows`, `verificaLoginPannello` e `percorsoVault()`;
    - `persistiToken: false`;
    - su stderr, una riga con il percorso esatto del comando di reset
      (`process.argv[1]`);
    - se `ARUBA_ENVIRONMENT` è `demo`, un avviso che i tool "API Aruba" useranno
      i server di prova.

    Se il caricamento di koffi fallisce, il server parte lo stesso e ogni
    `ottieni()` rifiuta con `HelloNonDisponibileError`.

    Testi delle finestre:
    - titolo `"Aruba Fatture MCP"`;
    - messaggio: "Inserisci le credenziali del pannello Aruba Fatturazione
      Elettronica. Verranno salvate cifrate con Windows Hello. Per cancellarle:
      node <percorso>\dist\index.js --reset-windows-hello";
    - `contesto` di Hello: "Sblocca le credenziali Aruba Fatture MCP".
  - **Transport:** il server collega il transport prima di qualsiasi sblocco.
    Il codice di oggi lo fa già alla fine del file: lo sblocco avviene solo
    dentro i tool.
- [ ] **Step 4: Verificare che passino**

  Run: `npm test`
  Expected: PASS
- [ ] **Step 5: Verificare a mano la modalità env invariata.**

  Run: `ARUBA_USERNAME=x ARUBA_PASSWORD=y node dist/index.js </dev/null`
  Expected: stderr `Server MCP aruba-fatture avviato (ambiente: demo).`

  Run: `node dist/index.js </dev/null` su Linux
  Expected: l'errore di oggi sulle variabili, uscita 1.
- [ ] **Step 6: Commit**

  ```bash
  git add src/index.ts src/titolare.ts test/unit/titolare.test.mjs
  git commit -m "Attiva la modalità Windows Hello e il comando di reset"
  ```

### Task 9: README e prova completa con Claude Desktop (serve l'utente al PC)

**Files:**
- Modify: `README.md`, nelle sezioni "Configurazione" e "Uso con un client MCP".

- [ ] **Step 1: Aggiornare il README**
  - Configurazione di Claude Desktop senza credenziali: `command` `node`,
    `args` con il percorso di `dist\index.js`, `env` con solo
    `ARUBA_ENVIRONMENT=production`.
  - Primo avvio e reset (`node <percorso>\dist\index.js --reset-windows-hello`
    da un terminale Windows).
  - Nota su koffi: unica dipendenza nativa, un solo manutentore, binari
    precompilati, versione fissata.
  - Limite attuale: con la verifica in due passaggi attiva, i tool del pannello
    rispondono che non è ancora supportata.
- [ ] **Step 2: Aggiornare la copia Windows** (comando del Task 7, Step 4).
- [ ] **Step 3: Configurare Claude Desktop** aggiungendo il server in
  `C:\Users\Simone\AppData\Roaming\Claude\claude_desktop_config.json`, dopo aver
  mostrato all'utente la modifica.
- [ ] **Step 4: Prove manuali con l'utente** (lista della spec, sezione
  "Verifica"). Spuntarle una per una:
  - primo inserimento;
  - password sbagliata e poi corretta;
  - account con 2FA (credenziali salvate, poi messaggio chiaro dai tool del
    pannello);
  - riavvio di Claude Desktop con sola conferma Hello;
  - conferma lenta oltre 45 secondi, poi "riprova";
  - annullamento di Hello;
  - `--reset-windows-hello` da terminale, poi di nuovo il primo inserimento;
  - configurazione con le variabili d'ambiente invariata;
  - finestre in primo piano davanti a Claude Desktop (Review Focus 1);
  - nessun file in chiaro: cercare username e password in `%TEMP%`,
    `%LOCALAPPDATA%`, `%USERPROFILE%\.aruba-fatture-mcp` e
    `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc`.

  La verifica in Windows 10 la fa l'utente in seguito, con la stessa lista.
- [ ] **Step 5: Commit**

  ```bash
  git add README.md
  git commit -m "Documenta la modalità Windows Hello"
  ```
