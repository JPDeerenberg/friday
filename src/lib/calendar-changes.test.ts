/**
 * Agenda-wijzigingen uit een notificatie: het antwoord van de Android-brug
 * wordt veilig ingelezen en omgezet naar leesbare regels.
 */
process.env.TZ = "Europe/Amsterdam";

import test from "node:test";
import assert from "node:assert";

import {
  consumeNotificationTap,
  describeChange,
  groupByDay,
  parseNotificationTap,
  type CalendarChange,
} from "./calendar-changes.ts";

const change = (over: Partial<CalendarChange>): CalendarChange => ({
  id: 1,
  title: "wisk - 4A",
  start: "2026-11-02T09:00:00.0000000Z", // 10:00 in Amsterdam
  end: "2026-11-02T09:50:00.0000000Z",
  kinds: ["cancelled"],
  ...over,
});

test("parses the bridge payload, drops junk, sorts by time", () => {
  const raw = JSON.stringify({
    page: "calendar",
    changes: [
      change({
        id: 2,
        start: "2026-11-03T08:00:00Z",
        end: "2026-11-03T09:00:00Z",
      }),
      change({ id: 1 }),
      {
        id: 3,
        title: "kapot",
        kinds: ["unknown"],
        start: "2026-11-02T08:00:00Z",
      },
      { id: 4, kinds: ["new"] }, // no start
      "not an object",
    ],
  });
  const tap = parseNotificationTap(raw)!;
  assert.strictEqual(tap.page, "calendar");
  assert.deepStrictEqual(
    tap.changes.map((c) => c.id),
    [1, 2],
  );
});

test("empty / invalid payloads give null, other pages keep their page name", () => {
  assert.strictEqual(parseNotificationTap(""), null);
  assert.strictEqual(parseNotificationTap(null), null);
  assert.strictEqual(parseNotificationTap("{oops"), null);
  assert.strictEqual(parseNotificationTap('{"changes":[]}'), null);
  assert.deepStrictEqual(
    parseNotificationTap('{"page":"messages","changes":[]}'),
    {
      page: "messages",
      changes: [],
    },
  );
});

test("no bridge (web / desktop) means no popup", () => {
  assert.strictEqual(consumeNotificationTap(), null);
});

test("cancelled", () => {
  const v = describeChange(change({ kinds: ["cancelled"] }));
  assert.strictEqual(v.label, "Vervallen");
  assert.strictEqual(v.tone, "bad");
  assert.deepStrictEqual(v.details, ["Gepland om 10:00–10:50"]);
});

test("moved within the same day shows old and new time", () => {
  const v = describeChange(
    change({
      kinds: ["moved"],
      start: "2026-11-02T11:00:00Z",
      end: "2026-11-02T11:50:00Z",
      oldStart: "2026-11-02T09:00:00Z",
      oldEnd: "2026-11-02T09:50:00Z",
    }),
  );
  assert.strictEqual(v.label, "Verplaatst");
  assert.strictEqual(v.tone, "warn");
  assert.deepStrictEqual(v.details, ["Was 10:00–10:50, nu 12:00–12:50"]);
});

test("moved to another day names both days", () => {
  const v = describeChange(
    change({
      kinds: ["moved"],
      start: "2026-11-04T09:00:00Z",
      end: "2026-11-04T09:50:00Z",
      oldStart: "2026-11-02T09:00:00Z",
      oldEnd: "2026-11-02T09:50:00Z",
    }),
  );
  assert.match(
    v.details[0],
    /^Was ma 2 nov\.? 10:00–10:50, nu wo 4 nov\.? 10:00–10:50$/,
  );
});

test("room and teacher, including values that were empty before", () => {
  const room = describeChange(
    change({ kinds: ["room"], oldRoom: "A1", newRoom: "B2" }),
  );
  assert.deepStrictEqual(room.details, ["Lokaal A1 → B2"]);
  assert.strictEqual(room.label, "Ander lokaal");
  const roomNew = describeChange(
    change({ kinds: ["room"], oldRoom: "", newRoom: "B2" }),
  );
  assert.deepStrictEqual(roomNew.details, ["Nu in lokaal B2"]);
  const teacher = describeChange(
    change({
      kinds: ["teacher"],
      oldTeacher: "Jansen",
      newTeacher: "de Vries",
    }),
  );
  assert.deepStrictEqual(teacher.details, ["Docent Jansen → de Vries"]);
});

test("several kinds: cancelled wins the label, all are listed", () => {
  const v = describeChange(
    change({
      kinds: ["room", "moved", "cancelled"],
      oldRoom: "A",
      newRoom: "B",
      oldStart: "2026-11-02T08:00:00Z",
      oldEnd: "2026-11-02T08:50:00Z",
    }),
  );
  assert.strictEqual(v.label, "Vervallen");
  assert.deepStrictEqual(v.labels, ["Vervallen", "Verplaatst", "Ander lokaal"]);
});

test("new and removed", () => {
  assert.strictEqual(describeChange(change({ kinds: ["new"] })).tone, "good");
  const removed = describeChange(change({ kinds: ["removed"] }));
  assert.strictEqual(removed.tone, "bad");
  assert.deepStrictEqual(removed.details, ["Stond gepland om 10:00–10:50"]);
});

test("grouped per day with Vandaag / Morgen labels, sorted by time", () => {
  const now = new Date("2026-11-02T07:00:00Z");
  const groups = groupByDay(
    [
      change({ id: 3, start: "2026-11-04T09:00:00Z" }),
      change({ id: 2, start: "2026-11-03T09:00:00Z" }),
      change({ id: 1, start: "2026-11-02T12:00:00Z" }),
      change({ id: 4, start: "2026-11-02T09:00:00Z" }),
    ],
    now,
  );
  assert.deepStrictEqual(
    groups.map((g) =>
      g.label.toLowerCase().startsWith("woensdag") ? "woensdag" : g.label,
    ),
    ["Vandaag", "Morgen", "woensdag"],
  );
  assert.deepStrictEqual(
    groups[0].items.map((c) => c.id),
    [4, 1],
  );
});
