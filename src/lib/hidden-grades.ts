/**
 * Verborgen cijfers terughalen.
 *
 * Een school kan cijfers tijdelijk (bv. een week) verbergen: Magister stopt
 * dan gewoon met het teruggeven van die cijfers. Een écht verwijderd cijfer
 * gedraagt zich precies hetzelfde, dus de app kan ze niet van elkaar
 * onderscheiden. Daarom geldt deze regel:
 *
 *  - Een cijfer dat we eerder zagen en dat nu ontbreekt, blijft zichtbaar met
 *    het label "verborgen door school" (veld `hiddenSince`).
 *  - Komt het terug in Magister, dan is het gewoon weer een normaal cijfer.
 *  - Na HIDDEN_GRADE_DAYS dagen weg te zijn geweest, beschouwen we het als
 *    echt verwijderd en laten we het los. Wie het eerder kwijt wil, kan het
 *    zelf verwijderen (knop bij het cijfer).
 *
 * Alleen een *geslaagd* antwoord van Magister telt. Een storing, geen internet
 * of een geblokkeerde verbinding verandert hier niets (dat vangt de gewone
 * offline-opslag op).
 */

import { openDB, type IDBPDatabase } from "idb";
import type { Grade } from "./types.ts";

export const HIDDEN_GRADE_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const DB_NAME = "friday-grade-memory";
const STORE = "years";

interface Remembered {
  grade: Grade;
  /** Tijdstip (ms) waarop het cijfer voor het eerst ontbrak; null = aanwezig. */
  missingSince: number | null;
}
export type GradeMemory = Record<string, Remembered>;

let enabled = true;
let dbPromise: Promise<IDBPDatabase> | null = null;

export function setHiddenGradeRestore(on: boolean) {
  enabled = on;
}

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

/** Alleen echte cijfers (geen gemiddelden/lege kolommen) worden teruggehaald. */
function isRestorable(g: Grade): boolean {
  return g.CijferKolom?.KolomSoort === 1 && !!g.CijferStr && g.CijferId != null;
}

/**
 * Zuivere kern (goed testbaar): vergelijk wat Magister nu geeft met wat we
 * eerder zagen. Geeft het nieuwe geheugen en de lijst om te tonen terug.
 */
export function reconcile(
  prev: GradeMemory | null,
  live: Grade[],
  now: number,
): { memory: GradeMemory; result: Grade[] } {
  const memory: GradeMemory = {};
  const liveIds = new Set<string>();

  for (const g of live) {
    if (!isRestorable(g)) continue;
    const key = String(g.CijferId);
    liveIds.add(key);
    // Een cijfer dat live terug is, is niet meer verborgen: schone kopie.
    const { hiddenSince: _drop, ...clean } = g;
    memory[key] = { grade: clean as Grade, missingSince: null };
  }

  const restored: Grade[] = [];
  for (const [key, entry] of Object.entries(prev ?? {})) {
    if (liveIds.has(key)) continue;
    const since = entry.missingSince ?? now;
    if (now - since > HIDDEN_GRADE_DAYS * DAY_MS) continue; // echt weg
    memory[key] = { grade: entry.grade, missingSince: since };
    restored.push({
      ...entry.grade,
      hiddenSince: new Date(since).toISOString(),
    });
  }

  return { memory, result: [...live, ...restored] };
}

// Gelijktijdige aanroepen (dashboard + cijferpagina + opslagronde) mogen
// elkaars lees-schrijfslag niet kruisen.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

const memKey = (pid: number, yearId: number) => `${pid}:${yearId}`;

/** Voeg verborgen cijfers toe aan een live resultaat van Magister. */
export async function restoreHiddenGrades(
  pid: number,
  yearId: number,
  live: Grade[],
  now = Date.now(),
): Promise<Grade[]> {
  if (!enabled) return live;
  const key = memKey(pid, yearId);
  try {
    return await withLock(key, async () => {
      const db = await getDb();
      const prev =
        ((await db.get(STORE, key)) as GradeMemory | undefined) ?? null;
      const { memory, result } = reconcile(prev, live, now);
      await db.put(STORE, memory, key);
      return result;
    });
  } catch (e) {
    console.warn("[HiddenGrades] could not reconcile", e);
    return live;
  }
}

/** Gebruiker verwijdert een verborgen cijfer zelf: nooit meer terughalen. */
export async function forgetHiddenGrade(
  pid: number,
  yearId: number,
  cijferId: number,
): Promise<void> {
  const key = memKey(pid, yearId);
  try {
    await withLock(key, async () => {
      const db = await getDb();
      const prev = (await db.get(STORE, key)) as GradeMemory | undefined;
      if (!prev) return;
      delete prev[String(cijferId)];
      await db.put(STORE, prev, key);
    });
  } catch (e) {
    console.warn("[HiddenGrades] could not forget grade", e);
  }
}

/** Alles vergeten (uitloggen of functie uitzetten). */
export async function clearGradeMemory(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE);
  } catch (e) {
    console.warn("[HiddenGrades] clear failed", e);
  }
}
