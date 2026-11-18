/**
 * "Minpunten" at a glance — worded to help, not to scare.
 *
 * Built on the compensation maths (a 5 costs a point, a 7 earns one, rules are
 * editable per school). The chip names what is easy to fix: it says how close each
 * subject is to a sufficient grade and points at the subject where a little effort
 * pays off most. It never uses alarm wording or red.
 */
import type { CompensationResult } from "./compensation.ts";

export interface MinpuntenSubject {
  name: string;
  average: number;
  /** Points this subject costs (always > 0 here: a subject without minpunten is not listed). */
  minpunten: number;
  /** How much the average must rise to round up to a sufficient grade (0 = already there). */
  gap: number;
}

export interface MinpuntenSummary {
  minpunten: number;
  pluspunten: number;
  balance: number;
  subjects: MinpuntenSubject[];
  /** Subjects within 0.3 of a sufficient grade. */
  closeCount: number;
}

/** The average at which a whole grade rounds (half up) to `passGrade`. */
function roundsUpAt(passGrade: number): number {
  return passGrade - 0.5;
}

export function summarizeMinpunten(
  result: CompensationResult,
  passGrade: number,
): MinpuntenSummary {
  let minpunten = 0;
  let pluspunten = 0;
  const subjects: MinpuntenSubject[] = [];
  for (const row of result.rows) {
    if (row.points < 0) {
      minpunten += -row.points;
      subjects.push({
        name: row.name,
        average: row.average,
        minpunten: -row.points,
        gap: Math.max(0, roundsUpAt(passGrade) - row.average),
      });
    } else {
      pluspunten += row.points;
    }
  }
  // Easiest to fix first.
  subjects.sort((a, b) => a.gap - b.gap || a.name.localeCompare(b.name, "nl", { sensitivity: "base" }));
  return {
    minpunten,
    pluspunten,
    balance: pluspunten - minpunten,
    subjects,
    closeCount: subjects.filter((s) => s.gap <= 0.3).length,
  };
}

export type MinpuntenTone = "great" | "calm";

export interface MinpuntenText {
  tone: MinpuntenTone;
  headline: string;
  hint: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeMinpunten(s: MinpuntenSummary): MinpuntenText {
  if (s.minpunten === 0) {
    return { tone: "great", headline: "Geen minpunten", hint: "Mooi bezig, hou dit vast!" };
  }
  const headline = plural(s.minpunten, "minpunt", "minpunten");
  const best = s.subjects[0];
  if (best && best.gap <= 0.3) {
    return {
      tone: "calm",
      headline,
      hint:
        s.closeCount > 1
          ? `${plural(s.closeCount, "vak", "vakken")} ${s.closeCount === 1 ? "ligt" : "liggen"} bijna op een voldoende.`
          : `${best.name} ligt bijna op een voldoende.`,
    };
  }
  return {
    tone: "calm",
    headline,
    hint: best ? `Met ${best.name} haal je het snelst winst.` : "Elke toets is een kans om te stijgen.",
  };
}
