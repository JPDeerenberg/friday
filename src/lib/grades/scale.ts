/**
 * Grade scale: one place that turns Magister's `CijferStr` into something the
 * app can calculate and colour with.
 *
 * Magister puts letters (V / O / G, A–F, ++ / – …) in the same list as normal
 * grades, usually with weight 0. Parsing used to be copy-pasted in ~7 places
 * with `parseFloat`, so a letter was either dropped or, worse, shown red as an
 * "insufficient" grade. Everything now goes through `parseGrade`.
 *
 * - A plain number ("7,5", "6.0") is a number.
 * - Anything else is a *letter*. What it means comes from the user's letter
 *   table (`LetterRule[]`); unknown letters are neutral, never red.
 */

export type LetterStatus = 'pass' | 'fail' | 'neutral';

export interface LetterRule {
  /** The text as Magister sends it, e.g. "V", "A+", "++". Matched case-insensitively. */
  token: string;
  status: LetterStatus;
  /** Optional number the letter stands for (used for graphs/stats, shown as ≈). */
  value: number | null;
}

export interface ParsedGrade {
  kind: 'number' | 'letter' | 'empty';
  raw: string;
  /** Number to calculate with, or null (unmapped letter / empty). */
  value: number | null;
  /** True when `value` came from the letter table rather than the grade itself. */
  approximate: boolean;
  /** Letters only: how the table classifies it. Always null for numbers. */
  status: LetterStatus | null;
}

/** Minimal shape of a Magister grade this module needs. */
export interface GradeLike {
  CijferStr?: string | null;
  Weging?: number | null;
  IsVoldoende?: boolean | null;
}

/** Trim, collapse whitespace, lowercase, unify the different minus/plus-minus characters. */
export function normalizeToken(s: string): string {
  return s
    .replace(/[\u2212\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const STRICT_NUMBER = /^\d+(?:[.,]\d+)?$/;

/** Strict number parse: "7,5" -> 7.5, "7+" / "V" / "" -> null. */
export function parseNumeric(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!STRICT_NUMBER.test(t)) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function findRule(token: string, rules: readonly LetterRule[]): LetterRule | undefined {
  const key = normalizeToken(token);
  return rules.find((r) => normalizeToken(r.token) === key);
}

export function parseGrade(
  cijferStr: string | null | undefined,
  rules: readonly LetterRule[] = [],
): ParsedGrade {
  const raw = (cijferStr ?? '').toString().trim();
  if (!raw) return { kind: 'empty', raw, value: null, approximate: false, status: null };

  const n = parseNumeric(raw);
  if (n !== null) return { kind: 'number', raw, value: n, approximate: false, status: null };

  const rule = findRule(raw, rules);
  const value = rule && typeof rule.value === 'number' && Number.isFinite(rule.value) ? rule.value : null;
  return {
    kind: 'letter',
    raw,
    value,
    approximate: value !== null,
    status: rule?.status ?? 'neutral',
  };
}

/** Number a grade can be calculated with (letters only when the table maps them). */
export function gradeNumber(g: GradeLike, rules: readonly LetterRule[] = []): number | null {
  return parseGrade(g.CijferStr, rules).value;
}

/**
 * Weight a grade counts with. Numbers without a weight count as 1 (as before).
 * Letters without a weight count as 0: a letter only moves an average when
 * Magister explicitly gives it a positive weight.
 */
export function effectiveWeight(g: GradeLike, parsed: ParsedGrade): number {
  if (typeof g.Weging === 'number' && Number.isFinite(g.Weging)) return Math.max(0, g.Weging);
  return parsed.kind === 'letter' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

export interface DetectedToken {
  /** First spelling seen. */
  token: string;
  count: number;
  weightMin: number | null;
  weightMax: number | null;
  /** How many of these grades Magister flagged as voldoende / onvoldoende. */
  passFlag: number;
  failFlag: number;
  suggestedStatus: LetterStatus;
  suggestedValue: number | null;
}

/** "7+", "6-", "5½" -> the number in front (what the old parseFloat did). */
function leadingNumber(token: string): number | null {
  const m = token.trim().match(/^(\d+(?:[.,]\d+)?)\s*[+\-\u2212\u00b1\u00bd]$/);
  return m ? Number(m[1].replace(',', '.')) : null;
}

/**
 * Collect every non-numeric `CijferStr` in `grades`.
 *
 * Status guess, deliberately cautious: Magister's pass flag is only trusted
 * when it actually distinguishes letters (some tokens always "voldoende" AND
 * some always "onvoldoende"). If every letter is flagged false it is probably
 * just the default for non-numeric grades, so we stay neutral instead of
 * painting them all red again.
 */
export function detectLetterTokens(grades: readonly GradeLike[]): DetectedToken[] {
  const map = new Map<string, DetectedToken>();
  for (const g of grades) {
    const raw = (g.CijferStr ?? '').toString().trim();
    if (!raw || parseNumeric(raw) !== null) continue;
    const key = normalizeToken(raw);
    let d = map.get(key);
    if (!d) {
      d = {
        token: raw,
        count: 0,
        weightMin: null,
        weightMax: null,
        passFlag: 0,
        failFlag: 0,
        suggestedStatus: 'neutral',
        suggestedValue: leadingNumber(raw),
      };
      map.set(key, d);
    }
    d.count++;
    if (typeof g.Weging === 'number') {
      d.weightMin = d.weightMin === null ? g.Weging : Math.min(d.weightMin, g.Weging);
      d.weightMax = d.weightMax === null ? g.Weging : Math.max(d.weightMax, g.Weging);
    }
    if (g.IsVoldoende === true) d.passFlag++;
    else if (g.IsVoldoende === false) d.failFlag++;
  }

  const list = [...map.values()];
  const allPass = list.filter((d) => d.passFlag > 0 && d.failFlag === 0);
  const allFail = list.filter((d) => d.failFlag > 0 && d.passFlag === 0);
  const flagIsInformative = allPass.length > 0 && allFail.length > 0;
  for (const d of list) {
    if (d.passFlag > 0 && d.failFlag === 0) d.suggestedStatus = 'pass';
    else if (d.failFlag > 0 && d.passFlag === 0 && flagIsInformative) d.suggestedStatus = 'fail';
    else d.suggestedStatus = 'neutral';
  }
  return list.sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

export interface LetterTableRow extends LetterRule {
  /** From the user's saved table (false = auto-detected suggestion). */
  saved: boolean;
  /** How often it occurs in the user's grades (0 = not currently in their grades). */
  count: number;
}

/** Saved rows first (user edits win), then detected tokens that have no row yet. */
export function buildLetterTable(
  saved: readonly LetterRule[],
  detected: readonly DetectedToken[],
): LetterTableRow[] {
  const rows: LetterTableRow[] = [];
  const seen = new Set<string>();
  const counts = new Map(detected.map((d) => [normalizeToken(d.token), d]));
  for (const r of saved) {
    const key = normalizeToken(r.token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...r, saved: true, count: counts.get(key)?.count ?? 0 });
  }
  for (const d of detected) {
    const key = normalizeToken(d.token);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      token: d.token,
      status: d.suggestedStatus,
      value: d.suggestedValue,
      saved: false,
      count: d.count,
    });
  }
  return rows;
}

/** Strip UI-only fields and invalid rows before saving. */
export function sanitizeRules(input: unknown): LetterRule[] {
  if (!Array.isArray(input)) return [];
  const out: LetterRule[] = [];
  const seen = new Set<string>();
  for (const r of input) {
    if (!r || typeof r !== 'object') continue;
    const token = typeof (r as any).token === 'string' ? (r as any).token.trim() : '';
    const key = normalizeToken(token);
    if (!key || seen.has(key) || parseNumeric(token) !== null) continue;
    seen.add(key);
    const status: LetterStatus = ['pass', 'fail', 'neutral'].includes((r as any).status) ? (r as any).status : 'neutral';
    const v = (r as any).value;
    const value = typeof v === 'number' && Number.isFinite(v) ? v : null;
    out.push({ token, status, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Starting points for the editor. These are conventions, not facts about any
// particular school: the UI labels them "startpunt, pas aan naar je school".
// ---------------------------------------------------------------------------

export interface LetterPreset {
  id: string;
  label: string;
  rules: LetterRule[];
}

export const LETTER_PRESETS: LetterPreset[] = [
  {
    id: 'vog',
    label: 'V / G / O',
    rules: [
      { token: 'V', status: 'pass', value: null },
      { token: 'G', status: 'pass', value: null },
      { token: 'O', status: 'fail', value: null },
    ],
  },
  {
    id: 'af',
    label: 'A – F',
    rules: [
      { token: 'A', status: 'pass', value: 9 },
      { token: 'B', status: 'pass', value: 8 },
      { token: 'C', status: 'pass', value: 7 },
      { token: 'D', status: 'neutral', value: 6 },
      { token: 'E', status: 'fail', value: 5 },
      { token: 'F', status: 'fail', value: 3 },
    ],
  },
  {
    id: 'plusmin',
    label: '++ / + / – / ––',
    rules: [
      { token: '++', status: 'pass', value: null },
      { token: '+', status: 'pass', value: null },
      { token: '+/-', status: 'neutral', value: null },
      { token: '-', status: 'fail', value: null },
      { token: '--', status: 'fail', value: null },
    ],
  },
];

/** Add preset rows without overwriting rows the user already has. */
export function applyPreset(current: readonly LetterRule[], preset: LetterPreset): LetterRule[] {
  const have = new Set(current.map((r) => normalizeToken(r.token)));
  return [...current, ...preset.rules.filter((r) => !have.has(normalizeToken(r.token))).map((r) => ({ ...r }))];
}
