import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAssignmentStatus,
  isOverdue,
  canHandIn,
  filterAssignments,
  vakOptions,
  sortVersions,
  latestVersion,
  selfHref,
  htmlHasContent,
  versionHasStudentContent,
  versionHasTeacherContent,
  validateHandIn,
  buildHandInBody,
  formatBytes,
  type ListFilters,
} from "./assignments.ts";
import type { Assignment, AssignmentVersion } from "./types.ts";

const NOW = new Date("2026-11-01T12:00:00Z");

function assignment(over: Partial<Assignment> = {}): Assignment {
  return {
    Id: 1,
    Links: [],
    Titel: "Opdracht",
    Vak: "Nederlands",
    InleverenVoor: "2026-11-10T12:00:00.0000000Z",
    IngeleverdOp: null,
    StatusLaatsteOpdrachtVersie: 4,
    LaatsteOpdrachtVersienummer: 1,
    Docenten: null,
    Omschrijving: null,
    Beoordeling: null,
    BeoordeeldOp: null,
    OpnieuwInleveren: false,
    Afgesloten: false,
    IsTeLaat: null,
    MagInleveren: true,
    Bijlagen: null,
    VersieNavigatieItems: null,
    ...over,
  };
}

function version(over: Partial<AssignmentVersion> = {}): AssignmentVersion {
  return {
    Id: 10,
    Vak: "Nederlands",
    Status: 4,
    OpdrachtId: 1,
    LeerlingOpmerking: null,
    DocentOpmerking: null,
    InleverenVoor: "2026-11-10T12:00:00.0000000Z",
    IngeleverdOp: null,
    GestartOp: null,
    Beoordeling: null,
    BeoordeeldOp: null,
    VersieNummer: 1,
    IsTeLaat: false,
    Omschrijving: "Schrijf een verslag",
    Links: [{ Rel: "Self", Href: "/api/personen/1/opdrachten/versie/10" }],
    LeerlingBijlagen: null,
    FeedbackBijlagen: null,
    ...over,
  };
}

describe("status", () => {
  it("follows the same priority as before", () => {
    assert.equal(getAssignmentStatus(assignment({ Afgesloten: true, BeoordeeldOp: "x" }), NOW).key, "closed");
    assert.equal(getAssignmentStatus(assignment({ BeoordeeldOp: "2026-11-02" }), NOW).key, "graded");
    assert.equal(getAssignmentStatus(assignment({ IngeleverdOp: "2026-11-02" }), NOW).key, "submitted");
    assert.equal(getAssignmentStatus(assignment({ MagInleveren: true }), NOW).label, "In te leveren");
    assert.equal(getAssignmentStatus(assignment({ MagInleveren: false }), NOW).label, "Openstaand");
  });
  it("marks a missed deadline as late unless Magister says otherwise", () => {
    const late = assignment({ InleverenVoor: "2026-10-01T00:00:00Z" });
    assert.equal(isOverdue(late, NOW), true);
    assert.equal(getAssignmentStatus(late, NOW).key, "overdue");
    assert.equal(isOverdue({ ...late, IsTeLaat: false }, NOW), false);
    assert.equal(isOverdue({ ...late, IsTeLaat: true, InleverenVoor: "2027-01-01" }, NOW), true);
    assert.equal(isOverdue({ ...late, IngeleverdOp: "2026-09-30" }, NOW), false);
  });
  it("offers the hand-in form only while it is allowed", () => {
    assert.equal(canHandIn(assignment()), true);
    assert.equal(canHandIn(assignment({ MagInleveren: false, OpnieuwInleveren: true })), true);
    assert.equal(canHandIn(assignment({ MagInleveren: false })), false);
    assert.equal(canHandIn(assignment({ Afgesloten: true })), false);
  });
});

describe("filterAssignments", () => {
  const list = [
    assignment({ Id: 1, Titel: "Beta", Vak: "Wiskunde", InleverenVoor: "2026-09-15T10:00:00Z" }),
    assignment({ Id: 2, Titel: "alpha", Vak: "Nederlands", InleverenVoor: "2026-11-20T10:00:00Z" }),
    assignment({ Id: 3, Titel: "Gamma", Vak: "Nederlands", InleverenVoor: "2025-10-01T10:00:00Z", IngeleverdOp: "2025-09-30" }),
    assignment({ Id: 4, Titel: "Delta", Vak: null, InleverenVoor: "2026-12-01T10:00:00Z", BeoordeeldOp: "2026-12-02" }),
  ];
  const base: ListFilters = { status: "all", vak: null, year: null, sort: "deadline-desc" };
  const ids = (l: Assignment[]) => l.map((a) => a.Id);

  it("sorts by deadline, newest first by default, and oldest first on request", () => {
    assert.deepEqual(ids(filterAssignments(list, base, NOW)), [4, 2, 1, 3]);
    assert.deepEqual(ids(filterAssignments(list, { ...base, sort: "deadline-asc" }, NOW)), [3, 1, 2, 4]);
  });
  it("sorts by title ignoring case", () => {
    assert.deepEqual(ids(filterAssignments(list, { ...base, sort: "title" }, NOW)), [2, 1, 4, 3]);
  });
  it("filters by school year (inclusive, by date)", () => {
    const f = { ...base, year: { begin: "2026-08-01T00:00:00Z", einde: "2027-07-31T00:00:00Z" } };
    assert.deepEqual(ids(filterAssignments(list, f, NOW)), [4, 2, 1]);
  });
  it("includes the first and last day of a school year", () => {
    const edge = [
      assignment({ Id: 7, InleverenVoor: "2026-08-01T00:00:00Z" }),
      assignment({ Id: 8, InleverenVoor: "2027-07-31T23:59:00Z" }),
    ];
    const f = { ...base, year: { begin: "2026-08-01", einde: "2027-07-31" } };
    assert.deepEqual(ids(filterAssignments(edge, f, NOW)).sort(), [7, 8]);
  });
  it("filters by subject and by status", () => {
    assert.deepEqual(ids(filterAssignments(list, { ...base, vak: "Nederlands" }, NOW)), [2, 3]);
    assert.deepEqual(ids(filterAssignments(list, { ...base, status: "submitted" }, NOW)), [3]);
    assert.deepEqual(ids(filterAssignments(list, { ...base, status: "graded" }, NOW)), [4]);
  });
  it("does not mutate its input", () => {
    const copy = [...list];
    filterAssignments(list, base, NOW);
    assert.deepEqual(list, copy);
  });
  it("lists subjects once, alphabetically, without blanks", () => {
    assert.deepEqual(vakOptions(list), ["Nederlands", "Wiskunde"]);
  });
});

describe("versions", () => {
  it("sorts by version number and uses the highest as the latest, whatever the order", () => {
    const items = [
      version({ Id: 12, VersieNummer: 3 }),
      version({ Id: 10, VersieNummer: 1 }),
      version({ Id: 11, VersieNummer: 2 }),
    ];
    assert.deepEqual(sortVersions(items).map((v) => v.VersieNummer), [1, 2, 3]);
    assert.equal(latestVersion(items)?.Id, 12);
    assert.equal(latestVersion([]), null);
    assert.equal(latestVersion(null), null);
  });
  it("copes with missing version numbers", () => {
    const items = [version({ Id: 5, VersieNummer: null }), version({ Id: 6, VersieNummer: 1 })];
    assert.equal(latestVersion(items)?.Id, 6);
  });
  it("finds the Self link regardless of case", () => {
    assert.equal(selfHref([{ Rel: "self", Href: "/api/x" }]), "/api/x");
    assert.equal(selfHref([{ Rel: "Other", Href: "/api/y" }]), null);
    assert.equal(selfHref(null), null);
  });
  it("recognises what a student and a teacher added", () => {
    assert.equal(versionHasStudentContent(version()), false);
    assert.equal(versionHasStudentContent(version({ LeerlingOpmerking: "<p>Klaar</p>" })), true);
    assert.equal(versionHasStudentContent(version({ IngeleverdOp: "2026-11-02" })), true);
    assert.equal(versionHasTeacherContent(version({ DocentOpmerking: "<p></p>" })), false);
    assert.equal(versionHasTeacherContent(version({ Beoordeling: "8,5" })), true);
    assert.equal(versionHasTeacherContent(version({ Beoordeling: "  " })), false);
  });
});

describe("htmlHasContent", () => {
  it("ignores empty markup and non-breaking spaces", () => {
    assert.equal(htmlHasContent(""), false);
    assert.equal(htmlHasContent(null), false);
    assert.equal(htmlHasContent("<p></p>"), false);
    assert.equal(htmlHasContent("<p>&nbsp;</p><p><br></p>"), false);
    assert.equal(htmlHasContent("<p> \u00a0 </p>"), false);
  });
  it("counts text and images", () => {
    assert.equal(htmlHasContent("<p>Hoi</p>"), true);
    assert.equal(htmlHasContent('<p><img src="data:x"></p>'), true);
  });
});

describe("hand-in", () => {
  const file = { name: "verslag.pdf", storageId: "abc-123", contentType: "application/pdf" };

  it("needs a comment or a file", () => {
    assert.ok(validateHandIn({ comment: "<p></p>", files: [] }));
    assert.equal(validateHandIn({ comment: "<p>Klaar!</p>", files: [] }), null);
    assert.equal(validateHandIn({ comment: "", files: [file] }), null);
  });

  it("builds the body from the fetched version and keeps its data", () => {
    const v = version({
      Id: 77,
      VersieNummer: 2,
      Status: 4,
      OpdrachtId: 5,
      InleverenVoor: "2026-11-10T12:00:00Z",
      GestartOp: "2026-11-01T08:00:00Z",
      Omschrijving: "Lees hoofdstuk 3",
    });
    const body = buildHandInBody(v, { comment: "<p>Klaar</p>", files: [file] });
    assert.equal(body.Id, 77);
    assert.equal(body.VersieNummer, 2);
    assert.equal(body.Status, 4);
    assert.equal(body.OpdrachtId, 5);
    assert.equal(body.InleverenVoor, "2026-11-10T12:00:00Z");
    assert.equal(body.GestartOp, "2026-11-01T08:00:00Z");
    assert.equal(body.Omschrijving, "Lees hoofdstuk 3");
    assert.equal(body.IngeleverdOp, null);
    assert.equal(body.LeerlingOpmerking, "<p>Klaar</p>");
    assert.deepEqual(body.LeerlingBijlagen, [
      {
        Id: 0,
        Naam: "verslag.pdf",
        ContentType: "application/pdf",
        Datum: null,
        Grootte: 0,
        Url: "",
        UniqueId: "abc-123",
        BronSoort: 1,
        Links: null,
      },
    ]);
  });

  it("sends no comment when the editor is empty, and a default content type", () => {
    const body = buildHandInBody(version(), {
      comment: "<p><br></p>",
      files: [{ ...file, contentType: "" }],
    });
    assert.equal(body.LeerlingOpmerking, null);
    const first = (body.LeerlingBijlagen as Array<{ ContentType: string }>)[0];
    assert.equal(first.ContentType, "application/octet-stream");
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatBytes(-1), "");
  });
});
