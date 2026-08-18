import test from 'node:test';
import assert from 'node:assert';
import { calcCombinationAverage } from './combinations.ts';

test('calcCombinationAverage averages participating subject averages', () => {
  const subjects = [
    { name: 'Maatschappijleer', avg: 7 },
    { name: 'CKV', avg: 8 },
    { name: 'Profielwerkstuk', avg: 6 },
  ];
  const result = calcCombinationAverage(subjects, { id: '1', name: 'Combi', subjectNames: ['Maatschappijleer', 'CKV', 'Profielwerkstuk'] });
  assert.ok(result);
  assert.strictEqual(result!.avg, 7);
  assert.strictEqual(result!.parts.length, 3);
  assert.deepStrictEqual(result!.missing, []);
});

test('calcCombinationAverage ignores subjects with no average yet', () => {
  const subjects = [{ name: 'Maatschappijleer', avg: 7 }, { name: 'CKV', avg: 0 }];
  const result = calcCombinationAverage(subjects, { id: '1', name: 'Combi', subjectNames: ['Maatschappijleer', 'CKV'] });
  assert.ok(result);
  assert.strictEqual(result!.avg, 7);
  assert.strictEqual(result!.parts.length, 1);
  assert.deepStrictEqual(result!.missing, ['CKV']);
});

test('calcCombinationAverage returns null when nothing counts', () => {
  const result = calcCombinationAverage([{ name: 'CKV', avg: 0 }], { id: '1', name: 'Combi', subjectNames: ['CKV'] });
  assert.strictEqual(result, null);
});