/**
 * Backend transport seam for the Friday web/iOS plan (plan v2, §3).
 *
 * ADDITIVE ONLY: this module is not imported anywhere yet, so the running
 * Tauri app cannot be affected by it. It declares the contract the future
 * `WebBackend` (fetch → web-api) must satisfy, alongside the current
 * `TauriBackend` (invoke → Rust commands, unchanged behavior).
 *
 * Tier mapping (plan v2, §1):
 * - Tier A (pure passthrough): `magister(path, init)` forwards to the
 *   generic proxy; no per-endpoint code on either side.
 * - Tier B (aggregation): implemented here in TypeScript on top of
 *   `magister()`, operating on the same raw JSON the proxy passes through.
 * - Tier C (auth/AI/export): dedicated methods below.
 */

// Tokens live in the browser (IndexedDB via cache.ts patterns). The backend
// never sees them except as a per-request Authorization header.
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO-8601
  apiEndpoint: string;
  personId: number | null;
}

export interface PasswordLoginResult {
  tokens: SessionTokens;
  accountId: string;
}

export type MagisterMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** HTTP failure from web-api. `status` drives refresh/logout decisions. */
export class WebApiError extends Error {
  readonly status: number;
  /** Server correlation ID — matches a line in the Render logs. */
  ref?: string;
  constructor(status: number, message: string, ref?: string) {
    super(message);
    this.name = "WebApiError";
    this.status = status;
    this.ref = ref;
  }
  /** Display string with the ref appended when present. */
  withRef(): string {
    return this.ref ? `${this.message} (ref: ${this.ref})` : this.message;
  }
}

function errorRef(data: unknown): string | undefined {
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>)["ref"] === "string") {
    return (data as Record<string, unknown>)["ref"] as string;
  }
  return undefined;
}

/** Throw a WebApiError preferring the server's Dutch message + ref. */
async function throwApiError(res: Response, fallback: string): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof data["error"] === "string" ? (data["error"] as string) : fallback;
  throw new WebApiError(res.status, message, errorRef(data));
}

export interface Backend {
  readonly kind: "tauri" | "web";
  /** Password-form login (school + username + password). No browser redirect. */
  login(school: string, username: string, password: string): Promise<PasswordLoginResult>;
  /** Tier-A passthrough: one authenticated Magister call. */
  magister<T>(tokens: SessionTokens, method: MagisterMethod, path: string, body?: unknown): Promise<T>;
  /** Refresh an expiring session. Returns fresh tokens. */
  refresh(tokens: SessionTokens): Promise<SessionTokens>;
  logout(tokens: SessionTokens): Promise<void>;
}

/** Current behavior, unchanged: delegates to src/lib/api.ts (Tauri invoke). */
export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;

  async login(_school: string, _username: string, _password: string): Promise<PasswordLoginResult> {
    // Desktop keeps the OAuth system-browser flow (startLoginFlow +
    // deep-link callback in +layout.svelte). Password login is web-only.
    throw new Error("Password login is only available in the web build; use Magister login in this app.");
  }

  async magister<T>(_tokens: SessionTokens, _method: MagisterMethod, _path: string, _body?: unknown): Promise<T> {
    // Tier-A calls on desktop stay as the existing per-command invoke()
    // wrappers in api.ts (they add Tier-B shaping in Rust today).
    throw new Error("Use the existing api.ts command wrappers on desktop.");
  }

  async refresh(tokens: SessionTokens): Promise<SessionTokens> {
    const api = await import("./api");
    const status = await api.restoreSession();
    if (status !== "restored") throw new Error(`Session refresh failed: ${status}`);
    return tokens;
  }

  async logout(_tokens: SessionTokens): Promise<void> {
    const api = await import("./api");
    await api.logout();
  }
}

function apiBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.["VITE_API_URL"] ?? "/api";
}

/** Web build: stateless fetch against web-api. Tokens stay in the browser. */
export class WebBackend implements Backend {
  readonly kind = "web" as const;
  private readonly base: string;

  constructor(base?: string) {
    this.base = (base ?? apiBase()).replace(/\/$/, "");
  }

  async login(school: string, username: string, password: string): Promise<PasswordLoginResult> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ school, username, password }),
      });
    } catch {
      throw new WebApiError(0, "Geen verbinding met de server.");
    }
    if (!res.ok) {
      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new WebApiError(429, "Te vaak geprobeerd, wacht een minuut.", errorRef(data));
      }
      await throwApiError(res, `Inloggen mislukt (HTTP ${res.status})`);
    }
    return (await res.json()) as PasswordLoginResult;
  }

  /** Raw-bytes GET (photos, files). 404 → null (no photo set). */
  async magisterBytes(tokens: SessionTokens, path: string): Promise<Uint8Array | null> {
    const res = await fetch(`${this.base}/magister/${path.replace(/^\//, "")}`, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "X-Magister-Endpoint": tokens.apiEndpoint,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) await throwApiError(res, `Verzoek mislukt (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * BYO-key AI forward (`chat` | `validate` | `models`). The API key travels
   * per-request in memory only — the server never logs, stores, or caches it.
   */
  async aiProxy<T>(op: "chat" | "validate" | "models", body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/ai/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new WebApiError(0, "Geen verbinding met de server.");
    }
    if (!res.ok) await throwApiError(res, `AI-verzoek mislukt (HTTP ${res.status})`);
    return ((await res.json().catch(() => ({}))) as T);
  }

  async magister<T>(tokens: SessionTokens, method: MagisterMethod, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/magister/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${tokens.accessToken}`,
        "X-Magister-Endpoint": tokens.apiEndpoint,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new WebApiError(429, "Te veel verzoeken, probeer het later opnieuw", errorRef(data));
    }
    if (!res.ok) await throwApiError(res, `Magister-verzoek mislukt (HTTP ${res.status})`);
    return (await res.json()) as T;
  }

  async refresh(tokens: SessionTokens): Promise<SessionTokens> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refreshToken, apiEndpoint: tokens.apiEndpoint }),
      });
    } catch {
      throw new WebApiError(0, "Geen verbinding met de server.");
    }
    if (!res.ok) await throwApiError(res, `Verversen mislukt (HTTP ${res.status})`);
    const fresh = (await res.json()) as SessionTokens;
    // The server never learns personId on refresh; keep the browser's own.
    if (fresh.personId == null) fresh.personId = tokens.personId;
    return fresh;
  }

  async logout(tokens: SessionTokens): Promise<void> {
    // Stateless server: nothing to invalidate. Best-effort notify only.
    try {
      await fetch(`${this.base}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
    } catch {
      // Logout must succeed locally even when offline.
    }
  }
}

/** Feature-detect the Tauri runtime (same check +layout.svelte already uses). */
export function currentBackend(): Backend {
  if (typeof window !== "undefined" && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
    return new TauriBackend();
  }
  return new WebBackend();
}
