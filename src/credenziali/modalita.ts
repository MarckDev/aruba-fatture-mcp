/**
 * Sceglie da dove arrivano le credenziali, in base ad argomenti, ambiente e
 * sistema operativo. Le variabili d'ambiente, se presenti, vincono sempre: chi
 * le usa oggi non deve notare differenze.
 */

import { COMANDO_RESET, type Credenziali } from "./tipi.js";

export type Modalita =
  | { tipo: "env"; credenziali: Credenziali }
  | { tipo: "hello" }
  | { tipo: "reset" }
  | { tipo: "errore"; messaggio: string };

export function scegliModalita(
  argv: string[],
  env: Record<string, string | undefined>,
  piattaforma: string,
): Modalita {
  if (argv.includes(COMANDO_RESET)) return { tipo: "reset" };

  // Una variabile vuota è quasi sempre un segnaposto lasciato nel file di
  // configurazione: va trattata come assente.
  const username = env.ARUBA_USERNAME || undefined;
  const password = env.ARUBA_PASSWORD || undefined;

  if (username && password) {
    return { tipo: "env", credenziali: { username, password } };
  }
  if (username || password) {
    const mancante = username ? "ARUBA_PASSWORD" : "ARUBA_USERNAME";
    return {
      tipo: "errore",
      messaggio:
        `Errore: manca ${mancante}. Impostare entrambe ARUBA_USERNAME e ARUBA_PASSWORD` +
        (piattaforma === "win32" ? ", oppure nessuna delle due per usare Windows Hello." : "."),
    };
  }
  if (piattaforma === "win32") return { tipo: "hello" };
  return {
    tipo: "errore",
    messaggio: "Errore: impostare le variabili d'ambiente ARUBA_USERNAME e ARUBA_PASSWORD.",
  };
}

/**
 * In modalità Windows Hello le credenziali sono quelle del pannello web, cioè
 * di produzione: con il predefinito storico "demo" i server di prova le
 * rifiuterebbero. Un valore esplicito vince sempre.
 */
export function scegliAmbiente(
  env: Record<string, string | undefined>,
  modalitaHello: boolean,
): string {
  return env.ARUBA_ENVIRONMENT || (modalitaHello ? "production" : "demo");
}
