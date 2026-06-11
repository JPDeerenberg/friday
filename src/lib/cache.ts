/**
 * Gecentraliseerd caching systeem voor Friday.
 *
 * Elke cache entry heeft een TTL (time-to-live) en wordt opgeslagen in localStorage.
 * Pagina's laden eerst uit cache (instant), starten dan een background refresh.
 *
 * Usage:
 *   const data = await cacheGet('dashboard', fetchDashboardData, 5 * 60 * 1000);
 *   // Eerste call: fetch + cache
 *   // Tweede call binnen 5 min: returns cached data (instant)
 *   // Na 5 min: returns cached data, maar start background refresh
 */

const CACHE_PREFIX = 'friday_cache_';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // milliseconds
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
  const cacheKey = CACHE_PREFIX + key;
  const cached = getFromCache<T>(cacheKey);

  // If cache hit and not expired, return immediately
  if (cached && !isExpired(cached) && !options?.skipCache) {
    return cached.data;
  }

  // If cache hit but expired, return stale data and refresh in background
  if (cached && !options?.skipCache) {
    // Don't await — fire and forget
    refreshCache(cacheKey, fetcher, ttlMs);
    return cached.data;
  }

  // No cache at all — fetch and wait
  try {
    const data = await fetcher();
    setCache(cacheKey, data, ttlMs);
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
export function cacheClear(key: string): void {
  const cacheKey = CACHE_PREFIX + key;
  try {
    localStorage.removeItem(cacheKey);
  } catch (e) {
    console.warn(`[Cache] Failed to clear "${key}":`, e);
  }
}

/**
 * Clear all Friday cache entries.
 */
export function cacheClearAll(): void {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
    keys.forEach(k => localStorage.removeItem(k));
  } catch (e) {
    console.warn('[Cache] Failed to clear all:', e);
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

function getFromCache<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (!entry || typeof entry.timestamp !== 'number') return null;
    return entry;
  } catch {
    return null;
  }
}

function setCache<T>(key: string, data: T, ttlMs: number): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now(), ttl: ttlMs };
    localStorage.setItem(key, JSON.stringify(entry));
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
    setCache(key, data, ttlMs);
  } catch (e) {
    console.warn(`[Cache] Background refresh failed for "${key}":`, e);
  }
}