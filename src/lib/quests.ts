/**
 * Missions ("Missies") and the season XP meter: small, friendly goals that
 * reward using the app in useful ways (checking tomorrow, ticking off homework,
 * opening a card pack…). Pure logic; the Svelte store (quests-store.ts)
 * persists it.
 *
 * Design rules, because the players are teenagers:
 *  - One season XP wallet. Missions, opened grade cards and Blackjack all feed
 *    the same number. Only mission XP is capped per day/week; card XP and
 *    Blackjack are not, so a good grade is always worth the same.
 *  - A lesson, card or page visit is never counted twice. `seen` remembers
 *    dedupe keys across day/week boundaries and travels with the sync document.
 *  - A missed day is never mentioned. The week streak counts weeks, survives a
 *    quiet current week, and a broken streak just starts again silently.
 */

import type { IconName } from "#lib/icons.ts";

export type QuestEvent =
  | "app_open"
  | "agenda_checked"
  | "homework_done"
  | "simulator_used"
  | "pack_opened"
  | "friend_shared"
  | "friend_added"
  | "wrapped_viewed"
  | "translated"
  | "grades_checked"
  | "messages_checked"
  | "plan_checked"
  | "assignments_checked"
  | "card_opened"
  | "blackjack_played"
  | "blackjack_won";

export interface QuestDef {
  id: string;
  title: string;
  icon: IconName;
  event: QuestEvent;
  target: number;
  xp: number;
  period: "day" | "week";
}

export const DAILY_POOL: ReadonlyArray<QuestDef> = [
  {
    id: "d-agenda",
    title: "Kijk in je agenda",
    icon: "calendar",
    event: "agenda_checked",
    target: 1,
    xp: 3,
    period: "day",
  },
  {
    id: "d-homework",
    title: "Vink 2 unieke huiswerkopdrachten af",
    icon: "check-circle",
    event: "homework_done",
    target: 2,
    xp: 5,
    period: "day",
  },
  {
    id: "d-sim",
    title: "Speel met de cijfer-simulator",
    icon: "sliders",
    event: "simulator_used",
    target: 1,
    xp: 4,
    period: "day",
  },
  {
    id: "d-pack",
    title: "Open een kaartpakket",
    icon: "gift",
    event: "pack_opened",
    target: 1,
    xp: 6,
    period: "day",
  },
  {
    id: "d-cards",
    title: "Open 3 cijferkaarten",
    icon: "sparkles",
    event: "card_opened",
    target: 3,
    xp: 6,
    period: "day",
  },
  {
    id: "d-grades",
    title: "Bekijk je cijfers",
    icon: "trophy",
    event: "grades_checked",
    target: 1,
    xp: 4,
    period: "day",
  },
  {
    id: "d-messages",
    title: "Check je berichten",
    icon: "mail",
    event: "messages_checked",
    target: 1,
    xp: 4,
    period: "day",
  },
  {
    id: "d-plan",
    title: "Bekijk je Friday-plan",
    icon: "rocket",
    event: "plan_checked",
    target: 1,
    xp: 5,
    period: "day",
  },
  {
    id: "d-assignments",
    title: "Bekijk je opdrachten",
    icon: "book",
    event: "assignments_checked",
    target: 1,
    xp: 4,
    period: "day",
  },
  {
    id: "d-blackjack",
    title: "Speel een potje Blackjack",
    icon: "gamepad",
    event: "blackjack_played",
    target: 1,
    xp: 5,
    period: "day",
  },
];

/** Always part of the day: the check-in. */
export const CHECK_IN: QuestDef = {
  id: "d-open",
  title: "Open Friday",
  icon: "sunrise",
  event: "app_open",
  target: 1,
  xp: 3,
  period: "day",
};

export const WEEKLY_HOMEWORK: QuestDef = {
  id: "w-homework",
  title: "Vink 8 unieke huiswerkopdrachten af",
  icon: "book",
  event: "homework_done",
  target: 8,
  xp: 15,
  period: "week",
};

export const WEEKLY_ROTATION: ReadonlyArray<QuestDef> = [
  {
    id: "w-share",
    title: "Deel je rooster met een vriend",
    icon: "smartphone",
    event: "friend_shared",
    target: 1,
    xp: 12,
    period: "week",
  },
  {
    id: "w-friend",
    title: "Voeg een vriend toe",
    icon: "handshake",
    event: "friend_added",
    target: 1,
    xp: 12,
    period: "week",
  },
  {
    id: "w-wrapped",
    title: "Bekijk je Wrapped",
    icon: "clapperboard",
    event: "wrapped_viewed",
    target: 1,
    xp: 8,
    period: "week",
  },
  {
    id: "w-translate",
    title: "Vertaal huiswerk in een andere taal",
    icon: "globe",
    event: "translated",
    target: 1,
    xp: 8,
    period: "week",
  },
  {
    id: "w-grades",
    title: "Bekijk je cijfers op 3 dagen",
    icon: "trophy",
    event: "grades_checked",
    target: 3,
    xp: 12,
    period: "week",
  },
  {
    id: "w-plan",
    title: "Bekijk je plan op 3 dagen",
    icon: "rocket",
    event: "plan_checked",
    target: 3,
    xp: 12,
    period: "week",
  },
  {
    id: "w-messages",
    title: "Check je berichten op 3 dagen",
    icon: "mail",
    event: "messages_checked",
    target: 3,
    xp: 10,
    period: "week",
  },
  {
    id: "w-blackjack",
    title: "Speel 5 potjes Blackjack",
    icon: "gamepad",
    event: "blackjack_played",
    target: 5,
    xp: 15,
    period: "week",
  },
  {
    id: "w-blackjack-win",
    title: "Win 3 potjes Blackjack",
    icon: "crown",
    event: "blackjack_won",
    target: 3,
    xp: 15,
    period: "week",
  },
  {
    id: "w-cards",
    title: "Open 8 cijferkaarten",
    icon: "sparkles",
    event: "card_opened",
    target: 8,
    xp: 15,
    period: "week",
  },
];

export const DAILY_XP_CAP = 20;
export const WEEKLY_XP_CAP = 45;

/** Upper bound for the dedupe map; older entries are pruned after ~400 days. */
export const MAX_SEEN = 3000;
export const SEEN_MAX_AGE_DAYS = 400;

// ---------------------------------------------------------------- keys

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** ISO week key "2026-W46" (weeks start on Monday). */
export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

/** School year "2026-2027" (Aug-Jul), same as the card seasons. */
export function questSeason(d: Date): string {
  const start = d.getMonth() + 1 >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${start + 1}`;
}

/** Stable key for a homework appointment; the same lesson only ever counts once. */
export const homeworkKey = (id: number | string) => `homework:${id}`;

/** Page-visit events count once per day, so a "3 days" weekly mission cannot be refreshed. */
export const dayEventKey = (event: QuestEvent, now: Date) =>
  `${event}:${dayKey(now)}`;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pick<T>(pool: T[], count: number, salt: string): T[] {
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    const idx = hash(`${salt}:${out.length}`) % pool.length;
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** Today's missions: the check-in plus three others, the same for everyone on the same day. */
export function dailyQuests(day: string): QuestDef[] {
  return [CHECK_IN, ...pick([...DAILY_POOL], 3, day)];
}

/** This week's missions: homework plus two rotating missions. */
export function weeklyQuests(week: string): QuestDef[] {
  return [WEEKLY_HOMEWORK, ...pick([...WEEKLY_ROTATION], 2, week)];
}

// ---------------------------------------------------------------- state

export interface QuestState {
  version: 2;
  season: string;
  /** Spendable season XP: mission rewards + opened cards + Blackjack result. */
  xp: number;
  day: string;
  /** Mission XP awarded today (caps only apply to this, not to card/Blackjack XP). */
  dayXp: number;
  dailyProgress: Record<string, number>;
  dailyDone: string[];
  week: string;
  weekXp: number;
  weeklyProgress: Record<string, number>;
  weeklyDone: string[];
  /** Weeks in which at least one daily mission was completed (last 60). */
  activeWeeks: string[];
  /** Dedupe key -> day key. Homework ids, card ids, page visits and card-XP credits. */
  seen: Record<string, string>;
  /** Existing opened-card XP has been folded into `xp` once. */
  cardXpSeeded: boolean;
  /** Card XP already added this season; used only while the migration runs. */
  cardXpCredited: number;
}

export function emptyQuestState(now: Date): QuestState {
  return {
    version: 2,
    season: questSeason(now),
    xp: 0,
    day: dayKey(now),
    dayXp: 0,
    dailyProgress: {},
    dailyDone: [],
    week: weekKey(now),
    weekXp: 0,
    weeklyProgress: {},
    weeklyDone: [],
    activeWeeks: [],
    seen: {},
    cardXpSeeded: false,
    cardXpCredited: 0,
  };
}

function pruneSeen(
  seen: Record<string, string>,
  now: Date,
): Record<string, string> {
  const entries = Object.entries(seen);
  if (entries.length <= MAX_SEEN - 500) return seen;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - SEEN_MAX_AGE_DAYS);
  const cutoffKey = dayKey(cutoff);
  const kept = entries.filter(
    ([, day]) => typeof day === "string" && day >= cutoffKey,
  );
  return Object.fromEntries(kept.slice(-MAX_SEEN));
}

/** Rolls the state over to today / this week / this school year. Never removes XP earned this season. */
export function rollState(state: QuestState, now: Date): QuestState {
  let s = state;
  const season = questSeason(now);
  if (s.season !== season)
    s = {
      ...s,
      season,
      xp: 0,
      activeWeeks: [],
      cardXpCredited: 0,
      cardXpSeeded: false,
    };
  const day = dayKey(now);
  if (s.day !== day)
    s = { ...s, day, dayXp: 0, dailyProgress: {}, dailyDone: [] };
  const week = weekKey(now);
  if (s.week !== week)
    s = { ...s, week, weekXp: 0, weeklyProgress: {}, weeklyDone: [] };
  const seen = pruneSeen(s.seen ?? {}, now);
  if (seen !== s.seen) s = { ...s, seen };
  return s;
}

export interface EventResult {
  state: QuestState;
  /** Missions completed by this event. */
  completed: QuestDef[];
  /** Mission XP actually awarded after the daily/weekly caps. */
  awarded: number;
}

export function applyQuestEvent(
  prev: QuestState,
  event: QuestEvent,
  now: Date,
  amount = 1,
  key?: string,
): EventResult {
  let s = rollState(prev, now);
  const completed: QuestDef[] = [];
  let awarded = 0;

  // Mark the dedupe key even when no mission is active today. That is what
  // makes a homework lesson or a card un-farmable, and it keeps "3 days"
  // missions from counting six refreshes on the same day.
  if (key) {
    if (s.seen[key]) return { state: s, completed, awarded };
    s = { ...s, seen: { ...s.seen, [key]: dayKey(now) } };
  }

  const active = [...dailyQuests(s.day), ...weeklyQuests(s.week)].filter(
    (q) => q.event === event,
  );
  for (const q of active) {
    const daily = q.period === "day";
    const done = daily ? s.dailyDone : s.weeklyDone;
    if (done.includes(q.id)) continue;
    const progressMap = daily ? s.dailyProgress : s.weeklyProgress;
    const progress = Math.min(q.target, (progressMap[q.id] ?? 0) + amount);
    const patch: Partial<QuestState> = daily
      ? { dailyProgress: { ...s.dailyProgress, [q.id]: progress } }
      : { weeklyProgress: { ...s.weeklyProgress, [q.id]: progress } };
    s = { ...s, ...patch };
    if (progress < q.target) continue;

    const room = daily ? DAILY_XP_CAP - s.dayXp : WEEKLY_XP_CAP - s.weekXp;
    const gain = Math.max(0, Math.min(q.xp, room));
    awarded += gain;
    completed.push(q);
    s = daily
      ? {
          ...s,
          dailyDone: [...s.dailyDone, q.id],
          dayXp: s.dayXp + gain,
          xp: s.xp + gain,
        }
      : {
          ...s,
          weeklyDone: [...s.weeklyDone, q.id],
          weekXp: s.weekXp + gain,
          xp: s.xp + gain,
        };
    if (daily && !s.activeWeeks.includes(s.week)) {
      s = { ...s, activeWeeks: [...s.activeWeeks, s.week].slice(-60) };
    }
  }
  return { state: s, completed, awarded };
}

/** Consecutive active weeks, counted back from this week (or from last week when this one is still quiet). */
export function weekStreak(state: QuestState, now: Date): number {
  const active = new Set(state.activeWeeks);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!active.has(weekKey(d))) d.setDate(d.getDate() - 7);
  let n = 0;
  while (active.has(weekKey(d)) && n < 60) {
    n++;
    d.setDate(d.getDate() - 7);
  }
  return n;
}

// ---------------------------------------------------------------- display

export interface QuestRow {
  def: QuestDef;
  progress: number;
  done: boolean;
}

export function todaysRows(state: QuestState, now: Date): QuestRow[] {
  const s = rollState(state, now);
  return dailyQuests(s.day).map((def) => ({
    def,
    progress: s.dailyDone.includes(def.id)
      ? def.target
      : (s.dailyProgress[def.id] ?? 0),
    done: s.dailyDone.includes(def.id),
  }));
}

export function weekRows(state: QuestState, now: Date): QuestRow[] {
  const s = rollState(state, now);
  return weeklyQuests(s.week).map((def) => ({
    def,
    progress: s.weeklyDone.includes(def.id)
      ? def.target
      : (s.weeklyProgress[def.id] ?? 0),
    done: s.weeklyDone.includes(def.id),
  }));
}

// ---------------------------------------------------------------- storage

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").slice(0, max)
    : [];
const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v as Record<string, unknown>))
      if (isNum(n) && out[k] === undefined) out[k] = n;
  }
  return out;
};
const seenMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, day] of Object.entries(v as Record<string, unknown>)) {
      if (k.length > 120 || typeof day !== "string" || !DAY_RE.test(day))
        continue;
      if (out[k] === undefined) out[k] = day;
    }
  }
  return out;
};

export function sanitizeQuestState(raw: unknown, now: Date): QuestState {
  const base = emptyQuestState(now);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
  return {
    version: 2,
    season: str(r.season, base.season),
    xp: isNum(r.xp) ? r.xp : 0,
    day: str(r.day, base.day),
    dayXp: isNum(r.dayXp) ? r.dayXp : 0,
    dailyProgress: numMap(r.dailyProgress),
    dailyDone: strList(r.dailyDone, 20),
    week: str(r.week, base.week),
    weekXp: isNum(r.weekXp) ? r.weekXp : 0,
    weeklyProgress: numMap(r.weeklyProgress),
    weeklyDone: strList(r.weeklyDone, 20),
    activeWeeks: strList(r.activeWeeks, 60),
    seen: seenMap(r.seen),
    cardXpSeeded: r.cardXpSeeded === true,
    cardXpCredited: isNum(r.cardXpCredited) ? r.cardXpCredited : 0,
  };
}
