/**
 * Unit tests for the Tier-B web port (src/lib/web-tier-b.ts).
 *
 * Needs the DOMPurify stub (sanitize.ts requires a DOM at import):
 *   node --import ./src/lib/test-hooks-register.ts src/lib/web-tier-b.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  buildCreateEventBody,
  buildDeleteBody,
  buildMessagesQuery,
  buildPatchBody,
  buildSendMessageBody,
  extractHtmlRedirect,
  extractVakGrades,
  itemsArray,
  mergeAbsencesIntoEvents,
  normalizeGrades,
  selfUrlFromLinks,
  stripApiPrefix,
  truncateDate,
  webAuthedImageUrl,
  webExportAllData,
  webGetBulkGradeExtraInfo,
  webGetCalendarEvents,
  webGetLeermiddelLaunchUrl,
  type TierA,
} from "./web-tier-b.ts";
import type { SessionTokens } from "./backend.ts";
import type { Absence, CalendarEvent } from "./types.ts";

const TOKENS = { accessToken: "t", refreshToken: "r", expiresAt: "", apiEndpoint: "https://x.magister.net", personId: 1 } as SessionTokens;

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    Id: 1, Start: "2026-09-14T08:00:00Z", Einde: "2026-09-14T09:00:00Z",
    LesuurVan: 1, LesuurTotMet: 1, DuurtHeleDag: false, Omschrijving: null,
    Lokatie: null, Status: 1, Type: 13, Subtype: null, IsOnlineDeelname: null,
    WeergaveType: null, Inhoud: null, InfoType: 0, Aantekening: null,
    Afgerond: false, HerhaalStatus: null, Vakken: null, Docenten: null,
    Lokalen: null, OpdrachtId: null, HeeftBijlagen: false, Bijlagen: null,
    Links: null, Afwezigheid: null, self_url: null, merged_absence: null,
    ...over,
  } as CalendarEvent;
}

test("truncateDate keeps YYYY-MM-DD, cuts ISO", () => {
  assert.strictEqual(truncateDate("2026-09-14"), "2026-09-14");
  assert.strictEqual(truncateDate("2026-09-14T23:59:59.000Z"), "2026-09-14");
  assert.strictEqual(truncateDate("kort"), "kort");
});

test("stripApiPrefix never double-prefixes", () => {
  assert.strictEqual(stripApiPrefix("/api/personen/1"), "personen/1");
  assert.strictEqual(stripApiPrefix("api/personen/1"), "personen/1");
  assert.strictEqual(stripApiPrefix("personen/1"), "personen/1");
  assert.strictEqual(stripApiPrefix("///api/personen/1"), "personen/1");
});

test("itemsArray handles Items/items/bare/missing", () => {
  assert.deepStrictEqual(itemsArray({ Items: [1] }), [1]);
  assert.deepStrictEqual(itemsArray({ items: [2] }), [2]);
  assert.deepStrictEqual(itemsArray([3]), [3]);
  assert.deepStrictEqual(itemsArray({}), []);
  assert.deepStrictEqual(itemsArray(null), []);
});

test("extractVakGrades flattens Cijfers, skips missing", () => {
  const vakken = [{ Cijfers: [{ a: 1 }, { a: 2 }] }, { geen: true }, { Cijfers: "x" }];
  assert.strictEqual(extractVakGrades(vakken).length, 2);
  assert.deepStrictEqual(extractVakGrades(null), []);
});

test("normalizeGrades prefers Items, falls back to vakken shapes", () => {
  assert.strictEqual(normalizeGrades({ Items: [{ g: 1 }] }).length, 1);
  assert.strictEqual(normalizeGrades({ items: [{ g: 1 }] }).length, 1);
  assert.strictEqual(normalizeGrades([{ g: 1 }]).length, 1);
  assert.strictEqual(normalizeGrades({ CijferVakken: [{ Cijfers: [{ g: 1 }] }] }).length, 1);
  assert.strictEqual(
    normalizeGrades({ CijferOverzicht: { CijferVakken: [{ Cijfers: [{ g: 1 }] }] } }).length,
    1,
  );
  assert.deepStrictEqual(normalizeGrades({ leeg: true }), []);
});

test("selfUrlFromLinks picks Self rel and strips /api/", () => {
  assert.strictEqual(
    selfUrlFromLinks([{ Rel: "Self", Href: "/api/personen/1/afspraken/2" }]),
    "personen/1/afspraken/2",
  );
  assert.strictEqual(selfUrlFromLinks([{ Rel: "Other", Href: "/api/x" }]), null);
  assert.strictEqual(selfUrlFromLinks(null), null);
});

test("mergeAbsencesIntoEvents matches nested Afspraak.Id and fills self_url", () => {
  const ev = event({ Id: 7, Links: [{ Rel: "Self", Href: "/api/p/1/a/7" }] });
  const absence = { Id: 9, Afspraak: { Id: 7 }, AfspraakId: null } as unknown as Absence;
  const other = { Id: 10, Afspraak: { Id: 999 }, AfspraakId: null } as unknown as Absence;
  const out = mergeAbsencesIntoEvents([ev], [absence, other]);
  assert.strictEqual(out[0].merged_absence, absence);
  assert.strictEqual(out[0].self_url, "p/1/a/7");
});

test("mergeAbsencesIntoEvents falls back to scalar AfspraakId", () => {
  const ev = event({ Id: 5 });
  const absence = { Id: 11, Afspraak: null, AfspraakId: 5 } as unknown as Absence;
  const out = mergeAbsencesIntoEvents([ev], [absence]);
  assert.strictEqual(out[0].merged_absence, absence);
});

test("buildMessagesQuery defaults and encodes", () => {
  assert.strictEqual(buildMessagesQuery(undefined, undefined, undefined), "top=15&skip=0");
  assert.strictEqual(
    buildMessagesQuery(5, 10, "a&b"),
    "top=5&skip=10&trefwoorden=a%26b",
  );
});

test("buildSendMessageBody picks endpoint and shapes refs", () => {
  const p = {
    recipients: [1], copyRecipients: [], blindCopyRecipients: [2],
    subject: "s", htmlContent: "h", hasPriority: true, isConcept: false,
    sendOption: undefined, relatedMessageId: undefined, attachmentIds: [3],
  };
  const { endpoint, body } = buildSendMessageBody(p);
  assert.strictEqual(endpoint, "berichten/berichten");
  const b = body as Record<string, unknown>;
  assert.deepStrictEqual(b["ontvangers"], [{ id: 1, ref_type: "persoon" }]);
  assert.deepStrictEqual(b["bijlagen"], [{ id: 3, ref_type: "upload" }]);
  assert.strictEqual(b["verzend_optie"], "standaard");
  assert.strictEqual(buildSendMessageBody({ ...p, isConcept: true }).endpoint, "berichten/concepten");
});

test("buildPatchBody and buildDeleteBody shapes", () => {
  assert.deepStrictEqual(buildPatchBody([1, 2], "/IsGelezen", true), {
    berichten: [
      { berichtId: 1, operations: [{ op: "replace", path: "/IsGelezen", value: true }] },
      { berichtId: 2, operations: [{ op: "replace", path: "/IsGelezen", value: true }] },
    ],
  });
  assert.deepStrictEqual(buildDeleteBody([4], true), {
    endpoint: "berichten/concepten",
    body: [{ conceptId: 4 }],
  });
  assert.deepStrictEqual(buildDeleteBody([4], false), {
    endpoint: "berichten/berichten",
    body: [{ berichtId: 4 }],
  });
});

test("buildCreateEventBody InfoType coherence", () => {
  const base = { start: "s", einde: "e", duurtHeleDag: false, omschrijving: " x " };
  const plain = buildCreateEventBody(base) as Record<string, unknown>;
  assert.strictEqual(plain["InfoType"], 0);
  assert.strictEqual(plain["Inhoud"], null);
  const noted = buildCreateEventBody({ ...base, inhoud: "huiswerk", eventType: 1 }) as Record<string, unknown>;
  assert.strictEqual(noted["InfoType"], 7);
  assert.strictEqual(noted["Type"], 1);
  assert.strictEqual(noted["Status"], 2);
  const blank = buildCreateEventBody({ ...base, inhoud: "   " }) as Record<string, unknown>;
  assert.strictEqual(blank["InfoType"], 0);
});

test("webGetCalendarEvents fetches in parallel, merges, sanitizes", async () => {
  const calls: string[] = [];
  const fake: TierA = {
    async magister<T>(_: SessionTokens, _m: string, path: string): Promise<T> {
      calls.push(path);
      if (path.includes("/afspraken?")) {
        return { Items: [event({ Id: 7, Inhoud: "<b>les</b>" })] } as unknown as T;
      }
      return { Items: [{ Id: 9, Afspraak: { Id: 7 } }] } as unknown as T;
    },
  };
  const out = await webGetCalendarEvents(fake, TOKENS, 1, "2026-09-14T00:00:00Z", "2026-09-20T00:00:00Z");
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].includes("van=2026-09-14") && calls[0].includes("tot=2026-09-20"));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].merged_absence?.Id, 9);
  // Sanitization boundary applied (stub prefixes output).
  assert.strictEqual(out[0].Inhoud, "stub-sanitized:<b>les</b>");
});

test("extractHtmlRedirect reads meta refresh and script redirects", () => {
  assert.strictEqual(
    extractHtmlRedirect('<meta http-equiv="refresh" content="0;url=https://x.example/a?b=1&amp;c=2" />'),
    "https://x.example/a?b=1&c=2",
  );
  assert.strictEqual(
    extractHtmlRedirect('<script>window.location.href = "https://y.example/b";</script>'),
    "https://y.example/b",
  );
  assert.strictEqual(extractHtmlRedirect("<html><body>plain</body></html>"), null);
});

test("webGetLeermiddelLaunchUrl follows HTML Doorsturen pages", async () => {
  const html = '<html><head><meta http-equiv="refresh" content="0;url=https://sso.example/login" /></head></html>';
  const be: TierA = {
    async magister<T>(): Promise<T> {
      throw new Error("not json");
    },
    async magisterBytes(): Promise<Uint8Array> {
      return new TextEncoder().encode(html);
    },
  };
  const url = await webGetLeermiddelLaunchUrl(be, TOKENS, "personen/1/digitaallesmateriaal/Ean/123");
  assert.strictEqual(url, "https://sso.example/login");
});

test("webGetLeermiddelLaunchUrl rejects foreign absolute hrefs", async () => {
  await assert.rejects(webGetLeermiddelLaunchUrl({ async magister<T>(): Promise<T> { throw new Error("x"); } } as TierA, TOKENS, "https://evil.example.com/book"));
});

test("webExportAllData combines categories, collects warnings", async () => {
  const fake: TierA = {
    async magister<T>(_: SessionTokens, _m: string, path: string): Promise<T> {
      if (path.includes("afspraken")) return { Items: [{ Id: 1 }] } as unknown as T;
      if (path.includes("aanmeldingen?")) return { items: [{ id: 7, Einde: "2026-07-31" }] } as unknown as T;
      if (path.includes("cijferoverzicht")) return { Items: [{ x: 1 }] } as unknown as T;
      if (path.includes("mappen/alle")) return { Items: [{ Id: 3 }] } as unknown as T;
      if (path.includes("mappen/3/berichten")) return { Items: [{ m: 1 }] } as unknown as T;
      if (path.includes("projecten")) throw new Error("no projects");
      if (path.includes("bronnen")) throw new Error("no bronnen");
      return { Items: [] } as unknown as T;
    },
  };
  const out = await webExportAllData(fake, TOKENS, 1);
  assert.ok(out.filename.startsWith("friday-export-") && out.filename.endsWith(".json"));
  const data = JSON.parse(out.json) as Record<string, unknown>;
  for (const key of ["lessen", "cijfers", "berichten", "studiewijzers"]) {
    assert.ok(key in data, `missing ${key}`);
  }
  assert.ok(!("bronnen" in data));
  assert.ok(out.warnings.some((w) => w.startsWith("bronnen:")));
  assert.ok(out.files.includes("lessen.json"));
  assert.ok(!out.files.includes("bronnen.json"));
});

test("webGetBulkGradeExtraInfo fans out and skips failures", async () => {
  const seen: number[] = [];
  const fake = { async magister<T>(): Promise<T> { throw new Error("unused"); } } as TierA;
  const out = await webGetBulkGradeExtraInfo(
    fake,
    TOKENS,
    async (id: number) => {
      seen.push(id);
      if (id === 2) throw new Error("boom");
      return { id } as unknown as import("./types.ts").GradeExtraInfo;
    },
    [1, 2, 3],
    2,
  );
  assert.deepStrictEqual(Object.keys(out).map(Number).sort(), [1, 3]);
  assert.deepStrictEqual(seen.sort(), [1, 2, 3]);
});
