/**
 * Client per le API di Aruba Fatturazione Elettronica (v2).
 * Documentazione: https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Credenziali, FonteCredenziali } from "./credenziali/tipi.js";

const ENDPOINTS = {
  demo: {
    auth: "https://demoauth.fatturazioneelettronica.aruba.it",
    api: "https://demows.fatturazioneelettronica.aruba.it",
  },
  production: {
    auth: "https://auth.fatturazioneelettronica.aruba.it",
    api: "https://ws.fatturazioneelettronica.aruba.it",
  },
} as const;

export type ArubaEnvironment = keyof typeof ENDPOINTS;

export class ArubaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "ArubaApiError";
  }
}

interface SigninResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  userName: string;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export class ArubaClient {
  private accessToken: string | null = null;
  private accessTokenExpiry = 0;
  private refreshToken: string | null = null;
  private refreshTokenExpiry = 0;
  private tokenAcquisition: Promise<string> | null = null;
  private tokenCachePath: string | null = null;

  /**
   * Con `persistiToken` il token è condiviso tra processi tramite un file in
   * %TEMP%: /auth/signin ha un rate limit severo, quindi ogni login evitato
   * conta. In modalità Windows Hello resta invece solo in memoria, perché quel
   * file darebbe accesso all'account senza password.
   */
  constructor(
    private readonly fonte: FonteCredenziali,
    private readonly environment: ArubaEnvironment,
    private readonly opzioni: { persistiToken: boolean },
  ) {}

  /** Alla prima chiamata: il nome del file dipende dallo username. */
  private async prepareTokenCache(): Promise<void> {
    if (!this.opzioni.persistiToken || this.tokenCachePath) return;
    const { username } = await this.fonte.ottieni();
    this.tokenCachePath = join(
      tmpdir(),
      `aruba-fatture-mcp-token-${this.environment}-${createHash("sha256").update(username).digest("hex").slice(0, 12)}.json`,
    );
    this.loadCachedToken();
  }

  private loadCachedToken(): void {
    if (!this.tokenCachePath) return;
    try {
      const cached = JSON.parse(readFileSync(this.tokenCachePath, "utf8"));
      if (typeof cached.accessToken === "string" && typeof cached.accessTokenExpiry === "number") {
        this.accessToken = cached.accessToken;
        this.accessTokenExpiry = cached.accessTokenExpiry;
        this.refreshToken = cached.refreshToken ?? null;
        this.refreshTokenExpiry = cached.refreshTokenExpiry ?? 0;
      }
    } catch {
      // Nessuna cache o cache illeggibile: si parte senza token.
    }
  }

  private saveCachedToken(): void {
    if (!this.tokenCachePath) return;
    try {
      writeFileSync(
        this.tokenCachePath,
        JSON.stringify({
          accessToken: this.accessToken,
          accessTokenExpiry: this.accessTokenExpiry,
          refreshToken: this.refreshToken,
          refreshTokenExpiry: this.refreshTokenExpiry,
        }),
        { mode: 0o600 },
      );
    } catch {
      // La cache è solo un'ottimizzazione: gli errori di scrittura non bloccano.
    }
  }

  private get urls() {
    return ENDPOINTS[this.environment];
  }

  /** `cred` è passato solo per il login con password: i suoi rifiuti vanno segnalati. */
  private async signin(body: URLSearchParams, cred?: Credenziali): Promise<void> {
    const res = await fetch(`${this.urls.auth}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      // 400/401 al login con password è l'unico caso che dice qualcosa sulla
      // password: rate limit ed errori del server non devono farla richiedere.
      // In demo le credenziali (quelle del pannello, di produzione) non sono
      // valide per definizione: un rifiuto non dice nulla sulla password.
      const rifiutata =
        cred !== undefined &&
        this.environment === "production" &&
        (res.status === 400 || res.status === 401);
      if (rifiutata) this.fonte.segnalaRifiuto(cred);
      const hint =
        res.status === 429
          ? "Rate limit di Aruba sull'autenticazione: attendi qualche minuto e riprova."
          : `Verifica username/password e ambiente (${this.environment}).` +
            (rifiutata ? this.fonte.suggerimentoRifiuto : "");
      throw new ArubaApiError(
        `Autenticazione Aruba fallita (HTTP ${res.status}). ${hint}`,
        res.status,
        text,
      );
    }
    const data = (await res.json()) as SigninResponse;
    this.accessToken = data.access_token;
    // Margine di 60s per evitare di usare token in scadenza.
    this.accessTokenExpiry = Date.now() + (data.expires_in ?? 1800) * 1000 - 60_000;
    this.refreshToken = data.refresh_token;
    // Il refresh token vale 60 minuti.
    this.refreshTokenExpiry = Date.now() + 60 * 60 * 1000 - 60_000;
    this.saveCachedToken();
  }

  /**
   * Serializza l'acquisizione del token: più chiamate concorrenti condividono
   * lo stesso login invece di generare richieste multiple verso /auth/signin
   * (che è soggetto a rate limit severi).
   */
  private async ensureToken(forceNew = false): Promise<string> {
    await this.prepareTokenCache();
    if (!forceNew && this.accessToken && Date.now() < this.accessTokenExpiry) {
      return this.accessToken;
    }
    if (this.tokenAcquisition) return this.tokenAcquisition;
    this.tokenAcquisition = this.acquireToken(forceNew).finally(() => {
      this.tokenAcquisition = null;
    });
    return this.tokenAcquisition;
  }

  private async acquireToken(forceNew: boolean): Promise<string> {
    if (!forceNew && this.refreshToken && Date.now() < this.refreshTokenExpiry) {
      try {
        await this.signin(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.refreshToken,
          }),
        );
        return this.accessToken!;
      } catch {
        // Refresh fallito: si riprova con il login completo.
      }
    }
    const cred = await this.fonte.ottieni();
    await this.signin(
      new URLSearchParams({
        grant_type: "password",
        username: cred.username,
        password: cred.password,
      }),
      cred,
    );
    return this.accessToken!;
  }

  private async rawRequest(
    baseUrl: string,
    path: string,
    options: {
      method?: string;
      query?: QueryParams;
      jsonBody?: unknown;
    } = {},
  ): Promise<Response> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const doFetch = async (token: string) =>
      fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(options.jsonBody !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body:
          options.jsonBody !== undefined
            ? JSON.stringify(options.jsonBody)
            : undefined,
      });

    let res = await doFetch(await this.ensureToken());
    if (res.status === 401) {
      const body = await res.clone().text();
      if (/deleg/i.test(body)) {
        // 401 per permessi mancanti, non per token scaduto: un nuovo login
        // non risolverebbe e consumerebbe solo il rate limit di /auth/signin.
        throw new ArubaApiError(
          "Operazione non autorizzata per questa utenza: l'uso delle API (ricerca, lettura e invio fatture) richiede un'utenza Premium o una delega da un'utenza Premium.",
          res.status,
          body,
        );
      }
      // Token non più valido lato server: nuovo login e un solo retry.
      res = await doFetch(await this.ensureToken(true));
    }
    if (!res.ok) {
      const text = await res.text();
      throw new ArubaApiError(
        `Errore API Aruba: HTTP ${res.status} su ${options.method ?? "GET"} ${url.pathname}`,
        res.status,
        text,
      );
    }
    return res;
  }

  /** Chiamata JSON verso l'host dei web service (ws.fatturazioneelettronica.aruba.it). */
  async apiJson<T = unknown>(
    path: string,
    options: { method?: string; query?: QueryParams; jsonBody?: unknown } = {},
  ): Promise<T> {
    const res = await this.rawRequest(this.urls.api, path, options);
    return (await res.json()) as T;
  }

  /** Chiamata binaria (ZIP/PDD) verso l'host dei web service. */
  async apiBinary(path: string, query: QueryParams): Promise<Buffer> {
    const res = await this.rawRequest(this.urls.api, path, { query });
    return Buffer.from(await res.arrayBuffer());
  }

  /** GET /auth/userInfo — attenzione: risiede sull'host di autenticazione. */
  async userInfo(): Promise<unknown> {
    const res = await this.rawRequest(this.urls.auth, "/auth/userInfo");
    return res.json();
  }
}
