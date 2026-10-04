/**
 * IndexedDB layer for AI chat persistence (Phase 5).
 *
 * One frontend implementation for web and desktop (the Tauri webview has
 * IndexedDB too): DB `friday-ai-chats` with stores `conversations` and
 * `messages`. Reads degrade to empty (private mode); writes throw so the
 * facade can fall back to memory. A `__simulateFailure` hook lets tests
 * exercise the quota-exceeded fallback without a real disk-full disk.
 */

import { openDB, type IDBPDatabase } from "idb";
import type { Conversation, StoredMessage } from "./ai-chats.ts";

const DB_NAME = "friday-ai-chats";
const CONVERSATIONS = "conversations";
const MESSAGES = "messages";

let dbPromise: Promise<IDBPDatabase> | null = null;
/** Test hook: next store operation throws QuotaExceededError. */
let failNext: Error | null = null;

/** Test hook: make the next store operation fail (quota fallback test). */
export function __simulateStoreFailure(err?: Error): void {
  failNext = err ?? new DOMException("Quota exceeded", "QuotaExceededError");
}

function takeFailure(): void {
  if (failNext) {
    const e = failNext;
    failNext = null;
    throw e;
  }
}

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CONVERSATIONS)) {
          db.createObjectStore(CONVERSATIONS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(MESSAGES)) {
          const store = db.createObjectStore(MESSAGES, { keyPath: "id" });
          store.createIndex("by-conversation", "conversation_id");
        }
      },
    });
  }
  return dbPromise;
}

export async function dbListConversations(): Promise<Conversation[]> {
  try {
    takeFailure();
    const db = await getDb();
    const all = ((await db.getAll(CONVERSATIONS)) as Conversation[]) ?? [];
    return all.sort((a, b) => (b.updated_at < a.updated_at ? -1 : 1));
  } catch {
    return [];
  }
}

export async function dbPutConversation(conv: Conversation): Promise<void> {
  takeFailure();
  const db = await getDb();
  await db.put(CONVERSATIONS, conv);
}

export async function dbDeleteConversation(id: string): Promise<void> {
  takeFailure();
  const db = await getDb();
  const tx = db.transaction([CONVERSATIONS, MESSAGES], "readwrite");
  await tx.objectStore(CONVERSATIONS).delete(id);
  const keys = await tx
    .objectStore(MESSAGES)
    .index("by-conversation")
    .getAllKeys(id);
  for (const k of keys) await tx.objectStore(MESSAGES).delete(k);
  await tx.done;
}

export async function dbClearAll(): Promise<void> {
  takeFailure();
  const db = await getDb();
  const tx = db.transaction([CONVERSATIONS, MESSAGES], "readwrite");
  await tx.objectStore(CONVERSATIONS).clear();
  await tx.objectStore(MESSAGES).clear();
  await tx.done;
}

export async function dbGetMessages(
  conversationId: string,
): Promise<StoredMessage[]> {
  try {
    takeFailure();
    const db = await getDb();
    const all =
      ((await db.getAllFromIndex(
        MESSAGES,
        "by-conversation",
        conversationId,
      )) as StoredMessage[]) ?? [];
    return all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  } catch {
    return [];
  }
}

export async function dbAddMessage(msg: StoredMessage): Promise<void> {
  takeFailure();
  const db = await getDb();
  await db.put(MESSAGES, msg);
}
