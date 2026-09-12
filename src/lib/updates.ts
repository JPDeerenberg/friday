import { writable } from "svelte/store";

// GitHub repo hosting the published releases (assets: .exe/.msi/.deb/.AppImage/.apk).
// NOTE: the local git remote still points at the old `agenda-tauri` name —
// GitHub redirects it to `friday`, and the release workflow publishes here.
export const UPDATE_REPO = "JPDeerenberg/friday";
export const UPDATE_CHECK_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

const CACHE_KEY = "friday-update-check";
// 24h — keeps us far below the 60 req/h unauthenticated GitHub rate limit.
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckResult {
  /** Running app version, e.g. "2.4.4" (no leading v). */
  current: string;
  /** Latest published release version, e.g. "2.4.3" (no leading v). */
  latest: string;
  /** Raw tag name, e.g. "v2.4.3". */
  tag: string;
  /** Release page URL to open in the browser. */
  htmlUrl: string;
  /** Release notes (may be empty). */
  notes: string;
  /** ISO publish date, may be empty. */
  publishedAt: string;
  updateAvailable: boolean;
  checkedAt: number;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; result: UpdateCheckResult }
  | { status: "available"; result: UpdateCheckResult }
  | { status: "error"; error: string };

/** Shared update state — written by ensureAutoUpdateCheck()/refreshUpdateStatus(). */
export const updateStatus = writable<UpdateState>({ status: "idle" });

/** Strip whitespace + leading "v"/"V" so " v2.4.3 " and "2.4.3" compare equal. */
export function normalizeVersion(v: string): string {
  return (v ?? "").trim().replace(/^[vV]/, "").trim();
}

/**
 * Compare two version strings numerically per dot-separated part.
 * Non-numeric suffixes (e.g. "-beta") are ignored for the numeric compare;
 * a version with more numeric parts only wins if the extra parts are > 0
 * (so "2.4" == "2.4.0").
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = normalizeVersion(a)
    .split(".")
    .map((p) => parseInt(p, 10));
  const pb = normalizeVersion(b)
    .split(".")
    .map((p) => parseInt(p, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0);
    const nb = Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0);
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  if (!normalizeVersion(latest) || !normalizeVersion(current)) return false;
  return compareVersions(current, latest) === -1;
}

export function parseRelease(
  json: {
    tag_name?: string;
    html_url?: string;
    body?: string | null;
    published_at?: string | null;
  },
  current: string,
): UpdateCheckResult {
  const tag = json.tag_name ?? "";
  const latest = normalizeVersion(tag);
  return {
    current: normalizeVersion(current),
    latest,
    tag,
    htmlUrl: json.html_url ?? `https://github.com/${UPDATE_REPO}/releases/latest`,
    notes: typeof json.body === "string" ? json.body : "",
    publishedAt: typeof json.published_at === "string" ? json.published_at : "",
    updateAvailable: isNewerVersion(latest, current),
    checkedAt: Date.now(),
  };
}

/** Running app version from Tauri (reads tauri.conf.json version at build time). */
export async function getCurrentVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return normalizeVersion(await getVersion());
  } catch {
    return "0.0.0";
  }
}

function readCache(): UpdateCheckResult | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UpdateCheckResult;
    if (!parsed || typeof parsed !== "object" || !parsed.latest) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(result: UpdateCheckResult): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(result));
  } catch {
    // Storage full/blocked — non-fatal.
  }
}

function isCacheFresh(cached: UpdateCheckResult): boolean {
  return (
    typeof cached.checkedAt === "number" &&
    Date.now() - cached.checkedAt < UPDATE_CHECK_TTL_MS
  );
}

export interface CheckOptions {
  /** Bypass the 24h cache and hit the GitHub API. */
  force?: boolean;
  /** Override instead of reading the Tauri app version (used by tests). */
  currentVersion?: string;
  /** Override fetch (used by tests). */
  fetcher?: typeof fetch;
}

/**
 * Check GitHub for the latest published release.
 * Uses a 24h localStorage cache unless `force` is set.
 * Draft releases never appear here — the /latest endpoint only returns
 * published, non-draft, non-prerelease releases.
 */
export async function checkForUpdates(options: CheckOptions = {}): Promise<UpdateCheckResult> {
  const cached = options.force ? null : readCache();
  if (cached && isCacheFresh(cached)) return cached;

  const current = options.currentVersion ?? (await getCurrentVersion());
  const doFetch = options.fetcher ?? fetch;
  let res: Response;
  try {
    res = await doFetch(UPDATE_CHECK_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    throw new Error("Geen verbinding met GitHub. Controleer je internet en probeer opnieuw.");
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub-limiet bereikt. Probeer het later opnieuw.");
  }
  if (!res.ok) {
    throw new Error(`GitHub gaf status ${res.status}. Probeer het later opnieuw.`);
  }
  const json = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    body?: string | null;
    published_at?: string | null;
  };
  if (!json || typeof json.tag_name !== "string" || !json.tag_name) {
    throw new Error("GitHub gaf een onverwacht antwoord. Probeer het later opnieuw.");
  }
  const result = parseRelease(json, current);
  writeCache(result);
  return result;
}

/** Silent startup check: only hits the network when the cache is stale. Never throws. */
export async function ensureAutoUpdateCheck(): Promise<void> {
  const cached = readCache();
  if (cached && isCacheFresh(cached)) {
    updateStatus.set(
      cached.updateAvailable
        ? { status: "available", result: cached }
        : { status: "up-to-date", result: cached },
    );
    return;
  }
  updateStatus.set({ status: "checking" });
  try {
    const result = await checkForUpdates();
    updateStatus.set(
      result.updateAvailable
        ? { status: "available", result }
        : { status: "up-to-date", result },
    );
  } catch (e) {
    updateStatus.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Manual check (button): always hits the network and surfaces errors via the store. */
export async function refreshUpdateStatus(): Promise<void> {
  updateStatus.set({ status: "checking" });
  try {
    const result = await checkForUpdates({ force: true });
    updateStatus.set(
      result.updateAvailable
        ? { status: "available", result }
        : { status: "up-to-date", result },
    );
  } catch (e) {
    updateStatus.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}
