/**
 * Grade reveal + card collection state.
 *
 * With the setting `gradeReveal` on, EVERY grade is hidden until the user opens
 * it (as a card, see cards.ts). Opened-state lives on this device only
 * (localStorage), so a fresh device starts with everything hidden.
 *
 * "Peek" mode (`gradePeek`) shows all grades without marking anything as opened,
 * for when you actually need to check or calculate. It is deliberately
 * session-only: restart the app and everything is hidden again.
 *
 * Hidden grades are filtered out of the data (see `splitGrades`) before averages,
 * charts or lists are built, so nothing can leak a value early.
 *
 * Keep this module free of `$lib` runtime imports so it stays importable from
 * plain Node tests.
 */
import { writable, get } from "svelte/store";
import type { Grade } from "$lib/types";
import {
  emptyTally,
  tallyAfterOpening,
  earnedAchievementIds,
  type AchievementContext,
  type CardData,
  type Tally,
} from "./cards.ts";

const STORAGE_KEY = "friday_grade_reveal_v2";
/** v1 stored `{ since, opened }`; we only carry the opened ids over. */
const LEGACY_KEY = "friday_grade_reveal";
const MAX_OPENED = 5000;
const MAX_SHOWCASE = 3;

export interface GradeRevealState {
  /** CijferId of every grade the user has opened. */
  opened: number[];
  /** Achievement id → unlock timestamp. */
  unlocked: Record<string, number>;
  /** Up to 3 favourite card ids pinned in the album. */
  showcase: number[];
  tally: Tally;
}

function hasStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function isNumberArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export function loadGradeRevealState(): GradeRevealState {
  const fresh = (): GradeRevealState => ({
    opened: [],
    unlocked: {},
    showcase: [],
    tally: emptyTally(),
  });
  if (!hasStorage()) return fresh();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (isNumberArray(p?.opened)) {
        const base = emptyTally();
        return {
          opened: p.opened,
          unlocked:
            p.unlocked && typeof p.unlocked === "object" ? p.unlocked : {},
          showcase: isNumberArray(p.showcase)
            ? p.showcase.slice(0, MAX_SHOWCASE)
            : [],
          tally: {
            ...base,
            ...(p.tally ?? {}),
            byRarity: { ...base.byRarity, ...(p.tally?.byRarity ?? {}) },
          },
        };
      }
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const p = JSON.parse(legacy);
      if (isNumberArray(p?.opened)) return { ...fresh(), opened: p.opened };
    }
  } catch {
    /* corrupt value: start fresh */
  }
  return fresh();
}

export const gradeRevealState = writable<GradeRevealState>(
  loadGradeRevealState(),
);

gradeRevealState.subscribe((value) => {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage full / blocked: the collection simply won't be remembered */
  }
});

/** Session-only: show everything without opening it. */
export const gradePeek = writable(false);

/** Set by the dashboard; the grades page opens a pack when it sees this. */
export const openPackIntent = writable(false);

// ---------------------------------------------------------------- hiding

function isHiddenGrade(grade: Grade, opened: ReadonlySet<number>): boolean {
  if (!grade.CijferStr) return false;
  // Only real grade columns; average/period columns are never held back.
  if (grade.CijferKolom?.KolomSoort !== 1) return false;
  return !opened.has(grade.CijferId);
}

/** True when this grade should currently be held back. */
export function isGradeHidden(
  grade: Grade,
  enabled: boolean,
  state: Pick<GradeRevealState, "opened">,
  peek = false,
): boolean {
  if (!enabled || peek) return false;
  return isHiddenGrade(grade, new Set(state.opened));
}

/**
 * Split grades into the ones to show and the ones still hidden. `hidden` is
 * sorted newest → oldest, so the newest grades go into the first pack.
 */
export function splitGrades(
  grades: Grade[],
  enabled: boolean,
  state: Pick<GradeRevealState, "opened">,
  peek = false,
): { visible: Grade[]; hidden: Grade[] } {
  if (!enabled || peek) return { visible: grades, hidden: [] };
  const opened = new Set(state.opened);
  const visible: Grade[] = [];
  const hidden: Grade[] = [];
  for (const grade of grades) {
    (isHiddenGrade(grade, opened) ? hidden : visible).push(grade);
  }
  hidden.sort((a, b) =>
    (b.DatumIngevoerd ?? "").localeCompare(a.DatumIngevoerd ?? ""),
  );
  return { visible, hidden };
}

// ---------------------------------------------------------------- collection

/**
 * Mark a card as opened: updates the opened list, XP/streak tally and any newly
 * earned achievements in one step. Idempotent per card id.
 * Returns the ids of achievements unlocked by this card.
 */
export function recordOpen(
  card: CardData,
  ctx: AchievementContext = { completeSets: 0 },
): { newlyUnlocked: string[] } {
  let newlyUnlocked: string[] = [];
  gradeRevealState.update((state) => {
    if (state.opened.includes(card.id)) return state;
    const tally = tallyAfterOpening(state.tally, card);
    const opened = [...state.opened, card.id];
    const earned = earnedAchievementIds(tally, ctx).filter(
      (id) => !(id in state.unlocked),
    );
    newlyUnlocked = earned;
    const now = Date.now();
    const unlocked = { ...state.unlocked };
    for (const id of earned) unlocked[id] = now;
    return {
      ...state,
      opened: opened.length > MAX_OPENED ? opened.slice(-MAX_OPENED) : opened,
      tally,
      unlocked,
    };
  });
  return { newlyUnlocked };
}

/** Pin / unpin a card in the showcase (max 3, oldest pin drops off first). */
export function toggleShowcase(id: number): void {
  gradeRevealState.update((state) => {
    if (state.showcase.includes(id)) {
      return { ...state, showcase: state.showcase.filter((x) => x !== id) };
    }
    return { ...state, showcase: [...state.showcase, id].slice(-MAX_SHOWCASE) };
  });
}

/** Forget everything: all grades are hidden again and the collection is empty. */
export function resetCollection(): void {
  gradeRevealState.set({
    opened: [],
    unlocked: {},
    showcase: [],
    tally: emptyTally(),
  });
}

export function getGradeRevealState(): GradeRevealState {
  return get(gradeRevealState);
}
