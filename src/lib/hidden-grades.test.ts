/**
 * Verborgen cijfers: een cijfer dat Magister niet meer teruggeeft blijft
 * 10 dagen zichtbaar (gemarkeerd), komt het terug dan is het normaal, en na
 * 10 dagen of handmatig verwijderen is het echt weg.
 */
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert";

import {
  clearGradeMemory,
  forgetHiddenGrade,
  HIDDEN_GRADE_DAYS,
  reconcile,
  restoreHiddenGrades,
  setHiddenGradeRestore,
} from "./hidden-grades.ts";
import type { Grade } from "./types.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 2);

function grade(id: number, str: string | null = "7,5", soort = 1): Grade {
  return {
    CijferId: id,
    CijferStr: str,
    CijferKolom: { Id: id * 10, KolomSoort: soort },
    TeltMee: true,
  } as unknown as Grade;
}
const ids = (l: Grade[]) => l.map((g) => g.CijferId).sort((a, b) => a - b);

test("first sight: nothing to restore", () => {
  const { result, memory } = reconcile(null, [grade(1), grade(2)], T0);
  assert.deepStrictEqual(ids(result), [1, 2]);
  assert.strictEqual(Object.keys(memory).length, 2);
  assert.ok(result.every((g) => !g.hiddenSince));
});

test("a grade that disappears comes back flagged; the others stay normal", () => {
  const first = reconcile(null, [grade(1), grade(2)], T0);
  const second = reconcile(first.memory, [grade(1)], T0 + DAY);
  assert.deepStrictEqual(ids(second.result), [1, 2]);
  const restored = second.result.find((g) => g.CijferId === 2)!;
  assert.strictEqual(restored.hiddenSince, new Date(T0 + DAY).toISOString());
  assert.ok(!second.result.find((g) => g.CijferId === 1)!.hiddenSince);
});

test("hiddenSince keeps the first moment it went missing", () => {
  const a = reconcile(null, [grade(1), grade(2)], T0);
  const b = reconcile(a.memory, [grade(1)], T0 + DAY);
  const c = reconcile(b.memory, [grade(1)], T0 + 5 * DAY);
  assert.strictEqual(
    c.result.find((g) => g.CijferId === 2)!.hiddenSince,
    new Date(T0 + DAY).toISOString(),
  );
});

test("when the school shows it again it is a normal grade again", () => {
  const a = reconcile(null, [grade(1), grade(2)], T0);
  const b = reconcile(a.memory, [grade(1)], T0 + DAY);
  const c = reconcile(b.memory, [grade(1), grade(2)], T0 + 3 * DAY);
  assert.deepStrictEqual(ids(c.result), [1, 2]);
  assert.ok(c.result.every((g) => !g.hiddenSince));
  // and a later disappearance starts a fresh clock
  const d = reconcile(c.memory, [grade(1)], T0 + 20 * DAY);
  assert.strictEqual(
    d.result.find((g) => g.CijferId === 2)!.hiddenSince,
    new Date(T0 + 20 * DAY).toISOString(),
  );
});

test("after 10 days it counts as really deleted and is dropped for good", () => {
  const a = reconcile(null, [grade(1), grade(2)], T0);
  const b = reconcile(a.memory, [grade(1)], T0 + DAY);
  const still = reconcile(
    b.memory,
    [grade(1)],
    T0 + DAY + HIDDEN_GRADE_DAYS * DAY,
  );
  assert.deepStrictEqual(ids(still.result), [1, 2]); // exactly 10 days: still shown
  const gone = reconcile(
    b.memory,
    [grade(1)],
    T0 + DAY + HIDDEN_GRADE_DAYS * DAY + 1,
  );
  assert.deepStrictEqual(ids(gone.result), [1]);
  const later = reconcile(gone.memory, [grade(1)], T0 + 40 * DAY);
  assert.deepStrictEqual(ids(later.result), [1]);
});

test("averages / empty columns are never restored", () => {
  const a = reconcile(null, [grade(1), grade(2, "7,0", 2), grade(3, null)], T0);
  const b = reconcile(a.memory, [], T0 + DAY);
  assert.deepStrictEqual(ids(b.result), [1]);
});

test("everything hidden at once (empty response) restores everything", () => {
  const a = reconcile(null, [grade(1), grade(2)], T0);
  const b = reconcile(a.memory, [], T0 + DAY);
  assert.deepStrictEqual(ids(b.result), [1, 2]);
});

test("persistent flow: remove button drops it for good, other years untouched", async () => {
  setHiddenGradeRestore(true);
  await clearGradeMemory();
  await restoreHiddenGrades(1, 100, [grade(1), grade(2)], T0);
  await restoreHiddenGrades(1, 200, [grade(9)], T0);

  const hidden = await restoreHiddenGrades(1, 100, [grade(1)], T0 + DAY);
  assert.deepStrictEqual(ids(hidden), [1, 2]);

  await forgetHiddenGrade(1, 100, 2);
  const after = await restoreHiddenGrades(1, 100, [grade(1)], T0 + 2 * DAY);
  assert.deepStrictEqual(ids(after), [1]);

  // another school year / another person has its own memory
  const other = await restoreHiddenGrades(1, 200, [], T0 + DAY);
  assert.deepStrictEqual(ids(other), [9]);
  const otherPerson = await restoreHiddenGrades(2, 200, [], T0 + DAY);
  assert.deepStrictEqual(ids(otherPerson), []);
});

test("turned off: passthrough, nothing remembered; clear wipes it", async () => {
  setHiddenGradeRestore(false);
  await clearGradeMemory();
  await restoreHiddenGrades(1, 300, [grade(1), grade(2)], T0);
  const off = await restoreHiddenGrades(1, 300, [grade(1)], T0 + DAY);
  assert.deepStrictEqual(ids(off), [1]);

  setHiddenGradeRestore(true);
  const on = await restoreHiddenGrades(1, 300, [grade(1)], T0 + 2 * DAY);
  assert.deepStrictEqual(ids(on), [1]); // nothing was remembered while off

  await restoreHiddenGrades(1, 301, [grade(5)], T0);
  await clearGradeMemory();
  const wiped = await restoreHiddenGrades(1, 301, [], T0 + DAY);
  assert.deepStrictEqual(ids(wiped), []);
});
