import test from 'node:test';
import assert from 'node:assert';
import type { CalendarEvent } from './types.ts';
import { getMonday, computeWeekStats, EMPTY_WEEK_STATS } from './weekStats.ts';

function fakeEvent(overrides: Partial<CalendarEvent> & { Start: string }): CalendarEvent {
  const { Start, Einde, ...rest } = overrides;
  return {
    Id: 1,
    Start,
    Einde: Einde ?? Start,
    LesuurVan: null,
    LesuurTotMet: null,
    DuurtHeleDag: false,
    Omschrijving: null,
    Lokatie: null,
    Status: 1,
    Type: 13,
    Subtype: null,
    IsOnlineDeelname: null,
    WeergaveType: null,
    Inhoud: null,
    InfoType: 0,
    Aantekening: null,
    Afgerond: false,
    HerhaalStatus: null,
    Vakken: null,
    Docenten: null,
    Lokalen: null,
    OpdrachtId: null,
    HeeftBijlagen: false,
    Bijlagen: null,
    Links: null,
    Afwezigheid: null,
    self_url: null,
    merged_absence: null,
    ...rest,
  };
}

// Reference "today" used by every test below: Wednesday 2 Sep 2026.
// Its Monday is 2026-08-31; last week's Monday is 2026-08-24; next week's is 2026-09-07.
const REF = new Date('2026-09-02T12:00:00');

test('getMonday: a Monday input returns the same calendar date at midnight', () => {
  const d = getMonday(new Date('2026-08-31T15:30:00'));
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7); // August, 0-indexed
  assert.strictEqual(d.getDate(), 31);
  assert.strictEqual(d.getHours(), 0);
});

test('getMonday: a Sunday input rolls back to the previous Monday', () => {
  const d = getMonday(new Date('2026-09-06T09:00:00')); // Sunday
  assert.strictEqual(d.getMonth(), 7);
  assert.strictEqual(d.getDate(), 31);
});

test('computeWeekStats: counts gaps between lesson-hour numbers and excludes non-lessons', () => {
  const events: CalendarEvent[] = [
    // Monday 2026-08-31 (this week): lessons at periods 1,2 then 5,6 -> 2 tussenuren, 4 lessons
    fakeEvent({ Start: '2026-08-31T08:30:00', LesuurVan: 1, LesuurTotMet: 1 }),
    fakeEvent({ Start: '2026-08-31T09:20:00', LesuurVan: 2, LesuurTotMet: 2 }),
    fakeEvent({ Start: '2026-08-31T12:00:00', LesuurVan: 5, LesuurTotMet: 5 }),
    fakeEvent({ Start: '2026-08-31T12:50:00', LesuurVan: 6, LesuurTotMet: 6 }),
    // Personal appointment (no LesuurVan) must not count as a lesson or affect the gap
    fakeEvent({ Start: '2026-08-31T10:00:00', LesuurVan: null, Type: 1 }),
    // Cancelled lesson must not count
    fakeEvent({ Start: '2026-08-31T13:40:00', LesuurVan: 7, LesuurTotMet: 7, Status: 4 }),
  ];
  const stats = computeWeekStats(events, REF);
  assert.strictEqual(stats.thisWeek.lessons, 4);
  assert.strictEqual(stats.thisWeek.tussenuren, 2);
});

test('computeWeekStats: buckets events into last/this/next week correctly', () => {
  const events: CalendarEvent[] = [
    fakeEvent({ Start: '2026-08-24T09:00:00', LesuurVan: 1, LesuurTotMet: 1 }), // last week
    fakeEvent({ Start: '2026-08-31T09:00:00', LesuurVan: 1, LesuurTotMet: 1 }), // this week
    fakeEvent({ Start: '2026-09-07T09:00:00', LesuurVan: 1, LesuurTotMet: 1 }), // next week
  ];
  const stats = computeWeekStats(events, REF);
  assert.strictEqual(stats.lastWeek.lessons, 1);
  assert.strictEqual(stats.thisWeek.lessons, 1);
  assert.strictEqual(stats.nextWeek.lessons, 1);
});

test('computeWeekStats: empty input returns all zeros', () => {
  const stats = computeWeekStats([], REF);
  assert.deepStrictEqual(stats, EMPTY_WEEK_STATS);
});
