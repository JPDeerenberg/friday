/**
 * AI diagnostics ring buffer (Phase 6 item 12).
 *
 * Last 50 AI requests with metadata only — timestamp, provider, model,
 * status, duration, error class, tool names. Never content, never keys.
 * This is how future "it fails sometimes" reports get actionable.
 * In-memory only; cleared on reload/logout.
 */

export type AiDiagStatus = "ok" | "error" | "aborted" | "stopped";

export interface AiDiagEntry {
  /** Epoch millis. */
  ts: number;
  platform: "web" | "desktop";
  provider: string;
  model: string;
  op: "chat" | "tools";
  status: AiDiagStatus;
  durationMs: number;
  /** Error class only (AiErrorKind) — never messages that could hold keys. */
  errorClass?: string;
  /** Tool names called this turn — never arguments or results. */
  toolNames?: string[];
}

/** Ring capacity (plan item 12). */
export const DIAG_LIMIT = 50;

const entries: AiDiagEntry[] = [];

function platform(): "web" | "desktop" {
  return typeof window !== "undefined" &&
    !(window as unknown as { __TAURI__?: unknown }).__TAURI__
    ? "web"
    : "desktop";
}

/** Record one AI request. Never throws. */
export function recordAiDiag(
  entry: Omit<AiDiagEntry, "ts" | "platform"> & {
    platform?: "web" | "desktop";
  },
): void {
  try {
    entries.push({
      ...entry,
      ts: Date.now(),
      platform: entry.platform ?? platform(),
    });
    while (entries.length > DIAG_LIMIT) entries.shift();
  } catch {
    // Diagnostics must never break the chat.
  }
}

export function getAiDiagnostics(): AiDiagEntry[] {
  return [...entries].reverse();
}

export function clearAiDiagnostics(): void {
  entries.length = 0;
}

/** Copyable text dump for bug reports. */
export function diagnosticsText(): string {
  return getAiDiagnostics()
    .map(
      (e) =>
        `${new Date(e.ts).toISOString()} ${e.platform}/${e.provider}/${e.model} ${e.op} ` +
        `${e.status} ${e.durationMs}ms` +
        (e.errorClass ? ` err=${e.errorClass}` : "") +
        (e.toolNames && e.toolNames.length > 0
          ? ` tools=${e.toolNames.join(",")}`
          : ""),
    )
    .join("\n");
}

/** Test hook: current buffer size. */
export function __diagLen(): number {
  return entries.length;
}
