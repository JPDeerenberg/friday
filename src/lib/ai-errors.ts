/**
 * AI error taxonomy + provider retry policy.
 *
 * Phase 6 of fixes/friday-ai-upgrade-plan.md (items 6 + 8). Used by the web
 * loop (`ai-loop.ts`), the desktop error strings (classified here on arrival
 * in `AIAssistant.svelte`), and the Rust loop mirrors the same policy in
 * `src-tauri/src/commands/ai.rs`.
 */

export type AiErrorKind =
  | "aborted"
  | "not_configured"
  | "invalid_key"
  | "model_not_found"
  | "rate_limited"
  | "context_too_long"
  | "server_busy"
  | "offline"
  | "unknown";

export interface AiErrorAction {
  label: string;
  kind: "open-ai-settings" | "retry" | "copy-detail";
}

export interface AiErrorInfo {
  kind: AiErrorKind;
  /** Dutch user-facing message. */
  message: string;
  retryable: boolean;
  action?: AiErrorAction;
  /** Technical detail with secrets scrubbed (status, short provider text). */
  detail?: string;
}

/** Statuses worth one automatic retry cycle (plus plain network failures). */
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
/** Never retried (except context_too_long, which gets one trim + retry). */
const FATAL_STATUS = new Set([400, 401, 403, 404]);

/** Max provider attempts per chat call: 1 try + 2 retries. */
export const MAX_CHAT_ATTEMPTS = 3;

function statusOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null) {
    const s = (err as Record<string, unknown>)["status"];
    if (typeof s === "number" && Number.isFinite(s)) return s;
  }
  const m = /HTTP\s+(\d{3})/i.exec(errorText(err));
  return m ? Number(m[1]) : null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err ?? "");
}

function isAbort(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e["aborted"] === true) return true;
    if (
      typeof e["name"] === "string" &&
      (e["name"] as string).includes("Abort")
    )
      return true;
  }
  return /abort|abgebroken|gestopt|stop/i.test(errorText(err));
}

/** Strip anything key-like from technical details shown to the user. */
export function scrubSecrets(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9\-_]+/g, "sk-…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(/(api[_-]?key["'\s:=]+)[^"'\s,}]+/gi, "$1…");
}

/**
 * Classify any AI failure into a typed error with a Dutch message and an
 * optional UI action. Desktop `invoke()` rejections arrive as strings and
 * are matched the same way (the Rust loop embeds HTTP statuses in them).
 */
export function classifyAiError(err: unknown): AiErrorInfo {
  const text = errorText(err);
  const status = statusOf(err);
  const detail = scrubSecrets(
    status !== null ? `HTTP ${status} — ${text}` : text,
  ).slice(0, 300);

  if (isAbort(err)) {
    return {
      kind: "aborted",
      message: "Genereren gestopt.",
      retryable: false,
      detail,
    };
  }
  if (/niet geconfigureerd/i.test(text)) {
    return {
      kind: "not_configured",
      message:
        "AI is nog niet ingesteld. Ga naar Instellingen > AI om je API-sleutel in te voeren.",
      retryable: false,
      action: { label: "Open AI-instellingen", kind: "open-ai-settings" },
      detail,
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    /401|403|invalid_api_key|incorrect api key|unauthorized|ongeldig.*sleutel|geen toegang/i.test(
      text,
    )
  ) {
    return {
      kind: "invalid_key",
      message: "API-sleutel ongeldig of geen toegang.",
      retryable: false,
      action: { label: "Open AI-instellingen", kind: "open-ai-settings" },
      detail,
    };
  }
  if (
    status === 404 ||
    /model.*not found|model_not_found|onbekend model/i.test(text)
  ) {
    return {
      kind: "model_not_found",
      message: "Model niet gevonden bij deze provider.",
      retryable: false,
      action: { label: "Open AI-instellingen", kind: "open-ai-settings" },
      detail,
    };
  }
  if (
    status === 429 ||
    /too many requests|rate limit|429|te veel verzoeken/i.test(text)
  ) {
    return {
      kind: "rate_limited",
      message: "Even te veel verzoeken — ik probeer het automatisch opnieuw.",
      retryable: true,
      detail,
    };
  }
  if (
    /context.*(too long|length|too big)|maximum context|token.*(limit|exceed)|te lang.*gesprek|context_?lengte/i.test(
      text,
    )
  ) {
    return {
      kind: "context_too_long",
      message: "Gesprek te lang — ik kort het in en probeer het opnieuw.",
      retryable: true,
      detail,
    };
  }
  if (status !== null && RETRYABLE_STATUS.has(status)) {
    return {
      kind: "server_busy",
      message:
        "De server is even druk of wordt wakker — ik probeer het opnieuw.",
      retryable: true,
      detail,
    };
  }
  if (
    status === 0 ||
    status === null ||
    /failed to fetch|networkerror|network error|load failed|geen verbinding|econn|enotfound|etimedout|timeout/i.test(
      text,
    )
  ) {
    // status === null with no better match is treated as a network failure.
    if (
      status === null &&
      !/fetch|network|verbinding|econn|timeout/i.test(text)
    ) {
      return {
        kind: "unknown",
        message: "Er ging iets mis. Probeer het opnieuw.",
        retryable: false,
        action: { label: "Kopieer details", kind: "copy-detail" },
        detail,
      };
    }
    return {
      kind: "offline",
      message:
        "Geen (stabiele) verbinding — controleer je internet en probeer het opnieuw.",
      retryable: true,
      action: { label: "Opnieuw proberen", kind: "retry" },
      detail,
    };
  }
  if (status !== null && FATAL_STATUS.has(status)) {
    return {
      kind: "unknown",
      message: "De provider wees het verzoek af. Controleer je instellingen.",
      retryable: false,
      action: { label: "Open AI-instellingen", kind: "open-ai-settings" },
      detail,
    };
  }
  return {
    kind: "unknown",
    message: "Er ging iets mis. Probeer het opnieuw.",
    retryable: false,
    action: { label: "Kopieer details", kind: "copy-detail" },
    detail,
  };
}

/** Base delay before retry attempt n (0-based): 500ms, 1s — plus jitter. */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  const delay = base + jitter;
  if (
    retryAfterMs !== null &&
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs)
  ) {
    return Math.min(15000, Math.max(delay, retryAfterMs));
  }
  return delay;
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

function retryAfterOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const v = (err as Record<string, unknown>)["retryAfterMs"];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

export interface RetryOptions {
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Call `fn` with up to 2 retries for transient failures (network errors,
 * 408/429/502/503/504). Never retries 400/401/403/404 — except through the
 * caller's trim path — and never retries after abort.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    if (opts?.signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (opts?.signal?.aborted || isAbort(err)) throw abortError();
      const info = classifyAiError(err);
      if (
        !info.retryable ||
        info.kind === "context_too_long" ||
        attempt >= MAX_CHAT_ATTEMPTS - 1
      )
        throw err;
      const delay = retryDelayMs(attempt, retryAfterOf(err));
      opts?.onRetry?.(attempt, delay, err);
      if (opts?.sleep) await opts.sleep(delay);
      else await sleepMs(delay, opts?.signal);
      attempt += 1;
    }
  }
}

/**
 * Parse model-supplied tool arguments. The proxy usually pre-parses them,
 * but some providers send a JSON string — and a model can always send junk.
 * Never throws: returns a Dutch retry hint instead (plan item 2).
 */
export function parseToolArgs(
  raw: unknown,
):
  { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      )
        return { ok: true, args: parsed as Record<string, unknown> };
      return {
        ok: false,
        message: "Ongeldige argumenten: geen object, probeer opnieuw.",
      };
    } catch {
      return {
        ok: false,
        message: "Ongeldige argumenten: geen geldige JSON, probeer opnieuw.",
      };
    }
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw))
    return { ok: true, args: raw as Record<string, unknown> };
  return {
    ok: false,
    message: "Ongeldige argumenten: geen object, probeer opnieuw.",
  };
}

/** Stable key for dedupe: same name + same args (any key order) = same call. */
export function dedupeKey(name: string, args: unknown): string {
  return `${name}\n${stableStringify(args)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
