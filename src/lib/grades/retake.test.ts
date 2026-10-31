import test from 'node:test';
import assert from 'node:assert';
import { applyRetakeRule, baseColumnLabel, isRetake } from './retake.ts';

const g = (str: string, name: string, date: string, retake = false, w: number | null = 1) => ({
  CijferStr: str, Weging: w, DatumIngevoerd: date,
  CijferKolom: { KolomNaam: name, IsHerkansingKolom: retake },
});

const orig = g('5,0', 'Toets H3', '2026-09-10');
const re = g('7,0', 'Herkansing Toets H3', '2026-09-24', true);
const other = g('8,0', 'Toets H4', '2026-10-01');

test('baseColumnLabel strips the herkansing wording', () => {
  assert.strictEqual(baseColumnLabel(re), 'toets h3');
  assert.strictEqual(baseColumnLabel(g('1', 'Toets H3 (herk.)', 'x', true)), 'toets h3');
  assert.ok(isRetake(re) && !isRetake(orig));
});

test('magister rule changes nothing', () => {
  assert.strictEqual(applyRetakeRule([orig, re, other], 'magister').length, 3);
});

test('best keeps the higher grade of a pair, once', () => {
  const out = applyRetakeRule([orig, re, other], 'best');
  assert.deepStrictEqual(out.map((x) => x.CijferStr), ['7,0', '8,0']);
  const lower = g('4,0', 'Herkansing Toets H3', '2026-09-24', true);
  const out2 = applyRetakeRule([orig, lower, other], 'best');
  assert.deepStrictEqual(out2.map((x) => x.CijferStr), ['5,0', '8,0']);
});

test('replace uses the retake even when it is lower', () => {
  const lower = g('4,0', 'Herkansing Toets H3', '2026-09-24', true);
  const out = applyRetakeRule([orig, lower, other], 'replace');
  assert.deepStrictEqual(out.map((x) => x.CijferStr), ['4,0', '8,0']);
});

test('ignore drops retakes', () => {
  const out = applyRetakeRule([orig, re, other], 'ignore');
  assert.deepStrictEqual(out.map((x) => x.CijferStr), ['5,0', '8,0']);
});

test('kept grade inherits the larger weight when Magister zeroed one of them', () => {
  const o = g('5,0', 'Toets H3', '2026-09-10', false, 0);
  const r = g('7,0', 'Herkansing Toets H3', '2026-09-24', true, 2);
  const [kept] = applyRetakeRule([o, r], 'best');
  assert.strictEqual(kept.Weging, 2);
});

test('unpaired retakes and letter grades are left alone', () => {
  const lonely = g('6,0', 'Herkansing Iets Anders', '2026-09-24', true);
  assert.strictEqual(applyRetakeRule([orig, lonely], 'best').length, 2);
  const letter = g('V', 'Herkansing Toets H3', '2026-09-24', true);
  assert.strictEqual(applyRetakeRule([orig, letter], 'best').length, 2);
});

test('input array is not mutated', () => {
  const input = [orig, re];
  applyRetakeRule(input, 'best');
  assert.strictEqual(input.length, 2);
  assert.strictEqual(orig.Weging, 1);
});
