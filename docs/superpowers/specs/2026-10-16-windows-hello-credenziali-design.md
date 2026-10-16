# Credenziali protette da Windows Hello — design

Data: 2026-10-16
Base: fork `SimoneAvogadro/aruba-fatture-mcp` di `MarckDev/aruba-fatture-mcp`,
commit `f381259`

## Intento

Oggi username e password Aruba stanno in chiaro: nel `.env` o nel blocco `env`
della configurazione del client MCP. In più il server scrive l'access token e il
refresh token Aruba in chiaro in `%TEMP%` (`aruba-client.ts`, `saveCachedToken`),
e chiunque legga quel file può usare l'account per fino a un'ora senza password.

L'utente non vuole credenziali né token leggibili su disco. Vuole che, quando il
server è avviato da Claude Desktop su Windows, le credenziali siano sbloccabili
solo con una conferma di Windows Hello.

## Obiettivi

- **Modalità Windows Hello automatica:** su Windows, se nell'ambiente mancano
  `ARUBA_USERNAME`/`ARUBA_PASSWORD`, il server legge le credenziali da un
  archivio cifrato sbloccabile solo con Windows Hello. Non serve nessuna opzione
  di avvio.
- La cifratura è **legata crittograficamente** a Windows Hello: senza la conferma
  dell'utente le credenziali non sono decifrabili, nemmeno da un altro programma
  che gira con lo stesso utente Windows. Mostrare una finestra di consenso e poi
  leggere un segreto accessibile comunque **non** basta.
- In modalità Windows Hello il token Aruba resta solo in memoria: niente cache su
  disco, nemmeno cifrata.
- Funziona su Windows 10 e Windows 11, con il server avviato da Claude Desktop
  (su questa macchina installato come pacchetto MSIX dello Store).

## Non obiettivi

- **Verifica in due passaggi (2FA) di Aruba:** il supporto completo è rimandato a
  un lavoro futuro. L'utente ha la 2FA attiva, con un codice da app Android. Qui
  ci si limita a riconoscerla (vedi decisione 3).
- Nessun supporto a macOS (Touch ID), Linux o WSL.
- Nessuna modifica ai tool MCP esposti né alla logica di fatturazione.
- Nessun ripiego su una protezione più debole: se il legame con Windows Hello non
  è realizzabile su un PC, il server si ferma con un messaggio chiaro.
- Nessuna pubblicazione (push, PR verso l'originale, pacchetto npm) salvo
  richiesta esplicita dell'utente.

## Anti-obiettivi (fallimento anche se "funziona")

- Password o token che finiscono in chiaro su disco, nei log, negli argomenti da
  riga di comando di un processo o nell'output dei tool MCP.
- Un ripiego silenzioso su altre fonti di credenziali quando Hello fallisce o
  viene annullato.
- Claude Desktop che segna il server come "fallito" perché il server aspetta
  l'utente prima di rispondere all'handshake MCP, o che interrompe un tool perché
  supera il timeout di 60 secondi.
- Account Aruba bloccato perché il server riprova il login in loop con una
  password sbagliata.
- Chi oggi usa `ARUBA_USERNAME`/`ARUBA_PASSWORD` nell'ambiente si ritrova con un
  comportamento diverso.

## Esperienza utente (decisa dall'utente)

1. In `claude_desktop_config.json` il server è configurato senza
   `ARUBA_USERNAME`/`ARUBA_PASSWORD`. Il server riconosce di essere su Windows e
   usa Windows Hello da solo.
2. **Prima volta** (nessuna credenziale salvata): il server chiede username e
   password in modo interattivo, li salva cifrati e li riusa nelle sessioni dopo.
3. **Volte successive:** basta la conferma di Windows Hello.
4. **Quando compare la richiesta:** al primo uso di un tool che ne ha bisogno, non
   all'apertura di Claude Desktop. Il tool risponde subito chiedendo di
   confermare nella finestra e riprovare (dettagli nella decisione 1).
5. **Password errata:** l'utente può reinserirla. Vale sia al primo inserimento
   sia quando la password salvata smette di funzionare (es. cambiata sul sito
   Aruba).
6. Con l'opzione `--reset-windows-hello` si cancellano le credenziali salvate.
   L'utente vuole che all'avvio sia visibile un'informazione che spieghi questa
   opzione.
7. Con `ARUBA_USERNAME`/`ARUBA_PASSWORD` nell'ambiente, su qualunque sistema, il
   server si comporta esattamente come oggi. Su sistemi non Windows senza
   credenziali dà l'errore di oggi.
8. L'account usato è quello di **produzione**, lo stesso del pannello web Aruba.
9. Le chiamate native a Windows passano dalla libreria **koffi**, scelta
   dall'utente: è lo standard di fatto per l'FFI in Node.js (circa 18 milioni di
   download al mese).

## Vincoli tecnici

- **Nessun terminale disponibile.** Il server MCP parla con Claude Desktop su
  stdin/stdout, quindi non può chiedere nulla all'utente lì. Ogni interazione
  avviene con finestre grafiche di Windows. Tutto ciò che si scrive su stderr
  finisce solo nei log MCP di Claude Desktop, che l'utente di norma non vede.
- **Handshake e timeout.** Claude Desktop avvia i server all'apertura dell'app e
  si aspetta una risposta rapida a `initialize`: il server collega il transport
  subito, lo sblocco avviene dopo. Ogni richiesta MCP ha un timeout di circa 60
  secondi (default dell'SDK TypeScript), quindi nessun tool può restare in attesa
  dell'utente oltre quel limite.
- **Dipendenze.** Si aggiunge una sola dipendenza runtime, `koffi`, con versione
  esatta (niente `^`), pubblicata da almeno due settimane al momento
  dell'aggiunta (la 3.3.3 del 10/10/2026 è troppo recente) e bloccata nel
  `package-lock.json`. Nessun'altra dipendenza nuova.
  - **koffi va caricata solo su Windows e solo in modalità Hello**, con un import
    dinamico, così il server continua a partire anche dove i suoi binari non ci
    sono o non servono.
  - Va annotato nel README che koffi ha un solo manutentore e contiene binari
    precompilati.
- **Niente processi esterni.** Le API di Windows (CNG/NCrypt con il Microsoft
  Passport Key Storage Provider, finestra credenziali CredUI) si chiamano dal
  processo Node tramite koffi. Credenziali e chiavi non lasciano mai il processo.
- **Node ≥ 18**, come dichiarato nel README; verificare che la versione di koffi
  scelta lo supporti. Crittografia simmetrica con `node:crypto` (AES-256-GCM).
- La password decifrata resta in memoria per tutta la vita del processo: serve
  per i login periodici di `ArubaClient` e `ArubaPanelClient` (la sessione del
  pannello si rinnova ogni 20 minuti). È accettato.

## Come si lega la cifratura a Windows Hello

Si usa lo stesso schema delle estensioni Windows Hello per KeePass
(KeePassWinHello), collaudato su Windows 10 e 11:

- una chiave RSA dedicata al progetto viene creata nel **Microsoft Passport Key
  Storage Provider** tramite NCrypt. La chiave vive nel TPM (o nello storage
  protetto di Hello) e il suo uso per decifrare richiede la conferma
  dell'utente;
- una chiave AES-256 casuale cifra username e password; la chiave AES viene a sua
  volta cifrata con la chiave pubblica RSA e salvata nel file;
- per sbloccare si chiede a Windows di decifrare la chiave AES con la chiave
  Hello: Windows mostra la richiesta di impronta, volto o PIN. Con la chiave AES
  si decifrano le credenziali.

Windows Hello accetta sempre anche il PIN come alternativa alla biometria;
l'applicazione non può escluderlo. È accettato.

## Decisioni prese da me (da confermare in lettura)

1. **Sblocco senza superare i 60 secondi.** Al primo tool che ha bisogno delle
   credenziali parte lo sblocco in background; il tool attende fino a circa 45
   secondi.
   - Se lo sblocco si completa, il tool prosegue normalmente.
   - Altrimenti risponde con un messaggio tipo "Conferma Windows Hello nella
     finestra aperta, poi riprova". Le chiamate successive non aprono una
     seconda finestra: aspettano quella in corso con lo stesso limite.
   - Se l'utente annulla, la chiamata in corso (o la successiva) restituisce un
     errore chiaro, e la chiamata dopo ancora ripropone lo sblocco.
   - Le chiamate NCrypt e CredUI sono bloccanti: vanno eseguite in modo da non
     fermare il ciclo degli eventi di Node (es. le chiamate asincrone di koffi o
     un worker thread), altrimenti il server smette di rispondere a Claude
     Desktop mentre la finestra è aperta.
2. **Verifica della password con il login del pannello.** Trattandosi
   dell'account di produzione, la password si verifica con un login reale al
   pannello web (lo stesso flusso di `ArubaPanelClient`), indipendentemente da
   `ARUBA_ENVIRONMENT`. Se `ARUBA_ENVIRONMENT` è `demo` in modalità Hello, va
   scritto un avviso nel log: i tool "API Aruba" userebbero i server di prova con
   credenziali di produzione. Le credenziali salvate non sono distinte per
   ambiente.
3. **Riconoscimento della 2FA.** Il login del pannello deve distinguere tre esiti
   dopo il POST delle credenziali: accesso riuscito, password rifiutata, pagina
   del secondo passaggio (OTP). Oggi `panel-client.ts` (righe 169–176) scambia la
   pagina OTP per una password rifiutata.
   - **In verifica:** la pagina OTP compare solo dopo una password corretta,
     quindi vale come password valida e le credenziali si salvano.
   - **Nei tool del pannello:** errore chiaro, del tipo "verifica in due passaggi
     attiva sull'account: non ancora supportata dai tool del pannello". Non conta
     come tentativo fallito e non fa ripetere la richiesta della password.
   - Come riconoscere la pagina OTP (campo `otp`/`totp` nel form, URL o titolo
     della pagina Keycloak) lo stabilisce il builder, verificandolo sull'account
     reale con l'utente.
4. **Quando richiedere di nuovo la password.** Solo quando Aruba la rifiuta
   esplicitamente (pagina di login Keycloak con errore di credenziali, oppure
   `/auth/signin` con `grant_type=password` che risponde credenziali non valide).
   - Errori di rete, errori 5xx, HTTP 429 o la pagina OTP non fanno mai ripetere
     la richiesta; un 429 dà il messaggio "riprova tra qualche minuto".
   - Massimo 3 tentativi di login con password per avvio, contando insieme
     pannello e API, poi errore.
   - Un unico "fornitore di credenziali" condiviso dai due client gestisce
     richiesta, verifica e nuovo salvataggio. Il nuovo salvataggio cifra con la
     chiave pubblica e non richiede una seconda conferma Hello: non
     proteggerebbe nulla, perché chiunque possa scrivere il file potrebbe già
     sostituirlo.
   - Se la chiave Hello non esiste più (ad esempio dopo aver reimpostato il PIN
     di Windows, che cancella le chiavi Hello), il server lo dice e richiede le
     credenziali come al primo avvio, invece di fermarsi.
5. **Dove compare l'informazione su `--reset-windows-hello`:** Claude Desktop non
   mostra all'utente l'output del server, quindi l'informazione va nel testo
   della finestra di inserimento credenziali e nei messaggi d'errore dei tool
   legati allo sblocco, oltre che su stderr (log) e nel README. Niente notifica a
   ogni avvio.
6. **`--reset-windows-hello` è un comando una tantum** da lanciare a mano dal
   terminale Windows (`node dist\index.js --reset-windows-hello`): cancella il
   file cifrato e la chiave Hello del progetto, stampa una conferma ed esce. Non
   richiede Hello: chi può cancellare il file può già farlo a mano. Dopo il reset,
   al successivo uso da Claude Desktop riparte il primo inserimento.
7. **Dove si salva:** `%USERPROFILE%\.aruba-fatture-mcp\`, non in `AppData`.
   Claude Desktop è un pacchetto MSIX, e Windows può reindirizzare in una
   cartella privata del pacchetto le scritture in `AppData` dei processi che
   avvia. Il terminale (usato per il reset) non vedrebbe quei file. Il file
   contiene un numero di versione del formato e tutto il necessario per
   decifrare tranne la chiave Hello.
8. **Tool sull'archivio locale** (`list_invoices`, `vat_report`, ...): chiedono
   lo sblocco solo se mancano sia `ARUBA_VAT_CODE` sia `ARUBA_FISCAL_CODE`. Se lo
   sblocco viene annullato restituiscono un errore; la funzione `titolare()` non
   deve memorizzare un risultato di ripiego ottenuto per uno sblocco annullato.
9. **Solo una delle due variabili presente** (`ARUBA_USERNAME` senza
   `ARUBA_PASSWORD` o viceversa): errore di configurazione, non modalità Hello.
   È quasi certamente una svista e conviene segnalarla.
10. **Cache del token in modalità variabili d'ambiente:** resta com'è oggi (file
    in `%TEMP%`), per non introdurre problemi di limite di login a chi non usa
    Hello.
11. **Windows Hello non configurato sul PC:** messaggio d'errore che spiega come
    attivarlo (Impostazioni → Account → Opzioni di accesso).

## Aggiunta: firma obbligatoria del file (2026-10-16)

Chiesta dall'utente dopo la prima versione verificata (tag `hello-verificata`).

- **Perché:** cifrare con la chiave pubblica non richiede conferma, quindi un
  programma che gira con l'utente potrebbe sostituire il file con credenziali
  di un altro account Aruba. Il server, dopo l'impronta, userebbe
  quell'account.
- **Salvataggio:** il file (formato 2) è firmato con la chiave Hello, SHA-256
  e PKCS#1 v1.5, sui campi `versione`, `chiaveCifrata`, `iv`, `tag` e `dati`.
  Firmare richiede Windows Hello, con il testo "Conferma il salvataggio delle
  credenziali Aruba Fatture MCP", diverso da quello dello sblocco.
- **Lettura:** la firma si verifica con la chiave pubblica, senza finestre,
  prima di chiedere la conferma per decifrare.
  - Un file non firmato, compreso il formato 1, o modificato non viene usato.
  - Si richiedono le credenziali con il messaggio "non è firmato o è stato
    modificato" e si salva un file nuovo firmato.
- **Conferme Hello:**
  - primo avvio: due (creazione della chiave e firma);
  - password cambiata o file rifiutato: una (firma);
  - avvio normale: una.
- **Nessuna migrazione del formato 1:** accettarlo anche una sola volta
  vanificherebbe la firma.

## Lasciato al builder

- **Prova reale prima di tutto**, su questa macchina (Windows 11). Node per
  Windows va eseguito da WSL tramite interop, oppure va installato se manca.
  - Con koffi, creare la chiave nel Passport KSP.
  - Cifrare e decifrare una chiave AES con conferma Hello.
  - Verificare che la chiave creata da un processo sia usabile da un altro.
  - Verificare che funzioni sia da un processo avviato da Claude Desktop (MSIX)
    sia dal terminale.

  Se il Passport KSP non regge, fermarsi e riportare all'utente prima di cambiare
  approccio.
- **Finestra delle credenziali:** dialogo nativo di Windows
  (`CredUIPromptForWindowsCredentials` o equivalente), con password mascherata e
  titolo riconoscibile ("Aruba Fatture MCP"). Deve funzionare da un processo
  senza console avviato da Claude Desktop.
- **Primo piano:** le finestre (credenziali e Hello) devono comparire davanti a
  Claude Desktop, non dietro. Verificarlo è parte del lavoro; se serve, impostare
  l'handle di finestra sulla chiave NCrypt (`NCRYPT_WINDOW_HANDLE_PROPERTY`) e
  sul dialogo CredUI.
- Struttura del codice (es. un modulo `credenziali-windows.ts` con il fornitore
  di credenziali usato dai due client), formato del file, testi dei messaggi,
  scelta della versione esatta di koffi.

## Verifica

- **Test automatici** con `node --test` (nessuna dipendenza di test nuova):
  - formato del file cifrato, cifratura e decifratura, file corrotto o versione
    sconosciuta;
  - scelta della modalità (variabili presenti, assenti, una sola; Windows o
    altro sistema);
  - regole di nuova richiesta della password, limite di 3 tentativi,
    riconoscimento della pagina OTP;
  - comportamento con timeout e annullamento;
  - nessun segreto nei messaggi d'errore.

  Le chiamate native e quelle ad Aruba vanno simulate.
- **Prova manuale su Windows 11** (questa macchina) e **Windows 10** (fatta
  dall'utente su un suo PC), con Claude Desktop:
  - primo inserimento;
  - password sbagliata e poi corretta;
  - account con 2FA (credenziali salvate, tool del pannello con messaggio
    chiaro);
  - riavvio con sola conferma Hello;
  - conferma lenta (oltre 45 secondi) con "riprova";
  - annullamento di Hello;
  - `--reset-windows-hello` da terminale;
  - Hello non configurato;
  - configurazione con variabili d'ambiente invariata;
  - controllo che in `%TEMP%`, `%LOCALAPPDATA%` e nella cartella del pacchetto
    Claude non ci sia nulla in chiaro.
- **README** aggiornato:
  - configurazione di Claude Desktop per la modalità Hello;
  - istruzioni per il reset;
  - nota su koffi;
  - limite attuale con la 2FA.
