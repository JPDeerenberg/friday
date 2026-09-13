/**
 * Browser session for the web build: Magister tokens in IndexedDB, refresh
 * before expiry, and refresh-and-retry-once on stale-token 401s.
 *
 * Mirrors the desktop semantics in `+layout.svelte` / `client.rs`:
 * - `restored` — usable session (refreshed if needed)
 * - `logged_out` — nothing stored, or server rejected the grant (401)
 * - `unavailable` — transient failure, tokens kept for a later retry
 *
 * Passwords never touch this store — only the token set returned by
 * `POST /api/auth/login` (see WebBackend).
 */

import { openDB, type IDBPDatabase } from "idb";
import { WebBackend, WebApiError, type MagisterMethod, type SessionTokens } from "./backend.ts";
import type { TierA } from "./web-tier-b.ts";

const DB_NAME = "friday-session";
const STORE_NAME = "session";
const SESSION_KEY = "current";
// Same 2-minute early-refresh buffer as magister-core TokenSet::is_expired.
const EXPIRY_BUFFER_MS = 120_000;

let dbPromise: Promise<IDBPDatabase> | null = null;
let backend: WebBackend | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      },
    });
  }
  return dbPromise;
}

export function webBackend(): WebBackend {
  if (!backend) backend = new WebBackend();
  return backend;
}

export async function loadWebSession(): Promise<SessionTokens | null> {
  try {
    const db = await getDb();
    const tokens = (await db.get(STORE_NAME, SESSION_KEY)) as SessionTokens | undefined;
    if (!tokens || typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string") return null;
    return tokens;
  } catch {
    return null;
  }
}

export async function saveWebSession(tokens: SessionTokens): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, tokens, SESSION_KEY);
}

export async function clearWebSession(): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE_NAME, SESSION_KEY);
  } catch {
    // Clearing must never fail logout.
  }
}

export function isExpiredLocal(tokens: SessionTokens): boolean {
  const expires = Date.parse(tokens.expiresAt);
  if (Number.isNaN(expires)) return true;
  return Date.now() + EXPIRY_BUFFER_MS >= expires;
}

export type RestoreStatus = "restored" | "logged_out" | "unavailable";

/** Load + validate the stored session, refreshing when (nearly) expired. */
export async function restoreWebSession(): Promise<RestoreStatus> {
  const tokens = await loadWebSession();
  if (!tokens) return "logged_out";
  if (!isExpiredLocal(tokens)) return "restored";
  try {
    const fresh = await webBackend().refresh(tokens);
    await saveWebSession(fresh);
    return "restored";
  } catch (e) {
    if (e instanceof WebApiError && e.status === 401) {
      await clearWebSession();
      return "logged_out";
    }
    return "unavailable";
  }
}

/**
 * One authenticated Tier-A call with the full lifecycle: fresh tokens,
 * single forced-refresh-and-retry on a stale-token 401 (mirrors
 * `get_with_shared` in client.rs), persistence of rotated tokens.
 */
export async function webRequest<T>(method: MagisterMethod, path: string, body?: unknown): Promise<T> {
  let tokens = await loadWebSession();
  if (!tokens) throw new WebApiError(401, "Niet ingelogd.");
  if (isExpiredLocal(tokens)) {
    tokens = await mustRefresh(tokens);
  }
  try {
    return await webBackend().magister<T>(tokens, method, path, body);
  } catch (e) {
    if (e instanceof WebApiError && e.status === 401) {
      const fresh = await mustRefresh(tokens);
      const result = await webBackend().magister<T>(fresh, method, path, body);
      return result;
    }
    throw e;
  }
}

async function mustRefresh(tokens: SessionTokens): Promise<SessionTokens> {
  try {
    const fresh = await webBackend().refresh(tokens);
    await saveWebSession(fresh);
    return fresh;
  } catch (e) {
    if (e instanceof WebApiError && e.status === 401) {
      await clearWebSession();
    }
    throw e;
  }
}

/** TierA adapter over the stored session, for all Tier-B functions. */
export function sessionTierA(): TierA {
  return {
    magister<T>(_: SessionTokens, method: MagisterMethod, path: string, body?: unknown): Promise<T> {
      return webRequest<T>(method, path, body);
    },
  };
}

export async function webRequestBytes(path: string): Promise<Uint8Array | null> {
  const tokens = await loadWebSession();
  if (!tokens) throw new WebApiError(401, "Niet ingelogd.");
  const fresh = isExpiredLocal(tokens) ? await mustRefresh(tokens) : tokens;
  try {
    return await webBackend().magisterBytes(fresh, path);
  } catch (e) {
    if (e instanceof WebApiError && e.status === 401) {
      const retry = await mustRefresh(fresh);
      return await webBackend().magisterBytes(retry, path);
    }
    throw e;
  }
}
