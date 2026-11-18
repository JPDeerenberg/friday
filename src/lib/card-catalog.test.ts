import test from "node:test";
import assert from "node:assert";
import { filterAndSort, activeFilterCount, subjectsOf, DEFAULT_FILTERS, type CatalogFilters } from "./card-catalog.ts";
import type { CardData, Rarity, Stamp } from "./cards.ts";

const NOW = new Date(2026, 10, 9);

function card(id: number, over: Partial<CardData> = {}): CardData {
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
    date: "2026-10-01",
    stamps: [],
    xp: 10,
    ...over,
  };
}
const f = (over: Partial<CatalogFilters> = {}): CatalogFilters => ({ ...DEFAULT_FILTERS, ...over });
const ids = (l: CardData[]) => l.map((c) => c.id);

const CARDS = [
  card(1, { subject: "Wiskunde", rarity: "gewoon", valueNum: 6, date: "2026-09-10" }),
  card(2, { subject: "Engels", rarity: "episch", valueNum: 9, date: "2026-10-05", stamps: ["boss"] as Stamp[] }),
  card(3, { subject: "Engels", rarity: "zeldzaam", valueNum: 8, date: "2026-10-20", shiny: true }),
  card(4, { subject: "Frans", rarity: "mythisch" as Rarity, valueNum: 10, date: "2026-10-25" }), // face-down
  card(5, { subject: "Wiskunde", rarity: "gewoon", valueNum: 5, date: "2025-11-01" }), // last season
];
const OPENED = new Set([1, 2, 3, 5]);

test("default view: everything, newest first", () => {
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f(), NOW)), [4, 3, 2, 1, 5]);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ sort: "oldest" }), NOW)), [5, 1, 2, 3, 4]);
});

test("subject, season and status filters apply to every card", () => {
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ subject: "Engels" }), NOW)), [3, 2]);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ season: "2025-2026" }), NOW)), [5]);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ status: "hidden" }), NOW)), [4]);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ status: "opened" }), NOW)), [3, 2, 1, 5]);
});

test("rarity, shiny and stamp filters never match a face-down card", () => {
  // Card 4 is mythisch, but face-down: filtering on it must not reveal that.
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ rarities: ["mythisch"] }), NOW)), []);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ rarities: ["gewoon", "episch"] }), NOW)), [2, 1, 5]);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ shinyOnly: true }), NOW)), [3]);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ stamp: "boss" }), NOW)), [2]);
  // ...and once it is opened, it does match.
  const all = new Set([1, 2, 3, 4, 5]);
  assert.deepEqual(ids(filterAndSort(CARDS, all, f({ rarities: ["mythisch"] }), NOW)), [4]);
});

test("filters combine", () => {
  const r = filterAndSort(CARDS, OPENED, f({ subject: "Engels", rarities: ["episch"], stamp: "boss" }), NOW);
  assert.deepEqual(ids(r), [2]);
});

test("sorting by rarity or value puts face-down cards last and leaks nothing", () => {
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ sort: "rarity" }), NOW)), [2, 3, 1, 5, 4]);
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ sort: "value" }), NOW)), [2, 3, 1, 5, 4]);
  // Two face-down cards keep a date order that does not depend on their value.
  const two = [card(7, { rarity: "mythisch", date: "2026-10-01" }), card(8, { rarity: "gewoon", date: "2026-10-02" })];
  assert.deepEqual(ids(filterAndSort(two, new Set(), f({ sort: "rarity" }), NOW)), [8, 7]);
  assert.deepEqual(ids(filterAndSort(two, new Set(), f({ sort: "value" }), NOW)), [8, 7]);
});

test("sorting by subject is alphabetical, newest first within a subject", () => {
  assert.deepEqual(ids(filterAndSort(CARDS, OPENED, f({ sort: "subject" }), NOW)), [3, 2, 4, 1, 5]);
});

test("does not mutate its input", () => {
  const copy = [...CARDS];
  filterAndSort(CARDS, OPENED, f({ sort: "rarity" }), NOW);
  assert.deepEqual(CARDS, copy);
});

test("counts active filters and lists subjects", () => {
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
  assert.equal(
    activeFilterCount(f({ rarities: ["gewoon"], subject: "x", season: "y", status: "opened", shinyOnly: true, stamp: "pb", sort: "value" })),
    6,
  );
  assert.deepEqual(subjectsOf(CARDS), ["Engels", "Frans", "Wiskunde"]);
});
