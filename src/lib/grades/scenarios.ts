/**
 * "What can still happen" maths: the range an average can end up in, how many
 * tests of a given grade it takes to reach a target, and which subjects are the
 * cheapest to rescue.
 */

export interface PointsWeight {
  totalPoints: number;
  totalWeight: number;
}

export interface Range {
  current: number | null;
  worst: number;
  best: number;
  /** Total weight after the remaining tests. */
  weightAfter: number;
}

/**
 * Lowest and highest average still reachable when `remainingWeight` worth of
 * tests is still to come and every one of them scores between `min` and `max`.
 */
export function bestWorstCase(
  s: PointsWeight,
  remainingWeight: number,
  min = 1,
  max = 10,
): Range | null {
  const rem = Math.max(0, remainingWeight);
  const weightAfter = s.totalWeight + rem;
  if (weightAfter <= 0) return null;
  return {
    current: s.totalWeight > 0 ? s.totalPoints / s.totalWeight : null,
    worst: (s.totalPoints + min * rem) / weightAfter,
    best: (s.totalPoints + max * rem) / weightAfter,
    weightAfter,
  };
}

/**
 * How many tests (each of `weight`) scoring `grade` bring the average to
 * `target`? 0 = already there, null = can never get there with that grade
 * (grade at or below the target while the average is below it).
 */
export function testsNeeded(
  s: PointsWeight,
  target: number,
  grade: number,
  weight = 1,
  cap = 99,
): number | null {
  if (weight <= 0) return null;
  const current = s.totalWeight > 0 ? s.totalPoints / s.totalWeight : null;
  if (current !== null && current >= target) return 0;
  if (grade <= target) return null;
  // (P + n*w*g) / (W + n*w) >= target  <=>  n >= (target*W - P) / (w*(g - target))
  const n = Math.ceil((target * s.totalWeight - s.totalPoints) / (weight * (grade - target)) - 1e-9);
  return n > cap ? null : Math.max(1, n);
}

export interface EffortRow {
  name: string;
  current: number;
  /** Grade the next test must be to reach the limit. */
  required: number;
  /** false when even a 10 (max) is not enough. */
  feasible: boolean;
}

/**
 * Subjects currently under `limit`, easiest rescue first: the lower the grade
 * the next test of weight `nextWeight` has to be, the cheaper the subject.
 */
export function effortToPass(
  subjects: readonly (PointsWeight & { name: string })[],
  limit: number,
  nextWeight = 1,
  max = 10,
): EffortRow[] {
  const rows: EffortRow[] = [];
  for (const s of subjects) {
    if (s.totalWeight <= 0 || nextWeight <= 0) continue;
    const current = s.totalPoints / s.totalWeight;
    if (current >= limit) continue;
    const required = (limit * (s.totalWeight + nextWeight) - s.totalPoints) / nextWeight;
    rows.push({ name: s.name, current, required, feasible: required <= max + 1e-9 });
  }
  return rows.sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.required - b.required);
}
