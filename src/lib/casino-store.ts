/**
 * Blackjack stats and the local in-progress hand.
 *
 * The wallet itself is the shared season XP in `quests-store.ts`; this store
 * only keeps the table statistics (which sync via `casino.state`) and the
 * current hand. The active hand stays local: it belongs to this device/session
 * and must not be overwritten by sync halfway through a deal.
 */
import { writable } from "svelte/store";
import {
  restoreHand,
  type BlackjackHand,
  type HandResult,
} from "./blackjack.ts";

const STATS_KEY = "friday_casino_v1";
const HAND_KEY = "friday_blackjack_hand_v1";

export interface CasinoStats {
  hands: number;
  wins: number;
  losses: number;
  pushes: number;
  blackjacks: number;
  /** Net XP over all settled hands (payout - stake). */
  net: number;
  bestWin: number;
  /** Positive = win streak, negative = loss streak, 0 = neutral. */
  streak: number;
  bestStreak: number;
}

export interface CasinoState {
  version: 1;
  stats: CasinoStats;
}

export function emptyCasinoStats(): CasinoStats {
  return {
    hands: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    blackjacks: 0,
    net: 0,
    bestWin: 0,
    streak: 0,
    bestStreak: 0,
  };
}

export function sanitizeCasinoStats(raw: unknown): CasinoStats {
  const base = emptyCasinoStats();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const signed = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
  return {
    hands: count(r.hands),
    wins: count(r.wins),
    losses: count(r.losses),
    pushes: count(r.pushes),
    blackjacks: count(r.blackjacks),
    net: signed(r.net),
    bestWin: count(r.bestWin),
    streak: signed(r.streak),
    bestStreak: count(r.bestStreak),
  };
}

export function sanitizeCasinoState(raw: unknown): CasinoState {
  if (!raw || typeof raw !== "object")
    return { version: 1, stats: emptyCasinoStats() };
  const r = raw as Record<string, unknown>;
  return { version: 1, stats: sanitizeCasinoStats(r.stats) };
}

function load(): CasinoState {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(STATS_KEY)
        : null;
    return sanitizeCasinoState(raw ? JSON.parse(raw) : null);
  } catch {
    return { version: 1, stats: emptyCasinoStats() };
  }
}

function loadHand(): BlackjackHand | null {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(HAND_KEY)
        : null;
    const hand = raw ? restoreHand(JSON.parse(raw)) : null;
    return hand?.phase === "player" ? hand : null;
  } catch {
    return null;
  }
}

export const casino = writable<CasinoState>(load());
casino.subscribe((state) => {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(state));
  } catch {
    // storage full or blocked
  }
});

export const activeHand = writable<BlackjackHand | null>(loadHand());
activeHand.subscribe((hand) => {
  try {
    if (hand) localStorage.setItem(HAND_KEY, JSON.stringify(hand));
    else localStorage.removeItem(HAND_KEY);
  } catch {
    // storage full or blocked
  }
});

export function clearActiveHand(): void {
  activeHand.set(null);
}

/** Called once per settled hand, after the payout has been credited. */
export function recordHand(
  result: HandResult,
  totalWager: number,
  payout: number,
): void {
  casino.update((state) => {
    const stats = { ...state.stats };
    const net = payout - totalWager;
    stats.hands += 1;
    if (result === "win") stats.wins += 1;
    else if (result === "blackjack") {
      stats.wins += 1;
      stats.blackjacks += 1;
    } else if (result === "lose") stats.losses += 1;
    else stats.pushes += 1;

    stats.net += net;
    if (net > stats.bestWin) stats.bestWin = net;
    if (result === "win" || result === "blackjack") {
      stats.streak = stats.streak < 0 ? 1 : stats.streak + 1;
      if (stats.streak > stats.bestStreak) stats.bestStreak = stats.streak;
    } else if (result === "lose") {
      stats.streak = stats.streak > 0 ? -1 : stats.streak - 1;
    }
    return { ...state, stats };
  });
}
