/**
 * Partita IVA e codice fiscale del titolare, necessari per distinguere le
 * fatture emesse da quelle ricevute. Si leggono da `userInfo`, con fallback
 * alle variabili d'ambiente se l'account non è raggiungibile (archivio
 * utilizzabile anche offline).
 */

import type { Titolare } from "./archivio.js";
import {
  HelloNonDisponibileError,
  SbloccoAnnullatoError,
  SbloccoInCorsoError,
  TroppiTentativiError,
  VaultIllegibileError,
} from "./credenziali/tipi.js";

/** Errori dello sblocco: vanno mostrati all'utente, non coperti da un ripiego. */
const ERRORI_SBLOCCO = [
  SbloccoAnnullatoError,
  SbloccoInCorsoError,
  TroppiTentativiError,
  HelloNonDisponibileError,
  VaultIllegibileError,
];

export function creaTitolare(opz: {
  daEnv: Titolare;
  modalitaHello: boolean;
  userInfo: () => Promise<unknown>;
}): () => Promise<Titolare> {
  let cache: Titolare | null = null;
  const { daEnv } = opz;

  return async () => {
    if (cache) return cache;

    // In modalità Hello i tool sull'archivio locale non devono chiedere uno
    // sblocco se l'utente ha già indicato i propri dati fiscali.
    if (opz.modalitaHello && (daEnv.partitaIva || daEnv.codiceFiscale)) {
      cache = daEnv;
      return cache;
    }

    try {
      const info = (await opz.userInfo()) as { vatCode?: string; fiscalCode?: string };
      cache = {
        partitaIva: info.vatCode ?? daEnv.partitaIva,
        codiceFiscale: info.fiscalCode ?? daEnv.codiceFiscale,
      };
      return cache;
    } catch (errore) {
      if (opz.modalitaHello) {
        if (ERRORI_SBLOCCO.some((E) => errore instanceof E)) throw errore;
        // Ripiego senza memorizzarlo: con dati fiscali vuoti la classificazione
        // sarebbe sbagliata per tutta la sessione, meglio riprovare alla
        // prossima chiamata.
        return daEnv;
      }
      cache = daEnv;
      return cache;
    }
  };
}
