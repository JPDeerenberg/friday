/**
 * Gecentraliseerd caching systeem voor Friday.
 *
 * Elke cache entry heeft een TTL (time-to-live) en wordt opgeslagen in IndexedDB
 * (via idb) — Part B 2A: replaced the previous localStorage backend, since
 * IndexedDB has async, non-blocking access and no ~5MB ceiling, which matters
 * once real datasets (grades, messages, calendar) start flowing through this.
 * Pagina's laden eerst uit cache (instant), starten dan een background refresh.
 *
 * The public API (cacheGet/cacheRefresh/cacheClear/cacheClearAll) is unchanged
 * from the localStorage version — every caller was already using these as
 * async functions, so this swap needed zero changes at any call site.
 *
 * Usage:
 *   const data = await cacheGet('dashboard', fetchDashboardData, 5 * 60 * 1000);
 *   // Eerste call: fetch + cache
 *   // Tweede call binnen 5 min: returns cached data (instant)
 *   // Na 5 min: returns cached data, maar start background refresh
 */

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'friday-cache';
const STORE_NAME = 'cache';
const DB_VERSION = 1;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // milliseconds
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Get data from cache, or fetch if expired/missing.
 * When stale (expired but exists), returns cached data immediately
 * and triggers a background refresh.
 */
export async function cacheGet<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = 5 * 60 * 1000, // default 5 minutes
  options?: { skipCache?: boolean }
): Promise<T> {
  const cached = await getFromCache<T>(key);

  // If cache hit and not expired, return immediately
  if (cached && !isExpired(cached) && !options?.skipCache) {
    return cached.data;
  }

  // If cache hit but expired, return stale data and refresh in background
  if (cached && !options?.skipCache) {
    // Don't await — fire and forget
    refreshCache(key, fetcher, ttlMs);
    return cached.data;
  }

  // No cache at all — fetch and wait
  try {
    const data = await fetcher();
    await setCache(key, data, ttlMs);
    return data;
  } catch (e) {
    // If fetch fails but we have stale cache, return that
    if (cached) {
      console.warn(`[Cache] Fetch failed for "${key}", using stale cache`, e);
      return cached.data;
    }
    throw e;
  }
}

/**
 * Force refresh cache for a key (skips cache).
 */
export async function cacheRefresh<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = 5 * 60 * 1000
): Promise<T> {
  const data = await cacheGet(key, fetcher, ttlMs, { skipCache: true });
  return data;
}

/**
 * Clear a specific cache entry.
 */
export async function cacheClear(key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE_NAME, key);
  } catch (e) {
    console.warn(`[Cache] Failed to clear "${key}":`, e);
  }
}

/**
 * Clear all Friday cache entries.
 */
export async function cacheClearAll(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE_NAME);
  } catch (e) {
    console.warn('[Cache] Failed to clear all:', e);
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

async function getFromCache<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const db = await getDb();
    const entry: CacheEntry<T> | undefined = await db.get(STORE_NAME, key);
    if (!entry || typeof entry.timestamp !== 'number') return null;
    return entry;
  } catch (e) {
    console.warn(`[Cache] Failed to read "${key}":`, e);
    return null;
  }
}

async function setCache<T>(key: string, data: T, ttlMs: number): Promise<void> {
  try {
    const db = await getDb();
    const entry: CacheEntry<T> = { data, timestamp: Date.now(), ttl: ttlMs };
    await db.put(STORE_NAME, entry, key);
  } catch (e) {
    console.warn(`[Cache] Failed to set "${key}":`, e);
  }
}

function isExpired(entry: CacheEntry<any>): boolean {
  return Date.now() - entry.timestamp > entry.ttl;
}

async function refreshCache<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<void> {
  try {
    const data = await fetcher();
    await setCache(key, data, ttlMs);
  } catch (e) {
    console.warn(`[Cache] Background refresh failed for "${key}":`, e);
  }
}
