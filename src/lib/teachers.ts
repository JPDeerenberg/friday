/**
 * Teacher names the student has renamed ("Mevr. Jansen" -> "Janneke"). The
 * rename applies everywhere a teacher name is shown, because every place goes
 * through `formatTeacherName` / `displayTeacherName`.
 *
 * No `#lib` imports and no Svelte, so it runs in plain Node tests; the settings
 * store pushes the saved aliases in via `setTeacherAliases`.
 */

export type TeacherAliases = Record<string, string>;

const MAX_ALIASES = 500;
const MAX_ALIAS_LENGTH = 60;

/** Magister names often carry the teacher code: "J. Jansen (JAN)". */
export function stripTeacherCode(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, "").trim();
}

/** What two spellings of the same teacher share: no code, one space, lower case. */
export function teacherKey(name: string): string {
  return stripTeacherCode(name).replace(/\s+/g, " ").toLowerCase();
}

/** Cleans whatever was stored: only non-empty string pairs, trimmed, bounded. */
export function sanitizeAliases(input: unknown): TeacherAliases {
  const out: TeacherAliases = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_ALIASES) break;
    if (typeof value !== "string") continue;
    const k = teacherKey(key);
    const v = value.replace(/\s+/g, " ").trim().slice(0, MAX_ALIAS_LENGTH);
    if (k && v) out[k] = v;
  }
  return out;
}

/** The alias for `name`, or null when it has none. */
export function aliasFor(name: string, aliases: TeacherAliases): string | null {
  const key = teacherKey(name);
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : null;
}

/** Returns a copy of `aliases` with `name` renamed to `alias`; an empty alias removes it. */
export function withAlias(aliases: TeacherAliases, name: string, alias: string): TeacherAliases {
  const key = teacherKey(name);
  const next = { ...aliases };
  const value = alias.replace(/\s+/g, " ").trim().slice(0, MAX_ALIAS_LENGTH);
  if (!key) return next;
  if (!value || value === stripTeacherCode(name)) delete next[key];
  else next[key] = value;
  return next;
}

let current: TeacherAliases = {};

/** Called by the settings store whenever the saved aliases change. */
export function setTeacherAliases(aliases: unknown): void {
  current = sanitizeAliases(aliases);
}

/**
 * The name to show: the alias if there is one, otherwise the name without its
 * teacher code ("J. Jansen (JAN)" -> "J. Jansen").
 */
export function formatTeacherName(name: string | undefined | null): string {
  if (!name) return "";
  return aliasFor(name, current) ?? stripTeacherCode(name);
}

/**
 * Like `formatTeacherName`, but a name without alias is shown exactly as Magister
 * sends it, code included — for screens that always showed the raw name.
 */
export function displayTeacherName(name: string | undefined | null): string {
  if (!name) return "";
  return aliasFor(name, current) ?? name;
}

// ---------------------------------------------------------------- names seen
//
// The rename screen lists the teachers the app has come across, so there is
// nothing to type: names are noted whenever agenda, assignments or grades load.

const SEEN_KEY = "friday_teachers_seen";
const MAX_SEEN = 400;
let seen: Record<string, string> | null = null;

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadSeen(): Record<string, string> {
  if (seen) return seen;
  seen = {};
  try {
    const raw = storage()?.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && k) seen[k] = v;
      }
    }
  } catch {
    // a corrupt list is just rebuilt
  }
  return seen;
}

/** Notes teacher names so the rename screen can list them. Cheap to call often. */
export function registerTeacherNames(names: ReadonlyArray<string | null | undefined>): void {
  const map = loadSeen();
  let changed = false;
  for (const raw of names) {
    if (!raw) continue;
    const key = teacherKey(raw);
    if (!key || key in map || Object.keys(map).length >= MAX_SEEN) continue;
    map[key] = stripTeacherCode(raw).replace(/\s+/g, " ");
    changed = true;
  }
  if (changed) {
    try {
      storage()?.setItem(SEEN_KEY, JSON.stringify(map));
    } catch {
      // storage full or blocked: the in-memory list still works this session
    }
  }
}

/** Teachers seen so far, alphabetical. */
export function listSeenTeachers(): { key: string; name: string }[] {
  return Object.entries(loadSeen())
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "nl", { sensitivity: "base" }));
}

/** For tests. */
export function _resetTeachersForTests(): void {
  current = {};
  seen = null;
}
