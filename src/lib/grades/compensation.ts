/**
 * Compensation points ("compensatiepunten" / "somscore"): many schools decide
 * promotion by giving every rounded final grade points (a 5 costs, a 7 earns)
 * and requiring a minimum total. Rules differ per school, so every number
 * here is editable; the defaults are only a common starting point.
 */
import { roundHalfUp } from './rounding.ts';

export interface CompensationConfig {
  /** Points per whole grade, keys "1".."10". */
  points: Record<string, number>;
  /** Total must be at least this. */
  minTotal: number;
  /** Max number of subjects below `passGrade` (null = no limit). */
  maxInsufficient: number | null;
  /** Whole grade that counts as sufficient (6). */
  passGrade: number;
}

export const DEFAULT_COMPENSATION: CompensationConfig = {
  points: { '1': -5, '2': -4, '3': -3, '4': -2, '5': -1, '6': 0, '7': 1, '8': 2, '9': 3, '10': 4 },
  minTotal: 0,
  maxInsufficient: null,
  passGrade: 6,
};

export function sanitizeCompensation(input: unknown): CompensationConfig {
  const d = DEFAULT_COMPENSATION;
  if (!input || typeof input !== 'object') return { ...d, points: { ...d.points } };
  const i = input as Partial<CompensationConfig>;
  const points: Record<string, number> = {};
  for (let g = 1; g <= 10; g++) {
    const v = (i.points as any)?.[String(g)];
    points[String(g)] = typeof v === 'number' && Number.isFinite(v) ? v : d.points[String(g)];
  }
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  return {
    points,
    minTotal: num(i.minTotal, d.minTotal),
    maxInsufficient:
      i.maxInsufficient === null || i.maxInsufficient === undefined
        ? null
        : num(i.maxInsufficient, 0),
    passGrade: Math.min(10, Math.max(1, Math.round(num(i.passGrade, d.passGrade)))),
  };
}

export interface CompensationRow {
  name: string;
  average: number;
  whole: number;
  points: number;
  insufficient: boolean;
}

export interface CompensationResult {
  rows: CompensationRow[];
  total: number;
  insufficientCount: number;
  ok: boolean;
  reasons: string[];
}

export function evaluateCompensation(
  subjects: readonly { name: string; avg: number }[],
  cfg: CompensationConfig,
): CompensationResult {
  const rows: CompensationRow[] = subjects
    .filter((s) => Number.isFinite(s.avg) && s.avg > 0)
    .map((s) => {
      const whole = Math.min(10, Math.max(1, roundHalfUp(s.avg, 0)));
      return {
        name: s.name,
        average: s.avg,
        whole,
        points: cfg.points[String(whole)] ?? 0,
        insufficient: whole < cfg.passGrade,
      };
    });
  const total = rows.reduce((sum, r) => sum + r.points, 0);
  const insufficientCount = rows.filter((r) => r.insufficient).length;
  const reasons: string[] = [];
  if (total < cfg.minTotal) reasons.push(`Totaal ${total} is lager dan ${cfg.minTotal}`);
  if (cfg.maxInsufficient !== null && insufficientCount > cfg.maxInsufficient)
    reasons.push(`${insufficientCount} onvoldoendes (max ${cfg.maxInsufficient})`);
  return { rows, total, insufficientCount, ok: reasons.length === 0, reasons };
}
