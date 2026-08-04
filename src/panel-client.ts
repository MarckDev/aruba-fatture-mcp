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
  username: string;
  createdAt: number;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export class ArubaPanelClient {
  private jar = new CookieJar();
  private session: PanelSession | null = null;
  private loginInFlight: Promise<void> | null = null;
  /** La sessione del gateway dura a lungo, ma la si rinnova per prudenza. */
  private readonly sessionTtlMs = 20 * 60 * 1000;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  // -- Basso livello: richiesta senza seguire i redirect, con cookie per host --

  private async raw(
    url: string,
    init: RequestInit & { body?: string } = {},
  ): Promise<Response> {
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
  private async follow(url: string, maxHops = 10): Promise<Response> {
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

  // -- Login OpenID Connect (authorization code) --

  private async doLogin(): Promise<void> {
    // 1) Avvio dal gateway: risponde 302 verso Keycloak e setta il cookie di
    //    sessione con cui, al ritorno, assocerà il code al giusto stato.
    const start = await this.raw(`${PANEL_ORIGIN}/api/oauth2/authorization/gateway`);
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
    const loginPage = await this.follow(keycloakUrl);
    const html = await loginPage.text();
    const action = this.extractFormAction(html);
    if (!action) {
      // Già autenticato lato Keycloak: la pagina può contenere direttamente il
      // redirect col code. Improbabile ad avvio pulito, ma gestito.
      throw new PanelError(
        "Form di login Keycloak non trovato: la pagina è cambiata o l'utenza è bloccata.",
        loginPage.status,
        html.slice(0, 400),
      );
    }

    // 3) POST delle credenziali: risposta 302 con il code verso il gateway.
    const form = new URLSearchParams({
      username: this.username,
      password: this.password,
      credentialId: "",
    });
    const posted = await this.raw(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const codeUrl = posted.headers.get("location");
    if (posted.status !== 302 || !codeUrl || !/[?&]code=/.test(codeUrl)) {
      const body = codeUrl ?? (await posted.text());
      const hint = /error|login-actions/i.test(body)
        ? "Credenziali rifiutate: verifica username e password."
        : "Risposta inattesa dal server di autenticazione.";
      throw new PanelError(`Login Aruba non riuscito. ${hint}`, posted.status, body);
    }

    // 4) Ritorno al gateway col code: stabilisce la sessione applicativa.
    const landing = await this.follow(codeUrl);
    if (landing.status >= 400) {
      throw new PanelError(
        "Scambio del code col gateway non riuscito.",
        landing.status,
        await landing.text(),
      );
    }

    this.session = { username: this.username, createdAt: Date.now() };
  }

  private extractFormAction(html: string): string | null {
    const match = html.match(/<form[^>]*\saction="([^"]+)"/i);
    if (!match) return null;
    return match[1].replace(/&amp;/g, "&");
  }

  /** Garantisce una sessione valida, serializzando i login concorrenti. */
  private async ensureSession(force = false): Promise<void> {
    if (
      !force &&
      this.session &&
      Date.now() - this.session.createdAt < this.sessionTtlMs
    ) {
      return;
    }
    if (this.loginInFlight) return this.loginInFlight;
    this.jar = new CookieJar();
    this.session = null;
    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  // -- Chiamate ai servizi del pannello --

  /**
   * POST verso `/services/<path>`. Alla prima 401 riprova una volta con un
   * nuovo login: la sessione può scadere lato server prima del TTL locale.
   */
  async service<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    await this.ensureSession();

    const doCall = () =>
      this.raw(`${PANEL_ORIGIN}/services/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "aru-sub": this.username,
          "aru-delegator": this.username,
        },
        body: JSON.stringify(body),
      });

    let res = await doCall();
    if (res.status === 401) {
      await this.ensureSession(true);
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
