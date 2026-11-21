/**
 * The grades of the current school year, shared by the home-screen widgets (grade
 * simulator, level card) so opening the home screen costs one request, not one
 * per widget. Requests in flight are shared; results are cached for a few minutes.
 */
import { get } from "svelte/store";
import { personId } from "#lib/stores.ts";
import {
  getBulkGradeExtraInfo,
  getGrades,
  getSchoolyears,
  formatDate,
} from "#lib/api.ts";
import { cacheGet } from "#lib/cache.ts";
import { currentSchoolyear } from "#lib/schoolyears.ts";
import type { Grade } from "#lib/types.ts";

const inflight = new Map<number, Promise<Grade[]>>();

export function loadCurrentYearGrades(
  pid: number = get(personId) as number,
): Promise<Grade[]> {
  const running = inflight.get(pid);
  if (running) return running;
  const p = (async () => {
    const today = formatDate(new Date());
    const years = await getSchoolyears(pid, "2013-01-01", today);
    const year = currentSchoolyear(years);
    if (!year?.id) return [];
    const yearId = year.id as number;
    return cacheGet(
      `year_grades_${pid}_${yearId}`,
      async () => {
        const grades = await getGrades(pid, yearId, year.einde);
        // Magister's grade list does not carry the real weight; it lives in the
        // per-column extra info (the grades page merges it the same way). Without
        // this every grade counts as 1× and any weighted average is wrong.
        const columns = [
          ...new Set(
            grades
              .filter((g) => g.CijferKolom?.KolomSoort === 1)
              .map((g) => g.CijferKolom.Id),
          ),
        ];
        if (columns.length === 0) return grades;
        try {
          const weights = await getBulkGradeExtraInfo(pid, yearId, columns);
          return grades.map((g) => {
            const extra = weights[g.CijferKolom.Id];
            return extra ? { ...g, Weging: extra.Weging } : g;
          });
        } catch (e) {
          console.warn("Simulator: wegingen laden mislukt", e);
          return grades;
        }
      },
      5 * 60 * 1000,
    );
  })().finally(() => inflight.delete(pid));
  inflight.set(pid, p);
  return p;
}
