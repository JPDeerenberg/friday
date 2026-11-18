import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickNextLesson, describeStart, formatMinutes, isTimetabledLesson } from "./next-lesson.ts";
import type { CalendarEvent } from "./types.ts";

// A Monday, 10:00 local time.
const NOW = new Date(2026, 10, 9, 10, 0, 0);
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 9 + dayOffset, h, m, 0).toISOString();

function lesson(over: Partial<CalendarEvent> & { Id: number }): CalendarEvent {
  return {
    Start: at(11),
    Einde: at(11, 50),
    LesuurVan: 4,
    LesuurTotMet: 4,
    DuurtHeleDag: false,
    Omschrijving: "wisk - jan - 214",
    Lokatie: "214",
    Status: 0,
    Type: 7,
    Subtype: null,
    IsOnlineDeelname: null,
    WeergaveType: null,
    Inhoud: null,
    InfoType: 0,
    Aantekening: null,
    Opmerking: null,
    Afgerond: false,
    HerhaalStatus: null,
    Vakken: [{ Id: 1, Naam: "Wiskunde" }],
    Docenten: [{ Id: 1, Naam: "J. Jansen (JAN)", Docentcode: "JAN" }],
    Lokalen: [{ Naam: "B214" }],
    OpdrachtId: null,
    HeeftBijlagen: false,
    Bijlagen: null,
    Links: null,
    Afwezigheid: null,
    self_url: null,
    merged_absence: null,
    ...over,
  } as CalendarEvent;
}

describe("pickNextLesson", () => {
  it("picks the first lesson that has not started yet", () => {
    const events = [
      lesson({ Id: 2, Start: at(13), Einde: at(13, 50), LesuurVan: 6 }),
      lesson({ Id: 1, Start: at(11), Einde: at(11, 50), LesuurVan: 4 }),
      lesson({ Id: 0, Start: at(8, 30), Einde: at(9, 20), LesuurVan: 1 }),
    ];
    const next = pickNextLesson(events, NOW)!;
    assert.equal(next.event.Id, 1);
    assert.equal(next.subject, "Wiskunde");
    assert.equal(next.room, "B214");
    assert.equal(next.startsInMin, 60);
    assert.equal(next.phase, "today");
  });

  it("keeps a lesson that started a minute ago, but not one that started long ago", () => {
    const justStarted = lesson({ Id: 1, Start: at(9, 57), Einde: at(10, 47) });
    const later = lesson({ Id: 2, Start: at(11), Einde: at(11, 50) });
    const a = pickNextLesson([justStarted, later], NOW)!;
    assert.equal(a.event.Id, 1);
    assert.equal(a.phase, "now");
    const longAgo = lesson({ Id: 3, Start: at(9, 30), Einde: at(10, 20) });
    assert.equal(pickNextLesson([longAgo, later], NOW)!.event.Id, 2);
  });

  it("skips cancelled lessons, all-day items and appointments without a lesson hour", () => {
    const events = [
      lesson({ Id: 1, Status: 5, Start: at(10, 30), Einde: at(11, 20) }),
      lesson({ Id: 2, Status: 4, Start: at(10, 30), Einde: at(11, 20) }),
      lesson({ Id: 3, DuurtHeleDag: true, Start: at(10, 30), Einde: at(11, 20) }),
      lesson({ Id: 4, LesuurVan: null, Start: at(10, 30), Einde: at(11, 20) }),
      lesson({ Id: 5, Start: at(12), Einde: at(12, 50) }),
    ];
    assert.equal(pickNextLesson(events, NOW)!.event.Id, 5);
    assert.equal(isTimetabledLesson(events[0]), false);
    assert.equal(isTimetabledLesson(events[3]), false);
  });

  it("moves on to the next day when today's lessons are over", () => {
    const events = [
      lesson({ Id: 1, Start: at(8, 30), Einde: at(9, 20) }),
      lesson({ Id: 2, Start: at(8, 30, 1), Einde: at(9, 20, 1) }),
    ];
    const next = pickNextLesson(events, NOW)!;
    assert.equal(next.event.Id, 2);
    assert.equal(next.phase, "later");
    assert.equal(describeStart(next, NOW), "Morgen");
  });

  it("returns null when there is nothing to show", () => {
    assert.equal(pickNextLesson([], NOW), null);
    assert.equal(pickNextLesson([lesson({ Id: 1, Start: at(8), Einde: at(8, 50) })], NOW), null);
  });

  it("falls back to the description, the location and 'no teacher'", () => {
    const e = lesson({ Id: 1, Vakken: null, Lokalen: null, Docenten: null, Omschrijving: "mentoruur" });
    const next = pickNextLesson([e], NOW)!;
    assert.equal(next.subject, "mentoruur");
    assert.equal(next.room, "214");
    assert.equal(next.teacher, null);
    const bare = pickNextLesson([lesson({ Id: 2, Vakken: null, Omschrijving: null, Lokalen: null, Lokatie: null })], NOW)!;
    assert.equal(bare.subject, "Les");
    assert.equal(bare.room, null);
  });

  it("ignores events with unparseable dates", () => {
    const bad = lesson({ Id: 1, Start: "kapot", Einde: "kapot" });
    assert.equal(pickNextLesson([bad], NOW), null);
  });

  it("labels the phase", () => {
    const soon = pickNextLesson([lesson({ Id: 1, Start: at(10, 10), Einde: at(11) })], NOW)!;
    assert.equal(soon.phase, "soon");
    assert.equal(describeStart(soon, NOW), "Begint over 10 min");
    const far = pickNextLesson([lesson({ Id: 2, Start: at(12, 5), Einde: at(13) })], NOW)!;
    assert.equal(describeStart(far, NOW), "Over 2 u 05 min");
    const running = pickNextLesson([lesson({ Id: 3, Start: at(9, 58), Einde: at(10, 48) })], NOW)!;
    assert.equal(describeStart(running, NOW), "Begonnen · nog 48 min");
    const thursday = pickNextLesson([lesson({ Id: 4, Start: at(8, 30, 3), Einde: at(9, 20, 3) })], NOW)!;
    assert.equal(describeStart(thursday, NOW), "Donderdag");
  });
});

describe("formatMinutes", () => {
  it("formats minutes and hours", () => {
    assert.equal(formatMinutes(0), "0 min");
    assert.equal(formatMinutes(59), "59 min");
    assert.equal(formatMinutes(60), "1 u");
    assert.equal(formatMinutes(125), "2 u 05 min");
    assert.equal(formatMinutes(-5), "0 min");
  });
});
