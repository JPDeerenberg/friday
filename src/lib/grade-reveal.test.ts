import test from "node:test";
import assert from "node:assert";
import {
  gradeRevealState,
  isGradeHidden,
  markGradeOpened,
  markGradesOpened,
  resetGradeRevealBaseline,
  splitGrades,
  toRevealItem,
  type GradeRevealState,
} from "./grade-reveal.ts";
import type { Grade } from "$lib/types";

const SINCE = Date.parse("2026-10-01T00:00:00");
const state = (opened: number[] = []): GradeRevealState => ({
  since: SINCE,
  opened,
});

function mkGrade(overrides: Partial<Grade> = {}): Grade {
  return {
    CijferId: 1,
    CijferStr: "7,5",
    IsVoldoende: true,
    IngevoerdDoor: null,
    DatumIngevoerd: "2026-10-20T10:00:00",
    Weging: 2,
    Inhalen: false,
    Vrijstelling: false,
    TeltMee: true,
    CijferKolom: {
      Id: 1,
      KolomNaam: "Toets 3",
      KolomNummer: null,
      KolomVolgNummer: null,
      KolomKop: null,
      KolomOmschrijving: "Hoofdstuk 3",
      KolomSoort: 1,
      IsHerkansingKolom: false,
      IsDocentKolom: false,
      HeeftOnderliggendeKolommen: false,
      IsPTAKolom: false,
    },
    CijferKolomIdEloOpdracht: null,
    Docent: null,
    VakOntheffing: false,
    VakVrijstelling: false,
    CijferPeriode: null,
    Vak: { Id: 1, Afkorting: "wi", Omschrijving: "Wiskunde", Volgnr: 1 },
    description: null,
    test_date: null,
    extra_weight: null,
    ...overrides,
  } as Grade;
}

test("a grade entered after the baseline is hidden", () => {
  assert.equal(isGradeHidden(mkGrade(), true, state()), true);
});

test("nothing is hidden when the feature is off", () => {
  const g = mkGrade();
  assert.equal(isGradeHidden(g, false, state()), false);
  const { visible, hidden } = splitGrades([g], false, state());
  assert.equal(visible.length, 1);
  assert.equal(hidden.length, 0);
});

test("grades from before the baseline (e.g. older years) stay visible", () => {
  const old = mkGrade({ DatumIngevoerd: "2025-03-02T09:00:00" });
  assert.equal(isGradeHidden(old, true, state()), false);
});

test("an opened grade is no longer hidden", () => {
  assert.equal(
    isGradeHidden(mkGrade({ CijferId: 5 }), true, state([5])),
    false,
  );
});

test("average columns, empty values and undated grades are never hidden", () => {
  const avg = mkGrade({
    CijferKolom: { ...mkGrade().CijferKolom, KolomSoort: 2 },
  });
  assert.equal(isGradeHidden(avg, true, state()), false);
  assert.equal(
    isGradeHidden(mkGrade({ CijferStr: null }), true, state()),
    false,
  );
  assert.equal(
    isGradeHidden(mkGrade({ DatumIngevoerd: null }), true, state()),
    false,
  );
  assert.equal(
    isGradeHidden(mkGrade({ DatumIngevoerd: "not a date" }), true, state()),
    false,
  );
});

test("non-numeric grades (V, G, *) are hidden too", () => {
  assert.equal(isGradeHidden(mkGrade({ CijferStr: "V" }), true, state()), true);
  assert.equal(isGradeHidden(mkGrade({ CijferStr: "*" }), true, state()), true);
});

test("splitGrades separates visible/hidden and sorts hidden oldest first", () => {
  const old = mkGrade({ CijferId: 1, DatumIngevoerd: "2025-01-01T08:00:00" });
  const b = mkGrade({ CijferId: 2, DatumIngevoerd: "2026-10-22T08:00:00" });
  const a = mkGrade({ CijferId: 3, DatumIngevoerd: "2026-10-05T08:00:00" });
  const { visible, hidden } = splitGrades([old, b, a], true, state());
  assert.deepEqual(
    visible.map((g) => g.CijferId),
    [1],
  );
  assert.deepEqual(
    hidden.map((g) => g.CijferId),
    [3, 2],
  );
});

test("opening grades updates the shared state and dedupes", () => {
  resetGradeRevealBaseline();
  markGradeOpened(10);
  markGradesOpened([10, 11]);
  let current: GradeRevealState | undefined;
  gradeRevealState.subscribe((v) => (current = v))();
  assert.deepEqual(current?.opened, [10, 11]);
});

test("resetting the baseline clears opened ids and moves 'since' to now", () => {
  markGradeOpened(99);
  const before = Date.now();
  resetGradeRevealBaseline();
  let current: GradeRevealState | undefined;
  gradeRevealState.subscribe((v) => (current = v))();
  assert.deepEqual(current?.opened, []);
  assert.ok((current?.since ?? 0) >= before);
});

test("toRevealItem maps the fields the overlay shows", () => {
  const item = toRevealItem(mkGrade({ CijferId: 7 }), true);
  assert.deepEqual(item, {
    id: 7,
    subject: "Wiskunde",
    title: "Hoofdstuk 3",
    value: "7,5",
    passed: true,
    weight: 2,
  });
});
