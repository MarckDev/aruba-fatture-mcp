/**
 * Fonte di credenziali protetta da Windows Hello.
 *
 * Sblocca il vault con la conferma dell'utente, oppure, se non ci sono
 * credenziali salvate (o Aruba le ha rifiutate), le chiede con una finestra,
 * le verifica con un login reale e le salva cifrate.
 *
 * Ogni richiesta MCP ha un timeout di circa 60 secondi, mentre l'utente può
 * metterci di più a confermare: un tool aspetta al massimo `attesaMassimaMs`,
 * poi risponde "conferma e riprova" lasciando la finestra aperta. Le chiamate
 * successive si agganciano allo stesso sblocco invece di aprirne un altro.
 */

import type { EsitoLogin } from "../panel-client.js";
import {
  ChiaveHelloMancanteError,
  FirmaNonValidaError,
  SbloccoAnnullatoError,
  SbloccoInCorsoError,
  TroppiTentativiError,
  type Credenziali,
  type FonteCredenziali,
} from "./tipi.js";
import { leggiCredenziali, salvaCredenziali, type ChiaveHello } from "./vault.js";

export interface DipendenzeHello {
  chiave: ChiaveHello;
  percorso: string;
  /** null = finestra annullata dall'utente. */
  chiediCredenziali(opz: { messaggioErrore?: string; usernameSuggerito?: string }): Promise<Credenziali | null>;
  /** Lancia per 429, rete, risposte inattese: niente salvataggio, nessun tentativo contato. */
  verifica(cred: Credenziali): Promise<EsitoLogin>;
  attesaMassimaMs?: number;
  tentativiMassimi?: number;
}

interface Reinserimento {
  messaggio: string;
  username?: string;
}

const PASSWORD_RIFIUTATA = "Aruba ha rifiutato la password: ricontrollala e riprova.";
const PASSWORD_CAMBIATA =
  "Aruba ha rifiutato la password salvata (forse è stata cambiata): inserisci quella attuale.";

export class FornitoreHello implements FonteCredenziali {
  readonly suggerimentoRifiuto =
    " Alla prossima richiesta Windows ti chiederà di reinserire la password Aruba.";

  private credenziali: Credenziali | null = null;
  private inVolo: Promise<Credenziali> | null = null;
  /** Errore di uno sblocco finito quando nessuno lo stava aspettando. */
  private erroreDaConsegnare: Error | null = null;
  private inAttesa = 0;
  private reinserimento: Reinserimento | null = null;
  private rifiuti = 0;
  private bloccato = false;
  private readonly attesaMassimaMs: number;
  private readonly tentativiMassimi: number;

  constructor(private readonly dip: DipendenzeHello) {
    this.attesaMassimaMs = dip.attesaMassimaMs ?? 45_000;
    this.tentativiMassimi = dip.tentativiMassimi ?? 3;
  }

  async ottieni(): Promise<Credenziali> {
    if (this.bloccato) throw new TroppiTentativiError();
    if (this.credenziali) return this.credenziali;
    if (this.erroreDaConsegnare) {
      const errore = this.erroreDaConsegnare;
      this.erroreDaConsegnare = null;
      throw errore;
    }

    if (!this.inVolo) {
      const sblocco = this.sblocca().finally(() => {
        this.inVolo = null;
      });
      // Registrato prima dei chiamanti: vede ancora contati quelli in attesa.
      sblocco.catch((errore: Error) => {
        if (this.inAttesa === 0) this.erroreDaConsegnare = errore;
      });
      this.inVolo = sblocco;
    }

    this.inAttesa++;
    let timer: NodeJS.Timeout | undefined;
    try {
      const scadenza = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SbloccoInCorsoError()), this.attesaMassimaMs);
      });
      return await Promise.race([this.inVolo, scadenza]);
    } finally {
      clearTimeout(timer);
      this.inAttesa--;
    }
  }

  segnalaRifiuto(cred: Credenziali): void {
    const correnti = this.credenziali;
    // Un rifiuto arrivato tardi per credenziali già sostituite non conta.
    if (!correnti || correnti.username !== cred.username || correnti.password !== cred.password) return;
    this.credenziali = null;
    this.reinserimento = { messaggio: PASSWORD_CAMBIATA, username: cred.username };
    this.contaRifiuto();
  }

  private async sblocca(): Promise<Credenziali> {
    if (!this.reinserimento) {
      try {
        const salvate = await leggiCredenziali(this.dip.percorso, this.dip.chiave);
        if (salvate) {
          this.credenziali = salvate;
          return salvate;
        }
      } catch (errore) {
        // Chiave sparita o file non firmato da noi: in entrambi i casi il file
        // non è utilizzabile, e reinserire le credenziali lo sostituisce con
        // uno valido. Il nuovo salvataggio richiede comunque Windows Hello.
        if (!(errore instanceof ChiaveHelloMancanteError || errore instanceof FirmaNonValidaError)) {
          throw errore;
        }
        this.reinserimento = { messaggio: errore.message };
      }
    }
    return this.inserisci();
  }

  /** Chiede, verifica e salva le credenziali, ripetendo finché Aruba le rifiuta. */
  private async inserisci(): Promise<Credenziali> {
    for (;;) {
      const cred = await this.dip.chiediCredenziali({
        messaggioErrore: this.reinserimento?.messaggio,
        usernameSuggerito: this.reinserimento?.username,
      });
      if (!cred) throw new SbloccoAnnullatoError();

      const esito = await this.dip.verifica(cred);
      if (esito === "rifiutata") {
        this.reinserimento = { messaggio: PASSWORD_RIFIUTATA, username: cred.username };
        this.contaRifiuto();
        if (this.bloccato) throw new TroppiTentativiError();
        continue;
      }

      // "otp" arriva solo dopo una password accettata: si salva comunque.
      if (!(await this.dip.chiave.esiste())) await this.dip.chiave.crea();
      await salvaCredenziali(this.dip.percorso, cred, this.dip.chiave);
      this.reinserimento = null;
      this.credenziali = cred;
      return cred;
    }
  }

  private contaRifiuto(): void {
    this.rifiuti++;
    if (this.rifiuti >= this.tentativiMassimi) this.bloccato = true;
  }
}
