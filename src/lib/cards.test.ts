import test from "node:test";
import assert from "node:assert";
import {
  ACHIEVEMENTS,
  artShapes,
  buildCards,
  cardXp,
  compareForPack,
  countCompleteSets,
  earnedAchievementIds,
  emptyTally,
  hash32,
  isShiny,
  levelInfo,
  openModeFor,
  parseGradeNumber,
  rarityOf,
  subjectTheme,
  tallyAfterOpening,
  type CardData,
} from "./cards.ts";
import type { Grade } from "$lib/types";

function mkGrade(
  id: number,
  value: string,
  over: Partial<Grade> = {},
  subject = "Wiskunde",
  date = "2026-10-01T10:00:00",
): Grade {
  return {
    CijferId: id,
    CijferStr: value,
    IsVoldoende: true,
    DatumIngevoerd: date,
    Weging: 1,
    CijferKolom: {
      Id: 1,
      KolomNaam: "Toets",
      KolomOmschrijving: "Hoofdstuk",
      KolomSoort: 1,
    },
    Vak: { Id: 1, Afkorting: "wi", Omschrijving: subject, Volgnr: 1 },
    ...over,
  } as Grade;
}

test("parseGradeNumber handles comma decimals and letters", () => {
  assert.equal(parseGradeNumber("7,5"), 7.5);
  assert.equal(parseGradeNumber("10"), 10);
  assert.equal(parseGradeNumber("V"), null);
  assert.equal(parseGradeNumber(null), null);
});

test("rarity boundaries", () => {
  assert.equal(rarityOf(5.5, true), "gewoon");
  assert.equal(rarityOf(6.4, true), "gewoon");
  assert.equal(rarityOf(6.5, true), "zeldzaam");
  assert.equal(rarityOf(7.5, true), "episch");
  assert.equal(rarityOf(8.5, true), "legendarisch");
  assert.equal(rarityOf(9.5, true), "mythisch");
  assert.equal(rarityOf(10, true), "mythisch");
  assert.equal(rarityOf(4.2, false), "glitch");
  assert.equal(rarityOf(null, true), "speciaal");
  assert.equal(rarityOf(null, false), "glitch");
});

test("seeds are deterministic and spread over the three open modes", () => {
  assert.equal(hash32("a"), hash32("a"));
  assert.notEqual(hash32("a"), hash32("b"));
  assert.equal(openModeFor(42), openModeFor(42));
  const modes = new Set(Array.from({ length: 60 }, (_, i) => openModeFor(i)));
  assert.equal(modes.size, 3);
  const shinies = Array.from({ length: 800 }, (_, i) => isShiny(i)).filter(
    Boolean,
  ).length;
  assert.ok(
    shinies > 25 && shinies < 80,
    `shiny rate looks off: ${shinies}/800`,
  );
});

test("buildCards: rarity, passed and threshold", () => {
  const cards = buildCards(
    [mkGrade(1, "7,5"), mkGrade(2, "4,2"), mkGrade(3, "V")],
    { threshold: 5.5 },
  );
  assert.equal(cards.get(1)?.rarity, "episch");
  assert.equal(cards.get(2)?.rarity, "glitch");
  assert.equal(cards.get(2)?.passed, false);
  assert.equal(cards.get(3)?.rarity, "speciaal");
});

test("buildCards ignores average columns and empty values", () => {
  const avg = mkGrade(9, "7,0", {
    CijferKolom: {
      Id: 2,
      KolomNaam: "Gem",
      KolomSoort: 2,
    } as Grade["CijferKolom"],
  });
  const empty = mkGrade(10, "", {});
  assert.equal(buildCards([avg, empty], { threshold: 5.5 }).size, 0);
});

test("stamps: first, boss, clutch, record and comeback", () => {
  const grades = [
    mkGrade(1, "6,0", {}, "Wiskunde", "2026-09-01T10:00:00"),
    mkGrade(2, "5,5", {}, "Wiskunde", "2026-09-10T10:00:00"),
    mkGrade(3, "7,5", { Weging: 3 }, "Wiskunde", "2026-09-20T10:00:00"),
  ];
  const cards = buildCards(grades, { threshold: 5.5 });
  assert.deepEqual(cards.get(1)?.stamps, ["first"]);
  assert.deepEqual(cards.get(2)?.stamps, ["clutch"]);
  assert.deepEqual(cards.get(3)?.stamps, ["boss", "pb", "comeback"]);
});

test("pack order goes worst to best, best card last", () => {
  const cards = buildCards(
    [
      mkGrade(1, "9,8"),
      mkGrade(2, "6,0"),
      mkGrade(3, "8,0"),
      mkGrade(4, "4,0"),
    ],
    { threshold: 5.5 },
  );
  const sorted = [...cards.values()].sort(compareForPack).map((c) => c.id);
  assert.deepEqual(sorted, [2, 4, 3, 1]);
});

test("xp and levels", () => {
  assert.equal(cardXp("mythisch", false, 0), 150);
  assert.equal(cardXp("gewoon", true, 1), 25);
  assert.equal(levelInfo(0).level, 1);
  assert.equal(levelInfo(49).level, 1);
  assert.equal(levelInfo(50).level, 2);
  assert.equal(levelInfo(50).title, "Student");
  const far = levelInfo(1_000_000);
  assert.equal(far.title, "Mythisch Brein");
  assert.ok(far.pct >= 0 && far.pct <= 1);
});

test("tally, streaks and achievements", () => {
  let t = emptyTally();
  const card = (over: Partial<CardData>): CardData => ({
    id: 1,
    subject: "Wiskunde",
    title: "t",
    value: "7",
    valueNum: 7,
    passed: true,
    rarity: "zeldzaam",
    shiny: false,
    mode: "hold",
    seed: 1,
    hue: 200,
    emoji: "x",
    weight: 1,
    date: null,
    stamps: [],
    xp: 20,
    ...over,
  });
  t = tallyAfterOpening(t, card({ id: 1 }));
  t = tallyAfterOpening(t, card({ id: 2, subject: "Engels" }));
  t = tallyAfterOpening(t, card({ id: 3, passed: false, rarity: "glitch" }));
  assert.equal(t.total, 3);
  assert.equal(t.streak, 0);
  assert.equal(t.bestStreak, 2);
  assert.deepEqual(t.subjects, ["Wiskunde", "Engels"]);
  const ids = earnedAchievementIds(t, { completeSets: 0 });
  assert.ok(
    ids.includes("first-pull") &&
      ids.includes("rare") &&
      ids.includes("glitch"),
  );
  assert.ok(!ids.includes("epic") && !ids.includes("pack-5"));
  assert.equal(
    new Set(ACHIEVEMENTS.map((a) => a.id)).size,
    ACHIEVEMENTS.length,
  );
});

test("complete sets need 3+ cards, all opened", () => {
  const cards = [
    ...buildCards([mkGrade(1, "7"), mkGrade(2, "8"), mkGrade(3, "6")], {
      threshold: 5.5,
    }).values(),
  ];
  assert.equal(countCompleteSets(cards, new Set([1, 2])), 0);
  assert.equal(countCompleteSets(cards, new Set([1, 2, 3])), 1);
  assert.equal(countCompleteSets(cards.slice(0, 2), new Set([1, 2])), 0);
});

test("generated art is deterministic and grows with rarity", () => {
  assert.deepEqual(artShapes(123, "gewoon"), artShapes(123, "gewoon"));
  assert.notDeepEqual(artShapes(123, "gewoon"), artShapes(124, "gewoon"));
  assert.ok(artShapes(5, "mythisch").length > artShapes(5, "gewoon").length);
});

test("subject themes", () => {
  assert.equal(subjectTheme("Wiskunde B").emoji, "📐");
  assert.equal(subjectTheme("Natuurkunde").emoji, "⚛️");
  const unknown = subjectTheme("Iets geks");
  assert.equal(unknown.emoji, "📚");
  assert.equal(subjectTheme("Iets geks").hue, unknown.hue);
});
