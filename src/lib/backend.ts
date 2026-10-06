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
  /** Honoured `Retry-After` (ms), when the server sent one. */
  retryAfterMs?: number;
  constructor(
    status: number,
    message: string,
    ref?: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "WebApiError";
    this.status = status;
    this.ref = ref;
    this.retryAfterMs = retryAfterMs;
  }
  /** Display string with the ref appended when present. */
  withRef(): string {
    return this.ref ? `${this.message} (ref: ${this.ref})` : this.message;
  }
}

function errorRef(data: unknown): string | undefined {
  if (
    data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>)["ref"] === "string"
  ) {
    return (data as Record<string, unknown>)["ref"] as string;
  }
  return undefined;
}

/** Throw a WebApiError preferring the server's Dutch message + ref. */
async function throwApiError(res: Response, fallback: string): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message =
    typeof data["error"] === "string" ? (data["error"] as string) : fallback;
  throw new WebApiError(res.status, message, errorRef(data), retryAfterMs(res));
}

/** Parse `Retry-After` (seconds or HTTP-date) into ms, if present. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

// --- Render free-tier cold start -------------------------------------------
// The free web service sleeps after ~15 min without traffic and Render's edge
// answers 502/503/504 while the instance wakes (~30-60 s). A refused/dropped
// connection surfaces here as status 0. All of those mean "the server is
// (re)starting", never "the user did something wrong".

/** Dutch message shown while the free-tier instance wakes up. */
export const SERVER_STARTING_MESSAGE =
  "De server wordt opgestart, even geduld…";

/** 502/503/504 from the API origin, or no response at all (status 0). */
export function isServerStartingStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export function isServerStartingError(e: unknown): boolean {
  return e instanceof WebApiError && isServerStartingStatus(e.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Backoff steps (~3-5 s) totalling ~60 s of sleep; with request time on top
 *  the whole wait lands at ~60-90 s, enough for a Render cold start. */
const COLD_START_DELAYS_MS = [
  3000, 3000, 4000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000,
];

/**
 * Run `fn`, retrying "server starting" failures (502/503/504 + network
 * failure) with backoff up to ~60-90 s total. Anything else throws
 * immediately. On exhaustion the final error carries
 * SERVER_STARTING_MESSAGE so the UI can show it verbatim.
 */
export async function withServerStartingRetry<T>(
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isServerStartingError(e)) throw e;
      const wait = COLD_START_DELAYS_MS.at(attempt);
      if (wait === undefined) {
        if (e instanceof WebApiError && e.message !== SERVER_STARTING_MESSAGE)
          throw new WebApiError(e.status, SERVER_STARTING_MESSAGE, e.ref);
        throw e;
      }
      await sleep(wait);
    }
  }
}

export interface SseFrame {
  event: string;
  /** JSON-parsed payload, or the raw string when it isn't JSON. */
  data: unknown;
}

/**
 * Pull complete SSE frames off the front of `buffer` (mirrors the proxy's
 * `split_sse_frames`). Comment-only frames are dropped; the remainder stays
 * buffered for the next chunk. Never throws.
 */
export function extractSseEvents(buffer: string): {
  events: SseFrame[];
  rest: string;
} {
  const events: SseFrame[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value.trim() || "message";
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // Keep the raw string.
    }
    events.push({ event, data });
  }
  return { events, rest };
}

export interface Backend {
  readonly kind: "tauri" | "web";
  /** Password-form login (school + username + password). No browser redirect. */
  login(
    school: string,
    username: string,
    password: string,
  ): Promise<PasswordLoginResult>;
  /** Tier-A passthrough: one authenticated Magister call. */
  magister<T>(
    tokens: SessionTokens,
    method: MagisterMethod,
    path: string,
    body?: unknown,
  ): Promise<T>;
  /** Refresh an expiring session. Returns fresh tokens. */
  refresh(tokens: SessionTokens): Promise<SessionTokens>;
  logout(tokens: SessionTokens): Promise<void>;
}

/** Current behavior, unchanged: delegates to src/lib/api.ts (Tauri invoke). */
export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;

  async login(
    _school: string,
    _username: string,
    _password: string,
  ): Promise<PasswordLoginResult> {
    // Desktop keeps the OAuth system-browser flow (startLoginFlow +
    // deep-link callback in +layout.svelte). Password login is web-only.
    throw new Error(
      "Password login is only available in the web build; use Magister login in this app.",
    );
  }

  async magister<T>(
    _tokens: SessionTokens,
    _method: MagisterMethod,
    _path: string,
    _body?: unknown,
  ): Promise<T> {
    // Tier-A calls on desktop stay as the existing per-command invoke()
    // wrappers in api.ts (they add Tier-B shaping in Rust today).
    throw new Error("Use the existing api.ts command wrappers on desktop.");
  }

  async refresh(tokens: SessionTokens): Promise<SessionTokens> {
    const api = await import("./api");
    const status = await api.restoreSession();
    if (status !== "restored")
      throw new Error(`Session refresh failed: ${status}`);
    return tokens;
  }

  async logout(_tokens: SessionTokens): Promise<void> {
    const api = await import("./api");
    await api.logout();
  }
}

function apiBase(): string {
  const env = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  return env?.["VITE_API_URL"] ?? "/api";
}

/** Web build: stateless fetch against web-api. Tokens stay in the browser. */
export class WebBackend implements Backend {
  readonly kind = "web" as const;
  private readonly base: string;

  constructor(base?: string) {
    this.base = (base ?? apiBase()).replace(/\/$/, "");
  }

  async login(
    school: string,
    username: string,
    password: string,
  ): Promise<PasswordLoginResult> {
    // Cold start: the free-tier instance may be asleep, so this POST can meet
    // a 502/503/504 from Render's edge or a refused connection while the
    // instance wakes (~30-60 s).
    // - No response received (network failure): nothing was submitted, so
    //   retry with backoff up to ~60-90 s total.
    // - A 502/503/504 response WAS received: the POST may have reached the
    //   app, and login is rate-limited (5/min) — retry at most ONCE, then
    //   surface the "server wordt opgestart" message.
    let respondedRetryUsed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.base}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ school, username, password }),
        });
      } catch {
        const wait = COLD_START_DELAYS_MS.at(attempt);
        if (wait === undefined)
          throw new WebApiError(0, SERVER_STARTING_MESSAGE);
        await sleep(wait);
        continue;
      }
      if (isServerStartingStatus(res.status)) {
        if (!respondedRetryUsed) {
          respondedRetryUsed = true;
          await sleep(4000);
          continue;
        }
        throw new WebApiError(res.status, SERVER_STARTING_MESSAGE);
      }
      if (!res.ok) {
        if (res.status === 429) {
          const data = (await res.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          throw new WebApiError(
            429,
            "Te vaak geprobeerd, wacht een minuut.",
            errorRef(data),
          );
        }
        await throwApiError(res, `Inloggen mislukt (HTTP ${res.status})`);
      }
      return (await res.json()) as PasswordLoginResult;
    }
  }

  /** Raw-bytes GET (photos, files). 404 → null (no photo set). */
  async magisterBytes(
    tokens: SessionTokens,
    path: string,
  ): Promise<Uint8Array | null> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/magister/${path.replace(/^\//, "")}`, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "X-Magister-Endpoint": tokens.apiEndpoint,
        },
      });
    } catch {
      // No response at all: waking free-tier instance or offline. The
      // caller (web-session) retries these with backoff.
      throw new WebApiError(0, SERVER_STARTING_MESSAGE);
    }
    if (res.status === 404) return null;
    if (isServerStartingStatus(res.status))
      throw new WebApiError(res.status, SERVER_STARTING_MESSAGE);
    if (!res.ok)
      await throwApiError(res, `Verzoek mislukt (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * BYO-key AI forward (`chat` | `validate` | `models`). The API key travels
   * per-request in memory only — the server never logs, stores, or caches it.
   */
  async aiProxy<T>(
    op: "chat" | "validate" | "models",
    body: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/ai/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts?.signal,
      });
    } catch (e) {
      // Abort must stay an abort (classifyAiError maps it to "stopped"),
      // never a faux offline error.
      if (
        opts?.signal?.aborted ||
        (e instanceof Error && e.name === "AbortError")
      ) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw new WebApiError(0, "Geen verbinding met de server.");
    }
    if (!res.ok)
      await throwApiError(res, `AI-verzoek mislukt (HTTP ${res.status})`);
    return (await res.json().catch(() => ({}))) as T;
  }

  /**
   * Streaming AI forward: same `chat` op with `stream: true`. The proxy
   * emits unified SSE (`text` deltas + final `done`); anything else
   * (older server, fallback path) arrives as plain JSON and is handled
   * the same way. Aborts stay aborts.
   */
  async aiProxyStreamChat(
    body: unknown,
    opts: { signal?: AbortSignal; onText: (delta: string) => void },
  ): Promise<{
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(body as Record<string, unknown>),
          stream: true,
        }),
        signal: opts?.signal,
      });
    } catch (e) {
      if (
        opts?.signal?.aborted ||
        (e instanceof Error && e.name === "AbortError")
      ) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw new WebApiError(0, "Geen verbinding met de server.");
    }
    if (!res.ok)
      await throwApiError(res, `AI-verzoek mislukt (HTTP ${res.status})`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      // Fallback: full JSON body (older proxy or provider fallback path).
      const data = (await res.json().catch(() => ({}))) as {
        content?: string;
        toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
      };
      const content = data.content ?? "";
      if (content) opts.onText(content);
      return { content, toolCalls: data.toolCalls ?? [] };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    for (;;) {
      const { done, value } = await reader.read().catch((e: unknown) => {
        if (
          opts?.signal?.aborted ||
          (e instanceof Error && e.name === "AbortError")
        ) {
          throw new DOMException("Aborted", "AbortError");
        }
        throw new WebApiError(0, "AI-verbinding verbroken.");
      });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = extractSseEvents(buffer);
      buffer = rest;
      for (const ev of events) {
        const payload = (ev.data ?? {}) as Record<string, unknown>;
        if (ev.event === "text") {
          const delta = payload["delta"];
          if (typeof delta === "string" && delta) {
            content += delta;
            opts.onText(delta);
          }
        } else if (ev.event === "done") {
          const data = payload["content"];
          const calls = payload["toolCalls"];
          reader.cancel().catch(() => {});
          return {
            content: typeof data === "string" ? data : content,
            toolCalls: Array.isArray(calls)
              ? (calls as Array<{
                  id: string;
                  name: string;
                  arguments: unknown;
                }>)
              : [],
          };
        } else if (ev.event === "error") {
          throw new Error(
            typeof payload["message"] === "string" && payload["message"]
              ? (payload["message"] as string)
              : "AI-verzoek mislukt.",
          );
        }
      }
    }
    return { content, toolCalls: [] };
  }

  async magister<T>(
    tokens: SessionTokens,
    method: MagisterMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/magister/${path.replace(/^\//, "")}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${tokens.accessToken}`,
          "X-Magister-Endpoint": tokens.apiEndpoint,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // No response at all: waking free-tier instance or offline. The
      // caller (web-session) retries these with backoff.
      throw new WebApiError(0, SERVER_STARTING_MESSAGE);
    }
    if (isServerStartingStatus(res.status))
      throw new WebApiError(res.status, SERVER_STARTING_MESSAGE);
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      throw new WebApiError(
        429,
        "Te veel verzoeken, probeer het later opnieuw",
        errorRef(data),
      );
    }
    if (!res.ok)
      await throwApiError(res, `Magister-verzoek mislukt (HTTP ${res.status})`);
    return (await res.json()) as T;
  }

  async refresh(tokens: SessionTokens): Promise<SessionTokens> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken: tokens.refreshToken,
          apiEndpoint: tokens.apiEndpoint,
        }),
      });
    } catch {
      // No response at all: waking free-tier instance or offline. The
      // caller (web-session) retries these with backoff. (A 502/503/504
      // from Render's edge never reached the app, so retrying this grant
      // cannot burn the single-use refresh token.)
      throw new WebApiError(0, SERVER_STARTING_MESSAGE);
    }
    if (isServerStartingStatus(res.status))
      throw new WebApiError(res.status, SERVER_STARTING_MESSAGE);
    if (!res.ok)
      await throwApiError(res, `Verversen mislukt (HTTP ${res.status})`);
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
  if (
    typeof window !== "undefined" &&
    (window as unknown as { __TAURI__?: unknown }).__TAURI__
  ) {
    return new TauriBackend();
  }
  return new WebBackend();
}
