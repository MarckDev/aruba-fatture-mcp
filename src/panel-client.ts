/**
 * Client per l'API privata del pannello web di Aruba Fatturazione Elettronica.
 *
 * Le API ufficiali (`ws.fatturazioneelettronica.aruba.it`) richiedono un'utenza
 * Premium: con un'utenza base rispondono 401 per deleghe mancanti. Il pannello
 * web, invece, è accessibile a qualunque utenza e parla con un backend REST
 * interno (`/services/*`) dietro un login OpenID Connect (Keycloak).
 *
 * Questo client replica il flusso di login del browser (authorization code +
 * form Keycloak) senza browser: il reCAPTCHA della pagina non è imposto lato
 * server, quindi il POST delle credenziali basta a ottenere il code. Ottenuta
 * la sessione, le chiamate `/services/*` usano il cookie di sessione più gli
 * header applicativi che il pannello aggiunge (`aru-sub`, `aru-delegator`).
 *
 * ATTENZIONE: è un'API non documentata, ricavata dal pannello. Può cambiare
 * senza preavviso; va usata solo per accedere ai propri dati.
 */

import type { Credenziali, FonteCredenziali } from "./credenziali/tipi.js";

const PANEL_ORIGIN = "https://fatturazioneelettronica.aruba.it";

export class PanelError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "PanelError";
  }
}

/** Cookie jar minimale per host: il flusso di login attraversa due domini. */
class CookieJar {
  private byHost = new Map<string, Map<string, string>>();

  store(host: string, setCookies: string[]): void {
    if (!setCookies.length) return;
    const jar = this.byHost.get(host) ?? new Map<string, string>();
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // Un valore "deleted"/vuoto rimuove il cookie (logout lato server).
      if (!value || value === "deleted") jar.delete(name);
      else jar.set(name, value);
    }
    this.byHost.set(host, jar);
  }

  header(host: string): string | undefined {
    const jar = this.byHost.get(host);
    if (!jar || jar.size === 0) return undefined;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/**
 * `fetch` con Node restituisce gli header `set-cookie` uniti in una sola
 * stringa: questo helper li ri-separa rispettando le virgole interne alle date
 * (`expires=Wed, 09 Jun 2027 ...`).
 */
function splitSetCookie(headers: Headers): string[] {
  // Node ≥ 18.14 espone getSetCookie(); fallback al parsing manuale.
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  if (!raw) return [];
  return raw.split(/,(?=[^;]+?=)/);
}

interface PanelSession {
  credenziali: Credenziali;
  createdAt: number;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export type EsitoLogin = "ok" | "otp" | "rifiutata";

/**
 * Interpreta la risposta di Keycloak al POST delle credenziali.
 *
 * Keycloak mostra la pagina del codice monouso solo dopo aver accettato la
 * password, quindi "otp" significa anche "password corretta". Un form di login
 * riproposto significa invece password rifiutata. Tutto il resto (rate limit,
 * errori del server, pagine sconosciute) non dice nulla sulla password.
 */
export function classificaRispostaLogin(
  status: number,
  location: string | null,
  html: string,
): EsitoLogin | "sconosciuto" {
  if (status === 302) {
    return location && /[?&]code=/.test(location) ? "ok" : "sconosciuto";
  }
  if (status === 429 || status >= 500) return "sconosciuto";
  if (/<input[^>]*\sname=["'](otp|totp)["']/i.test(html)) return "otp";
  if (/<input[^>]*\sname=["']password["']/i.test(html)) return "rifiutata";
  return "sconosciuto";
}

/** Richieste HTTP senza redirect automatici, con un cookie jar per host. */
class SessioneHttp {
  readonly jar = new CookieJar();

  async raw(url: string, init: RequestInit & { body?: string } = {}): Promise<Response> {
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    const cookie = this.jar.header(host);
    if (cookie) headers.set("Cookie", cookie);

    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    this.jar.store(host, splitSetCookie(res.headers));
    return res;
  }

  /** Segue i redirect manualmente, riapplicando i cookie del dominio di arrivo. */
  async follow(url: string, maxHops = 10): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < maxHops; hop++) {
      const res = await this.raw(current);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return res;
        current = new URL(location, current).toString();
        continue;
      }
      return res;
    }
    throw new PanelError("Troppi redirect durante il login.", 0, current);
  }
}

const MESSAGGIO_OTP =
  "Login Aruba non riuscito: sull'account è attiva la verifica in due passaggi, non ancora supportata dai tool del pannello. La password è corretta.";

/**
 * Passi 1–3 del login OpenID Connect (authorization code): avvio dal gateway,
 * pagina di login Keycloak, POST delle credenziali. Restituisce l'esito e, se
 * riuscito, l'URL col code da riportare al gateway.
 */
async function inviaCredenziali(
  sessione: SessioneHttp,
  cred: Credenziali,
): Promise<{ esito: EsitoLogin; codeUrl: string; corpo: string }> {
  // 1) Avvio dal gateway: risponde 302 verso Keycloak e setta il cookie di
  //    sessione con cui, al ritorno, assocerà il code al giusto stato.
  const start = await sessione.raw(`${PANEL_ORIGIN}/api/oauth2/authorization/gateway`);
  const keycloakUrl = start.headers.get("location");
  if (start.status < 300 || start.status >= 400 || !keycloakUrl) {
    const body = await start.text();
    throw new PanelError(
      "Avvio del login non riuscito: il gateway non ha reindirizzato a Keycloak.",
      start.status,
      body,
    );
  }

  // 2) Pagina di login Keycloak: se ne estrae l'action del form.
  const loginPage = await sessione.follow(keycloakUrl);
  const html = await loginPage.text();
  const action = extractFormAction(html);
  if (!action) {
    throw new PanelError(
      "Form di login Keycloak non trovato: la pagina è cambiata o l'utenza è bloccata.",
      loginPage.status,
      html.slice(0, 400),
    );
  }

  // 3) POST delle credenziali: risposta 302 con il code verso il gateway.
  const form = new URLSearchParams({
    username: cred.username,
    password: cred.password,
    credentialId: "",
  });
  const posted = await sessione.raw(action, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const location = posted.headers.get("location");
  const corpo = location ?? (await posted.text());
  const esito = classificaRispostaLogin(posted.status, location, corpo);
  if (esito === "sconosciuto") {
    const hint =
      posted.status === 429
        ? "Troppi tentativi di accesso: attendi qualche minuto e riprova."
        : "Risposta inattesa dal server di autenticazione.";
    throw new PanelError(`Login Aruba non riuscito. ${hint}`, posted.status, corpo.slice(0, 400));
  }
  return { esito, codeUrl: location ?? "", corpo };
}

function extractFormAction(html: string): string | null {
  const match = html.match(/<form[^>]*\saction="([^"]+)"/i);
  if (!match) return null;
  return match[1].replace(/&amp;/g, "&");
}

/**
 * Verifica username e password con un login reale al pannello, senza tenere
 * la sessione: serve a controllare le credenziali prima di salvarle. Lancia
 * PanelError quando la risposta non dice nulla sulla password (es. 429).
 */
export async function verificaLoginPannello(cred: Credenziali): Promise<EsitoLogin> {
  const { esito } = await inviaCredenziali(new SessioneHttp(), cred);
  return esito;
}

export class ArubaPanelClient {
  private sessione = new SessioneHttp();
  private session: PanelSession | null = null;
  private loginInFlight: Promise<void> | null = null;
  /** La sessione del gateway dura a lungo, ma la si rinnova per prudenza. */
  private readonly sessionTtlMs = 20 * 60 * 1000;

  constructor(private readonly fonte: FonteCredenziali) {}

  // -- Login OpenID Connect (authorization code) --

  private async doLogin(): Promise<void> {
    const cred = await this.fonte.ottieni();
    const { esito, codeUrl, corpo } = await inviaCredenziali(this.sessione, cred);
    if (esito === "rifiutata") {
      this.fonte.segnalaRifiuto(cred);
      throw new PanelError(
        "Login Aruba non riuscito. Credenziali rifiutate: verifica username e password." +
          this.fonte.suggerimentoRifiuto,
        0,
        corpo.slice(0, 400),
      );
    }
    if (esito === "otp") throw new PanelError(MESSAGGIO_OTP, 0, "");

    // 4) Ritorno al gateway col code: stabilisce la sessione applicativa.
    const landing = await this.sessione.follow(codeUrl);
    if (landing.status >= 400) {
      throw new PanelError(
        "Scambio del code col gateway non riuscito.",
        landing.status,
        await landing.text(),
      );
    }

    this.session = { credenziali: cred, createdAt: Date.now() };
  }

  /** Garantisce una sessione valida, serializzando i login concorrenti. */
  private async ensureSession(force = false): Promise<PanelSession> {
    if (
      !force &&
      this.session &&
      Date.now() - this.session.createdAt < this.sessionTtlMs
    ) {
      return this.session;
    }
    if (!this.loginInFlight) {
      this.sessione = new SessioneHttp();
      this.session = null;
      this.loginInFlight = this.doLogin().finally(() => {
        this.loginInFlight = null;
      });
    }
    await this.loginInFlight;
    return this.session!;
  }

  // -- Chiamate ai servizi del pannello --

  /**
   * Chiamata a `/services/<path>`. Il pannello usa POST per la quasi totalità
   * degli endpoint; alcuni (es. cancellazione bozza) richiedono DELETE. Alla
   * prima 401 riprova una volta con un nuovo login: la sessione può scadere
   * lato server prima del TTL locale.
   */
  async service<T = unknown>(
    path: string,
    body: unknown = {},
    method: "POST" | "DELETE" = "POST",
  ): Promise<T> {
    let { credenziali } = await this.ensureSession();

    const doCall = () =>
      this.sessione.raw(`${PANEL_ORIGIN}/services/${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "aru-sub": credenziali.username,
          "aru-delegator": credenziali.username,
        },
        body: JSON.stringify(body),
      });

    let res = await doCall();
    if (res.status === 401) {
      ({ credenziali } = await this.ensureSession(true));
      res = await doCall();
    }
    if (!res.ok) {
      throw new PanelError(
        `Errore dal pannello Aruba su ${path} (HTTP ${res.status}).`,
        res.status,
        await res.text(),
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Scarica tutte le pagine di un endpoint di ricerca (`advancedSearch`,
   * `DtClienteList`, ...): il pannello ignora i filtri data lato server, quindi
   * si recupera l'intero anno e si filtra a valle.
   */
  async serviceAll<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown> = {},
    pageSize = 200,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    // Limite di sicurezza contro loop imprevisti sul conteggio pagine.
    for (let guard = 0; guard < 500; guard++) {
      const res = await this.service<{
        Items?: T[];
        Count?: number;
        Pages?: number;
      }>(path, { ...body, PageNumber: page, PageSize: pageSize });
      const batch = res.Items ?? [];
      items.push(...batch);
      const totalPages = res.Pages ?? 1;
      if (page >= totalPages || batch.length === 0) break;
      page++;
    }
    return items;
  }
}
