/**
 * The grades of the current school year, shared by the home-screen widgets (grade
 * simulator, level card) so opening the home screen costs one request, not one
 * per widget. Requests in flight are shared; results are cached for a few minutes.
 */
import { get } from "svelte/store";
import { personId } from "$lib/stores";
import { getGrades, getSchoolyears, formatDate } from "$lib/api";
import { cacheGet } from "$lib/cache";
import { currentSchoolyear } from "$lib/schoolyears";
import type { Grade } from "$lib/types";

const inflight = new Map<number, Promise<Grade[]>>();

export function loadCurrentYearGrades(pid: number = get(personId) as number): Promise<Grade[]> {
  const running = inflight.get(pid);
  if (running) return running;
  const p = (async () => {
    const today = formatDate(new Date());
    const years = await getSchoolyears(pid, "2013-01-01", today);
    const year = currentSchoolyear(years);
    if (!year?.id) return [];
    return cacheGet(
      `year_grades_${pid}_${year.id}`,
      () => getGrades(pid, year.id as number, year.einde),
      5 * 60 * 1000,
    );
  })().finally(() => inflight.delete(pid));
  inflight.set(pid, p);
  return p;
}
