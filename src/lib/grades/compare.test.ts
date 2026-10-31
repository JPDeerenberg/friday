import test from 'node:test';
import assert from 'node:assert';
import { schoolAverages, compareWithSchool } from './compare.ts';

const col = (str: string, date: string, soort = 2, period = 1, name = 'Gemiddelde') => ({
  CijferStr: str, DatumIngevoerd: date, CijferPeriode: { Id: period },
  CijferKolom: { KolomSoort: soort, KolomNaam: name },
});

test('schoolAverages keeps only numeric average columns, newest first', () => {
  const avgs = schoolAverages([
    col('6,8', '2026-10-01'), col('7,1', '2026-10-20'), col('7,5', '2026-10-25', 1),
    col('V', '2026-10-26'),
  ]);
  assert.deepStrictEqual(avgs.map((a) => a.value), [7.1, 6.8]);
});

test('compareWithSchool compares rounded values', () => {
  const avgs = schoolAverages([col('6,8', '2026-10-01')]);
  assert.strictEqual(compareWithSchool(avgs, 6.77, 1)!.matches, true);
  const off = compareWithSchool(avgs, 6.4, 1)!;
  assert.strictEqual(off.matches, false);
  assert.ok(Math.abs(off.diff - -0.4) < 1e-9);
});

test('compareWithSchool uses the period when given, and returns null without data', () => {
  const avgs = schoolAverages([col('6,0', '2026-09-01', 2, 1), col('7,0', '2026-10-01', 2, 2)]);
  assert.strictEqual(compareWithSchool(avgs, 6, 1, 1)!.school.value, 6);
  assert.strictEqual(compareWithSchool(avgs, 7, 1, 2)!.school.value, 7);
  assert.strictEqual(compareWithSchool(avgs, 7, 1, 3), null);
  assert.strictEqual(compareWithSchool([], 7, 1), null);
  assert.strictEqual(compareWithSchool(avgs, 0, 1), null);
});
