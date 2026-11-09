/**
 * Helpers for the school years ("aanmeldingen") from Magister, shared by the pages
 * that offer a school-year selector (Opdrachten, Afwezigheid).
 *
 * Note: the list only contains more than the current year when it is requested
 * *with* a date range (`getSchoolyears(pid, "2013-01-01", today)`); without one
 * Magister answers with the current enrolment only.
 */
import type { Schoolyear } from "./types.ts";

const dayOf = (iso: string) => (iso ?? "").slice(0, 10);

/** School years newest first. */
export function sortSchoolyears(years: ReadonlyArray<Schoolyear>): Schoolyear[] {
  return [...years].sort((a, b) => dayOf(b.begin).localeCompare(dayOf(a.begin)));
}

/** The school year that contains `now`, else the most recent one. */
export function currentSchoolyear(
  years: ReadonlyArray<Schoolyear>,
  now: Date = new Date(),
): Schoolyear | null {
  if (years.length === 0) return null;
  const today = now.toISOString().slice(0, 10);
  const sorted = sortSchoolyears(years);
  return (
    sorted.find((y) => dayOf(y.begin) <= today && today <= dayOf(y.einde)) ?? sorted[0]
  );
}

/** "2025/2026"-style label for a school year. */
export function schoolyearLabel(y: Schoolyear): string {
  const from = dayOf(y.begin).slice(0, 4);
  const to = dayOf(y.einde).slice(0, 4);
  const group = y.studie?.code || y.groep?.code || "";
  const years = from === to ? from : `${from}/${to}`;
  return group ? `${years} · ${group}` : years;
}
