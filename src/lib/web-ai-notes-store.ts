/**
 * Browser twin of `AiNotesState` (commands/ai_notes.rs): AI-Geheugen in
 * IndexedDB instead of `ai_notes.json`. A separate `friday-ai-notes`
 * database (store `notes`) avoids a version migration of `friday-ai`.
 *
 * Like `web-ai-store.ts`, reads degrade to null (callers substitute the
 * skeleton); writes throw so failures surface instead of silently losing
 * user data. Every successful write dispatches `friday:ai-notes-changed`
 * for live Settings updates.
 */

import { openDB, type IDBPDatabase } from "idb";
import type { AiNotes } from "./ai-notes.ts";

const DB_NAME = "friday-ai-notes";
const STORE_NAME = "notes";
const NOTES_KEY = "current";

export const NOTES_CHANGED_EVENT = "friday:ai-notes-changed";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME))
          db.createObjectStore(STORE_NAME);
      },
    });
  }
  return dbPromise;
}

export async function loadNotesRecord(): Promise<AiNotes | null> {
  try {
    const db = await getDb();
    const rec = (await db.get(STORE_NAME, NOTES_KEY)) as AiNotes | undefined;
    if (!rec || typeof rec.content !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

export async function saveNotesRecord(notes: AiNotes): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, notes, NOTES_KEY);
  dispatchNotesChanged(notes.revision);
}

export function dispatchNotesChanged(revision: number): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function"
  )
    return;
  window.dispatchEvent(
    new CustomEvent(NOTES_CHANGED_EVENT, { detail: { revision } }),
  );
}
