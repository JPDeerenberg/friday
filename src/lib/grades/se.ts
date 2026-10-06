import type { Grade } from "$lib/types";

/**
 * SE (schoolexamen) herkenning voor cijfers.
 *
 * Magister's `IsPTAKolom` is op veel scholen waar voor elke kolom uit het PTA,
 * ook voor toetsen die geen schoolexamen zijn. Daarom kijkt de `auto`-standaard
 * (naast de PTA-markering) ook naar een tekstsignaal in de kolomnamen.
 *
 * De `auto`-regel is provisorisch: hij is nog niet getoetst aan echte
 * kolomnamen van de school van de gebruiker. Zie `logSeColumnDiagnostic()`
 * (dev-only tabel) om de werkelijke namen te verzamelen.
 */

export type SeDetectionMode = "auto" | "magister" | "off";

export interface SeConfig {
  seDetection?: SeDetectionMode;
  overrides?: Record<number, boolean>;
}

/** Case-insensitieve teksttokens die op een schoolexamen wijzen. */
const SE_TOKENS_CI = new Set(["pta", "schoolexamen"]);

/** Kolomnummers SE1..SE9 (onderscheidend genoeg voor case-insensitieve match). */
const SE_NUMBERED_RE = /^se[1-9]$/i;

/** Uitsluitingssignalen: centraal examen is per definitie geen SE. */
const CE_TOKEN = "CE"; // alleen hoofdletters, net als SE
const CE_PHRASES = ["centraal examen", "centraal-examen", "centraalexamens"];

function splitTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/** Tekstvelden waarin naar een SE-signaal wordt gezocht. */
export function collectSeTexts(g: Grade): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const push = (field: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push({ field, text: v });
  };
  const kolom = g.CijferKolom;
  push("KolomKop", kolom?.KolomKop);
  push("KolomNaam", kolom?.KolomNaam);
  push("KolomOmschrijving", kolom?.KolomOmschrijving);
  push("description", g.description);
  // Defensief: sommige backends voegen dit veld los toe aan het cijfer.
  push(
    "WerkInformatieOmschrijving",
    (g as unknown as Record<string, unknown>).WerkInformatieOmschrijving,
  );
  return out;
}

/** Geeft het gevonden SE-signaal terug (voor reden/tooltip), of null. */
export function findSeSignal(
  g: Grade,
): { field: string; match: string } | null {
  for (const { field, text } of collectSeTexts(g)) {
    for (const token of splitTokens(text)) {
      if (token === "SE" || SE_NUMBERED_RE.test(token)) {
        return { field, match: token };
      }
      if (SE_TOKENS_CI.has(token.toLowerCase())) {
        return { field, match: token };
      }
    }
  }
  return null;
}

function hasCeSignal(g: Grade): { field: string; match: string } | null {
  for (const { field, text } of collectSeTexts(g)) {
    for (const token of splitTokens(text)) {
      if (token === CE_TOKEN) return { field, match: token };
    }
    const lower = text.toLowerCase();
    for (const phrase of CE_PHRASES) {
      if (lower.includes(phrase)) return { field, match: phrase };
    }
  }
  return null;
}

function getOverride(g: Grade, config?: SeConfig): boolean | null {
  const id = g.CijferKolom?.Id;
  if (id == null || !config?.overrides) return null;
  if (!Object.prototype.hasOwnProperty.call(config.overrides, id)) {
    return null;
  }
  return config.overrides[id] ? true : false;
}

/** True wanneer dit cijfer als schoolexamen (SE) telt. */
export function isSchoolexamenGrade(g: Grade, config?: SeConfig): boolean {
  const override = getOverride(g, config);
  if (override !== null) return override;

  const mode: SeDetectionMode = config?.seDetection ?? "auto";
  if (mode === "off") return false;

  const pta = !!g.CijferKolom?.IsPTAKolom;
  if (mode === "magister") return pta;

  // auto: PTA-markering én tekstsignaal, nooit bij een CE-signaal.
  if (!pta) return false;
  if (hasCeSignal(g)) return false;
  return findSeSignal(g) !== null;
}

/** Nederlandse uitleg waarom een cijfer wel/geen SE is (tooltip/debug). */
export function seReason(g: Grade, config?: SeConfig): string {
  const override = getOverride(g, config);
  if (override === true) return "Handmatig gemarkeerd als SE";
  if (override === false) return "Handmatig uitgesloten van SE";

  const mode: SeDetectionMode = config?.seDetection ?? "auto";
  if (mode === "off") return "SE-herkenning staat uit";
  if (mode === "magister") {
    return g.CijferKolom?.IsPTAKolom
      ? "Magister markeert deze kolom als PTA"
      : "Magister markeert deze kolom niet als PTA";
  }

  // auto
  if (!g.CijferKolom?.IsPTAKolom) {
    return "Geen PTA-markering van Magister";
  }
  const ce = hasCeSignal(g);
  if (ce) return `Geen SE: bevat CE-signaal (“${ce.match}” in ${ce.field})`;
  const se = findSeSignal(g);
  if (se) return `SE herkend: PTA + “${se.match}” in ${se.field}`;
  return "PTA volgens Magister, maar geen SE/PTA in de kolomnaam";
}

export interface SeAverage {
  avg: number;
  count: number;
  totalPoints: number;
  totalWeight: number;
}

/**
 * Gewogen gemiddelde (Weging, alleen TeltMee) van de SE-cijfers.
 * Zelfde parse-semantiek als computeSubjectSummary in Grades.svelte.
 */
export function seWeightedAverage(
  subGrades: Grade[],
  config?: SeConfig,
): SeAverage {
  let totalPoints = 0;
  let totalWeight = 0;
  let count = 0;
  for (const g of subGrades) {
    if (!g.CijferStr || !g.TeltMee) continue;
    if (!isSchoolexamenGrade(g, config)) continue;
    const val = parseFloat(g.CijferStr.replace(",", "."));
    if (isNaN(val)) continue;
    const w = typeof g.Weging === "number" ? g.Weging : 1;
    totalPoints += val * w;
    totalWeight += w;
    count++;
  }
  return {
    avg: totalWeight > 0 ? totalPoints / totalWeight : 0,
    count,
    totalPoints,
    totalWeight,
  };
}

export interface SeColumnRow {
  KolomKop: string | null;
  KolomNaam: string | null;
  KolomOmschrijving: string | null;
  IsPTAKolom: boolean;
  Weging: number | null;
  KolomSoort: number;
  aantal: number;
}

/** Distincte kolomcombinaties, voor de dev-diagnose van de auto-regel. */
export function distinctSeColumns(grades: Grade[]): SeColumnRow[] {
  const map = new Map<string, SeColumnRow>();
  for (const g of grades) {
    const k = g.CijferKolom;
    const key = [
      k?.KolomKop ?? "",
      k?.KolomNaam ?? "",
      k?.KolomOmschrijving ?? "",
      k?.IsPTAKolom ? "1" : "0",
      typeof g.Weging === "number" ? String(g.Weging) : "",
      String(k?.KolomSoort ?? ""),
    ].join("|");
    const existing = map.get(key);
    if (existing) {
      existing.aantal++;
    } else {
      map.set(key, {
        KolomKop: k?.KolomKop ?? null,
        KolomNaam: k?.KolomNaam ?? null,
        KolomOmschrijving: k?.KolomOmschrijving ?? null,
        IsPTAKolom: !!k?.IsPTAKolom,
        Weging: typeof g.Weging === "number" ? g.Weging : null,
        KolomSoort: k?.KolomSoort ?? 0,
        aantal: 1,
      });
    }
  }
  return [...map.values()];
}

/**
 * Dev-only diagnose: toont de distincte kolomnamen zodat de gebruiker echte
 * rijen kan plakken en de provisorische `auto`-regel getoetst kan worden.
 */
export function logSeColumnDiagnostic(grades: Grade[]): SeColumnRow[] {
  const rows = distinctSeColumns(grades);
  console.table(rows);
  console.info(
    "[SE] Plak een paar rijen uit deze tabel om de automatische SE-herkenning te toetsen aan echte kolomnamen.",
  );
  return rows;
}
