/**
 * Comparing schedules: who is in a lesson right now, who has a gap, when are you
 * and your friends free at the same time, and what does everyone's day look like.
 * Read-only maths over lesson times; pure and tested.
 */
import type { AbsoluteLesson } from "./friends-share.ts";

export interface Person {
  id: string;
  name: string;
  /** 0-359, for the colour of this person. */
  hue: number;
  lessons: ReadonlyArray<AbsoluteLesson>;
  /**
   * Local-midnight range covered by the shared snapshot. Absent for your own
   * schedule (always known). Used to tell "no lessons" apart from "no data".
   */
  coversFrom?: number;
  coversTo?: number;
}

export type PresenceKind =
  | "in-lesson" // In a lesson.
  | "gap" // Between two lessons (a "tussenuur").
  | "before" // School day has not started for this person yet.
  | "done" // Lessons are over for today.
  | "no-school"; // No lessons today.

export interface Presence {
  kind: PresenceKind;
  subject?: string;
  /** ms: when the lesson ends / the next lesson starts / the day starts. */
  until?: number;
  /** ms: since when the gap / "done" state holds. */
  since?: number;
}

const midnight = (ms: number) =>
  new Date(
    new Date(ms).getFullYear(),
    new Date(ms).getMonth(),
    new Date(ms).getDate(),
  ).getTime();
const sameDay = (a: number, b: number) => midnight(a) === midnight(b);

/** All lessons of `lessons` that start on the same calendar day as `at`, sorted. */
export function lessonsOnDay(
  lessons: ReadonlyArray<AbsoluteLesson>,
  at: number,
): AbsoluteLesson[] {
  return lessons
    .filter((l) => sameDay(l.start, at))
    .sort((a, b) => a.start - b.start);
}

/** Whether this person shared a schedule that covers the given day. */
export function coversDay(person: Person, day: Date): boolean {
  if (person.coversFrom === undefined || person.coversTo === undefined)
    return true;
  const t = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
  ).getTime();
  return t >= person.coversFrom && t < person.coversTo;
}

export function presenceAt(
  lessons: ReadonlyArray<AbsoluteLesson>,
  at: number,
): Presence {
  const day = lessonsOnDay(lessons, at);
  if (day.length === 0) return { kind: "no-school" };
  const current = day.find((l) => l.start <= at && at < l.end);
  if (current)
    return { kind: "in-lesson", subject: current.subject, until: current.end };
  if (at < day[0].start) return { kind: "before", until: day[0].start };
  const last = day[day.length - 1];
  if (at >= last.end) return { kind: "done", since: last.end };
  const next = day.find((l) => l.start > at)!;
  const prev = [...day].reverse().find((l) => l.end <= at)!;
  return { kind: "gap", until: next.start, since: prev.end };
}

export interface PresenceEntry {
  person: Person;
  presence: Presence;
}

/** Everyone's state at `at`, in the order given. */
export function presenceOf(
  people: ReadonlyArray<Person>,
  at: number,
): PresenceEntry[] {
  return people.map((person) => ({
    person,
    presence: presenceAt(person.lessons, at),
  }));
}

/** People who could meet right now: anyone not in a lesson (including a day off). */
export function freeNow(
  people: ReadonlyArray<Person>,
  at: number,
): PresenceEntry[] {
  return presenceOf(people, at).filter((e) => e.presence.kind !== "in-lesson");
}

// ---------------------------------------------------------------- free time

export interface FreeBlock {
  start: number;
  end: number;
  minutes: number;
}

const blockOf = (start: number, end: number): FreeBlock => ({
  start,
  end,
  minutes: Math.round((end - start) / 60000),
});

/**
 * Stretches without a lesson inside [start, end). Overlapping or back-to-back
 * lessons are handled; blocks are in chronological order.
 */
export function freeBlocks(
  lessons: ReadonlyArray<AbsoluteLesson>,
  day: Date,
  start: number,
  end: number,
): FreeBlock[] {
  const out: FreeBlock[] = [];
  let cursor = start;
  for (const l of lessonsOnDay(lessons, day.getTime())) {
    if (l.end <= start || l.start >= end) continue;
    const s = Math.max(start, l.start);
    const e = Math.min(end, l.end);
    if (s > cursor) out.push(blockOf(cursor, s));
    cursor = Math.max(cursor, e);
  }
  if (cursor < end) out.push(blockOf(cursor, end));
  return out;
}

/** First lesson start to last lesson end for the group; null when nobody has lessons. */
export function dayBounds(
  people: ReadonlyArray<Person>,
  day: Date,
): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const p of people) {
    for (const l of lessonsOnDay(p.lessons, day.getTime())) {
      start = Math.min(start, l.start);
      end = Math.max(end, l.end);
    }
  }
  return start < end ? { start, end } : null;
}

function intersect(
  a: ReadonlyArray<FreeBlock>,
  b: ReadonlyArray<FreeBlock>,
): FreeBlock[] {
  const out: FreeBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push(blockOf(start, end));
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

/** Free time that you and one friend share, across both of your school days. */
export function sharedFreeSlots(
  a: Person,
  b: Person,
  day: Date,
  minMinutes = 5,
): FreeBlock[] {
  const bounds = dayBounds([a, b], day);
  if (!bounds) return [];
  return intersect(
    freeBlocks(a.lessons, day, bounds.start, bounds.end),
    freeBlocks(b.lessons, day, bounds.start, bounds.end),
  ).filter((f) => f.minutes >= minMinutes);
}

export interface CommonFree {
  /** Times at school when nobody has a lesson, at least `minMinutes` long. */
  slots: FreeBlock[];
  /** ms: when the last person is done, or null when nobody has lessons that day. */
  allDoneAt: number | null;
  /** How many of the people have lessons on that day. */
  withLessons: number;
}

/**
 * When does nobody in `people` have a lesson, within the school day (first lesson
 * start to last lesson end of the group)? People without lessons that day do not
 * constrain anything.
 */
export function commonFreeSlots(
  people: ReadonlyArray<Person>,
  day: Date,
  minMinutes = 20,
): CommonFree {
  const at = day.getTime();
  const all: AbsoluteLesson[] = [];
  let withLessons = 0;
  for (const p of people) {
    const l = lessonsOnDay(p.lessons, at);
    if (l.length > 0) withLessons++;
    all.push(...l);
  }
  if (all.length === 0) return { slots: [], allDoneAt: null, withLessons: 0 };

  all.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const l of all) {
    const last = merged[merged.length - 1];
    if (last && l.start <= last.end) last.end = Math.max(last.end, l.end);
    else merged.push({ start: l.start, end: l.end });
  }
  const slots: FreeBlock[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const start = merged[i].end;
    const end = merged[i + 1].start;
    const minutes = Math.round((end - start) / 60000);
    if (minutes >= minMinutes) slots.push({ start, end, minutes });
  }
  return { slots, allDoneAt: merged[merged.length - 1].end, withLessons };
}

export interface AvailabilityWindow {
  start: number;
  end: number;
  minutes: number;
  /** Everyone who has no lesson during the whole window, in the order given. */
  free: Person[];
  /** Everyone who has a lesson in (part of) the window. */
  busy: Person[];
}

/**
 * All stretches of the group's school day where *you* (the first person) and at
 * least one friend are free at the same time, with exactly who is free. Windows
 * are cut at lesson boundaries, adjacent stretches with the same group merged.
 */
export function availability(
  people: ReadonlyArray<Person>,
  day: Date,
  minMinutes = 10,
): AvailabilityWindow[] {
  const me = people[0];
  const bounds = dayBounds(people, day);
  if (!me || !bounds) return [];

  const lessons = new Map(
    people.map((p) => [p.id, lessonsOnDay(p.lessons, day.getTime())]),
  );
  const edges = new Set<number>([bounds.start, bounds.end]);
  for (const list of lessons.values()) {
    for (const l of list) {
      if (l.start > bounds.start && l.start < bounds.end) edges.add(l.start);
      if (l.end > bounds.start && l.end < bounds.end) edges.add(l.end);
    }
  }
  const points = [...edges].sort((a, b) => a - b);

  const segments: { start: number; end: number; free: Person[] }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const free = people.filter(
      (p) =>
        !(lessons.get(p.id) ?? []).some((l) => l.start < end && l.end > start),
    );
    const prev = segments[segments.length - 1];
    const same =
      prev &&
      prev.free.length === free.length &&
      prev.free.every((p, idx) => p.id === free[idx].id);
    if (same) prev.end = end;
    else segments.push({ start, end, free });
  }

  return segments
    .filter((s) => s.free.some((p) => p.id === me.id) && s.free.length >= 2)
    .map((s) => ({
      start: s.start,
      end: s.end,
      minutes: Math.round((s.end - s.start) / 60000),
      free: s.free,
      busy: people.filter((p) => !s.free.some((f) => f.id === p.id)),
    }))
    .filter((s) => s.minutes >= minMinutes);
}

/** The moment to propose: everyone free first, then the most friends, then the longest. */
export function bestMoment(
  windows: ReadonlyArray<AvailabilityWindow>,
): AvailabilityWindow | null {
  let best: AvailabilityWindow | null = null;
  for (const w of windows) {
    if (!best) {
      best = w;
      continue;
    }
    const wAll = w.busy.length === 0;
    const bAll = best.busy.length === 0;
    if (wAll !== bAll) {
      if (wAll) best = w;
      continue;
    }
    if (w.free.length !== best.free.length) {
      if (w.free.length > best.free.length) best = w;
      continue;
    }
    if (w.minutes > best.minutes) best = w;
  }
  return best;
}

/** The best shared moment on `day`, ignoring people whose snapshot does not cover it. */
export function bestMomentFor(
  people: ReadonlyArray<Person>,
  day: Date,
  minMinutes = 10,
): AvailabilityWindow | null {
  return bestMoment(
    availability(
      people.filter((p) => coversDay(p, day)),
      day,
      minMinutes,
    ),
  );
}

export interface TimelineRow {
  person: Person;
  blocks: { start: number; end: number; subject: string }[];
}

export interface Timeline {
  /** Axis in minutes after midnight. */
  startMin: number;
  endMin: number;
  rows: TimelineRow[];
}

const minutesOfDay = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

/** One day as rows of lesson blocks on a shared time axis (whole hours, 08:00-16:00 at least). */
export function dayTimeline(
  people: ReadonlyArray<Person>,
  day: Date,
): Timeline {
  const at = day.getTime();
  const rows: TimelineRow[] = people.map((person) => ({
    person,
    blocks: lessonsOnDay(person.lessons, at).map((l) => ({
      start: l.start,
      end: l.end,
      subject: l.subject,
    })),
  }));
  let startMin = 8 * 60;
  let endMin = 16 * 60;
  for (const r of rows) {
    for (const b of r.blocks) {
      startMin = Math.min(
        startMin,
        Math.floor(minutesOfDay(b.start) / 60) * 60,
      );
      endMin = Math.max(endMin, Math.ceil(minutesOfDay(b.end) / 60) * 60);
    }
  }
  return { startMin, endMin, rows };
}

/** Local midnights of the next `count` school days (Mon-Fri) from `from` on. */
export function upcomingSchoolDays(from: Date, count: number): Date[] {
  const out: Date[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (out.length < count) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** "12:30" */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A hue from an id, so each friend keeps their own colour. */
export function hueForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** "Anna", "Anna en Ben", "Anna, Ben en Chris". */
export function joinNames(names: ReadonlyArray<string>): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} en ${names[names.length - 1]}`;
}

/** One-line status in Dutch, e.g. "Tussenuur tot 11:10". */
export function describePresence(p: Presence): string {
  switch (p.kind) {
    case "in-lesson":
      return `Heeft ${p.subject ?? "les"} tot ${clock(p.until!)}`;
    case "gap":
      return `Tussenuur tot ${clock(p.until!)}`;
    case "before":
      return `Begint om ${clock(p.until!)}`;
    case "done":
      return `Klaar sinds ${clock(p.since!)}`;
    default:
      return "Geen les vandaag";
  }
}
