/**
 * The friends list as plain data and pure reducers: importing a friend's link,
 * keeping the newest version, noticing when your own schedule changed since you
 * last shared it. The Svelte store (friends-store.ts) only persists this.
 *
 * Friends live in the student's own browser/app storage; nothing here talks to a
 * server.
 */
import {
  absoluteLessons,
  cleanName,
  diffLessons,
  snapshotRange,
  type ScheduleDiff,
  type ScheduleSnapshot,
  type SharedLesson,
} from "./friends-share.ts";
import { hueForId, type Person } from "./friends-compare.ts";

export const MAX_FRIENDS = 40;

export interface FriendRecord {
  id: string;
  /** Name from the link. */
  name: string;
  /** Own name for this friend; wins over `name`. */
  nickname: string;
  snapshot: ScheduleSnapshot;
  /** ms */
  importedAt: number;
  /** Shown in the comparison. */
  enabled: boolean;
}

export interface LastShared {
  signature: string;
  /** ms */
  at: number;
  windowStart: string;
  lessons: SharedLesson[];
}

export interface FriendsState {
  version: 1;
  myId: string;
  myName: string;
  lastShared: LastShared | null;
  friends: FriendRecord[];
}

export function emptyState(myId: string): FriendsState {
  return { version: 1, myId, myName: "", lastShared: null, friends: [] };
}

export const friendLabel = (f: FriendRecord) => f.nickname || f.name;

// ---------------------------------------------------------------- import

export type ImportStatus = "added" | "updated" | "older" | "self" | "full";

export function importFriend(
  state: FriendsState,
  snapshot: ScheduleSnapshot,
  now: number = Date.now(),
): { state: FriendsState; status: ImportStatus } {
  if (snapshot.id === state.myId) return { state, status: "self" };
  const existing = state.friends.find((f) => f.id === snapshot.id);
  if (existing) {
    if (snapshot.createdAt <= existing.snapshot.createdAt)
      return { state, status: "older" };
    return {
      state: {
        ...state,
        friends: state.friends.map((f) =>
          f.id === snapshot.id
            ? { ...f, name: snapshot.name, snapshot, importedAt: now }
            : f,
        ),
      },
      status: "updated",
    };
  }
  if (state.friends.length >= MAX_FRIENDS) return { state, status: "full" };
  const record: FriendRecord = {
    id: snapshot.id,
    name: snapshot.name,
    nickname: "",
    snapshot,
    importedAt: now,
    enabled: true,
  };
  return {
    state: { ...state, friends: [...state.friends, record] },
    status: "added",
  };
}

/**
 * Replace the snapshot of an existing friend in place and adopt the new link's
 * id. Used when the same person shares a link from a new install or another
 * device (their random sender id changed): keeps the nickname, the toggle and
 * the list position instead of adding a second entry.
 */
export function adoptSnapshot(
  state: FriendsState,
  friendId: string,
  snapshot: ScheduleSnapshot,
  now: number = Date.now(),
): FriendsState {
  if (snapshot.id === state.myId) return state;
  if (state.friends.some((f) => f.id === snapshot.id)) return state;
  let adopted = false;
  const friends = state.friends.map((f) => {
    if (f.id !== friendId) return f;
    adopted = true;
    return {
      ...f,
      id: snapshot.id,
      name: snapshot.name,
      snapshot,
      importedAt: now,
    };
  });
  return adopted ? { ...state, friends } : state;
}

export function removeFriend(state: FriendsState, id: string): FriendsState {
  return { ...state, friends: state.friends.filter((f) => f.id !== id) };
}

export function setEnabled(
  state: FriendsState,
  id: string,
  enabled: boolean,
): FriendsState {
  return {
    ...state,
    friends: state.friends.map((f) => (f.id === id ? { ...f, enabled } : f)),
  };
}

export function renameFriend(
  state: FriendsState,
  id: string,
  nickname: string,
): FriendsState {
  const clean = cleanName(nickname);
  return {
    ...state,
    friends: state.friends.map((f) =>
      f.id === id ? { ...f, nickname: clean } : f,
    ),
  };
}

export function setMyName(state: FriendsState, name: string): FriendsState {
  return { ...state, myName: cleanName(name) };
}

export function markShared(
  state: FriendsState,
  snapshot: Pick<ScheduleSnapshot, "windowStart" | "lessons">,
  signature: string,
  now: number = Date.now(),
): FriendsState {
  return {
    ...state,
    lastShared: {
      signature,
      at: now,
      windowStart: snapshot.windowStart,
      lessons: snapshot.lessons,
    },
  };
}

// ---------------------------------------------------------------- notices

export type ChangeNotice =
  { kind: "new-week" } | ({ kind: "changed" } & ScheduleDiff);

/**
 * Whether the student should share a new link: null when nothing changed or when
 * they have not shared anything yet (the page offers sharing anyway).
 */
export function changeNotice(
  state: FriendsState,
  current: { windowStart: string; lessons: ReadonlyArray<SharedLesson> },
): ChangeNotice | null {
  const last = state.lastShared;
  if (!last) return null;
  if (last.windowStart !== current.windowStart) return { kind: "new-week" };
  const diff = diffLessons(last.lessons, current.lessons);
  return diff.changed ? { kind: "changed", ...diff } : null;
}

export function describeNotice(n: ChangeNotice): string {
  if (n.kind === "new-week")
    return "Het is een nieuwe week: deel een nieuwe QR, dan klopt het rooster van je vrienden weer.";
  const parts: string[] = [];
  if (n.removed > 0)
    parts.push(
      `${n.removed} ${n.removed === 1 ? "les is" : "lessen zijn"} vervallen of verplaatst`,
    );
  if (n.added > 0)
    parts.push(`${n.added} ${n.added === 1 ? "nieuwe les" : "nieuwe lessen"}`);
  return `Je rooster is veranderd (${parts.join(", ")}). Deel een nieuwe QR voor je vrienden.`;
}

// ---------------------------------------------------------------- freshness

export type Freshness = "fresh" | "old" | "expired";

/** Expired: every lesson in the snapshot is in the past. Old: made more than 5 days ago (may be out of date). */
export function freshness(
  s: ScheduleSnapshot,
  now: number = Date.now(),
): Freshness {
  const [y, m, d] = s.windowStart.split("-").map(Number);
  const windowEnd = new Date(y, m - 1, d + s.days).getTime();
  if (now >= windowEnd) return "expired";
  return now - s.createdAt * 60000 > 5 * 86400000 ? "old" : "fresh";
}

export function ageText(
  createdAtMinutes: number,
  now: number = Date.now(),
): string {
  const min = Math.max(0, Math.floor((now - createdAtMinutes * 60000) / 60000));
  if (min < 2) return "zojuist";
  if (min < 60) return `${min} min geleden`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} uur geleden`;
  const days = Math.floor(h / 24);
  return days === 1 ? "gisteren" : `${days} dagen geleden`;
}

// ---------------------------------------------------------------- people

/** The comparison's people: enabled friends with their lessons as absolute times and coverage. */
export function friendsAsPeople(state: FriendsState): Person[] {
  return state.friends
    .filter((f) => f.enabled)
    .map((f) => {
      const { from, to } = snapshotRange(f.snapshot);
      return {
        id: f.id,
        name: friendLabel(f),
        hue: hueForId(f.id),
        lessons: absoluteLessons(f.snapshot),
        coversFrom: from,
        coversTo: to,
      };
    });
}

// ---------------------------------------------------------------- storage

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function sanitizeLessons(v: unknown, days: number): SharedLesson[] | null {
  if (!Array.isArray(v) || v.length > 14 * 24) return null;
  const out: SharedLesson[] = [];
  for (const l of v) {
    if (!l || typeof l !== "object") return null;
    const { day, start, end, subject } = l as Record<string, unknown>;
    if (!isNum(day) || !isNum(start) || !isNum(end) || !isStr(subject))
      return null;
    if (day < 0 || day >= days || start < 0 || end <= start || end > 24 * 60)
      return null;
    out.push({ day, start, end, subject: subject.slice(0, 14) });
  }
  return out;
}

function sanitizeSnapshot(v: unknown): ScheduleSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (
    !isStr(s.id) ||
    !/^[0-9a-f]{8}$/.test(s.id) ||
    !isStr(s.name) ||
    !isNum(s.createdAt)
  )
    return null;
  if (!isStr(s.windowStart) || !/^\d{4}-\d{2}-\d{2}$/.test(s.windowStart))
    return null;
  if (!isNum(s.days) || s.days < 1 || s.days > 14) return null;
  const lessons = sanitizeLessons(s.lessons, s.days);
  if (!lessons) return null;
  return {
    id: s.id,
    name: cleanName(s.name) || "Vriend",
    createdAt: s.createdAt,
    windowStart: s.windowStart,
    days: s.days,
    lessons,
  };
}

/** Reads stored state defensively; broken friends are dropped, not fatal. Returns null when unusable. */
export function sanitizeState(raw: unknown): FriendsState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.myId) || !/^[0-9a-f]{8}$/.test(r.myId)) return null;
  const friends: FriendRecord[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.friends)) {
    for (const f of r.friends) {
      if (!f || typeof f !== "object" || friends.length >= MAX_FRIENDS)
        continue;
      const fr = f as Record<string, unknown>;
      const snapshot = sanitizeSnapshot(fr.snapshot);
      if (!snapshot || seen.has(snapshot.id) || snapshot.id === r.myId)
        continue;
      seen.add(snapshot.id);
      friends.push({
        id: snapshot.id,
        name: snapshot.name,
        nickname: isStr(fr.nickname) ? cleanName(fr.nickname) : "",
        snapshot,
        importedAt: isNum(fr.importedAt) ? fr.importedAt : 0,
        enabled: fr.enabled !== false,
      });
    }
  }
  let lastShared: LastShared | null = null;
  const ls = r.lastShared as Record<string, unknown> | null | undefined;
  if (
    ls &&
    typeof ls === "object" &&
    isStr(ls.signature) &&
    isNum(ls.at) &&
    isStr(ls.windowStart)
  ) {
    const lessons = sanitizeLessons(ls.lessons, 14);
    if (lessons)
      lastShared = {
        signature: ls.signature,
        at: ls.at,
        windowStart: ls.windowStart,
        lessons,
      };
  }
  return {
    version: 1,
    myId: r.myId,
    myName: isStr(r.myName) ? cleanName(r.myName) : "",
    lastShared,
    friends,
  };
}
