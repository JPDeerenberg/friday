import type { Grade, GradePeriod } from '$lib/types';

/** Distinct grading periods across all grades, ordered by VolgNummer. */
export function getPeriods(grades: Grade[]): GradePeriod[] {
  const map = new Map<number, GradePeriod>();
  for (const g of grades) {
    if (g.CijferPeriode) map.set(g.CijferPeriode.Id, g.CijferPeriode);
  }
  return [...map.values()].sort((a, b) => a.VolgNummer - b.VolgNummer);
}

/** Grades that belong to a specific grading period. */
export function filterGradesByPeriod(grades: Grade[], periodId: number): Grade[] {
  return grades.filter((g) => g.CijferPeriode?.Id === periodId);
}

/** True when a grade is part of the official PTA/schoolexamen program. */
export function isPtaGrade(g: Grade): boolean {
  return !!g.CijferKolom?.IsPTAKolom;
}