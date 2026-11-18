import test from "node:test";
import assert from "node:assert";
import { summarizeMinpunten, describeMinpunten } from "./minpunten.ts";
import { evaluateCompensation, DEFAULT_COMPENSATION } from "./compensation.ts";

const summary = (subjects: { name: string; avg: number }[]) =>
  summarizeMinpunten(evaluateCompensation(subjects, DEFAULT_COMPENSATION), DEFAULT_COMPENSATION.passGrade);

test("counts minpunten and pluspunten separately", () => {
  const s = summary([
    { name: "Frans", avg: 5.2 }, // whole 5 -> -1
    { name: "Wiskunde", avg: 3.8 }, // whole 4 -> -2
    { name: "Engels", avg: 7.6 }, // whole 8 -> +2
    { name: "Nask", avg: 6.1 }, // whole 6 -> 0
  ]);
  assert.equal(s.minpunten, 3);
  assert.equal(s.pluspunten, 2);
  assert.equal(s.balance, -1);
  assert.deepEqual(s.subjects.map((x) => x.name), ["Frans", "Wiskunde"]);
});

test("the subject closest to a sufficient grade comes first", () => {
  const s = summary([
    { name: "Wiskunde", avg: 4.1 },
    { name: "Frans", avg: 5.4 },
  ]);
  assert.equal(s.subjects[0].name, "Frans");
  assert.ok(Math.abs(s.subjects[0].gap - 0.1) < 1e-9);
  assert.ok(Math.abs(s.subjects[1].gap - 1.4) < 1e-9);
  assert.equal(s.closeCount, 1);
});

test("no minpunten is celebrated", () => {
  const t = describeMinpunten(summary([{ name: "Frans", avg: 6.4 }]));
  assert.equal(t.tone, "great");
  assert.equal(t.headline, "Geen minpunten");
});

test("no subjects at all counts as no minpunten", () => {
  const s = summary([]);
  assert.equal(s.minpunten, 0);
  assert.equal(describeMinpunten(s).headline, "Geen minpunten");
});

test("the wording points at what is close and never alarms", () => {
  const close = describeMinpunten(summary([{ name: "Frans", avg: 5.4 }]));
  assert.equal(close.headline, "1 minpunt");
  assert.equal(close.hint, "Frans ligt bijna op een voldoende.");

  const two = describeMinpunten(summary([{ name: "Frans", avg: 5.3 }, { name: "Duits", avg: 5.4 }]));
  assert.equal(two.headline, "2 minpunten");
  assert.equal(two.hint, "2 vakken liggen bijna op een voldoende.");

  const far = describeMinpunten(summary([{ name: "Wiskunde", avg: 3.9 }, { name: "Frans", avg: 4.6 }]));
  assert.equal(far.headline, "3 minpunten");
  assert.match(far.hint, /^Met Frans haal je het snelst winst\.$/);
  for (const t of [close, two, far]) {
    assert.ok(!/(zak|gevaar|onvoldoende|fout|slecht|helaas)/i.test(`${t.headline} ${t.hint}`));
  }
});

test("a school with other pass grades uses its own threshold", () => {
  // This school wants a 7: a 6 costs a point there.
  const cfg = { ...DEFAULT_COMPENSATION, passGrade: 7, points: { ...DEFAULT_COMPENSATION.points, "6": -1 } };
  const s = summarizeMinpunten(evaluateCompensation([{ name: "Frans", avg: 6.2 }], cfg), 7);
  assert.ok(Math.abs(s.subjects[0].gap - 0.3) < 1e-9);
});
