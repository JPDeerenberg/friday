import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  presenceAt, presenceOf, freeNow, commonFreeSlots, dayTimeline, upcomingSchoolDays, clock, hueForId, describePresence,
  type Person,
} from "./friends-compare.ts";

const MON = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 9 + dayOffset, h, m).getTime();
const lesson = (sh: number, sm: number, eh: number, em: number, subject: string, dayOffset = 0) => ({
  start: MON(sh, sm, dayOffset), end: MON(eh, em, dayOffset), subject,
});
const person = (id: string, lessons: Person["lessons"]): Person => ({ id, name: id, hue: 0, lessons });

const ANNA = person("anna", [lesson(8, 30, 9, 20, "Wiskunde"), lesson(9, 20, 10, 10, "Frans"), lesson(11, 10, 12, 0, "Engels")]);
const BEN = person("ben", [lesson(9, 20, 10, 10, "Frans"), lesson(10, 10, 11, 0, "Nask")]);
const OFF = person("off", [lesson(8, 30, 9, 20, "Wiskunde", 1)]); // only Tuesday

describe("presenceAt", () => {
  it("knows each phase of the day", () => {
    assert.deepEqual(presenceAt(ANNA.lessons, MON(8, 0)), { kind: "before", until: MON(8, 30) });
    assert.deepEqual(presenceAt(ANNA.lessons, MON(8, 45)), { kind: "in-lesson", subject: "Wiskunde", until: MON(9, 20) });
    assert.deepEqual(presenceAt(ANNA.lessons, MON(10, 30)), { kind: "gap", until: MON(11, 10), since: MON(10, 10) });
    assert.deepEqual(presenceAt(ANNA.lessons, MON(12, 0)), { kind: "done", since: MON(12, 0) });
    assert.equal(presenceAt(ANNA.lessons, MON(10, 0, 1)).kind, "no-school");
  });
  it("has no gap between back-to-back lessons", () => {
    assert.equal(presenceAt(ANNA.lessons, MON(9, 20)).subject, "Frans");
  });
  it("counts the start but not the end of a lesson as 'in lesson'", () => {
    assert.equal(presenceAt(ANNA.lessons, MON(8, 30)).kind, "in-lesson");
    assert.equal(presenceAt(ANNA.lessons, MON(9, 20)).kind, "in-lesson");
    assert.equal(presenceAt([lesson(8, 30, 9, 20, "x")], MON(9, 20)).kind, "done");
  });
});

describe("freeNow", () => {
  it("lists the people who are not in a lesson and do have school today", () => {
    const people = [ANNA, BEN, OFF];
    const at = MON(10, 30);
    assert.deepEqual(freeNow(people, at).map((e) => e.person.id), ["anna"]);
    assert.deepEqual(presenceOf(people, at).map((e) => e.presence.kind), ["gap", "in-lesson", "no-school"]);
  });
});

describe("commonFreeSlots", () => {
  it("finds the stretches at school when nobody has a lesson", () => {
    const r = commonFreeSlots([ANNA, BEN], new Date(MON(8)), 5);
    assert.equal(r.withLessons, 2);
    assert.equal(r.allDoneAt, MON(12, 0));
    assert.deepEqual(r.slots, [{ start: MON(11, 0), end: MON(11, 10), minutes: 10 }]);
  });
  it("ignores slots shorter than the minimum", () => {
    assert.deepEqual(commonFreeSlots([ANNA, BEN], new Date(MON(8)), 20).slots, []);
  });
  it("finds a real shared break", () => {
    const a = person("a", [lesson(8, 30, 9, 20, "x"), lesson(10, 30, 11, 20, "y")]);
    const b = person("b", [lesson(8, 30, 9, 20, "x"), lesson(10, 30, 11, 20, "z")]);
    assert.deepEqual(commonFreeSlots([a, b], new Date(MON(8)), 20).slots, [{ start: MON(9, 20), end: MON(10, 30), minutes: 70 }]);
  });
  it("lets people without lessons that day not constrain anything", () => {
    const r = commonFreeSlots([ANNA, OFF], new Date(MON(8)), 20);
    assert.equal(r.withLessons, 1);
    assert.deepEqual(r.slots, [{ start: MON(10, 10), end: MON(11, 10), minutes: 60 }]);
  });
  it("returns nothing when nobody has lessons", () => {
    assert.deepEqual(commonFreeSlots([OFF], new Date(MON(8)), 20), { slots: [], allDoneAt: null, withLessons: 0 });
    assert.deepEqual(commonFreeSlots([], new Date(MON(8)), 20), { slots: [], allDoneAt: null, withLessons: 0 });
  });
});

describe("dayTimeline", () => {
  it("builds rows with an axis that fits every lesson (08:00-16:00 at least)", () => {
    const t = dayTimeline([ANNA, BEN], new Date(MON(8)));
    assert.equal(t.startMin, 8 * 60);
    assert.equal(t.endMin, 16 * 60);
    assert.equal(t.rows[0].blocks.length, 3);
    const late = dayTimeline([person("l", [lesson(7, 45, 17, 30, "x")])], new Date(MON(8)));
    assert.equal(late.startMin, 7 * 60);
    assert.equal(late.endMin, 18 * 60);
  });
});

describe("helpers", () => {
  it("lists the next school days, skipping the weekend", () => {
    const days = upcomingSchoolDays(new Date(2026, 10, 13, 15), 4); // Friday
    assert.deepEqual(days.map((d) => d.getDate()), [13, 16, 17, 18]);
  });
  it("formats clocks", () => {
    assert.equal(clock(MON(9, 5)), "09:05");
  });
  it("gives a stable hue per id", () => {
    assert.equal(hueForId("a1b2c3d4"), hueForId("a1b2c3d4"));
    assert.ok(hueForId("a1b2c3d4") >= 0 && hueForId("a1b2c3d4") < 360);
  });
  it("describes presence in Dutch", () => {
    assert.equal(describePresence({ kind: "in-lesson", subject: "Frans", until: MON(10, 10) }), "Heeft Frans tot 10:10");
    assert.equal(describePresence({ kind: "gap", until: MON(11, 10), since: MON(10, 10) }), "Tussenuur tot 11:10");
    assert.equal(describePresence({ kind: "done", since: MON(12) }), "Klaar sinds 12:00");
    assert.equal(describePresence({ kind: "before", until: MON(8, 30) }), "Begint om 08:30");
    assert.equal(describePresence({ kind: "no-school" }), "Geen les vandaag");
  });
});
