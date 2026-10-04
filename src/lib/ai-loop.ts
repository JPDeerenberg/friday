/**
 * Provider-agnostic AI tool loop core.
 *
 * Phase 6 of fixes/friday-ai-upgrade-plan.md (items 1–5, part of 6).
 * The web loop (`ai.ts`) wires this to the Tier-A proxy; the desktop loop
 * (`src-tauri/src/commands/ai.rs`) mirrors the same policy in Rust.
 *
 * Per turn: up to 8 rounds of chat → execute tools → feed results back.
 * - Every tool call gets a result (per-tool timeout, failures become
 *   `{error, retryable}` payloads, never a thrown turn).
 * - Malformed/unknown tools fail gracefully with a Dutch retry hint.
 * - Independent (read) calls run concurrently; staged writes stay sequential.
 * - Identical calls within a turn are deduped from a cache + note.
 * - Rounds exhausted or budget tripped → one final tools-disabled call
 *   with a Dutch nudge instead of a canned fallback.
 * - Context-overflow → trim history and retry the call once.
 * - AbortSignal stops the turn, keeping partial text + stopped flag.
 */

import {
  abortError,
  classifyAiError,
  dedupeKey,
  parseToolArgs,
  withRetry,
} from "./ai-errors.ts";

/** Per-tool timeout (plan item 1). */
export const TOOL_TIMEOUT_MS = 15000;
/** File reads get longer (plan item 1). */
export const FILE_READ_TIMEOUT_MS = 30000;
export const FILE_READ_TOOLS = new Set([
  "read_attachment_text",
  "download_file",
]);
/** Default rounds per turn (plan item 5). */
export const MAX_ROUNDS = 8;
/** Final tools-disabled nudge (plan item 5). */
export const FINAL_NUDGE =
  "Geef nu je beste antwoord met wat je hebt; zeg wat ontbreekt.";
/** Empty-content last resort (only when even the final call is blank). */
export const EMPTY_FALLBACK =
  "Ik kon geen antwoord formuleren. Probeer het opnieuw.";

export function toolTimeoutMs(name: string): number {
  return FILE_READ_TOOLS.has(name) ? FILE_READ_TIMEOUT_MS : TOOL_TIMEOUT_MS;
}

export interface LoopToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LoopChatResponse {
  content: string;
  toolCalls: LoopToolCall[];
}

export interface LoopToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LoopToolOutcome {
  /** Model-facing text for this tool result. */
  text: string;
  /** Staged write payload (pending_user_confirmation), if any. */
  staged?: unknown;
}

export interface LoopChatMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LoopToolRequest[];
}

export interface LoopCallTrace {
  name: string;
  args: unknown;
  ok: boolean;
  text: string;
}

export interface LoopTurnTrace {
  /** Assistant text of the turn (may be empty when thinking). */
  text: string;
  calls: LoopCallTrace[];
}

/** Activity for the UI liveness line. `tool` is the raw tool name. */
export interface LoopActivity {
  kind: "answer" | "tool" | "idle";
  tool?: string;
}

const TOOL_ACTIVITY: Array<[RegExp, string]> = [
  [/^get_calendar/, "Rooster ophalen…"],
  [/^get_grades|^get_full_grade_overview/, "Cijfers ophalen…"],
  [/^get_assignment/, "Opdrachten ophalen…"],
  [/^get_messages|^get_message_content/, "Berichten ophalen…"],
  [/^get_today_summary/, "Dagoverzicht ophalen…"],
  [/^get_ai_schedule/, "Planning ophalen…"],
  [
    /^(create|update|move|complete|dismiss|delete)_ai_schedule/,
    "Planning bijwerken…",
  ],
  [/^set_homework_duration/, "Duur opslaan…"],
  [/^run_update_ai_schedule/, "Planning herberekenen…"],
  [/^read_notes/, "Notities lezen…"],
  [/^(append|edit|replace)_note/, "Notitie opslaan…"],
  [/^read_attachment_text|^list_files|^download_file/, "Bijlage lezen…"],
  [/^calculate_grade_scenario/, "Cijfers berekenen…"],
  [
    /^send_message|^mark_messages_read|^create_calendar_event/,
    "Actie voorbereiden…",
  ],
  [/^get_current_time/, "Tijd opzoeken…"],
];

/** Dutch liveness message for a tool call. Pure — shared with desktop UI. */
export function activityForTool(name: string): string {
  for (const [re, msg] of TOOL_ACTIVITY) {
    if (re.test(name)) return msg;
  }
  return "Gegevens ophalen…";
}

export interface LoopResult {
  content: string;
  staged: unknown[];
  stopped: boolean;
  roundsUsed: number;
  /** Compact per-turn tool trace for persistence (item 4). */
  trace: LoopTurnTrace[];
}

export interface LoopDeps {
  systemPrompt: string;
  initialMessages: LoopChatMessage[];
  maxRounds?: number;
  chat: (
    messages: LoopChatMessage[],
    opts: {
      toolsEnabled: boolean;
      signal?: AbortSignal;
      attempt: number;
      onTextDelta?: (delta: string) => void;
    },
  ) => Promise<LoopChatResponse>;
  executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    data: unknown;
    error?: string;
    staged?: unknown;
  }>;
  /** Staged-write tools run sequentially; everything else concurrently. */
  isWriteTool?: (name: string) => boolean;
  onBudgetAccount: (data: unknown) => { payload: unknown; budgetHit: boolean };
  /** Liveness line for the UI ("Rooster ophalen…", answer, idle). */
  onActivity?: (activity: LoopActivity) => void;
  /** Streamed text deltas, forwarded into the provider call. */
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Race a promise against a timeout and an abort; late rejections stay handled. */
export function withToolTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(abortError());
    };
    timer = setTimeout(() => {
      done();
      reject(new Error(`Time-out bij tool ${toolName} (>${ms / 1000}s)`));
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Trim an over-long history for one recovery retry: keep the system prompt
 * plus the last few turns. (Phase 5 will upgrade this to a rolling summary.)
 */
export function trimHistory(
  messages: LoopChatMessage[],
  keep = 4,
): LoopChatMessage[] {
  if (messages.length === 0) return messages;
  const [first, ...rest] = messages;
  const tail = rest.slice(-keep);
  return first.role === "system" ? [first, ...tail] : tail.slice(-keep);
}

function failureText(
  tool: string,
  error: unknown,
): { text: string; retryable: boolean } {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>)["error"] === "string"
  ) {
    const data = error as Record<string, unknown>;
    return {
      text: JSON.stringify({
        tool,
        error: data["error"],
        retryable: data["retryable"] === true,
      }),
      retryable: data["retryable"] === true,
    };
  }
  const reason =
    error instanceof Error ? error.message : String(error ?? "Onbekende fout");
  const retryable = classifyAiError(error).retryable;
  return { text: `Fout bij ophalen van data: ${reason}`, retryable };
}

export async function runToolLoop(deps: LoopDeps): Promise<LoopResult> {
  const maxRounds = deps.maxRounds ?? MAX_ROUNDS;
  const isWrite = deps.isWriteTool ?? (() => false);
  const messages: LoopChatMessage[] = [
    { role: "system", content: deps.systemPrompt },
    ...deps.initialMessages,
  ];
  const staged: unknown[] = [];
  const cache = new Map<string, { text: string; ok: boolean }>();
  // In-flight dedupe: concurrent identical reads share one execution.
  const inflight = new Map<string, Promise<{ text: string; ok: boolean }>>();
  const trace: LoopTurnTrace[] = [];
  let finalContent = "";
  let roundsUsed = 0;
  let toolCallsSeen = false;
  let budgetTripped = false;
  let trimRetried = false;

  try {
    for (let round = 0; round < maxRounds; round++) {
      throwIfAborted(deps.signal);
      let res: LoopChatResponse;
      try {
        deps.onActivity?.({ kind: "answer" });
        res = await withRetry(
          (attempt) =>
            deps.chat(messages, {
              toolsEnabled: true,
              signal: deps.signal,
              attempt,
              onTextDelta: deps.onTextDelta,
            }),
          { signal: deps.signal, sleep: deps.sleep },
        );
      } catch (err) {
        if (classifyAiError(err).kind === "context_too_long" && !trimRetried) {
          trimRetried = true;
          const trimmed = trimHistory(messages);
          messages.length = 0;
          messages.push(...trimmed);
          round -= 1;
          continue;
        }
        throw err;
      }
      if (res.content) finalContent = res.content;
      if (!res.toolCalls || res.toolCalls.length === 0) break;
      toolCallsSeen = true;
      roundsUsed = round + 1;

      // Parse args first (never throws the turn), then dedupe.
      const planned: Array<
        | {
            kind: "ready";
            call: LoopToolCall;
            args: Record<string, unknown>;
            key: string;
          }
        | { kind: "badargs"; call: LoopToolCall; message: string }
      > = res.toolCalls.map((call) => {
        const parsed = parseToolArgs(call.arguments);
        if (!parsed.ok)
          return { kind: "badargs", call, message: parsed.message };
        return {
          kind: "ready",
          call,
          args: parsed.args,
          key: dedupeKey(call.name, parsed.args),
        };
      });

      // Replay the assistant turn WITH its tool calls (providers reject an
      // assistant message that has neither content nor tool calls), using the
      // parsed arguments so the history round-trips through the proxy.
      messages.push({
        role: "assistant",
        content: res.content,
        tool_calls: planned.map((p) => ({
          id: p.call.id,
          name: p.call.name,
          args: p.kind === "ready" ? p.args : {},
        })),
      });

      const texts = new Array<string>(planned.length);
      const oks = new Array<boolean>(planned.length).fill(true);
      const runOne = async (
        item: Extract<(typeof planned)[number], { kind: "ready" }>,
        index: number,
      ): Promise<void> => {
        throwIfAborted(deps.signal);
        const cached = cache.get(item.key);
        if (cached !== undefined) {
          texts[index] =
            `${cached.text}\n[Notitie: identieke tool-aanroep als eerder deze beurt — cached resultaat hergebruikt.]`;
          oks[index] = cached.ok;
          return;
        }
        const ongoing = inflight.get(item.key);
        if (ongoing !== undefined) {
          const shared = await ongoing;
          throwIfAborted(deps.signal);
          texts[index] =
            `${shared.text}\n[Notitie: identieke tool-aanroep als eerder deze beurt — cached resultaat hergebruikt.]`;
          oks[index] = shared.ok;
          return;
        }
        // Fresh execution shared with concurrent twins.
        let release!: (out: { text: string; ok: boolean }) => void;
        const shared = new Promise<{ text: string; ok: boolean }>((resolve) => {
          release = resolve;
        });
        inflight.set(item.key, shared);
        try {
          const out = await execFresh(item);
          texts[index] = out.text;
          oks[index] = out.ok;
          release(out);
        } catch (e) {
          inflight.delete(item.key);
          release({ text: "", ok: false });
          throw e;
        }
        inflight.delete(item.key);
      };

      const execFresh = async (
        item: Extract<(typeof planned)[number], { kind: "ready" }>,
      ): Promise<{ text: string; ok: boolean }> => {
        deps.onActivity?.({ kind: "tool", tool: item.call.name });
        let outcome: {
          ok: boolean;
          data: unknown;
          error?: string;
          staged?: unknown;
        };
        try {
          outcome = await withToolTimeout(
            deps.executeTool(item.call.name, item.args),
            toolTimeoutMs(item.call.name),
            item.call.name,
            deps.signal,
          );
        } catch (e) {
          if (deps.signal?.aborted || classifyAiError(e).kind === "aborted")
            throw e;
          const f = failureText(item.call.name, e);
          const text = f.retryable
            ? JSON.stringify({
                tool: item.call.name,
                error: e instanceof Error ? e.message : String(e),
                retryable: true,
              })
            : f.text;
          cache.set(item.key, { text, ok: false });
          return { text, ok: false };
        }
        if (!outcome.ok) {
          const text = failureText(
            item.call.name,
            outcome.error ?? outcome.data,
          ).text;
          cache.set(item.key, { text, ok: false });
          return { text, ok: false };
        }
        if (outcome.staged !== undefined) staged.push(outcome.staged);
        const { payload, budgetHit } = deps.onBudgetAccount(outcome.data);
        if (budgetHit) budgetTripped = true;
        const text = JSON.stringify(payload);
        cache.set(item.key, { text, ok: true });
        return { text, ok: true };
      };

      // Reads concurrently, staged writes sequentially, original order kept.
      const readys = planned
        .map((p, i) => ({ p, i }))
        .filter(
          (
            x,
          ): x is {
            p: Extract<(typeof planned)[number], { kind: "ready" }>;
            i: number;
          } => x.p.kind === "ready",
        );
      const reads = readys.filter((x) => !isWrite(x.p.call.name));
      const writes = readys.filter((x) => isWrite(x.p.call.name));
      const settlements = await Promise.allSettled(
        reads.map((x) => runOne(x.p, x.i)),
      );
      for (const s of settlements) {
        if (s.status === "rejected") throw s.reason;
      }
      for (const x of writes) await runOne(x.p, x.i);
      planned.forEach((p, i) => {
        if (p.kind === "badargs") {
          texts[i] = p.message;
          oks[i] = false;
        }
      });

      res.toolCalls.forEach((call, i) => {
        messages.push({
          role: "tool",
          content: texts[i] ?? "Fout bij ophalen van data: Onbekende fout",
          tool_call_id: call.id,
          name: call.name,
        });
      });

      trace.push({
        text: res.content,
        calls: planned.map((p, i) =>
          p.kind === "badargs"
            ? {
                name: p.call.name,
                args: p.call.arguments,
                ok: false,
                text: texts[i],
              }
            : {
                name: p.call.name,
                args: p.args,
                ok: oks[i] !== false,
                text: texts[i] ?? "",
              },
        ),
      });

      if (round === maxRounds - 1) break;
    }
  } catch (err) {
    if (deps.signal?.aborted || classifyAiError(err).kind === "aborted") {
      deps.onActivity?.({ kind: "idle" });
      return {
        content: finalContent,
        staged,
        stopped: true,
        roundsUsed,
        trace,
      };
    }
    deps.onActivity?.({ kind: "idle" });
    throw err;
  }

  const hitLimit = toolCallsSeen && roundsUsed >= maxRounds;
  // The closing call salvages a turn that is still owed an answer: the round
  // limit hit with tools pending, or a budget trip after which the model went
  // quiet without answering. A natural end with content needs nothing.
  const trippedQuiet = budgetTripped && !finalContent;
  if (toolCallsSeen && (hitLimit || trippedQuiet)) {
    try {
      throwIfAborted(deps.signal);
      deps.onActivity?.({ kind: "answer" });
      const closing = await withRetry(
        (attempt) =>
          deps.chat([...messages, { role: "system", content: FINAL_NUDGE }], {
            toolsEnabled: false,
            signal: deps.signal,
            attempt,
            onTextDelta: deps.onTextDelta,
          }),
        { signal: deps.signal, sleep: deps.sleep },
      );
      if (closing.content) finalContent = closing.content;
    } catch (err) {
      if (deps.signal?.aborted || classifyAiError(err).kind === "aborted") {
        deps.onActivity?.({ kind: "idle" });
        return {
          content: finalContent,
          staged,
          stopped: true,
          roundsUsed,
          trace,
        };
      }
      if (!finalContent) throw err;
      // Keep what we have; the closing call is best-effort.
    }
  }

  if (!finalContent) finalContent = EMPTY_FALLBACK;
  deps.onActivity?.({ kind: "idle" });
  return { content: finalContent, staged, stopped: false, roundsUsed, trace };
}
