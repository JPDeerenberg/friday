import test from 'node:test';
import assert from 'node:assert';
import {
  parseNumeric, parseGrade, effectiveWeight, detectLetterTokens, buildLetterTable,
  sanitizeRules, applyPreset, LETTER_PRESETS, normalizeToken,
} from './scale.ts';

test('parseNumeric is strict: only plain numbers', () => {
  assert.strictEqual(parseNumeric('7,5'), 7.5);
  assert.strictEqual(parseNumeric(' 6.0 '), 6);
  assert.strictEqual(parseNumeric('7+'), null);
  assert.strictEqual(parseNumeric('V'), null);
  assert.strictEqual(parseNumeric(''), null);
  assert.strictEqual(parseNumeric(null), null);
});

test('parseGrade: unknown letters are neutral, never failing', () => {
  const p = parseGrade('V', []);
  assert.strictEqual(p.kind, 'letter');
  assert.strictEqual(p.status, 'neutral');
  assert.strictEqual(p.value, null);
});

test('parseGrade uses the table, case- and minus-insensitively', () => {
  const rules = [
    { token: 'o', status: 'fail' as const, value: null },
    { token: 'A-', status: 'pass' as const, value: 8.5 },
  ];
  assert.strictEqual(parseGrade('O', rules).status, 'fail');
  const a = parseGrade('A\u2212', rules); // unicode minus
  assert.strictEqual(a.status, 'pass');
  assert.strictEqual(a.value, 8.5);
  assert.strictEqual(a.approximate, true);
});

test('numbers never get a letter status', () => {
  const p = parseGrade('7,5', [{ token: '7,5', status: 'fail', value: 1 }]);
  assert.strictEqual(p.kind, 'number');
  assert.strictEqual(p.status, null);
  assert.strictEqual(p.value, 7.5);
});

test('effectiveWeight: letters default to 0, numbers to 1, explicit weight wins', () => {
  const letter = parseGrade('V');
  const num = parseGrade('7');
  assert.strictEqual(effectiveWeight({ Weging: null }, letter), 0);
  assert.strictEqual(effectiveWeight({ Weging: undefined }, num), 1);
  assert.strictEqual(effectiveWeight({ Weging: 0 }, num), 0);
  assert.strictEqual(effectiveWeight({ Weging: 2 }, letter), 2);
});

test('detectLetterTokens groups by normalised token and counts', () => {
  const d = detectLetterTokens([
    { CijferStr: 'V', Weging: 0 }, { CijferStr: 'v', Weging: 0 },
    { CijferStr: 'O', Weging: 0 }, { CijferStr: '7,5', Weging: 1 }, { CijferStr: '' },
  ]);
  assert.deepStrictEqual(d.map((x) => [normalizeToken(x.token), x.count]), [['v', 2], ['o', 1]]);
  assert.strictEqual(d[0].weightMax, 0);
});

test('detection trusts the pass flag only when it tells letters apart', () => {
  const informative = detectLetterTokens([
    { CijferStr: 'V', IsVoldoende: true }, { CijferStr: 'O', IsVoldoende: false },
  ]);
  assert.strictEqual(informative.find((x) => x.token === 'V')!.suggestedStatus, 'pass');
  assert.strictEqual(informative.find((x) => x.token === 'O')!.suggestedStatus, 'fail');

  // Everything false = probably Magister's default for letters: stay neutral, not red.
  const allFalse = detectLetterTokens([
    { CijferStr: 'A', IsVoldoende: false }, { CijferStr: 'B', IsVoldoende: false },
  ]);
  assert.ok(allFalse.every((x) => x.suggestedStatus === 'neutral'));

  const allTrue = detectLetterTokens([{ CijferStr: 'G', IsVoldoende: true }]);
  assert.strictEqual(allTrue[0].suggestedStatus, 'pass');
});

test('detection suggests the leading number for 7+ / 6- style grades', () => {
  const d = detectLetterTokens([{ CijferStr: '7+' }, { CijferStr: '6-' }, { CijferStr: 'V' }]);
  assert.strictEqual(d.find((x) => x.token === '7+')!.suggestedValue, 7);
  assert.strictEqual(d.find((x) => x.token === '6-')!.suggestedValue, 6);
  assert.strictEqual(d.find((x) => x.token === 'V')!.suggestedValue, null);
});

test('buildLetterTable: saved rows win over suggestions and keep their order', () => {
  const detected = detectLetterTokens([{ CijferStr: 'V', IsVoldoende: true }, { CijferStr: 'X' }]);
  const rows = buildLetterTable([{ token: 'v', status: 'fail', value: 4 }], detected);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].saved, true);
  assert.strictEqual(rows[0].status, 'fail');
  assert.strictEqual(rows[0].count, 1);
  assert.strictEqual(rows[1].token, 'X');
  assert.strictEqual(rows[1].saved, false);
});

test('sanitizeRules drops junk, numbers and duplicates', () => {
  const out = sanitizeRules([
    { token: ' V ', status: 'pass', value: null },
    { token: 'v', status: 'fail', value: 3 },
    { token: '7', status: 'pass', value: 7 },
    { token: '', status: 'pass' },
    { token: 'Z', status: 'weird', value: 'x' },
    null,
  ]);
  assert.deepStrictEqual(out, [
    { token: 'V', status: 'pass', value: null },
    { token: 'Z', status: 'neutral', value: null },
  ]);
  assert.deepStrictEqual(sanitizeRules('nope'), []);
});

test('applyPreset adds missing rows but never overwrites the user\'s', () => {
  const vog = LETTER_PRESETS.find((p) => p.id === 'vog')!;
  const out = applyPreset([{ token: 'o', status: 'neutral', value: null }], vog);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out.find((r) => r.token.toLowerCase() === 'o')!.status, 'neutral');
});
