/**
 * AI chat persistence + context management (Phase 5).
 *
 * One frontend implementation for web and desktop: conversations and
 * messages live in IndexedDB (`web-ai-chats-store.ts`), with an in-memory
 * fallback when storage is unavailable (private mode, quota). Chats never
 * contain API keys or Authorization data — only roles, text, compact tool
 * traces and scrubbed error info.
 */

import type { AiErrorInfo } from "./ai-errors.ts";
import type { LoopTurnTrace } from "./ai-loop.ts";
import { loadSettings } from "./stores.ts";
import {
  dbAddMessage,
  dbClearAll,
  dbDeleteConversation,
  dbGetMessages,
  dbListConversations,
  dbPutConversation,
} from "./web-ai-chats-store.ts";

/** History budget for one request (~12k tokens at ~3.5 chars/token). */
export const HISTORY_BUDGET_TOKENS = 12000;
export const CHARS_PER_TOKEN = 3.5;
/** Tool-result preview kept per call (~500 chars or key facts). */
export const TRACE_PREVIEW_CHARS = 500;
export const DEFAULT_CONVERSATION_TITLE = "Nieuwe chat";
const LAST_CONVERSATION_KEY = "friday-ai-last-conversation";

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** Rolling summary of dropped history (item 5), null until overflow. */
  summary: string | null;
  /** Thread length covered by `summary`. */
  summary_through: number;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  text: string;
  trace?: LoopTurnTrace[];
  error?: AiErrorInfo | null;
  stopped?: boolean;
  created_at: string;
}

// ─── In-memory fallback (quota / private mode) ─────────────────────────────

let memoryMode = false;
const memConversations = new Map<string, Conversation>();
const memMessages = new Map<string, StoredMessage[]>();

/** False once a write has failed and everything runs in memory. */
export function isChatStoragePersistent(): boolean {
  return !memoryMode;
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function byUpdatedDesc(a: Conversation, b: Conversation): number {
  return a.updated_at < b.updated_at ? 1 : -1;
}

// ─── Conversations ──────────────────────────────────────────────────────────

export async function listConversations(): Promise<Conversation[]> {
  if (!memoryMode) {
    try {
      return await dbListConversations();
    } catch {
      memoryMode = true;
    }
  }
  return [...memConversations.values()].sort(byUpdatedDesc);
}

export async function createConversation(
  title?: string,
): Promise<Conversation> {
  const now = nowIso();
  const conv: Conversation = {
    id: makeId(),
    title: title ?? DEFAULT_CONVERSATION_TITLE,
    created_at: now,
    updated_at: now,
    summary: null,
    summary_through: 0,
  };
  if (!memoryMode) {
    try {
      await dbPutConversation(conv);
      return conv;
    } catch {
      memoryMode = true;
    }
  }
  memConversations.set(conv.id, conv);
  memMessages.set(conv.id, []);
  return conv;
}

async function writeConversation(conv: Conversation): Promise<void> {
  conv.updated_at = nowIso();
  if (!memoryMode) {
    try {
      await dbPutConversation(conv);
      return;
    } catch {
      memoryMode = true;
    }
  }
  memConversations.set(conv.id, conv);
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  const all = await listConversations();
  return all.find((c) => c.id === id) ?? null;
}

export async function renameConversation(
  id: string,
  title: string,
): Promise<void> {
  const conv = await getConversation(id);
  if (!conv) return;
  conv.title = title.trim() || DEFAULT_CONVERSATION_TITLE;
  await writeConversation(conv);
}

export async function deleteConversation(id: string): Promise<void> {
  if (!memoryMode) {
    try {
      await dbDeleteConversation(id);
      return;
    } catch {
      memoryMode = true;
    }
  }
  memConversations.delete(id);
  memMessages.delete(id);
}

export async function clearAllConversations(): Promise<void> {
  memConversations.clear();
  memMessages.clear();
  memoryMode = false;
  try {
    await dbClearAll();
  } catch {
    // Clearing must never fail logout flows; memory is already empty.
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(LAST_CONVERSATION_KEY);
    }
  } catch {
    // Non-browser (tests) — nothing to clear.
  }
}

export async function setConversationSummary(
  id: string,
  summary: string | null,
  through: number,
): Promise<void> {
  const conv = await getConversation(id);
  if (!conv) return;
  conv.summary = summary;
  conv.summary_through = through;
  await writeConversation(conv);
}

// ─── Messages ───────────────────────────────────────────────────────────────

export async function getMessages(
  conversationId: string,
): Promise<StoredMessage[]> {
  if (!memoryMode) {
    try {
      return await dbGetMessages(conversationId);
    } catch {
      memoryMode = true;
    }
  }
  return [...(memMessages.get(conversationId) ?? [])];
}

export async function appendMessage(
  conversationId: string,
  msg: Omit<StoredMessage, "id" | "conversation_id" | "created_at">,
): Promise<StoredMessage> {
  const stored: StoredMessage = {
    ...msg,
    id: makeId(),
    conversation_id: conversationId,
    created_at: nowIso(),
  };
  if (!memoryMode) {
    try {
      await dbAddMessage(stored);
    } catch {
      memoryMode = true;
      memMessages.set(conversationId, [
        ...(memMessages.get(conversationId) ?? []),
        stored,
      ]);
    }
  } else {
    memMessages.set(conversationId, [
      ...(memMessages.get(conversationId) ?? []),
      stored,
    ]);
  }
  // Auto-title from the first user message (item 2).
  if (msg.role === "user") {
    const conv = await getConversation(conversationId);
    if (conv && conv.title === DEFAULT_CONVERSATION_TITLE) {
      const existing = await getMessages(conversationId);
      if (existing.filter((m) => m.role === "user").length <= 1) {
        conv.title = msg.text.slice(0, 40) || DEFAULT_CONVERSATION_TITLE;
        await writeConversation(conv);
      }
    }
  } else {
    const conv = await getConversation(conversationId);
    if (conv) await writeConversation(conv);
  }
  return stored;
}

// ─── Retention (item 3) ─────────────────────────────────────────────────────

export function getChatsRetentionDays(): number | null {
  try {
    const v = (loadSettings() as Record<string, unknown>)[
      "aiChatsRetentionDays"
    ];
    if (v === null || v === undefined) return null; // forever
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 90;
  } catch {
    return 90;
  }
}

export function shouldSaveChats(): boolean {
  try {
    return (loadSettings() as Record<string, unknown>)["saveAiChats"] !== false;
  } catch {
    return true;
  }
}

/** Delete conversations idle longer than the retention window. Returns count. */
export async function pruneExpiredConversations(
  retentionDays: number | null,
): Promise<number> {
  if (retentionDays === null) return 0;
  const cutoff = Date.now() - retentionDays * 86400000;
  const all = await listConversations();
  let pruned = 0;
  for (const conv of all) {
    if (Date.parse(conv.updated_at) < cutoff) {
      await deleteConversation(conv.id);
      pruned += 1;
    }
  }
  return pruned;
}

// ─── Last-open conversation ─────────────────────────────────────────────────

export function getLastConversationId(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(LAST_CONVERSATION_KEY);
  } catch {
    return null;
  }
}

export function setLastConversationId(id: string | null): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (id) window.localStorage.setItem(LAST_CONVERSATION_KEY, id);
    else window.localStorage.removeItem(LAST_CONVERSATION_KEY);
  } catch {
    // Storage unavailable — restoring just won't happen.
  }
}

// ─── Context budget + tool-trace replay (items 4–5) ──────────────────────────

export interface ThreadMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  trace?: LoopTurnTrace[];
}

function compactArgs(args: unknown): string {
  const s = JSON.stringify(args) ?? "";
  const chars = Array.from(s);
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}…` : s;
}

function previewOf(text: string): string {
  const chars = Array.from(text ?? "");
  return chars.length > TRACE_PREVIEW_CHARS
    ? `${chars.slice(0, TRACE_PREVIEW_CHARS).join("")}…`
    : chars.join("");
}

/**
 * Compact tool context replayed with older assistant turns, so follow-ups
 * like "en de dag erna?" don't trigger needless refetches. Never the full
 * raw results — name, args and a ~500-char preview per call.
 */
export function traceBlock(trace: LoopTurnTrace[] | undefined): string {
  if (!trace || trace.length === 0) return "";
  const lines: string[] = [];
  for (const turn of trace) {
    for (const call of turn.calls ?? []) {
      lines.push(
        `- ${call.name}(${compactArgs(call.args)}) → ${previewOf(call.text)}`,
      );
    }
  }
  if (lines.length === 0) return "";
  return (
    "\n\n[Eerdere toolresultaten uit dit gesprek — gebruik deze, haal ze niet opnieuw op " +
    "tenzij de gebruiker om iets anders vraagt:\n" +
    lines.join("\n") +
    "\n]"
  );
}

function threadMessageSize(m: ThreadMessage): number {
  return m.content.length + traceBlock(m.trace).length;
}

export interface FittedPayload {
  messages: ThreadMessage[];
  /** Front messages excluded to fit the budget. */
  dropped: ThreadMessage[];
}

/**
 * Keep the last N thread messages that fit the token budget. The latest
 * message is always kept; the system prompt is added by the loops on top.
 */
export function fitHistoryForRequest(
  thread: ThreadMessage[],
  budgetTokens: number = HISTORY_BUDGET_TOKENS,
): FittedPayload {
  const budgetChars = Math.max(1, budgetTokens) * CHARS_PER_TOKEN;
  const sizes = thread.map(threadMessageSize);
  const kept: ThreadMessage[] = [];
  let used = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (kept.length > 0 && used + sizes[i] > budgetChars) break;
    kept.unshift(thread[i]);
    used += sizes[i];
  }
  return {
    messages: kept,
    dropped: thread.slice(0, thread.length - kept.length),
  };
}

export function summaryPromptFor(dropped: ThreadMessage[]): string {
  const lines = dropped.map(
    (m) => `${m.role}: ${m.content}${traceBlock(m.trace)}`,
  );
  return (
    "Vat het voorgaande gesprek samen in één alinea (max ~120 woorden) met alleen " +
    "de feiten die nodig zijn om het gesprek voort te zetten " +
    "(voorkeuren, afspraken, cijfers of plannen die genoemd zijn):\n\n" +
    lines.join("\n")
  );
}

/**
 * Generate the rolling summary over dropped history. Returns null when there
 * is nothing to summarize or the call fails — the caller then falls back to
 * plain truncation and never fails the chat.
 */
export async function summarizeDropped(
  dropped: ThreadMessage[],
  summarize: (prompt: string) => Promise<string>,
): Promise<string | null> {
  if (dropped.length === 0) return null;
  try {
    const out = await summarize(summaryPromptFor(dropped));
    const text = (out ?? "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

export function summarySystemMessage(summary: string): ThreadMessage {
  return {
    role: "system",
    content: `Samenvatting van het eerdere gesprek in dit gesprek: ${summary}`,
  };
}
