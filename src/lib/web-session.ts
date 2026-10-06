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
import {
  WebBackend,
  WebApiError,
  withServerStartingRetry,
  type MagisterMethod,
  type SessionTokens,
} from "./backend.ts";
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
        if (!db.objectStoreNames.contains(STORE_NAME))
          db.createObjectStore(STORE_NAME);
      },
    });
  }
  return dbPromise;
}

export function webBackend(): WebBackend {
  if (!backend) backend = new WebBackend();
  return backend;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Full data URL for a stored base64 photo, with sniffed MIME. Base64 magic
 * prefixes: PNG `iVBORw0KGgo`, GIF `R0lGOD`, JPEG `/9j/`. Fixes PNG photos
 * rendered under a hardcoded jpeg prefix (broken in some browsers).
 */
export function photoDataUrl(b64: string | null | undefined): string | null {
  if (!b64) return null;
  const mime = b64.startsWith("iVBORw0KGgo")
    ? "image/png"
    : b64.startsWith("R0lGOD")
      ? "image/gif"
      : "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

export async function loadWebSession(): Promise<SessionTokens | null> {
  try {
    const db = await getDb();
    const tokens = (await db.get(STORE_NAME, SESSION_KEY)) as
      SessionTokens | undefined;
    if (
      !tokens ||
      typeof tokens.accessToken !== "string" ||
      typeof tokens.refreshToken !== "string"
    )
      return null;
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

/** Load + validate the stored session, refreshing when (nearly) expired.
 * A waking free-tier instance (502/503/504 + network failure) is retried
 * with backoff (~60-90 s) instead of failing immediately; only a genuine
 * rejection (401) logs out, anything else stays `unavailable` with the
 * stored tokens kept for a later retry. */
export async function restoreWebSession(): Promise<RestoreStatus> {
  const tokens = await loadWebSession();
  if (!tokens) return "logged_out";
  if (!isExpiredLocal(tokens)) return "restored";
  try {
    await withServerStartingRetry(() => mustRefresh(tokens));
    return "restored";
  } catch (e) {
    if (e instanceof WebApiError && e.status === 401) return "logged_out";
    return "unavailable";
  }
}

/**
 * One authenticated Tier-A call with the full lifecycle: fresh tokens,
 * single forced-refresh-and-retry on a stale-token 401 (mirrors
 * `get_with_shared` in client.rs), persistence of rotated tokens.
 * "Server starting" failures (Render cold start) are retried with backoff
 * (~60-90 s) instead of failing immediately.
 */
export async function webRequest<T>(
  method: MagisterMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  return withServerStartingRetry(async () => {
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
        const result = await webBackend().magister<T>(
          fresh,
          method,
          path,
          body,
        );
        return result;
      }
      throw e;
    }
  });
}

// Magister refresh tokens are single-use: the first refresh_token grant wins and
// rotates the token, every other grant that presents the old one gets
// invalid_grant (-> 401 here). Several requests fire at once (dashboard fan-out,
// resume, a second tab), so without coordination one expiry produced N refreshes,
// N-1 of them "rejected", and the loser wiped the session -> random logouts.
//
//  - in-tab: all callers share ONE in-flight refresh promise;
//  - cross-tab: the refresh runs under a Web Lock and re-reads IndexedDB first,
//    so a tab that waited adopts the tokens another tab just rotated;
//  - a 401 only clears the session if IndexedDB still holds the refresh token we
//    used (i.e. nobody else rotated it; the grant is truly dead).
let refreshInFlight: Promise<SessionTokens> | null = null;

function sameSession(a: SessionTokens, b: SessionTokens): boolean {
  return a.refreshToken === b.refreshToken;
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;
  if (!locks?.request) return fn();
  return locks.request("friday-token-refresh", fn) as Promise<T>;
}

async function doRefresh(used: SessionTokens): Promise<SessionTokens> {
  return withRefreshLock(async () => {
    // Someone else (another tab / an earlier call) may have refreshed while we waited.
    const stored = await loadWebSession();
    // Logged out (e.g. in another tab) while we waited: do not resurrect the session.
    if (!stored) throw new WebApiError(401, "Niet ingelogd.");
    if (!sameSession(stored, used) && !isExpiredLocal(stored)) return stored;
    const current = stored;
    try {
      const fresh = await webBackend().refresh(current);
      await saveWebSession(fresh);
      return fresh;
    } catch (e) {
      if (e instanceof WebApiError && e.status === 401) {
        // Lost a race against a refresh that landed between our check and our grant?
        const after = await loadWebSession();
        if (after && !sameSession(after, current) && !isExpiredLocal(after))
          return after;
        await clearWebSession();
      }
      throw e;
    }
  });
}

function mustRefresh(tokens: SessionTokens): Promise<SessionTokens> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(tokens).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** TierA adapter over the stored session, for all Tier-B functions. */
export function sessionTierA(): TierA {
  return {
    magister<T>(
      _: SessionTokens,
      method: MagisterMethod,
      path: string,
      body?: unknown,
    ): Promise<T> {
      return webRequest<T>(method, path, body);
    },
    magisterBytes(_: SessionTokens, path: string): Promise<Uint8Array | null> {
      return webRequestBytes(path);
    },
  };
}

export async function webRequestBytes(
  path: string,
): Promise<Uint8Array | null> {
  return withServerStartingRetry(async () => {
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
  });
}
