import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  subjectTotals,
  averageWith,
  neededGrade,
  oneDecimal,
  reactionFor,
} from "./quick-grades.ts";
import type { Grade } from "./types.ts";

let id = 0;
function grade(
  vak: string,
  str: string | null,
  weging: number | null = 1,
  over: Partial<Grade> = {},
): Grade {
  return {
    CijferId: ++id,
    CijferStr: str,
    IsVoldoende: true,
    IngevoerdDoor: null,
    DatumIngevoerd: null,
    Weging: weging,
    Inhalen: false,
    Vrijstelling: false,
    TeltMee: true,
    CijferKolom: { KolomSoort: 1 } as Grade["CijferKolom"],
    CijferKolomIdEloOpdracht: null,
    Docent: null,
    VakOntheffing: false,
    VakVrijstelling: false,
    CijferPeriode: null,
    Vak: { Omschrijving: vak } as Grade["Vak"],
    description: null,
    test_date: null,
    extra_weight: null,
    ...over,
  } as Grade;
}

describe("subjectTotals", () => {
  it("builds weighted averages per subject, alphabetical", () => {
    const t = subjectTotals([
      grade("Wiskunde", "6,0", 1),
      grade("Wiskunde", "8,0", 3),
      grade("Engels", "7,5", 2),
    ]);
    assert.deepEqual(
      t.map((s) => s.name),
      ["Engels", "Wiskunde"],
    );
    const wis = t[1];
    assert.equal(wis.weight, 4);
    assert.equal(wis.count, 2);
    assert.equal(wis.average, 7.5); // (6 + 24) / 4
  });

  it("ignores letters, empty values, averages columns, exemptions and non-counting grades", () => {
    const t = subjectTotals([
      grade("Frans", "V"),
      grade("Frans", null),
      grade("Frans", "7", 1, {
        CijferKolom: { KolomSoort: 2 } as Grade["CijferKolom"],
      }),
      grade("Frans", "7", 1, { Vrijstelling: true }),
      grade("Frans", "7", 1, { TeltMee: false }),
      grade("Frans", "6,5", 1),
    ]);
    assert.equal(t.length, 1);
    assert.equal(t[0].count, 1);
    assert.equal(t[0].average, 6.5);
  });

  it("falls back to weight 1 only when missing, an explicit 0 does not count", () => {
    const t = subjectTotals([
      grade("Nask", "6", null),
      grade("Nask", "8", 0),
      grade("", "9"),
    ]);
    assert.equal(t.length, 1);
    assert.equal(t[0].weight, 1);
    assert.equal(t[0].average, 6);
  });

  it("returns nothing without grades", () => {
    assert.deepEqual(subjectTotals([]), []);
  });
});

describe("averageWith / neededGrade", () => {
  const t = subjectTotals([
    grade("Wiskunde", "6", 1),
    grade("Wiskunde", "8", 1),
  ])[0]; // avg 7, weight 2

  it("computes the new average for an extra grade", () => {
    assert.equal(averageWith(t, 7, 1), 7);
    assert.equal(oneDecimal(averageWith(t, 10, 1)), 8);
    assert.equal(oneDecimal(averageWith(t, 4, 2)), 5.5); // (14 + 8) / 4
  });

  it("computes the grade needed for a target", () => {
    const n = neededGrade(t, 7.5, 1);
    assert.equal(n.kind, "grade");
    if (n.kind === "grade") assert.equal(oneDecimal(n.value), 8.5); // (7.5*3 - 14) / 1
  });

  it("recognises 'safe' and 'impossible'", () => {
    assert.deepEqual(neededGrade(t, 4.5, 1), { kind: "safe" }); // even a 1.0 keeps you above 4.5
    const modest = neededGrade(t, 5.5, 1);
    assert.equal(modest.kind, "grade");
    assert.deepEqual(neededGrade(t, 9.5, 1), { kind: "impossible" });
    assert.deepEqual(neededGrade(t, 6, 0), { kind: "impossible" });
  });

  it("feeds its own answer back to the target", () => {
    const n = neededGrade(t, 7.4, 2);
    assert.equal(n.kind, "grade");
    if (n.kind === "grade")
      assert.ok(Math.abs(averageWith(t, n.value, 2) - 7.4) < 1e-9);
  });
});

describe("reactionFor", () => {
  it("is encouraging and never negative", () => {
    assert.equal(reactionFor(7.9, 7.0, 5.5).icon, "rocket");
    assert.equal(reactionFor(8.2, 8.1, 5.5).icon, "flame");
    assert.equal(reactionFor(7.2, 7.1, 5.5).icon, "smile");
    assert.equal(reactionFor(6, 6, 5.5).icon, "thumbs-up");
    assert.equal(reactionFor(5.0, 4.8, 5.5).icon, "trend-up");
    assert.equal(reactionFor(4.5, 5.0, 5.5).icon, "zap");
    assert.equal(reactionFor(6, null, 5.5).icon, "thumbs-up");
  });
});
