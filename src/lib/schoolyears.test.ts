import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sortSchoolyears, currentSchoolyear, schoolyearLabel } from "./schoolyears.ts";
import type { Schoolyear } from "./types.ts";

const NOW = new Date("2026-11-01T12:00:00Z");

function year(begin: string, einde: string, code = "4V"): Schoolyear {
  return {
    id: 1,
    studie: { id: 1, code, omschrijving: null },
    groep: null,
    lesperiode: { code: "x" },
    profielen: [],
    persoonlijke_mentor: null,
    begin,
    einde,
    is_zitten_blijver: null,
    indicatie: null,
    opleiding_code: null,
    is_hoofd_aanmelding: null,
  };
}

describe("school years", () => {
  const y24 = year("2024-08-01T00:00:00Z", "2025-07-31T00:00:00Z", "3V");
  const y25 = year("2025-08-01T00:00:00Z", "2026-07-31T00:00:00Z", "4V");
  const y26 = year("2026-08-01T00:00:00Z", "2027-07-31T00:00:00Z", "5V");

  it("picks the year that contains today, whatever the order", () => {
    assert.equal(currentSchoolyear([y24, y26, y25], NOW), y26);
    assert.equal(currentSchoolyear([y26, y25, y24], new Date("2025-10-10")), y25);
  });
  it("falls back to the newest year during the summer break", () => {
    assert.equal(currentSchoolyear([y24, y25], new Date("2026-08-20")), y25);
    assert.equal(currentSchoolyear([], NOW), null);
  });
  it("sorts newest first and labels years", () => {
    assert.deepEqual(sortSchoolyears([y24, y26, y25]), [y26, y25, y24]);
    assert.equal(schoolyearLabel(y26), "2026/2027 · 5V");
    assert.equal(schoolyearLabel({ ...y26, studie: { id: null, code: "", omschrijving: null } }), "2026/2027");
  });
});

