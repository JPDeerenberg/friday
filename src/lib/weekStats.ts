import type { CalendarEvent } from './types';

export interface WeekStat {
  tussenuren: number;
  lessons: number;
}

export interface WeekStats {
  lastWeek: WeekStat;
  thisWeek: WeekStat;
  nextWeek: WeekStat;
}

export const EMPTY_WEEK_STATS: WeekStats = {
  lastWeek: { tussenuren: 0, lessons: 0 },
  thisWeek: { tussenuren: 0, lessons: 0 },
  nextWeek: { tussenuren: 0, lessons: 0 },
};

/** Monday 00:00:00 local time of the week containing `date`. Does not mutate `date`. */
export function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// A calendar item only carries a lesson-hour number (LesuurVan) when it's an
// actual timetabled lesson from the Magister rooster. Personal appointments
// created via "Nieuwe afspraak" (Type 1) never get one — the create-event
// request body has no LesuurVan/LesuurTotMet field at all (see
// CreateCalendarEvent in src-tauri/src/models/calendar.rs) — so this filter
// naturally and reliably excludes them without needing to branch on `Type`.
function isLesson(e: CalendarEvent): boolean {
  return e.LesuurVan !== null && e.Status !== 4 && e.Status !== 5;
}

function countTussenurenForDay(dayEvents: CalendarEvent[]): number {
  const lessons = dayEvents
    .filter(isLesson)
    .sort((a, b) => (a.LesuurVan! - b.LesuurVan!) || a.Start.localeCompare(b.Start));

  let gaps = 0;
  for (let i = 0; i < lessons.length - 1; i++) {
    const prevEnd = lessons[i].LesuurTotMet ?? lessons[i].LesuurVan!;
    const nextStart = lessons[i + 1].LesuurVan!;
    if (nextStart > prevEnd + 1) gaps += nextStart - prevEnd - 1;
  }
  return gaps;
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function computeWeekStat(events: CalendarEvent[], weekMonday: Date): WeekStat {
  const weekStartStr = formatYmd(weekMonday);
  const weekEnd = new Date(weekMonday);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = formatYmd(weekEnd);

  // Group by calendar day first — lesson-hour numbers reset every day, so
  // gaps must never be computed across a day boundary.
  const byDay: Record<string, CalendarEvent[]> = {};
  for (const e of events) {
    if (!e.Start) continue;
    const dayStr = e.Start.substring(0, 10);
    if (dayStr < weekStartStr || dayStr >= weekEndStr) continue;
    (byDay[dayStr] ??= []).push(e);
  }

  let tussenuren = 0;
  let lessons = 0;
  for (const dayStr in byDay) {
    tussenuren += countTussenurenForDay(byDay[dayStr]);
    lessons += byDay[dayStr].filter(isLesson).length;
  }
  return { tussenuren, lessons };
}

/**
 * `events` must already cover the 21-day window from
 * `getMonday(referenceDate) - 7d` through `getMonday(referenceDate) + 14d` (exclusive).
 */
export function computeWeekStats(events: CalendarEvent[], referenceDate: Date): WeekStats {
  const thisMonday = getMonday(referenceDate);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  const nextMonday = new Date(thisMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  return {
    lastWeek: computeWeekStat(events, lastMonday),
    thisWeek: computeWeekStat(events, thisMonday),
    nextWeek: computeWeekStat(events, nextMonday),
  };
}
