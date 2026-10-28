/**
 * Grade reveal ("cijfer onthullen").
 *
 * When the setting `gradeReveal` is on, a grade that arrives *after* the
 * feature was first used on this device stays hidden until the user opens it
 * (with a short animation). The real grade never changes; it is only held back
 * from the UI.
 *
 * Which grades count as "new"?
 *  - `since` is a timestamp set the first time this module runs on a device
 *    (and again whenever the user switches the feature back on). Only grades
 *    entered after `since` can be hidden, so existing grades — and the grades of
 *    earlier school years — are never hidden on update.
 *  - `opened` holds the ids of grades the user has already revealed.
 *
 * Hidden grades are filtered out of the data (see `splitGrades`) before any
 * averages, charts or lists are built, so nothing can leak the value early.
 *
 * State is per device (localStorage). Keep this module free of `$lib` runtime
 * imports so it stays importable from plain Node tests.
 */
import { writable, get } from "svelte/store";
import type { Grade } from "$lib/types";

const STORAGE_KEY = "friday_grade_reveal";
/** Cap so the opened-list can't grow forever; oldest ids drop off first. */
const MAX_OPENED = 2000;

export interface GradeRevealState {
  /** ms timestamp; only grades entered after this can be hidden. */
  since: number;
  /** CijferId of grades the user already opened. */
  opened: number[];
}

/** What the reveal overlay needs to know about one grade. */
export interface RevealItem {
  id: number;
  subject: string;
  title: string;
  value: string;
  passed: boolean;
  weight: number | null;
}

function hasStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

export function loadGradeRevealState(): GradeRevealState {
  if (hasStorage()) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed?.since === "number" &&
          Number.isFinite(parsed.since) &&
          Array.isArray(parsed.opened)
        ) {
          return {
            since: parsed.since,
            opened: parsed.opened.filter(
              (n: unknown) => typeof n === "number" && Number.isFinite(n),
            ),
          };
        }
      }
    } catch {
      /* corrupt value: fall through to a fresh state */
    }
  }
  // First run on this device: everything that exists right now counts as seen.
  return { since: Date.now(), opened: [] };
}

export const gradeRevealState = writable<GradeRevealState>(
  loadGradeRevealState(),
);

// Persist every change (this also writes the initial state on first run).
gradeRevealState.subscribe((value) => {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage full / blocked: the feature simply won't remember */
  }
});

function isHiddenGrade(
  grade: Grade,
  since: number,
  opened: ReadonlySet<number>,
): boolean {
  if (!grade.CijferStr) return false;
  // Only real grade columns; average/period columns are never held back.
  if (grade.CijferKolom?.KolomSoort !== 1) return false;
  if (opened.has(grade.CijferId)) return false;
  if (!grade.DatumIngevoerd) return false;
  const entered = Date.parse(grade.DatumIngevoerd);
  if (!Number.isFinite(entered)) return false;
  return entered > since;
}

/** True when this grade should currently be held back. */
export function isGradeHidden(
  grade: Grade,
  enabled: boolean,
  state: GradeRevealState,
): boolean {
  if (!enabled) return false;
  return isHiddenGrade(grade, state.since, new Set(state.opened));
}

/**
 * Split grades into the ones to show and the ones still to be revealed.
 * `hidden` is sorted oldest → newest so they are opened in the order they came.
 */
export function splitGrades(
  grades: Grade[],
  enabled: boolean,
  state: GradeRevealState,
): { visible: Grade[]; hidden: Grade[] } {
  if (!enabled) return { visible: grades, hidden: [] };
  const opened = new Set(state.opened);
  const visible: Grade[] = [];
  const hidden: Grade[] = [];
  for (const grade of grades) {
    (isHiddenGrade(grade, state.since, opened) ? hidden : visible).push(grade);
  }
  hidden.sort((a, b) =>
    (a.DatumIngevoerd ?? "").localeCompare(b.DatumIngevoerd ?? ""),
  );
  return { visible, hidden };
}

export function markGradesOpened(ids: number[]): void {
  if (ids.length === 0) return;
  gradeRevealState.update((state) => {
    const merged = [...new Set([...state.opened, ...ids])];
    return {
      ...state,
      opened: merged.length > MAX_OPENED ? merged.slice(-MAX_OPENED) : merged,
    };
  });
}

export function markGradeOpened(id: number): void {
  markGradesOpened([id]);
}

/**
 * Start fresh: everything that exists right now counts as seen. Called when the
 * user switches the feature back on, so grades that arrived while it was off
 * don't suddenly disappear.
 */
export function resetGradeRevealBaseline(): void {
  gradeRevealState.set({ since: Date.now(), opened: [] });
}

export function toRevealItem(grade: Grade, passed: boolean): RevealItem {
  return {
    id: grade.CijferId,
    subject: grade.Vak?.Omschrijving ?? "Onbekend vak",
    title:
      grade.CijferKolom?.KolomOmschrijving ??
      grade.CijferKolom?.KolomNaam ??
      "Cijfer",
    value: grade.CijferStr ?? "",
    passed,
    weight: grade.Weging ?? null,
  };
}

/** Snapshot of the current state (handy for non-component callers). */
export function getGradeRevealState(): GradeRevealState {
  return get(gradeRevealState);
}
