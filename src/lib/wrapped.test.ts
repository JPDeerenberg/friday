import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWrapped, wrappedShareText, type WrappedInput } from "./wrapped.ts";
import type { Grade } from "./types.ts";
import type { CardData } from "./cards.ts";

let id = 0;
function grade(vak: string, str: string, date: string, weging = 1): Grade {
  return {
    CijferId: ++id, CijferStr: str, IsVoldoende: true, IngevoerdDoor: null, DatumIngevoerd: date, Weging: weging,
    Inhalen: false, Vrijstelling: false, TeltMee: true, CijferKolom: { KolomSoort: 1 } as Grade["CijferKolom"],
    CijferKolomIdEloOpdracht: null, Docent: null, VakOntheffing: false, VakVrijstelling: false, CijferPeriode: null,
    Vak: { Omschrijving: vak } as Grade["Vak"], description: null, test_date: null, extra_weight: null,
  } as Grade;
}
function card(i: number, rarity: CardData["rarity"]): CardData {
  return {
    id: i, subject: "Wiskunde", title: "t", value: "7", valueNum: 7, passed: true, rarity, shiny: false, mode: "tear",
    seed: i, hue: 0, icon: "books", weight: 1, date: "2026-10-01", stamps: [], xp: 10,
  };
}

const base = (over: Partial<WrappedInput> = {}): WrappedInput => ({
  season: "2026-2027", now: new Date(2026, 10, 9), grades: [], cards: [], opened: new Set(), level: 3,
  levelTitle: "Doorzetter", missionPoints: 0, missionTier: "Nog geen rang", weekStreak: 0, ...over,
});
const kinds = (s: ReturnType<typeof buildWrapped>) => s.map((x) => x.kind);

describe("buildWrapped", () => {
  it("always opens with the intro and closes with the title", () => {
    const s = buildWrapped(base());
    assert.deepEqual(kinds(s), ["intro", "outro"]);
    const intro = s[0];
    assert.equal(intro.kind === "intro" && intro.daysIn, 100); // 1 Aug -> 9 Nov
  });
  it("summarises grades: count, subjects, weighted average, best subject, highest grade", () => {
    const s = buildWrapped(base({
      grades: [grade("Wiskunde", "6,0", "2026-09-10"), grade("Wiskunde", "8,0", "2026-10-10", 3), grade("Engels", "9,0", "2026-10-20"), grade("Frans", "5,5", "2026-10-21")],
    }));
    const g = s.find((x) => x.kind === "grades")!;
    assert.deepEqual(g.kind === "grades" && [g.count, g.subjects], [4, 3]);
    assert.ok(g.kind === "grades" && Math.abs(g.average! - (6 + 24 + 9 + 5.5) / 6) < 1e-9);
    const best = s.find((x) => x.kind === "best")!;
    assert.equal(best.kind === "best" && best.subject, "Engels");
    const top = s.find((x) => x.kind === "highest")!;
    assert.deepEqual(top.kind === "highest" && [top.value, top.subject], [9, "Engels"]);
  });
  it("skips 'best subject' when there is only one subject", () => {
    const s = buildWrapped(base({ grades: [grade("Wiskunde", "7", "2026-09-01"), grade("Wiskunde", "8", "2026-10-01")] }));
    assert.ok(!kinds(s).includes("best"));
  });
  it("names the most improved subject, and only when it really improved", () => {
    const rising = [grade("Frans", "5,0", "2026-09-01"), grade("Frans", "5,5", "2026-09-15"), grade("Frans", "7,0", "2026-10-15"), grade("Frans", "7,5", "2026-11-01")];
    const imp = buildWrapped(base({ grades: rising })).find((x) => x.kind === "improved")!;
    assert.ok(imp.kind === "improved" && imp.subject === "Frans" && imp.to > imp.from + 1.5);
    const falling = [grade("Frans", "8,0", "2026-09-01"), grade("Frans", "7,5", "2026-09-15"), grade("Frans", "6,0", "2026-10-15"), grade("Frans", "5,5", "2026-11-01")];
    assert.ok(!kinds(buildWrapped(base({ grades: falling }))).includes("improved"));
    const few = [grade("Frans", "5,0", "2026-09-01"), grade("Frans", "9,0", "2026-11-01")];
    assert.ok(!kinds(buildWrapped(base({ grades: few }))).includes("improved"));
  });
  it("counts only opened cards and never reveals what is face-down", () => {
    const cards = [card(1, "gewoon"), card(2, "episch"), card(3, "mythisch")];
    const c = buildWrapped(base({ cards, opened: new Set([1, 2]) })).find((x) => x.kind === "cards")!;
    assert.deepEqual(c.kind === "cards" && [c.opened, c.rarest], [2, "episch"]);
    assert.ok(!kinds(buildWrapped(base({ cards, opened: new Set() }))).includes("cards"));
  });
  it("includes missions only when points were earned", () => {
    assert.ok(!kinds(buildWrapped(base())).includes("missions"));
    const m = buildWrapped(base({ missionPoints: 120, missionTier: "Starter", weekStreak: 3 })).find((x) => x.kind === "missions")!;
    assert.deepEqual(m.kind === "missions" && [m.points, m.tier, m.weeks], [120, "Starter", 3]);
  });
  it("is positive only: no slide mentions failing, low grades or insufficient marks", () => {
    const s = buildWrapped(base({ grades: [grade("Frans", "3,0", "2026-09-01"), grade("Wiskunde", "4,5", "2026-10-01")] }));
    const text = JSON.stringify(s) + wrappedShareText(s, "2026-2027");
    assert.ok(!/onvoldoende|gezakt|slecht|laagste/i.test(text));
  });
});

describe("wrappedShareText", () => {
  it("makes a short paste-able summary", () => {
    const s = buildWrapped(base({
      grades: [grade("Wiskunde", "6,0", "2026-09-10"), grade("Engels", "9,0", "2026-10-20")],
      cards: [card(1, "episch")], opened: new Set([1]), missionPoints: 40, missionTier: "Starter",
    }));
    const t = wrappedShareText(s, "2026-2027");
    assert.match(t, /^Mijn Friday Wrapped 2026\/27/);
    assert.match(t, /2 cijfers in 2 vakken, gemiddeld 7,5/);
    assert.match(t, /Beste vak: Engels \(9,0\)/);
    assert.match(t, /Hoogste cijfer: 9,0 voor Engels/);
    assert.match(t, /1 kaart geopend/);
    assert.match(t, /Level 3: Doorzetter/);
  });
});
