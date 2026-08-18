export interface GradeCombination {
  id: string;
  name: string;
  subjectNames: string[];
}

const STORAGE_KEY = 'grade_combinations';

/** Load user-defined combinatiecijfer groups from localStorage. */
export function loadCombinations(): GradeCombination[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is GradeCombination =>
        !!c &&
        typeof c.id === 'string' &&
        typeof c.name === 'string' &&
        Array.isArray(c.subjectNames) &&
        c.subjectNames.every((s: unknown) => typeof s === 'string')
    );
  } catch {
    return [];
  }
}

/** Persist user-defined combinatiecijfer groups to localStorage. */
export function saveCombinations(list: GradeCombination[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export interface CombinationPart {
  name: string;
  avg: number;
}

export interface CombinationResult {
  avg: number;
  parts: CombinationPart[];
  missing: string[];
}

/** Combined grade: simple average of the participating subject averages (each counts once). */
export function calcCombinationAverage(
  subjects: { name: string; avg: number }[],
  combination: GradeCombination
): CombinationResult | null {
  const byName = new Map(subjects.map((s) => [s.name, s]));
  const parts: CombinationPart[] = [];
  const missing: string[] = [];
  for (const name of combination.subjectNames) {
    const s = byName.get(name);
    if (s && s.avg > 0) parts.push({ name, avg: s.avg });
    else missing.push(name);
  }
  if (parts.length === 0) return null;
  const avg = parts.reduce((a, p) => a + p.avg, 0) / parts.length;
  return { avg, parts, missing };
}