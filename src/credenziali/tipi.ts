/**
 * Tipi condivisi per la gestione delle credenziali Aruba.
 *
 * I client (API e pannello) non ricevono più username e password fissi ma una
 * "fonte": in modalità variabili d'ambiente restituisce sempre le stesse
 * credenziali, in modalità Windows Hello le sblocca dal vault cifrato e le
 * richiede all'utente quando Aruba le rifiuta.
 */

export interface Credenziali {
  username: string;
  password: string;
}

export interface FonteCredenziali {
  ottieni(): Promise<Credenziali>;
  /** Aruba ha rifiutato queste credenziali (password errata o cambiata). */
  segnalaRifiuto(cred: Credenziali): void;
  /** Frase da aggiungere al messaggio d'errore di un rifiuto ("" se nessuna). */
  readonly suggerimentoRifiuto: string;
}

export const COMANDO_RESET = "--reset-windows-hello";

const COME_RESETTARE = `Per cancellare le credenziali salvate: node <percorso>\\dist\\index.js ${COMANDO_RESET}`;

/** Credenziali fisse, lette dalle variabili d'ambiente: il comportamento storico. */
export class FonteStatica implements FonteCredenziali {
  readonly suggerimentoRifiuto = "";

  constructor(private readonly credenziali: Credenziali) {}

  async ottieni(): Promise<Credenziali> {
    return this.credenziali;
  }

  segnalaRifiuto(): void {
    // Non c'è modo di chiederne altre: l'errore del client basta.
  }
}

export class SbloccoInCorsoError extends Error {
  constructor(
    message = "Windows sta chiedendo conferma in una finestra (credenziali Aruba o Windows Hello): completala e poi riprova. " +
      COME_RESETTARE,
  ) {
    super(message);
    this.name = "SbloccoInCorsoError";
  }
}

export class SbloccoAnnullatoError extends Error {
  constructor(
    message = "Sblocco delle credenziali Aruba annullato. Alla prossima richiesta Windows chiederà di nuovo conferma. " +
      COME_RESETTARE,
  ) {
    super(message);
    this.name = "SbloccoAnnullatoError";
  }
}

export class TroppiTentativiError extends Error {
  constructor(
    message = "Troppe password rifiutate da Aruba in questa sessione: chiudi e riapri Claude Desktop per riprovare, così da non far bloccare l'account. " +
      COME_RESETTARE,
  ) {
    super(message);
    this.name = "TroppiTentativiError";
  }
}

export class HelloNonDisponibileError extends Error {
  constructor(dettaglio?: string) {
    super(
      "Windows Hello non è disponibile su questo PC" +
        (dettaglio ? ` (${dettaglio})` : "") +
        ". Attivalo da Impostazioni → Account → Opzioni di accesso, oppure imposta ARUBA_USERNAME e ARUBA_PASSWORD. " +
        COME_RESETTARE,
    );
    this.name = "HelloNonDisponibileError";
  }
}

export class ChiaveHelloMancanteError extends Error {
  constructor(
    message = "La chiave Windows Hello che protegge le credenziali Aruba non esiste più (ad esempio dopo aver reimpostato il PIN di Windows): reinserisci le credenziali.",
  ) {
    super(message);
    this.name = "ChiaveHelloMancanteError";
  }
}

export class FirmaNonValidaError extends Error {
  constructor(
    message = "Il file delle credenziali Aruba non è firmato o è stato modificato: per sicurezza non viene usato. Reinserisci le credenziali.",
  ) {
    super(message);
    this.name = "FirmaNonValidaError";
  }
}

export class VaultIllegibileError extends Error {
  constructor(dettaglio?: string) {
    super(
      "Il file delle credenziali Aruba salvate è illeggibile" +
        (dettaglio ? ` (${dettaglio})` : "") +
        ". " +
        COME_RESETTARE +
        ", poi reinseriscile.",
    );
    this.name = "VaultIllegibileError";
  }
}
