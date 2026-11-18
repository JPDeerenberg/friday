import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  stripTeacherCode,
  teacherKey,
  sanitizeAliases,
  aliasFor,
  withAlias,
  setTeacherAliases,
  formatTeacherName,
  displayTeacherName,
  registerTeacherNames,
  listSeenTeachers,
  _resetTeachersForTests,
} from "./teachers.ts";

// A tiny in-memory localStorage for the "seen" list.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

beforeEach(() => {
  store.clear();
  _resetTeachersForTests();
});

describe("names", () => {
  it("strips the teacher code and matches regardless of case, spacing or code", () => {
    assert.equal(stripTeacherCode("J. Jansen (JAN)"), "J. Jansen");
    assert.equal(stripTeacherCode("Mevr. De Vries"), "Mevr. De Vries");
    assert.equal(teacherKey("  J.  Jansen (JAN) "), "j. jansen");
    assert.equal(teacherKey("j. jansen"), teacherKey("J. Jansen (XYZ)"));
  });
});

describe("sanitizeAliases", () => {
  it("keeps only usable pairs, normalised", () => {
    const out = sanitizeAliases({
      "J. Jansen (JAN)": "  Janneke   ",
      "": "x",
      "A. Bakker": "",
      "B. Smit": 5,
    });
    assert.deepEqual(out, { "j. jansen": "Janneke" });
  });
  it("copes with garbage", () => {
    assert.deepEqual(sanitizeAliases(null), {});
    assert.deepEqual(sanitizeAliases("x"), {});
    assert.deepEqual(sanitizeAliases(["a"]), {});
  });
  it("bounds the alias length", () => {
    const out = sanitizeAliases({ a: "x".repeat(200) });
    assert.equal(out["a"].length, 60);
  });
});

describe("aliasFor / withAlias", () => {
  it("finds an alias by any spelling of the name", () => {
    const aliases = { "j. jansen": "Janneke" };
    assert.equal(aliasFor("J. Jansen (JAN)", aliases), "Janneke");
    assert.equal(aliasFor("j.  jansen", aliases), "Janneke");
    assert.equal(aliasFor("A. Bakker", aliases), null);
    assert.equal(aliasFor("", aliases), null);
  });
  it("is not fooled by prototype keys", () => {
    assert.equal(aliasFor("constructor", {}), null);
    assert.equal(aliasFor("__proto__", {}), null);
  });
  it("adds, changes and removes aliases without mutating the original", () => {
    const base = { "a. bakker": "Bak" };
    const added = withAlias(base, "J. Jansen (JAN)", " Janneke ");
    assert.deepEqual(added, { "a. bakker": "Bak", "j. jansen": "Janneke" });
    assert.deepEqual(base, { "a. bakker": "Bak" });
    assert.deepEqual(withAlias(added, "J. Jansen", "Jan"), { "a. bakker": "Bak", "j. jansen": "Jan" });
    assert.deepEqual(withAlias(added, "J. Jansen", ""), { "a. bakker": "Bak" });
    // Renaming a teacher back to their own name removes the alias.
    assert.deepEqual(withAlias(added, "J. Jansen (JAN)", "J. Jansen"), { "a. bakker": "Bak" });
  });
});

describe("applied everywhere", () => {
  it("formatTeacherName uses the alias, else the name without code", () => {
    assert.equal(formatTeacherName("J. Jansen (JAN)"), "J. Jansen");
    setTeacherAliases({ "j. jansen": "Janneke" });
    assert.equal(formatTeacherName("J. Jansen (JAN)"), "Janneke");
    assert.equal(formatTeacherName("A. Bakker (BAK)"), "A. Bakker");
  });
  it("displayTeacherName keeps the raw name when there is no alias", () => {
    assert.equal(displayTeacherName("J. Jansen (JAN)"), "J. Jansen (JAN)");
    setTeacherAliases({ "j. jansen": "Janneke" });
    assert.equal(displayTeacherName("J. Jansen (JAN)"), "Janneke");
  });
  it("sanitises what the store hands over", () => {
    setTeacherAliases({ "j. jansen": 12, "a. bakker": "Bak" });
    assert.equal(formatTeacherName("J. Jansen"), "J. Jansen");
    assert.equal(formatTeacherName("A. Bakker"), "Bak");
  });
});

describe("teachers seen", () => {
  it("records each teacher once, without the code, and lists them alphabetically", () => {
    registerTeacherNames(["B. Smit (SMI)", "A. Bakker (BAK)", "B. Smit (SMI)", "b.  smit", null, undefined, ""]);
    assert.deepEqual(listSeenTeachers(), [
      { key: "a. bakker", name: "A. Bakker" },
      { key: "b. smit", name: "B. Smit" },
    ]);
  });
  it("persists and restores the list", () => {
    registerTeacherNames(["J. Jansen (JAN)"]);
    _resetTeachersForTests(); // forget the in-memory copy, keep storage
    assert.deepEqual(listSeenTeachers(), [{ key: "j. jansen", name: "J. Jansen" }]);
  });
  it("survives a corrupt stored list", () => {
    store.set("friday_teachers_seen", "{kapot");
    assert.deepEqual(listSeenTeachers(), []);
    registerTeacherNames(["A. Bakker"]);
    assert.equal(listSeenTeachers().length, 1);
  });
});
