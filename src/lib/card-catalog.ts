/**
 * The complete card list ("Alle kaarten"): filters and sorting.
 *
 * Face-down cards are still hidden grades, so nothing here may reveal what is on
 * them. Rarity, shininess, stamps and the grade itself are all derived from the
 * grade — so filters and sort orders on those only ever match *opened* cards, and
 * a face-down card sorts after the opened ones. Subject, school year and date are
 * already visible on a face-down tile, so those filters apply to every card.
 *
 * Pure and free of `#lib` runtime imports so it runs in plain Node tests.
 */
import { RARITY_META, seasonOf, type CardData, type Rarity, type Stamp } from "./cards.ts";

export type CatalogStatus = "all" | "opened" | "hidden";
export type CatalogSort = "newest" | "oldest" | "rarity" | "value" | "subject";

export interface CatalogFilters {
  rarities: Rarity[];
  subject: string | null;
  /** "2025-2026", or null for every school year. */
  season: string | null;
  status: CatalogStatus;
  shinyOnly: boolean;
  stamp: Stamp | null;
  sort: CatalogSort;
}

export const DEFAULT_FILTERS: CatalogFilters = {
  rarities: [],
  subject: null,
  season: null,
  status: "all",
  shinyOnly: false,
  stamp: null,
  sort: "newest",
};

/** How many filters are switched on (the sort order does not count). */
export function activeFilterCount(f: CatalogFilters): number {
  return (
    (f.rarities.length > 0 ? 1 : 0) +
    (f.subject ? 1 : 0) +
    (f.season ? 1 : 0) +
    (f.status !== "all" ? 1 : 0) +
    (f.shinyOnly ? 1 : 0) +
    (f.stamp ? 1 : 0)
  );
}

const byDate = (a: CardData, b: CardData) => (a.date ?? "").localeCompare(b.date ?? "");

export function filterAndSort(
  cards: ReadonlyArray<CardData>,
  opened: ReadonlySet<number>,
  f: CatalogFilters,
  now: Date = new Date(),
): CardData[] {
  const out = cards.filter((c) => {
    const isOpen = opened.has(c.id);
    if (f.status === "opened" && !isOpen) return false;
    if (f.status === "hidden" && isOpen) return false;
    if (f.subject && c.subject !== f.subject) return false;
    if (f.season && seasonOf(c.date, now) !== f.season) return false;
    // Everything below is derived from the grade: face-down cards never match.
    if (f.rarities.length > 0 && !(isOpen && f.rarities.includes(c.rarity))) return false;
    if (f.shinyOnly && !(isOpen && c.shiny)) return false;
    if (f.stamp && !(isOpen && c.stamps.includes(f.stamp))) return false;
    return true;
  });

  const rank = (c: CardData) => (opened.has(c.id) ? 0 : 1);
  switch (f.sort) {
    case "oldest":
      return out.sort(byDate);
    case "subject":
      return out.sort(
        (a, b) => a.subject.localeCompare(b.subject, "nl", { sensitivity: "base" }) || byDate(b, a),
      );
    case "rarity":
      return out.sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (rank(a) === 0 ? RARITY_META[b.rarity].tier - RARITY_META[a.rarity].tier : 0) ||
          byDate(b, a),
      );
    case "value":
      return out.sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (rank(a) === 0 ? (b.valueNum ?? -1) - (a.valueNum ?? -1) : 0) ||
          byDate(b, a),
      );
    default:
      return out.sort((a, b) => byDate(b, a));
  }
}

/** Distinct subjects, alphabetical. */
export function subjectsOf(cards: ReadonlyArray<CardData>): string[] {
  return [...new Set(cards.map((c) => c.subject))].sort((a, b) =>
    a.localeCompare(b, "nl", { sensitivity: "base" }),
  );
}
