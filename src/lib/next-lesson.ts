/**
 * "Where is my next lesson?" — the one thing students open the app for between
 * lessons. Pure logic (no Svelte, no network) so it can be tested.
 */
import type { CalendarEvent } from "./types.ts";

/** A timetabled lesson: has a lesson-hour, is not cancelled, is not an all-day item. */
export function isTimetabledLesson(e: CalendarEvent): boolean {
  return (
    e.LesuurVan !== null &&
    e.LesuurVan !== undefined &&
    e.Status !== 4 &&
    e.Status !== 5 &&
    !e.DuurtHeleDag
  );
}

export type NextLessonPhase =
  /** Already started (within the grace period). */
  | "now"
  /** Starts within 15 minutes. */
  | "soon"
  /** Later today. */
  | "today"
  /** A later day. */
  | "later";

export interface NextLesson {
  event: CalendarEvent;
  phase: NextLessonPhase;
  subject: string;
  room: string | null;
  teacher: string | null;
  start: Date;
  end: Date;
  /** Whole minutes until the start (negative once started). */
  startsInMin: number;
  /** Whole minutes until the end. */
  endsInMin: number;
}

/**
 * The lesson to show: the first timetabled lesson that has not been under way for
 * longer than `graceMin` minutes. Returns null when there is none in `events`.
 */
export function pickNextLesson(
  events: ReadonlyArray<CalendarEvent>,
  now: Date,
  graceMin = 5,
): NextLesson | null {
  const lessons = events
    .filter(isTimetabledLesson)
    .map((event) => ({ event, start: new Date(event.Start), end: new Date(event.Einde) }))
    .filter((l) => !isNaN(l.start.getTime()) && !isNaN(l.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const cutoff = now.getTime() - graceMin * 60_000;
  const next = lessons.find((l) => l.start.getTime() >= cutoff);
  if (!next) return null;

  const startsInMin = Math.round((next.start.getTime() - now.getTime()) / 60_000);
  const endsInMin = Math.round((next.end.getTime() - now.getTime()) / 60_000);
  const sameDay = next.start.toDateString() === now.toDateString();
  const phase: NextLessonPhase =
    startsInMin <= 0 ? "now" : !sameDay ? "later" : startsInMin <= 15 ? "soon" : "today";

  const e = next.event;
  return {
    event: e,
    phase,
    subject: (e.Vakken?.[0]?.Naam || e.Omschrijving || "Les").trim(),
    room: (e.Lokalen?.[0]?.Naam || e.Lokatie || "").trim() || null,
    teacher: (e.Docenten?.[0]?.Naam || "").trim() || null,
    start: next.start,
    end: next.end,
    startsInMin,
    endsInMin,
  };
}

/** "5 min", "1 u 05 min", "2 u". */
export function formatMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} u` : `${h} u ${String(rest).padStart(2, "0")} min`;
}

const DAY_NAMES = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];

/** The line under the room: when the lesson starts, in plain Dutch. */
export function describeStart(next: NextLesson, now: Date): string {
  switch (next.phase) {
    case "now":
      return next.startsInMin === 0 || next.startsInMin > -1
        ? "Begint nu"
        : `Begonnen · nog ${formatMinutes(next.endsInMin)}`;
    case "soon":
      return `Begint over ${formatMinutes(next.startsInMin)}`;
    case "today":
      return `Over ${formatMinutes(next.startsInMin)}`;
    default: {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const day =
        next.start.toDateString() === tomorrow.toDateString()
          ? "morgen"
          : DAY_NAMES[next.start.getDay()];
      return `${day.charAt(0).toUpperCase()}${day.slice(1)}`;
    }
  }
}
