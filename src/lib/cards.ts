/**
 * Grade cards.
 *
 * Every grade is a collectible card. Everything here is deterministic and
 * derived from the grade itself — rarity is never random, so it stays an honest
 * reflection of the result. The only "luck" is cosmetic (shiny variant and which
 * of the three open-gestures a card uses), and even that is seeded by the grade
 * id so a card looks and behaves the same on every device.
 *
 * Keep this module free of `$lib` runtime imports (type imports are fine) so it
 * stays importable from plain Node tests.
 */
import type { Grade } from "$lib/types";

export type Rarity =
  | "gewoon"
  | "speciaal"
  | "glitch"
  | "zeldzaam"
  | "episch"
  | "legendarisch"
  | "mythisch";

export type OpenMode = "tear" | "scratch" | "hold";
export type Stamp = "boss" | "clutch" | "pb" | "comeback" | "first";

export interface RarityMeta {
  label: string;
  /** Main accent colour. */
  color: string;
  /** Secondary accent. */
  color2: string;
  xp: number;
  /** 0–6: drives how big the reveal is and the pack order (low → high). */
  tier: number;
}

export const RARITY_META: Record<Rarity, RarityMeta> = {
  gewoon: {
    label: "Gewoon",
    color: "#cbd5e1",
    color2: "#64748b",
    xp: 10,
    tier: 0,
  },
  speciaal: {
    label: "Speciaal",
    color: "#5eead4",
    color2: "#0d9488",
    xp: 15,
    tier: 1,
  },
  glitch: {
    label: "Glitch",
    color: "#fb7185",
    color2: "#22d3ee",
    xp: 25,
    tier: 2,
  },
  zeldzaam: {
    label: "Zeldzaam",
    color: "#38bdf8",
    color2: "#2563eb",
    xp: 20,
    tier: 3,
  },
  episch: {
    label: "Episch",
    color: "#c084fc",
    color2: "#7c3aed",
    xp: 40,
    tier: 4,
  },
  legendarisch: {
    label: "Legendarisch",
    color: "#fbbf24",
    color2: "#d97706",
    xp: 80,
    tier: 5,
  },
  mythisch: {
    label: "Mythisch",
    color: "#f0abfc",
    color2: "#22d3ee",
    xp: 150,
    tier: 6,
  },
};

export const RARITIES = Object.keys(RARITY_META) as Rarity[];

export const STAMP_META: Record<Stamp, { label: string; icon: string }> = {
  boss: { label: "Boss-toets", icon: "👑" },
  clutch: { label: "Clutch", icon: "🎯" },
  pb: { label: "Record", icon: "🏆" },
  comeback: { label: "Comeback", icon: "🔥" },
  first: { label: "1e editie", icon: "✨" },
};

export interface CardData {
  id: number;
  subject: string;
  title: string;
  /** Display value, exactly as Magister gives it ("7,5", "V", …). */
  value: string;
  valueNum: number | null;
  passed: boolean;
  rarity: Rarity;
  shiny: boolean;
  mode: OpenMode;
  seed: number;
  hue: number;
  emoji: string;
  weight: number | null;
  date: string | null;
  stamps: Stamp[];
  xp: number;
}

// ---------------------------------------------------------------- seeds / rng

/** Small, stable string hash (xmur3-style) → unsigned 32-bit int. */
export function hash32(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic PRNG (mulberry32): returns a function giving floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODES: OpenMode[] = ["tear", "scratch", "hold"];

/** Which gesture opens this card. Random-looking, but stable per grade. */
export function openModeFor(id: number): OpenMode {
  return MODES[hash32(`mode:${id}`) % 3];
}

/** 1-in-16 cosmetic shiny variant, stable per grade. */
export function isShiny(id: number): boolean {
  return hash32(`shiny:${id}`) % 16 === 0;
}

// ---------------------------------------------------------------- parsing

export function parseGradeNumber(
  str: string | null | undefined,
): number | null {
  if (!str) return null;
  const n = Number(str.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- rarity

export function rarityOf(valueNum: number | null, passed: boolean): Rarity {
  if (!passed) return "glitch";
  if (valueNum === null) return "speciaal";
  if (valueNum < 6.5) return "gewoon";
  if (valueNum < 7.5) return "zeldzaam";
  if (valueNum < 8.5) return "episch";
  if (valueNum < 9.5) return "legendarisch";
  return "mythisch";
}

/** Worst → best order for revealing a pack (best card last). */
export function compareForPack(a: CardData, b: CardData): number {
  const t = RARITY_META[a.rarity].tier - RARITY_META[b.rarity].tier;
  if (t !== 0) return t;
  return (a.valueNum ?? 0) - (b.valueNum ?? 0);
}

// ---------------------------------------------------------------- subject theme

const THEMES: Array<[RegExp, { hue: number; emoji: string }]> = [
  [/wiskunde|rekenen|statistiek/i, { hue: 215, emoji: "📐" }],
  [/natuurkunde|nask|fysica/i, { hue: 190, emoji: "⚛️" }],
  [/scheikunde|chemie/i, { hue: 150, emoji: "🧪" }],
  [/biologie|levende natuur/i, { hue: 105, emoji: "🧬" }],
  [/nederlands|\bned\b/i, { hue: 5, emoji: "📖" }],
  [/engels|english/i, { hue: 345, emoji: "💬" }],
  [
    /frans|duits|spaans|latijn|grieks|chinees|italiaans|russisch/i,
    { hue: 28, emoji: "🗣️" },
  ],
  [/geschiedenis|maatschappij|burgerschap/i, { hue: 38, emoji: "🏛️" }],
  [/aardrijkskunde|geografie/i, { hue: 170, emoji: "🌍" }],
  [/economie|bedrijfs|management/i, { hue: 50, emoji: "💶" }],
  [/kunst|tekenen|ckv|handvaardigheid|beeldend/i, { hue: 315, emoji: "🎨" }],
  [/muziek/i, { hue: 290, emoji: "🎵" }],
  [
    /informatica|programmeren|ict|techniek|technologie/i,
    { hue: 255, emoji: "💻" },
  ],
  [/lichamelijke|gymnastiek|\blo\b|sport/i, { hue: 15, emoji: "⚽" }],
  [/filosofie|levensbeschouwing|godsdienst/i, { hue: 270, emoji: "🧠" }],
  [/mentor|loopbaan|studie/i, { hue: 200, emoji: "🧭" }],
];

export function subjectTheme(subject: string): { hue: number; emoji: string } {
  for (const [re, theme] of THEMES) if (re.test(subject)) return theme;
  return { hue: hash32(`hue:${subject}`) % 360, emoji: "📚" };
}

// ---------------------------------------------------------------- card building

export interface BuildOptions {
  /** Grades below this count as insufficient (the user's setting). */
  threshold: number;
  /** Weight at which a grade is a "boss" test. */
  bossWeight?: number;
}

function subjectOf(grade: Grade): string {
  return grade.Vak?.Omschrijving ?? "Onbekend vak";
}

/** Stamps are derived from the grade's neighbours in the same subject. */
function stampsFor(
  grade: Grade,
  valueNum: number | null,
  index: number,
  chrono: Array<{ value: number | null }>,
  opts: Required<BuildOptions>,
): Stamp[] {
  const stamps: Stamp[] = [];
  if (index === 0) stamps.push("first");
  if ((grade.Weging ?? 0) >= opts.bossWeight) stamps.push("boss");
  if (valueNum !== null) {
    if (valueNum === opts.threshold) stamps.push("clutch");
    const earlier = chrono
      .slice(0, index)
      .map((c) => c.value)
      .filter((v): v is number => v !== null);
    if (earlier.length >= 2 && valueNum > Math.max(...earlier))
      stamps.push("pb");
    const prev = index > 0 ? chrono[index - 1].value : null;
    if (prev !== null && valueNum >= opts.threshold && valueNum - prev >= 1.5) {
      stamps.push("comeback");
    }
  }
  return stamps.slice(0, 3);
}

export function cardXp(
  rarity: Rarity,
  shiny: boolean,
  stampCount: number,
): number {
  const base = RARITY_META[rarity].xp;
  return Math.round(base * (shiny ? 1.5 : 1)) + stampCount * 10;
}

/** Build a card for every real grade column (KolomSoort 1) with a value. */
export function buildCards(
  grades: Grade[],
  options: BuildOptions,
): Map<number, CardData> {
  const opts: Required<BuildOptions> = { bossWeight: 3, ...options };
  const bySubject = new Map<string, Grade[]>();
  for (const g of grades) {
    if (!g.CijferStr || g.CijferKolom?.KolomSoort !== 1) continue;
    const key = subjectOf(g);
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(g);
  }

  const cards = new Map<number, CardData>();
  for (const [subject, list] of bySubject) {
    list.sort((a, b) =>
      (a.DatumIngevoerd ?? "").localeCompare(b.DatumIngevoerd ?? ""),
    );
    const chrono = list.map((g) => ({ value: parseGradeNumber(g.CijferStr) }));
    const theme = subjectTheme(subject);
    list.forEach((g, index) => {
      const valueNum = chrono[index].value;
      const passed =
        valueNum !== null
          ? valueNum >= opts.threshold
          : g.IsVoldoende !== false;
      const rarity = rarityOf(valueNum, passed);
      const shiny = isShiny(g.CijferId);
      const stamps = stampsFor(g, valueNum, index, chrono, opts);
      cards.set(g.CijferId, {
        id: g.CijferId,
        subject,
        title:
          g.CijferKolom?.KolomOmschrijving ||
          g.CijferKolom?.KolomNaam ||
          "Cijfer",
        value: g.CijferStr ?? "",
        valueNum,
        passed,
        rarity,
        shiny,
        mode: openModeFor(g.CijferId),
        seed: hash32(`${g.CijferId}:${subject}`),
        hue: theme.hue,
        emoji: theme.emoji,
        weight: g.Weging ?? null,
        date: g.DatumIngevoerd ?? null,
        stamps,
        xp: cardXp(rarity, shiny, stamps.length),
      });
    });
  }
  return cards;
}

// ---------------------------------------------------------------- levels

export const TITLES = [
  "Beginner",
  "Student",
  "Slimmerik",
  "Studiebeest",
  "Topper",
  "Held",
  "Meester",
  "Legende",
  "Grootmeester",
  "Mythisch Brein",
];

const xpStart = (level: number) => 25 * (level - 1) * level;

export interface LevelInfo {
  level: number;
  title: string;
  /** XP earned inside the current level. */
  into: number;
  /** XP needed to finish the current level. */
  need: number;
  pct: number;
}

export function levelInfo(xp: number): LevelInfo {
  let level = 1;
  while (xp >= xpStart(level + 1)) level++;
  const start = xpStart(level);
  const need = xpStart(level + 1) - start;
  return {
    level,
    title: TITLES[Math.min(level - 1, TITLES.length - 1)],
    into: xp - start,
    need,
    pct: Math.min(1, (xp - start) / need),
  };
}

// ---------------------------------------------------------------- tally & achievements

/** Running totals, updated whenever a card is opened (see grade-reveal.ts). */
export interface Tally {
  total: number;
  xp: number;
  byRarity: Record<Rarity, number>;
  shiny: number;
  comebacks: number;
  bosses: number;
  subjects: string[];
  streak: number;
  bestStreak: number;
}

export function emptyTally(): Tally {
  return {
    total: 0,
    xp: 0,
    byRarity: Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<
      Rarity,
      number
    >,
    shiny: 0,
    comebacks: 0,
    bosses: 0,
    subjects: [],
    streak: 0,
    bestStreak: 0,
  };
}

/** Pure: the tally after opening `card`. */
export function tallyAfterOpening(tally: Tally, card: CardData): Tally {
  const streak = card.passed ? tally.streak + 1 : 0;
  return {
    total: tally.total + 1,
    xp: tally.xp + card.xp,
    byRarity: {
      ...tally.byRarity,
      [card.rarity]: (tally.byRarity[card.rarity] ?? 0) + 1,
    },
    shiny: tally.shiny + (card.shiny ? 1 : 0),
    comebacks: tally.comebacks + (card.stamps.includes("comeback") ? 1 : 0),
    bosses: tally.bosses + (card.stamps.includes("boss") ? 1 : 0),
    subjects: tally.subjects.includes(card.subject)
      ? tally.subjects
      : [...tally.subjects, card.subject],
    streak,
    bestStreak: Math.max(tally.bestStreak, streak),
  };
}

export interface AchievementContext {
  /** Subjects where every grade has been opened (needs the full card list). */
  completeSets: number;
}

export interface Achievement {
  id: string;
  title: string;
  desc: string;
  icon: string;
  target: number;
  value: (t: Tally, ctx: AchievementContext) => number;
}

const atLeast = (t: Tally, from: Rarity[]) =>
  from.reduce((n, r) => n + (t.byRarity[r] ?? 0), 0);

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: "first-pull",
    title: "Eerste pull",
    desc: "Open je eerste kaart",
    icon: "🎴",
    target: 1,
    value: (t) => t.total,
  },
  {
    id: "pack-5",
    title: "Pakketje",
    desc: "Open 5 kaarten",
    icon: "📦",
    target: 5,
    value: (t) => t.total,
  },
  {
    id: "collector-25",
    title: "Verzamelaar",
    desc: "Open 25 kaarten",
    icon: "🗂️",
    target: 25,
    value: (t) => t.total,
  },
  {
    id: "collector-100",
    title: "Archivaris",
    desc: "Open 100 kaarten",
    icon: "🏛️",
    target: 100,
    value: (t) => t.total,
  },
  {
    id: "rare",
    title: "Zeldzame vondst",
    desc: "Trek een Zeldzame kaart of beter",
    icon: "💎",
    target: 1,
    value: (t) =>
      atLeast(t, ["zeldzaam", "episch", "legendarisch", "mythisch"]),
  },
  {
    id: "epic",
    title: "Episch moment",
    desc: "Trek een Epische kaart of beter",
    icon: "⚡",
    target: 1,
    value: (t) => atLeast(t, ["episch", "legendarisch", "mythisch"]),
  },
  {
    id: "legend",
    title: "Legendarisch!",
    desc: "Trek een Legendarische kaart",
    icon: "🌟",
    target: 1,
    value: (t) => atLeast(t, ["legendarisch", "mythisch"]),
  },
  {
    id: "myth",
    title: "Mythisch!!",
    desc: "Trek een Mythische kaart",
    icon: "🌈",
    target: 1,
    value: (t) => t.byRarity.mythisch ?? 0,
  },
  {
    id: "glitch",
    title: "Glitch in de matrix",
    desc: "Trek een Glitch-kaart",
    icon: "👾",
    target: 1,
    value: (t) => t.byRarity.glitch ?? 0,
  },
  {
    id: "shiny",
    title: "Shiny hunter",
    desc: "Trek een shiny kaart",
    icon: "✨",
    target: 1,
    value: (t) => t.shiny,
  },
  {
    id: "comeback",
    title: "Comeback kid",
    desc: "3 comeback-kaarten",
    icon: "🔥",
    target: 3,
    value: (t) => t.comebacks,
  },
  {
    id: "streak",
    title: "Op een rij",
    desc: "5 voldoendes achter elkaar geopend",
    icon: "📈",
    target: 5,
    value: (t) => t.bestStreak,
  },
  {
    id: "subjects",
    title: "Vakkenvuller",
    desc: "Kaarten uit 5 verschillende vakken",
    icon: "🧩",
    target: 5,
    value: (t) => t.subjects.length,
  },
  {
    id: "bosses",
    title: "Bossbeaters",
    desc: "3 boss-toetsen geopend",
    icon: "👑",
    target: 3,
    value: (t) => t.bosses,
  },
  {
    id: "set",
    title: "Setje compleet",
    desc: "Open alle kaarten van één vak",
    icon: "🏅",
    target: 1,
    value: (_t, ctx) => ctx.completeSets,
  },
];

export function achievementProgress(
  a: Achievement,
  t: Tally,
  ctx: AchievementContext,
) {
  const value = Math.min(a.target, a.value(t, ctx));
  return { value, pct: value / a.target, done: value >= a.target };
}

export function earnedAchievementIds(
  t: Tally,
  ctx: AchievementContext,
): string[] {
  return ACHIEVEMENTS.filter((a) => a.value(t, ctx) >= a.target).map(
    (a) => a.id,
  );
}

/** Subjects where every card has been opened (needs at least 3 cards). */
export function countCompleteSets(
  cards: CardData[],
  opened: ReadonlySet<number>,
): number {
  const bySubject = new Map<string, CardData[]>();
  for (const c of cards) {
    if (!bySubject.has(c.subject)) bySubject.set(c.subject, []);
    bySubject.get(c.subject)!.push(c);
  }
  let n = 0;
  for (const list of bySubject.values()) {
    if (list.length >= 3 && list.every((c) => opened.has(c.id))) n++;
  }
  return n;
}

// ---------------------------------------------------------------- generated art

export interface ArtShape {
  kind: "circle" | "ring" | "poly" | "rect" | "line";
  x: number;
  y: number;
  r: number;
  rot: number;
  sides: number;
  /** Opacity 0–1. */
  o: number;
  /** Index into the card's 4-colour palette. */
  c: number;
}

/**
 * Seeded abstract artwork (viewBox 200×280). Same seed → same card art, so no
 * two cards look alike but a card never changes. Higher rarities get more and
 * bolder shapes.
 */
export function artShapes(seed: number, rarity: Rarity): ArtShape[] {
  const rnd = mulberry32(seed);
  const tier = RARITY_META[rarity].tier;
  const count = 8 + tier * 2;
  const kinds: ArtShape["kind"][] = ["circle", "ring", "poly", "rect", "line"];
  const shapes: ArtShape[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    shapes.push({
      kind,
      x: Math.round(rnd() * 200),
      y: Math.round(rnd() * 280),
      r: Math.round(14 + rnd() * (38 + tier * 6)),
      rot: Math.round(rnd() * 360),
      sides: 3 + Math.floor(rnd() * 4),
      o: Math.round((0.12 + rnd() * 0.32) * 100) / 100,
      c: Math.floor(rnd() * 4),
    });
  }
  return shapes;
}

/** Polygon points for a regular n-gon (used by the art renderer). */
export function polyPoints(
  x: number,
  y: number,
  r: number,
  sides: number,
  rot: number,
): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((rot + (i * 360) / sides) * Math.PI) / 180;
    pts.push(
      `${(x + Math.cos(a) * r).toFixed(1)},${(y + Math.sin(a) * r).toFixed(1)}`,
    );
  }
  return pts.join(" ");
}
