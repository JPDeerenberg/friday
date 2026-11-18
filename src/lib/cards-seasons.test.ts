import test from "node:test";
import assert from "node:assert";
import {
  seasonOf,
  seasonLabel,
  seasonXp,
  seasonsOf,
  careerInfo,
  levelInfo,
  type CardData,
} from "./cards.ts";

const NOW = new Date(2026, 10, 9); // 9 Nov 2026 -> season 2026-2027

function card(id: number, date: string | null, xp: number): CardData {
  return {
    id,
    subject: "Wiskunde",
    title: "t",
    value: "7",
    valueNum: 7,
    passed: true,
    rarity: "gewoon",
    shiny: false,
    mode: "tear",
    seed: id,
    hue: 0,
    icon: "books",
    weight: 1,
    date,
    stamps: [],
    xp,
  };
}

test("a school year runs from August to July", () => {
  assert.equal(seasonOf("2026-08-01T00:00:00", NOW), "2026-2027");
  assert.equal(seasonOf("2026-07-31T23:00:00", NOW), "2025-2026");
  assert.equal(seasonOf("2027-01-15", NOW), "2026-2027");
  assert.equal(seasonOf("2025-09-30T10:00:00.0000000Z", NOW), "2025-2026");
  assert.equal(seasonOf("2026-12-31", NOW), "2026-2027");
  assert.equal(seasonOf("2027-07-01", NOW), "2026-2027");
});

test("missing or invalid dates count as today's season", () => {
  assert.equal(seasonOf(null, NOW), "2026-2027");
  assert.equal(seasonOf(undefined, NOW), "2026-2027");
  assert.equal(seasonOf("kapot", NOW), "2026-2027");
  assert.equal(seasonOf("", new Date(2027, 2, 1)), "2026-2027");
});

test("season label", () => {
  assert.equal(seasonLabel("2025-2026"), "2025/26");
  assert.equal(seasonLabel("raar"), "raar");
});

test("season XP counts only opened cards of that season", () => {
  const cards = [
    card(1, "2025-10-01", 10), // last season
    card(2, "2025-11-01", 25), // last season
    card(3, "2026-09-10", 15), // this season
    card(4, "2026-10-10", 40), // this season, still face-down
    card(5, null, 20), // no date -> this season
  ];
  const opened = new Set([1, 2, 3, 5]);
  assert.equal(seasonXp(cards, opened, "2026-2027", NOW), 35);
  assert.equal(seasonXp(cards, opened, "2025-2026", NOW), 35);
  assert.equal(seasonXp(cards, new Set(), "2026-2027", NOW), 0);
});

test("a student with an extra year does not start ahead", () => {
  // Same grades this season; one student also has a big last season.
  const thisSeason = [card(1, "2026-09-01", 100), card(2, "2026-10-01", 100)];
  const veteran = [...thisSeason, card(3, "2025-10-01", 3000)];
  const open = new Set([1, 2, 3]);
  const a = levelInfo(seasonXp(thisSeason, open, "2026-2027", NOW));
  const b = levelInfo(seasonXp(veteran, open, "2026-2027", NOW));
  assert.equal(a.level, b.level);
});

test("seasons are listed newest first and always include the current one", () => {
  assert.deepEqual(seasonsOf([], NOW), ["2026-2027"]);
  const list = seasonsOf([card(1, "2024-09-01", 1), card(2, "2025-09-01", 1)], NOW);
  assert.deepEqual(list, ["2026-2027", "2025-2026", "2024-2025"]);
});

test("career rank climbs with all-time XP and tops out", () => {
  assert.equal(careerInfo(0).rank, "Nieuweling");
  assert.equal(careerInfo(999).rank, "Nieuweling");
  assert.equal(careerInfo(1000).rank, "Brons");
  assert.equal(careerInfo(1000).nextAt, 3000);
  assert.equal(careerInfo(2000).pct, 0.5);
  assert.equal(careerInfo(25000).rank, "Legende");
  assert.equal(careerInfo(25000).nextAt, null);
  assert.equal(careerInfo(999999).pct, 1);
  assert.equal(careerInfo(-5).xp, 0);
});
