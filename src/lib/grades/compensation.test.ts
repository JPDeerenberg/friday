import test from 'node:test';
import assert from 'node:assert';
import { evaluateCompensation, DEFAULT_COMPENSATION, sanitizeCompensation } from './compensation.ts';

test('points follow the rounded grade; total and insufficient count', () => {
  const r = evaluateCompensation(
    [{ name: 'wi', avg: 5.4 }, { name: 'ne', avg: 7.5 }, { name: 'en', avg: 6.2 }, { name: 'bi', avg: 4.6 }],
    DEFAULT_COMPENSATION,
  );
  // 5.4->5 (-1), 7.5->8 (+2), 6.2->6 (0), 4.6->5 (-1)
  assert.deepStrictEqual(r.rows.map((x) => x.points), [-1, 2, 0, -1]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.insufficientCount, 2);
  assert.strictEqual(r.ok, true);
});

test('fails with reasons when the total is too low or too many insufficient', () => {
  const r = evaluateCompensation(
    [{ name: 'a', avg: 4 }, { name: 'b', avg: 5 }, { name: 'c', avg: 6 }],
    { ...DEFAULT_COMPENSATION, minTotal: 0, maxInsufficient: 1 },
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.total, -3);
  assert.strictEqual(r.reasons.length, 2);
});

test('subjects without an average are skipped', () => {
  const r = evaluateCompensation([{ name: 'a', avg: 0 }, { name: 'b', avg: NaN }, { name: 'c', avg: 8 }], DEFAULT_COMPENSATION);
  assert.strictEqual(r.rows.length, 1);
});

test('sanitizeCompensation repairs bad input and keeps valid edits', () => {
  const s = sanitizeCompensation({ points: { '5': -2, '6': 'x' }, minTotal: 2, maxInsufficient: 2, passGrade: 6.4 });
  assert.strictEqual(s.points['5'], -2);
  assert.strictEqual(s.points['6'], 0);
  assert.strictEqual(s.minTotal, 2);
  assert.strictEqual(s.maxInsufficient, 2);
  assert.strictEqual(s.passGrade, 6);
  assert.strictEqual(sanitizeCompensation(null).maxInsufficient, null);
});
