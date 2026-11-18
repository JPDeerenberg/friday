/**
 * Comparing schedules: who is in a lesson right now, who has a gap, and when is
 * nobody in a lesson. Read-only maths over lesson times; pure and tested.
 */
import type { AbsoluteLesson } from "./friends-share.ts";

export interface Person {
  id: string;
  name: string;
  /** 0-359, for the colour of this person. */
  hue: number;
  lessons: ReadonlyArray<AbsoluteLesson>;
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

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

function lessonsOnDay(lessons: ReadonlyArray<AbsoluteLesson>, at: number): AbsoluteLesson[] {
  return lessons.filter((l) => sameDay(l.start, at)).sort((a, b) => a.start - b.start);
}

export function presenceAt(lessons: ReadonlyArray<AbsoluteLesson>, at: number): Presence {
  const day = lessonsOnDay(lessons, at);
  if (day.length === 0) return { kind: "no-school" };
  const current = day.find((l) => l.start <= at && at < l.end);
  if (current) return { kind: "in-lesson", subject: current.subject, until: current.end };
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
export function presenceOf(people: ReadonlyArray<Person>, at: number): PresenceEntry[] {
  return people.map((person) => ({ person, presence: presenceAt(person.lessons, at) }));
}

/** People who could meet right now: in a gap, done for the day, or not yet started. */
export function freeNow(people: ReadonlyArray<Person>, at: number): PresenceEntry[] {
  return presenceOf(people, at).filter((e) => e.presence.kind !== "in-lesson" && e.presence.kind !== "no-school");
}

export interface FreeSlot {
  start: number;
  end: number;
  minutes: number;
}

export interface CommonFree {
  /** Times at school when nobody has a lesson, at least `minMinutes` long. */
  slots: FreeSlot[];
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
export function commonFreeSlots(people: ReadonlyArray<Person>, day: Date, minMinutes = 20): CommonFree {
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
  const slots: FreeSlot[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const start = merged[i].end;
    const end = merged[i + 1].start;
    const minutes = Math.round((end - start) / 60000);
    if (minutes >= minMinutes) slots.push({ start, end, minutes });
  }
  return { slots, allDoneAt: merged[merged.length - 1].end, withLessons };
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
export function dayTimeline(people: ReadonlyArray<Person>, day: Date): Timeline {
  const at = day.getTime();
  const rows: TimelineRow[] = people.map((person) => ({
    person,
    blocks: lessonsOnDay(person.lessons, at).map((l) => ({ start: l.start, end: l.end, subject: l.subject })),
  }));
  let startMin = 8 * 60;
  let endMin = 16 * 60;
  for (const r of rows) {
    for (const b of r.blocks) {
      startMin = Math.min(startMin, Math.floor(minutesOfDay(b.start) / 60) * 60);
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
