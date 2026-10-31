/**
 * Compare the app's own weighted average with the average column the school
 * publishes in Magister (`KolomSoort === 2`). A difference usually means the
 * school rounds, weighs or excludes something differently, which is exactly
 * what you want to notice.
 */
import { parseNumeric } from './scale.ts';
import { roundHalfUp } from './rounding.ts';

interface AverageColumnGrade {
  CijferStr?: string | null;
  DatumIngevoerd?: string | null;
  CijferPeriode?: { Id: number } | null;
  CijferKolom?: { KolomSoort?: number; KolomNaam?: string | null; KolomKop?: string | null } | null;
}

export interface SchoolAverage {
  label: string;
  value: number;
  date: string;
  periodId: number | null;
}

/** Numeric average columns of one subject, newest first. */
export function schoolAverages(subjectGrades: readonly AverageColumnGrade[]): SchoolAverage[] {
  const out: SchoolAverage[] = [];
  for (const g of subjectGrades) {
    if (g.CijferKolom?.KolomSoort !== 2) continue;
    const value = parseNumeric(g.CijferStr);
    if (value === null) continue;
    out.push({
      label: (g.CijferKolom?.KolomNaam || g.CijferKolom?.KolomKop || 'Gemiddelde').toString(),
      value,
      date: g.DatumIngevoerd ?? '',
      periodId: g.CijferPeriode?.Id ?? null,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface Comparison {
  school: SchoolAverage;
  computed: number;
  /** computed - school, after rounding both to `decimals`. */
  diff: number;
  matches: boolean;
}

/**
 * Pick the school average for `periodId` (or the newest when no period is
 * selected) and compare. Both numbers are rounded to `decimals` first, so a
 * school's rounded "6,8" matches a computed 6.8 (or 6.77).
 */
export function compareWithSchool(
  averages: readonly SchoolAverage[],
  computed: number,
  decimals: number,
  periodId: number | null = null,
): Comparison | null {
  if (!Number.isFinite(computed) || computed <= 0) return null;
  const pick =
    periodId !== null ? averages.find((a) => a.periodId === periodId) : averages[0];
  if (!pick) return null;
  const c = roundHalfUp(computed, decimals);
  const s = roundHalfUp(pick.value, decimals);
  const diff = roundHalfUp(c - s, decimals + 1);
  return { school: pick, computed, diff, matches: Math.abs(c - s) < Math.pow(10, -decimals) / 2 };
}
