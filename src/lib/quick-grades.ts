/**
 * Maths behind the quick grade simulator on the home screen: "what if my next
 * test is a 7?". Deliberately simple — a weighted mean of the grades you can see —
 * and labelled as an estimate in the UI; the grades page stays the source of truth.
 *
 * Pure and free of `#lib` runtime imports so it can run in plain Node tests.
 */
import type { Grade } from "./types.ts";
import { parseGrade } from "./grades/scale.ts";
import { roundHalfUp } from "./grades/rounding.ts";
import type { IconName } from "./icons.ts";

export interface SubjectTotals {
  name: string;
  /** Sum of grade × weight. */
  points: number;
  /** Sum of weights. */
  weight: number;
  /** Number of grades. */
  count: number;
  /** null until there is at least one counting grade. */
  average: number | null;
}

/** A grade that counts in an average: a number in a real grade column. */
export function numericGrade(
  g: Grade,
): { value: number; weight: number } | null {
  if (g.CijferKolom?.KolomSoort !== 1) return null;
  if (g.Vrijstelling || g.TeltMee === false) return null;
  const parsed = parseGrade(g.CijferStr);
  if (parsed.kind !== "number" || parsed.value === null) return null;
  // Same rule as `effectiveWeight` on the grades page: an explicit weight wins
  // (0 means "does not count"), only a missing weight falls back to 1.
  const weight =
    typeof g.Weging === "number" && Number.isFinite(g.Weging)
      ? Math.max(0, g.Weging)
      : 1;
  return { value: parsed.value, weight };
}

/** Per-subject totals over `grades`, subjects alphabetical. Hidden grades must be filtered out by the caller. */
export function subjectTotals(grades: ReadonlyArray<Grade>): SubjectTotals[] {
  const map = new Map<string, SubjectTotals>();
  for (const g of grades) {
    const n = numericGrade(g);
    if (!n) continue;
    const name = (g.Vak?.Omschrijving ?? "").trim();
    if (!name) continue;
    const t = map.get(name) ?? {
      name,
      points: 0,
      weight: 0,
      count: 0,
      average: null,
    };
    t.points += n.value * n.weight;
    t.weight += n.weight;
    t.count += 1;
    map.set(name, t);
  }
  for (const t of map.values())
    t.average = t.weight > 0 ? t.points / t.weight : null;
  return [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "nl", { sensitivity: "base" }),
  );
}

/** The subject's average after one more grade. */
export function averageWith(
  t: SubjectTotals,
  grade: number,
  weight: number,
): number {
  const w = t.weight + weight;
  return w > 0 ? (t.points + grade * weight) / w : grade;
}

export type Needed =
  /** `value` on the next test gets you there. */
  | { kind: "grade"; value: number }
  /** Already at/above the target, even with a 1.0 next time. */
  | { kind: "safe" }
  /** Even a 10 is not enough. */
  | { kind: "impossible" };

/** The grade needed on the next test (given its weight) to reach `target` as the average. */
export function neededGrade(
  t: SubjectTotals,
  target: number,
  weight: number,
): Needed {
  if (weight <= 0) return { kind: "impossible" };
  const required = (target * (t.weight + weight) - t.points) / weight;
  if (required <= 1) return { kind: "safe" };
  if (required > 10) return { kind: "impossible" };
  return { kind: "grade", value: required };
}

/** Round the way the grade pages do (half up). */
export function oneDecimal(v: number, decimals = 1): number {
  return roundHalfUp(v, decimals);
}

export interface Reaction {
  icon: IconName;
  text: string;
}

/**
 * A short, kind reaction to the simulated average. Never negative: a low number
 * is an opportunity, not a failure — this is a "what if", not a verdict.
 */
export function reactionFor(
  next: number,
  current: number | null,
  threshold: number,
): Reaction {
  if (current !== null && next - current >= 0.5)
    return { icon: "rocket", text: "Grote stap omhoog!" };
  if (next >= 8) return { icon: "flame", text: "Topgemiddelde!" };
  if (next >= 7) return { icon: "smile", text: "Sterk bezig." };
  if (next >= threshold)
    return { icon: "thumbs-up", text: "Je staat voldoende." };
  if (current !== null && next > current)
    return { icon: "trend-up", text: "Je komt dichterbij." };
  return { icon: "zap", text: "Hier valt nog winst te halen." };
}
