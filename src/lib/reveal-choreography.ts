/**
 * Choreography data for the pack ceremony.
 *
 * The reveal used to be a pile of magic numbers spread through PackReveal:
 * a stop here, a flash there, a walkout whose length depended on the rarity.
 * This module turns that into one profile per card + intensity, so the whole
 * show can be reasoned about (and tested) without a browser.
 *
 * Keep it free of `#lib` runtime imports (cards.ts only has type imports) so
 * plain Node can load it in the test runner.
 */
import { RARITY_META, type CardData, type Rarity } from "./cards.ts";

export type RevealIntensity = "uit" | "normaal" | "vol";

/**
 * The visual identity of a rarity. `none` still gets the clean impact —
 * effects that only exist for higher tiers are gated by `k` and `tier`.
 */
export type RevealSignature =
  "none" | "prism" | "glitch" | "frost" | "storm" | "gold" | "cosmic";

export interface RevealProfile {
  tier: number;
  signature: RevealSignature;
  /** Effect budget: 0 = plain, 0.5 = normaal, 1 = vol. */
  k: number;
  /** Hit-stop before the impact frame, in ms. */
  stopMs: number;
  /** Length of the white flash, in ms. */
  flashMs: number;
  /** 0 = none, 1 = soft, 2 = strong, 3 = cinematic. */
  shake: 0 | 1 | 2 | 3;
  /** How long the rarity stamp stays on screen, in ms. */
  stampMs: number;
  /** Slow walkout before the flip. 0 = go straight to the impact. */
  walkoutMs: number;
  /** Fraction of the walkout where the rarity colour takes over. */
  walkoutRarityAt: number;
  /** Delay between the impact and the card settling into `shown`, in ms. */
  revealMs: number;
  /** Keep an ambient emitter running while the card hovers. */
  ambient: boolean;
}

const SIGNATURES: Record<Rarity, RevealSignature> = {
  gewoon: "none",
  speciaal: "prism",
  glitch: "glitch",
  zeldzaam: "frost",
  episch: "storm",
  legendarisch: "gold",
  mythisch: "cosmic",
};

export function signatureFor(rarity: Rarity): RevealSignature {
  return SIGNATURES[rarity];
}

const WALKOUT_BASE = [0, 0, 0, 0, 1500, 2200, 3000] as const;

export function revealProfile(
  card: CardData,
  intensity: RevealIntensity,
  reducedMotion = false,
): RevealProfile {
  const tier = RARITY_META[card.rarity].tier;
  const signature = signatureFor(card.rarity);
  const level: RevealIntensity = reducedMotion ? "uit" : intensity;

  if (level === "uit") {
    return {
      tier,
      signature,
      k: 0,
      stopMs: 0,
      flashMs: 0,
      shake: 0,
      stampMs: 0,
      walkoutMs: 0,
      walkoutRarityAt: 0,
      revealMs: 450,
      ambient: false,
    };
  }

  const full = level === "vol";
  const walkoutBase = WALKOUT_BASE[tier] ?? 0;
  const walkoutMs = walkoutBase
    ? Math.round(walkoutBase * (full ? 1 : 0.6))
    : 0;

  return {
    tier,
    signature,
    k: full ? 1 : 0.5,
    stopMs: tier >= 3 ? (full ? 130 : 70) : 0,
    flashMs: full ? 520 : 320,
    shake: full ? (tier >= 5 ? 3 : tier >= 3 ? 2 : 1) : tier >= 4 ? 1 : 0,
    stampMs: 1700,
    walkoutMs,
    walkoutRarityAt: 0.62,
    revealMs: tier >= 4 && !full ? 800 : 950,
    ambient: full && tier >= 4,
  };
}

export type ImpactCueKind =
  "flash" | "shake" | "burst" | "hit" | "chime" | "glitch" | "stamp" | "shown";

export interface ImpactCue {
  /** Milliseconds after the impact starts (the hit-stop has already passed). */
  at: number;
  kind: ImpactCueKind;
  /** Duration for `flash` and `stamp`. */
  ms?: number;
  /** Strength for `shake`. */
  level?: 1 | 2 | 3;
}

/**
 * The impact timeline. Every visual/audio beat of the reveal comes from here,
 * so the ordering stays consistent and can be asserted in tests.
 */
export function impactCues(
  profile: RevealProfile,
  opts: { stamp: boolean; glitch?: boolean },
): ImpactCue[] {
  // Times are relative to the landing frame; the hit-stop happens before.
  const t = 0;
  const cues: ImpactCue[] = [];

  if (profile.k > 0) {
    cues.push({ at: t, kind: "flash", ms: profile.flashMs });
    if (profile.shake) {
      cues.push({ at: t, kind: "shake", ms: 800, level: profile.shake });
    }
    cues.push({ at: t, kind: "burst" }, { at: t, kind: "hit" });
    cues.push({ at: t, kind: "chime" });
    if (opts.glitch) cues.push({ at: t, kind: "glitch" });
    if (opts.stamp) cues.push({ at: t, kind: "stamp", ms: profile.stampMs });
  }

  cues.push({ at: t + profile.revealMs, kind: "shown" });
  return cues.sort((a, b) => a.at - b.at);
}

export type WalkoutCueKind = "rarity" | "ambient" | "impact";

export interface WalkoutCue {
  at: number;
  kind: WalkoutCueKind;
}

/** Beats inside the slow walkout (Episch and up). */
export function walkoutCues(profile: RevealProfile): WalkoutCue[] {
  if (!profile.walkoutMs) return [{ at: 0, kind: "impact" }];
  return [
    {
      at: Math.round(profile.walkoutMs * profile.walkoutRarityAt),
      kind: "rarity" as const,
    },
    {
      at: Math.round(profile.walkoutMs * 0.3),
      kind: "ambient" as const,
    },
    { at: profile.walkoutMs, kind: "impact" as const },
  ].sort((a, b) => a.at - b.at);
}

export interface SignatureFx {
  embers: boolean;
  lightning: boolean;
  stars: boolean;
  snow: boolean;
  bubbles: boolean;
  goldrain: boolean;
  glitch: boolean;
}

/** Which ambient emitters belong to this card's signature. */
export function signatureFx(profile: RevealProfile): SignatureFx {
  const on = profile.k > 0;
  const big = on && profile.tier >= 4;
  return {
    embers: big && profile.signature === "storm",
    lightning: big && profile.signature === "storm",
    stars: big && profile.signature === "cosmic",
    snow: on && profile.signature === "frost",
    bubbles: on && profile.signature === "prism",
    goldrain: big && profile.signature === "gold",
    glitch: on && profile.signature === "glitch",
  };
}
