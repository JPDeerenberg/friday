/**
 * Missions ("Missies") and the season pass: small, friendly goals that reward
 * using the app in useful ways (checking tomorrow, ticking off homework, opening a
 * card pack…). Pure logic; the Svelte store (quests-store.ts) persists it.
 *
 * Design rules, because the players are teenagers:
 *  - Mission points (MP) are a *separate* meter from the card level, so they can
 *    never outweigh actual grades; they are capped per day and per week, and
 *    everyone has the same caps.
 *  - Nothing is ever taken away and a missed day is never mentioned. The streak
 *    counts weeks (not days), survives a quiet current week, and a broken streak
 *    just starts again silently.
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
  | "translated";

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
    title: "Vink 2 huiswerkopdrachten af",
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
  title: "Vink 8 huiswerkopdrachten af",
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
];

export const DAILY_XP_CAP = 15;
export const WEEKLY_XP_CAP = 30;

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

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Today's missions: the check-in plus two others, the same for everyone on the same day. */
export function dailyQuests(day: string): QuestDef[] {
  const pool = [...DAILY_POOL];
  const first = hash(`${day}:a`) % pool.length;
  const a = pool.splice(first, 1)[0];
  const b = pool[hash(`${day}:b`) % pool.length];
  return [CHECK_IN, a, b];
}

/** This week's missions: homework plus one rotating social/fun one. */
export function weeklyQuests(week: string): QuestDef[] {
  return [
    WEEKLY_HOMEWORK,
    WEEKLY_ROTATION[hash(week) % WEEKLY_ROTATION.length],
  ];
}

// ---------------------------------------------------------------- state

export interface QuestState {
  version: 1;
  season: string;
  /** Mission points this season. */
  xp: number;
  day: string;
  dayXp: number;
  dailyProgress: Record<string, number>;
  dailyDone: string[];
  week: string;
  weekXp: number;
  weeklyProgress: Record<string, number>;
  weeklyDone: string[];
  /** Weeks in which at least one daily mission was completed (last 60). */
  activeWeeks: string[];
}

export function emptyQuestState(now: Date): QuestState {
  return {
    version: 1,
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
  };
}

/** Rolls the state over to today / this week / this school year. Never removes earned points of the current season. */
export function rollState(state: QuestState, now: Date): QuestState {
  let s = state;
  const season = questSeason(now);
  if (s.season !== season) s = { ...s, season, xp: 0, activeWeeks: [] };
  const day = dayKey(now);
  if (s.day !== day)
    s = { ...s, day, dayXp: 0, dailyProgress: {}, dailyDone: [] };
  const week = weekKey(now);
  if (s.week !== week)
    s = { ...s, week, weekXp: 0, weeklyProgress: {}, weeklyDone: [] };
  return s;
}

export interface EventResult {
  state: QuestState;
  /** Missions completed by this event. */
  completed: QuestDef[];
  /** Points actually awarded after the daily/weekly caps. */
  awarded: number;
}

export function applyQuestEvent(
  prev: QuestState,
  event: QuestEvent,
  now: Date,
  amount = 1,
): EventResult {
  let s = rollState(prev, now);
  const completed: QuestDef[] = [];
  let awarded = 0;

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

// ---------------------------------------------------------------- season pass

export const TIER_SIZE = 150;
export const TIER_TITLES: ReadonlyArray<string> = [
  "Starter",
  "Doorzetter",
  "Planner",
  "Regelaar",
  "Slimmerik",
  "Topper",
  "Strateeg",
  "Meester",
  "Kampioen",
  "Legende",
];

export interface TierInfo {
  tier: number;
  title: string;
  /** MP inside the current tier. */
  into: number;
  need: number;
  pct: number;
}

export function tierInfo(xp: number): TierInfo {
  const points = Math.max(0, Math.floor(xp));
  const tier = Math.floor(points / TIER_SIZE);
  const into = points - tier * TIER_SIZE;
  return {
    tier,
    title:
      tier === 0 ? "Nog geen rang" : (TIER_TITLES[tier - 1] ?? `Tier ${tier}`),
    into,
    need: TIER_SIZE,
    pct: into / TIER_SIZE,
  };
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

export function sanitizeQuestState(raw: unknown, now: Date): QuestState {
  const base = emptyQuestState(now);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
  return {
    version: 1,
    season: str(r.season, base.season),
    xp: isNum(r.xp) ? r.xp : 0,
    day: str(r.day, base.day),
    dayXp: isNum(r.dayXp) ? r.dayXp : 0,
    dailyProgress: numMap(r.dailyProgress),
    dailyDone: strList(r.dailyDone, 10),
    week: str(r.week, base.week),
    weekXp: isNum(r.weekXp) ? r.weekXp : 0,
    weeklyProgress: numMap(r.weeklyProgress),
    weeklyDone: strList(r.weeklyDone, 10),
    activeWeeks: strList(r.activeWeeks, 60),
  };
}
