import test from "node:test";
import assert from "node:assert";
import {
  gradePeek,
  gradeRevealState,
  isGradeHidden,
  recordOpen,
  resetCollection,
  splitGrades,
  toggleShowcase,
  getGradeRevealState,
  type GradeRevealState,
} from "./grade-reveal.ts";
import { buildCards } from "./cards.ts";
import type { Grade } from "$lib/types";

function mkGrade(id: number, value = "7,5", over: Partial<Grade> = {}): Grade {
  return {
    CijferId: id,
    CijferStr: value,
    IsVoldoende: true,
    DatumIngevoerd: `2026-10-${String(10 + (id % 18)).padStart(2, "0")}T10:00:00`,
    Weging: 1,
    CijferKolom: {
      Id: 1,
      KolomNaam: "Toets",
      KolomOmschrijving: "H1",
      KolomSoort: 1,
    },
    Vak: { Id: 1, Afkorting: "wi", Omschrijving: "Wiskunde", Volgnr: 1 },
    ...over,
  } as Grade;
}
const none = { opened: [] as number[] };

test("everything is hidden by default, even old grades", () => {
  const old = mkGrade(1, "7,5", { DatumIngevoerd: "2024-01-01T10:00:00" });
  assert.equal(isGradeHidden(old, true, none), true);
});

test("nothing is hidden when the feature is off or when peeking", () => {
  const g = mkGrade(1);
  assert.equal(isGradeHidden(g, false, none), false);
  assert.equal(isGradeHidden(g, true, none, true), false);
  const split = splitGrades([g], true, none, true);
  assert.equal(split.visible.length, 1);
  assert.equal(split.hidden.length, 0);
});

test("opened grades become visible; others stay hidden", () => {
  const { visible, hidden } = splitGrades(
    [mkGrade(1), mkGrade(2), mkGrade(3)],
    true,
    { opened: [2] },
  );
  assert.deepEqual(
    visible.map((g) => g.CijferId),
    [2],
  );
  assert.equal(hidden.length, 2);
});

test("average columns and empty values are never hidden", () => {
  const avg = mkGrade(1, "7,0", {
    CijferKolom: {
      Id: 2,
      KolomNaam: "Gem",
      KolomSoort: 2,
    } as Grade["CijferKolom"],
  });
  assert.equal(isGradeHidden(avg, true, none), false);
  assert.equal(isGradeHidden(mkGrade(2, ""), true, none), false);
});

test("hidden grades are sorted newest first", () => {
  const a = mkGrade(1, "7", { DatumIngevoerd: "2026-10-01T08:00:00" });
  const b = mkGrade(2, "7", { DatumIngevoerd: "2026-10-20T08:00:00" });
  const c = mkGrade(3, "7", { DatumIngevoerd: "2026-10-10T08:00:00" });
  assert.deepEqual(
    splitGrades([a, b, c], true, none).hidden.map((g) => g.CijferId),
    [2, 3, 1],
  );
});

test("recordOpen is idempotent, tracks xp and unlocks achievements once", () => {
  resetCollection();
  const card = buildCards([mkGrade(5, "9,0")], { threshold: 5.5 }).get(5)!;
  const first = recordOpen(card);
  assert.ok(first.newlyUnlocked.includes("first-pull"));
  assert.ok(first.newlyUnlocked.includes("legend"));
  const again = recordOpen(card);
  assert.deepEqual(again.newlyUnlocked, []);
  const s = getGradeRevealState();
  assert.deepEqual(s.opened, [5]);
  assert.equal(s.tally.total, 1);
  assert.equal(s.tally.xp, card.xp);
  assert.ok(typeof s.unlocked["first-pull"] === "number");
});

test("showcase holds at most 3 and toggles off", () => {
  resetCollection();
  [1, 2, 3, 4].forEach(toggleShowcase);
  assert.deepEqual(getGradeRevealState().showcase, [2, 3, 4]);
  toggleShowcase(3);
  assert.deepEqual(getGradeRevealState().showcase, [2, 4]);
});

test("reset hides everything again", () => {
  recordOpen(buildCards([mkGrade(9)], { threshold: 5.5 }).get(9)!);
  resetCollection();
  let s!: GradeRevealState;
  gradeRevealState.subscribe((v) => (s = v))();
  assert.deepEqual(s.opened, []);
  assert.equal(s.tally.total, 0);
});

test("peek is session state that starts off", () => {
  let v;
  gradePeek.subscribe((x) => (v = x))();
  assert.equal(v, false);
});
