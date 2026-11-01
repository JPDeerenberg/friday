/**
 * Offline-opslag voor Friday.
 *
 * Elke succesvolle leesactie (cijfers, agenda, berichten, opdrachten, ...)
 * wordt automatisch bewaard in IndexedDB. Lukt een leesactie niet — geen
 * internet, Magister is down of de school blokkeert tijdelijk — dan krijg je
 * de laatst bewaarde kopie terug, zodat alles geladen blijft.
 *
 * Eén instelling (`offlineStorage`, standaard aan) schakelt dit voor de héle
 * app in of uit. Uitzetten wist de opgeslagen kopie.
 *
 * Bewust een aparte database naast `cache.ts`: die cache heeft een TTL en is
 * bedoeld voor snelheid; deze opslag is bedoeld als vangnet en verloopt nooit.
 */

import { openDB, type IDBPDatabase } from "idb";
import { writable } from "svelte/store";

const DB_NAME = "friday-offline";
const DB_VERSION = 1;
const KV = "kv"; // key -> { data, savedAt }
const ITEMS = "items"; // `${kind}:${pid}:${id}` -> { date, data, savedAt }
const FILES = "files"; // url -> { blob, name, savedAt, size }

/** Grootste bijlage die offline bewaard wordt. */
export const MAX_OFFLINE_FILE_BYTES = 5 * 1024 * 1024;
/** Hoe lang we op een live antwoord wachten als er een bewaarde kopie is. */
export const LIVE_TIMEOUT_MS = 15_000;

interface KvEntry<T = unknown> {
  data: T;
  savedAt: number;
}
interface ItemEntry<T = unknown> {
  date: string; // YYYY-MM-DD
  data: T;
  savedAt: number;
}
interface FileEntry {
  blob: Blob;
  name: string;
  savedAt: number;
  size: number;
}

let enabled = true;
let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        for (const name of [KV, ITEMS, FILES]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      },
    });
  }
  return dbPromise;
}

// ─── Status voor de UI ──────────────────────────────────────────────

export interface OfflineStatus {
  /** true zolang we bewaarde gegevens tonen i.p.v. live gegevens. */
  stale: boolean;
  /** Tijdstip (ms) van de oudste bewaarde kopie die we recent toonden. */
  savedAt: number | null;
  /** Tijdstip (ms) van de laatste complete opslagronde. */
  lastSyncAt: number | null;
}

export const offlineStatus = writable<OfflineStatus>({
  stale: false,
  savedAt: null,
  lastSyncAt: null,
});

function markStale(savedAt: number) {
  offlineStatus.update((s) => ({
    ...s,
    stale: true,
    savedAt: s.stale && s.savedAt ? Math.min(s.savedAt, savedAt) : savedAt,
  }));
}

function markLive() {
  offlineStatus.update((s) =>
    s.stale ? { ...s, stale: false, savedAt: null } : s,
  );
}

export function setLastSyncAt(ts: number) {
  offlineStatus.update((s) => ({ ...s, lastSyncAt: ts }));
  if (enabled) void kvPut("meta:lastSyncAt", ts);
}

/** Staat er al een bewaarde kopie onder deze sleutel? */
export async function hasStored(key: string): Promise<boolean> {
  return (await kvGet(key)) !== null;
}

export async function loadLastSyncAt(): Promise<number | null> {
  const hit = await kvGet<number>("meta:lastSyncAt");
  if (hit) offlineStatus.update((s) => ({ ...s, lastSyncAt: hit.data }));
  return hit?.data ?? null;
}

// ─── Aan/uit ────────────────────────────────────────────────────────

export function setOfflineEnabled(on: boolean) {
  enabled = on;
}

export function isOfflineEnabled(): boolean {
  return enabled;
}

function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// ─── Lage laag: key/value ───────────────────────────────────────────

async function kvGet<T>(key: string): Promise<KvEntry<T> | null> {
  try {
    const db = await getDb();
    const hit = (await db.get(KV, key)) as KvEntry<T> | undefined;
    return hit && typeof hit.savedAt === "number" ? hit : null;
  } catch (e) {
    console.warn(`[Offline] read failed for "${key}"`, e);
    return null;
  }
}

async function kvPut<T>(key: string, data: T): Promise<void> {
  try {
    const db = await getDb();
    await db.put(KV, { data, savedAt: Date.now() } satisfies KvEntry<T>, key);
  } catch (e) {
    console.warn(`[Offline] write failed for "${key}"`, e);
  }
}

/** Wacht op `p`, maar hooguit `ms`; ruimt de timer altijd op. */
function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("offline-timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ─── withOffline: live, anders bewaard ──────────────────────────────

export interface OfflineOptions<T> {
  /** Voeg een nieuw live resultaat samen met de bewaarde kopie. */
  merge?: (old: T, fresh: T) => T;
  /** Bewaar het resultaat niet (bv. zoekopdrachten). */
  skipStore?: boolean;
  /** Een "leeg" live antwoord telt niet als beter dan een bewaarde kopie. */
  isEmpty?: (v: T) => boolean;
}

/**
 * Voer `fetcher` uit. Lukt het: bewaar het resultaat en geef het terug.
 * Faalt het (of duurt het te lang en is er een kopie): geef de bewaarde kopie.
 * Zonder bewaarde kopie wordt de oorspronkelijke fout gewoon doorgegeven.
 */
export async function withOffline<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: OfflineOptions<T> = {},
): Promise<T> {
  if (!enabled) return fetcher();

  const stored = await kvGet<T>(key);

  // Geen verbinding volgens het apparaat: meteen de kopie, niet wachten op
  // retries of time-outs.
  if (stored && isBrowserOffline()) {
    markStale(stored.savedAt);
    return stored.data;
  }

  const save = async (fresh: T): Promise<T> => {
    if (opts.skipStore) return fresh;
    if (opts.isEmpty?.(fresh) && stored && !opts.isEmpty(stored.data)) {
      // Live antwoord is leeg terwijl we eerder wel iets hadden: bewaar
      // de oude kopie, maar toon wat live is (kan legitiem leeg zijn).
      return fresh;
    }
    const merged =
      opts.merge && stored ? opts.merge(stored.data, fresh) : fresh;
    await kvPut(key, merged);
    return merged;
  };

  const live = fetcher().then(async (fresh) => {
    const out = await save(fresh);
    markLive();
    return out;
  });
  live.catch(() => {}); // fouten worden hieronder afgehandeld; nooit "unhandled"

  try {
    if (!stored) return await live;
    // Er is een kopie: wacht beperkt op live, daarna de kopie tonen. De
    // lopende aanvraag schrijft zichzelf alsnog weg als hij slaagt.
    return await raceWithTimeout(live, LIVE_TIMEOUT_MS);
  } catch (e) {
    if (stored) {
      console.warn(`[Offline] using saved copy for "${key}"`, e);
      markStale(stored.savedAt);
      return stored.data;
    }
    throw e;
  }
}

/** Pas een bewaarde kopie aan (bv. een verwijderd verborgen cijfer eruit). */
export async function updateStored<T>(
  key: string,
  mutate: (v: T) => T,
): Promise<void> {
  const hit = await kvGet<T>(key);
  if (hit) await kvPut(key, mutate(hit.data));
}

/** Handig voor wrappers: key bouwen uit delen. */
export function offlineKey(
  ...parts: Array<string | number | null | undefined>
) {
  return parts.map((p) => (p == null ? "" : String(p))).join(":");
}

// ─── Items per datum (agenda, opdrachten) ───────────────────────────

function itemPrefix(kind: string, pid: number) {
  return `${kind}:${pid}:`;
}

function dateOnly(s: string | null | undefined): string {
  return (s ?? "").slice(0, 10);
}

/**
 * Vervang alles binnen [start, end] door `items`. Items buiten dat venster
 * blijven staan, zodat bladeren door verschillende weken de opslag opbouwt.
 */
export async function saveRange<T>(
  kind: string,
  pid: number,
  start: string,
  end: string,
  items: T[],
  idOf: (t: T) => string | number,
  dateOfItem: (t: T) => string | null | undefined,
): Promise<void> {
  if (!enabled) return;
  try {
    const db = await getDb();
    const tx = db.transaction(ITEMS, "readwrite");
    const store = tx.store;
    const prefix = itemPrefix(kind, pid);
    const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
    let cursor = await store.openCursor(range);
    while (cursor) {
      const d = (cursor.value as ItemEntry).date;
      if (d >= start && d <= end) await cursor.delete();
      cursor = await cursor.continue();
    }
    const now = Date.now();
    for (const it of items) {
      await store.put(
        {
          date: dateOnly(dateOfItem(it)),
          data: it,
          savedAt: now,
        } satisfies ItemEntry<T>,
        `${prefix}${idOf(it)}`,
      );
    }
    await tx.done;
  } catch (e) {
    console.warn(`[Offline] saveRange failed for ${kind}`, e);
  }
}

export async function loadRange<T>(
  kind: string,
  pid: number,
  start: string,
  end: string,
): Promise<{ items: T[]; savedAt: number } | null> {
  try {
    const db = await getDb();
    const prefix = itemPrefix(kind, pid);
    const all = (await db.getAll(
      ITEMS,
      IDBKeyRange.bound(prefix, prefix + "\uffff"),
    )) as ItemEntry<T>[];
    const hits = all.filter((e) => e.date >= start && e.date <= end);
    if (hits.length === 0) return null;
    return {
      items: hits.map((h) => h.data),
      savedAt: Math.min(...hits.map((h) => h.savedAt)),
    };
  } catch (e) {
    console.warn(`[Offline] loadRange failed for ${kind}`, e);
    return null;
  }
}

/** Eén bewaard item zoeken op id (voor detailschermen zonder eigen kopie). */
export async function loadItem<T>(
  kind: string,
  pid: number,
  id: string | number,
): Promise<{ item: T; savedAt: number } | null> {
  try {
    const db = await getDb();
    const hit = (await db.get(ITEMS, `${itemPrefix(kind, pid)}${id}`)) as
      ItemEntry<T> | undefined;
    return hit ? { item: hit.data, savedAt: hit.savedAt } : null;
  } catch {
    return null;
  }
}

/** Verwijder bewaarde items die vóór `cutoff` (YYYY-MM-DD) vallen. */
export async function pruneItemsBefore(
  kind: string,
  pid: number,
  cutoff: string,
): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(ITEMS, "readwrite");
    const prefix = itemPrefix(kind, pid);
    let cursor = await tx.store.openCursor(
      IDBKeyRange.bound(prefix, prefix + "\uffff"),
    );
    while (cursor) {
      if ((cursor.value as ItemEntry).date < cutoff) await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch (e) {
    console.warn(`[Offline] prune failed for ${kind}`, e);
  }
}

/**
 * Een bereik-lezing met terugval: live → bewaren; faalt het → bewaarde items.
 */
export async function withOfflineRange<T>(opts: {
  kind: string;
  pid: number;
  start: string;
  end: string;
  fetcher: () => Promise<T[]>;
  idOf: (t: T) => string | number;
  dateOf: (t: T) => string | null | undefined;
}): Promise<T[]> {
  const { kind, pid, start, end, fetcher, idOf, dateOf } = opts;
  if (!enabled) return fetcher();

  const fromStore = () => loadRange<T>(kind, pid, start, end);

  if (isBrowserOffline()) {
    const hit = await fromStore();
    if (hit) {
      markStale(hit.savedAt);
      return hit.items;
    }
  }

  const live = fetcher().then(async (fresh) => {
    await saveRange(kind, pid, start, end, fresh, idOf, dateOf);
    markLive();
    return fresh;
  });
  live.catch(() => {});

  try {
    const hit = await fromStore();
    if (!hit) return await live;
    return await raceWithTimeout(live, LIVE_TIMEOUT_MS);
  } catch (e) {
    const hit = await fromStore();
    if (hit) {
      console.warn(`[Offline] using saved ${kind} for ${start}..${end}`, e);
      markStale(hit.savedAt);
      return hit.items;
    }
    throw e;
  }
}

// ─── Bijlagen (alleen kleine bestanden) ─────────────────────────────

export async function saveFile(
  url: string,
  blob: Blob,
  name: string,
): Promise<boolean> {
  if (!enabled || blob.size > MAX_OFFLINE_FILE_BYTES) return false;
  try {
    const db = await getDb();
    await db.put(
      FILES,
      {
        blob,
        name,
        savedAt: Date.now(),
        size: blob.size,
      } satisfies FileEntry,
      url,
    );
    return true;
  } catch (e) {
    console.warn("[Offline] saveFile failed", e);
    return false;
  }
}

export async function loadFile(
  url: string,
): Promise<{ blob: Blob; name: string; savedAt: number } | null> {
  try {
    const db = await getDb();
    const hit = (await db.get(FILES, url)) as FileEntry | undefined;
    return hit
      ? { blob: hit.blob, name: hit.name, savedAt: hit.savedAt }
      : null;
  } catch {
    return null;
  }
}

export async function hasFile(url: string): Promise<boolean> {
  return (await loadFile(url)) !== null;
}

/** Pad op schijf van een eerder gedownloade bijlage (desktop/Android). */
export async function saveDownloadedPath(url: string, path: string) {
  if (!enabled) return;
  await kvPut(`filepath:${url}`, path);
}

export async function loadDownloadedPath(url: string): Promise<string | null> {
  return (await kvGet<string>(`filepath:${url}`))?.data ?? null;
}

// ─── Identiteit voor koud starten zonder internet ───────────────────

export interface OfflineIdentity {
  personId: number;
  account: unknown;
  picture: string | null;
}

export async function saveIdentity(id: OfflineIdentity): Promise<void> {
  if (!enabled) return;
  await kvPut("identity", id);
}

export async function loadIdentity(): Promise<OfflineIdentity | null> {
  if (!enabled) return null;
  return (await kvGet<OfflineIdentity>("identity"))?.data ?? null;
}

// ─── Opruimen ───────────────────────────────────────────────────────

export async function clearOffline(): Promise<void> {
  try {
    const db = await getDb();
    await Promise.all([db.clear(KV), db.clear(ITEMS), db.clear(FILES)]);
  } catch (e) {
    console.warn("[Offline] clear failed", e);
  }
  offlineStatus.set({ stale: false, savedAt: null, lastSyncAt: null });
}

/** Ruwe schatting van het geheugengebruik, voor in de instellingen. */
export async function offlineUsageBytes(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    return typeof est?.usage === "number" ? est.usage : null;
  } catch {
    return null;
  }
}
