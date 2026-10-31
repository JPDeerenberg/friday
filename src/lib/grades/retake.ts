/**
 * Retake (herkansing) rules.
 *
 * Schools handle retakes differently, so the default `magister` follows exactly
 * what Magister sends (weights included) and nothing changes. The other rules
 * pair a retake column with its original by name ("Toets H3" / "Herkansing
 * Toets H3") within one subject and then:
 *   best    keep the higher of the two
 *   replace the retake replaces the original, even when lower
 *   ignore  retakes do not count at all
 * Retakes that cannot be paired to an original stay untouched.
 */
import { parseGrade, effectiveWeight, type LetterRule } from './scale.ts';

export type RetakeRule = 'magister' | 'best' | 'replace' | 'ignore';

export const RETAKE_RULES: RetakeRule[] = ['magister', 'best', 'replace', 'ignore'];

interface RetakeGrade {
  CijferStr?: string | null;
  Weging?: number | null;
  DatumIngevoerd?: string | null;
  CijferKolom?: {
    KolomNaam?: string | null;
    KolomKop?: string | null;
    KolomOmschrijving?: string | null;
    IsHerkansingKolom?: boolean | null;
  } | null;
}

const RETAKE_WORDS = /\b(herkansing(?:en)?|herkansen|herkans|herk|her|hk|herex(?:amen)?)\b\.?/gi;

/** Column label without the "herkansing" noise, for pairing. */
export function baseColumnLabel(g: RetakeGrade): string {
  const k = g.CijferKolom;
  const raw = (k?.KolomOmschrijving || k?.KolomNaam || k?.KolomKop || '').toString();
  return raw
    .replace(RETAKE_WORDS, ' ')
    .replace(/[()\[\]:\-_/.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isRetake(g: RetakeGrade): boolean {
  return g.CijferKolom?.IsHerkansingKolom === true;
}

/**
 * Returns the grades that should feed calculations. The input list is not
 * mutated; replaced grades are cloned with a merged weight where needed.
 */
export function applyRetakeRule<T extends RetakeGrade>(
  grades: readonly T[],
  rule: RetakeRule,
  letters: readonly LetterRule[] = [],
): T[] {
  if (rule === 'magister') return [...grades];
  if (rule === 'ignore') return grades.filter((g) => !isRetake(g));

  const originals = grades.filter((g) => !isRetake(g));
  const out = new Set<T>(grades);
  const replacements = new Map<T, T>();

  for (const retake of grades.filter(isRetake)) {
    const label = baseColumnLabel(retake);
    if (!label) continue;
    const candidates = originals
      .filter((o) => baseColumnLabel(o) === label)
      // nearest original that was entered before the retake (or the only one)
      .sort((a, b) => (b.DatumIngevoerd ?? '').localeCompare(a.DatumIngevoerd ?? ''));
    const original =
      candidates.find((o) => (o.DatumIngevoerd ?? '') <= (retake.DatumIngevoerd ?? '~')) ?? candidates[0];
    if (!original || !out.has(original)) continue;

    const pr = parseGrade(retake.CijferStr, letters);
    const po = parseGrade(original.CijferStr, letters);
    if (pr.value === null || po.value === null) continue;

    const weight = Math.max(effectiveWeight(original, po), effectiveWeight(retake, pr));
    let keep: T;
    let drop: T;
    if (rule === 'replace') {
      keep = retake;
      drop = original;
    } else {
      // best: ties keep the original
      keep = pr.value > po.value ? retake : original;
      drop = keep === retake ? original : retake;
    }
    out.delete(drop);
    out.delete(keep);
    const merged = { ...keep, Weging: weight } as T;
    replacements.set(keep, merged);
    out.add(merged);
  }

  // keep input order
  const result: T[] = [];
  for (const g of grades) {
    if (out.has(g)) result.push(g);
    else if (replacements.has(g) && out.has(replacements.get(g)!)) result.push(replacements.get(g)!);
  }
  return result;
}
