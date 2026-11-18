/**
 * "Wrapped": a story of the school year so far, built from the grades you can
 * see and the cards you opened. Pure logic.
 *
 * It is a celebration, so it only ever says positive things: a slide that would
 * be negative (no improvement, nothing to brag about) is simply left out. Grades
 * that are still hidden by the card-reveal feature must be filtered out by the
 * caller; cards that are still face-down are never counted or revealed.
 */
import type { Grade } from "./types.ts";
import { numericGrade, subjectTotals } from "./quick-grades.ts";
import {
  RARITY_META,
  seasonLabel,
  type CardData,
  type Rarity,
} from "./cards.ts";

export type WrappedSlide =
  | { kind: "intro"; season: string; daysIn: number }
  | { kind: "grades"; count: number; subjects: number; average: number | null }
  | { kind: "best"; subject: string; average: number }
  | { kind: "highest"; value: number; subject: string; date: string | null }
  | { kind: "improved"; subject: string; from: number; to: number }
  | {
      kind: "cards";
      opened: number;
      rarest: Rarity | null;
      level: number;
      title: string;
    }
  | { kind: "missions"; points: number; tier: string; weeks: number }
  | { kind: "outro"; title: string; level: number };

export interface WrappedInput {
  /** "2026-2027" */
  season: string;
  now: Date;
  /** Grades the student can see. */
  grades: ReadonlyArray<Grade>;
  cards: ReadonlyArray<CardData>;
  opened: ReadonlySet<number>;
  /** Season level and its title (from cards.ts). */
  level: number;
  levelTitle: string;
  missionPoints: number;
  missionTier: string;
  weekStreak: number;
}

const gradeDate = (g: Grade): string => g.test_date || g.DatumIngevoerd || "";

function seasonStart(season: string): Date {
  const y = Number(season.split("-")[0]);
  return new Date(Number.isFinite(y) ? y : new Date().getFullYear(), 7, 1);
}

/** Subject whose average rose most between the earlier and the later half of its grades. */
function mostImproved(
  grades: ReadonlyArray<Grade>,
): { subject: string; from: number; to: number } | null {
  const bySubject = new Map<
    string,
    { date: string; value: number; weight: number }[]
  >();
  for (const g of grades) {
    const n = numericGrade(g);
    const subject = (g.Vak?.Omschrijving ?? "").trim();
    if (!n || !subject) continue;
    const list = bySubject.get(subject) ?? [];
    list.push({ date: gradeDate(g), ...n });
    bySubject.set(subject, list);
  }
  let best: { subject: string; from: number; to: number; gain: number } | null =
    null;
  for (const [subject, list] of bySubject) {
    if (list.length < 4) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const mid = Math.floor(list.length / 2);
    const mean = (xs: typeof list) =>
      xs.reduce((p, x) => p + x.value * x.weight, 0) /
      xs.reduce((p, x) => p + x.weight, 0);
    const from = mean(list.slice(0, mid));
    const to = mean(list.slice(mid));
    const gain = to - from;
    if (gain >= 0.3 && (!best || gain > best.gain))
      best = { subject, from, to, gain };
  }
  return best ? { subject: best.subject, from: best.from, to: best.to } : null;
}

export function buildWrapped(input: WrappedInput): WrappedSlide[] {
  const slides: WrappedSlide[] = [];
  const daysIn = Math.max(
    0,
    Math.floor(
      (input.now.getTime() - seasonStart(input.season).getTime()) / 86400000,
    ),
  );
  slides.push({ kind: "intro", season: input.season, daysIn });

  const totals = subjectTotals(input.grades);
  const count = totals.reduce((p, t) => p + t.count, 0);
  if (count > 0) {
    const points = totals.reduce((p, t) => p + t.points, 0);
    const weight = totals.reduce((p, t) => p + t.weight, 0);
    slides.push({
      kind: "grades",
      count,
      subjects: totals.length,
      average: weight > 0 ? points / weight : null,
    });

    const best = [...totals]
      .filter((t) => t.average !== null)
      .sort((a, b) => b.average! - a.average!)[0];
    if (best && totals.length > 1)
      slides.push({ kind: "best", subject: best.name, average: best.average! });

    let top: { value: number; subject: string; date: string } | null = null;
    for (const g of input.grades) {
      const n = numericGrade(g);
      const subject = (g.Vak?.Omschrijving ?? "").trim();
      if (!n || !subject) continue;
      const d = gradeDate(g);
      if (
        !top ||
        n.value > top.value ||
        (n.value === top.value && d > top.date)
      )
        top = { value: n.value, subject, date: d };
    }
    if (top)
      slides.push({
        kind: "highest",
        value: top.value,
        subject: top.subject,
        date: top.date || null,
      });

    const improved = mostImproved(input.grades);
    if (improved) slides.push({ kind: "improved", ...improved });
  }

  // Cards: only what has been opened.
  const openedCards = input.cards.filter((c) => input.opened.has(c.id));
  if (openedCards.length > 0) {
    const rarest = openedCards.reduce<CardData | null>(
      (r, c) =>
        !r || RARITY_META[c.rarity].tier > RARITY_META[r.rarity].tier ? c : r,
      null,
    );
    slides.push({
      kind: "cards",
      opened: openedCards.length,
      rarest: rarest ? rarest.rarity : null,
      level: input.level,
      title: input.levelTitle,
    });
  }

  if (input.missionPoints > 0) {
    slides.push({
      kind: "missions",
      points: input.missionPoints,
      tier: input.missionTier,
      weeks: input.weekStreak,
    });
  }

  slides.push({ kind: "outro", title: input.levelTitle, level: input.level });
  return slides;
}

const nl = (n: number, d = 1) => n.toFixed(d).replace(".", ",");

/** A short text version to paste into a chat. */
export function wrappedShareText(
  slides: ReadonlyArray<WrappedSlide>,
  season: string,
): string {
  const lines = [`Mijn Friday Wrapped ${seasonLabel(season)}`];
  for (const s of slides) {
    if (s.kind === "grades")
      lines.push(
        `${s.count} cijfers in ${s.subjects} vakken${s.average !== null ? `, gemiddeld ${nl(s.average)}` : ""}`,
      );
    else if (s.kind === "best")
      lines.push(`Beste vak: ${s.subject} (${nl(s.average)})`);
    else if (s.kind === "highest")
      lines.push(`Hoogste cijfer: ${nl(s.value)} voor ${s.subject}`);
    else if (s.kind === "improved")
      lines.push(`Meest gestegen: ${s.subject} (${nl(s.from)} → ${nl(s.to)})`);
    else if (s.kind === "cards")
      lines.push(
        `${s.opened} ${s.opened === 1 ? "kaart" : "kaarten"} geopend${s.rarest ? `, zeldzaamst: ${RARITY_META[s.rarest].label}` : ""}`,
      );
    else if (s.kind === "missions")
      lines.push(`${s.points} missiepunten (${s.tier})`);
    else if (s.kind === "outro") lines.push(`Level ${s.level}: ${s.title}`);
  }
  return lines.join("\n");
}
