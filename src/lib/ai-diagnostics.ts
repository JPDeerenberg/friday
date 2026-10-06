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
  /**
   * Message *shapes* at failure time (roles + content/tool-call counts,
   * e.g. `assistant(c0,t1)`) — never content, never keys. Diagnoses 4xx
   * rejections like Mistral's `invalid_request_assistant_message`.
   */
  messageShape?: string[];
  /** Provider machine-readable error type, when the error carried one. */
  providerType?: string;
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
        (e.providerType ? ` type=${e.providerType}` : "") +
        (e.messageShape && e.messageShape.length > 0
          ? ` shape=[${e.messageShape.join(",")}]`
          : "") +
        (e.toolNames && e.toolNames.length > 0
          ? ` tools=${e.toolNames.join(",")}`
          : ""),
    )
    .join("\n");
}

/** Minimal structural view of one history message (roles only). */
export interface ShapeableMessage {
  role: string;
  content?: string;
  /** Web replay / proxy spelling of attached tool calls. */
  toolCalls?: unknown[];
  tool_calls?: unknown[];
  /** Turn-level trace (assistant turns replayed with prior tool context). */
  trace?: Array<{ calls?: unknown[] }>;
}

/** Shape of one message, e.g. `assistant(c0,t1)` — never content. */
export function shapeOfMessage(m: ShapeableMessage): string {
  if (m.role !== "assistant") return m.role;
  const hasContent = (m.content ?? "").trim() !== "";
  const calls =
    m.toolCalls ?? m.tool_calls ?? m.trace?.flatMap((t) => t.calls ?? []);
  return `assistant(c${hasContent ? 1 : 0},t${calls?.length ?? 0})`;
}

/** Shapes of a whole history — never content, never keys. */
export function historyShapeOf(messages: ShapeableMessage[]): string[] {
  return messages.map(shapeOfMessage);
}

/**
 * Provider machine-readable error type from an error string, when the
 * proxy/server embedded one as ` (type=X[, code=Y])`.
 */
export function providerTypeOf(err: unknown): string | undefined {
  const text =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  const m = /\(type=([A-Za-z0-9_.-]+)(?:, code=[^)]+)?\)/.exec(text);
  return m ? m[1] : undefined;
}

/** Test hook: current buffer size. */
export function __diagLen(): number {
  return entries.length;
}
