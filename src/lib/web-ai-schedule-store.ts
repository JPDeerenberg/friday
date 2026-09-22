/**
 * Browser twin of `AiScheduleState` (commands/ai_schedule.rs): AI-planning
 * items in IndexedDB instead of `ai_schedule.json`. Same semantics —
 * validation, overlap guardrail, idempotent create, AiChat→User promotion
 * on manual edit, completed/dismissed pruning on update.
 */

import { openDB, type IDBPDatabase } from "idb";
import type { AiScheduleItem } from "./ai-schedule-types.ts";
import { intervalsOverlapStr, isoToWall } from "./web-planner.ts";

const DB_NAME = "friday-ai-schedule";
const STORE_NAME = "items";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function loadScheduleItems(): Promise<AiScheduleItem[]> {
  try {
    const db = await getDb();
    return ((await db.getAll(STORE_NAME)) as AiScheduleItem[]) ?? [];
  } catch {
    return [];
  }
}

export async function saveScheduleItems(items: AiScheduleItem[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  await tx.store.clear();
  // Store uses in-line keys (keyPath "id"): NO explicit key argument —
  // passing one alongside in-line keys throws DataError. Items always
  // carry an id (generated on create).
  for (const item of items) await tx.store.put(item);
  await tx.done;
}

function nowIso(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function validateScheduleItem(item: AiScheduleItem): void {
  if (!item.title.trim()) throw new Error("Titel is verplicht.");
  if (!(item.urgency >= 1 && item.urgency <= 5)) throw new Error("Urgency moet tussen 1 en 5 zijn.");
  const s = isoToWall(item.start);
  const e = isoToWall(item.end);
  if (s == null || e == null) throw new Error("Ongeldige datum (verwacht ISO 8601).");
  if (e <= s) throw new Error("Eind moet na start liggen.");
}

function isPlannable(it: AiScheduleItem): boolean {
  return it.item_type !== "free_time" && it.item_type !== "sleep";
}

function isHistory(it: AiScheduleItem): boolean {
  return it.status === "dismissed" || it.status === "completed";
}

/**
 * Guardrail: no two plannable AI items may occupy the same time.
 * FreeTime/Sleep (regenerated) and history are exempt.
 */
export function findScheduleOverlap(
  existing: AiScheduleItem[],
  start: string,
  end: string,
  ignoreId?: string | null,
): string | null {
  for (const it of existing) {
    if (ignoreId != null && it.id === ignoreId) continue;
    if (!isPlannable(it) || isHistory(it)) continue;
    if (intervalsOverlapStr(start, end, it.start, it.end)) return it.id;
  }
  return null;
}

function randomId(): string {
  const r =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `ai-${Date.now()}-${r}`;
}

export function inRange(item: AiScheduleItem, startMs: number, endMs: number): boolean {
  const s = isoToWall(item.start);
  const e = isoToWall(item.end);
  if (s == null || e == null) return false;
  return e >= startMs && s <= endMs;
}
