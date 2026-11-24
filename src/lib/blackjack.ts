/**
 * Pure Blackjack rules. No Svelte, no storage: the table component owns the
 * wallet side effects and `casino-store.ts` owns the stats.
 *
 * Rules: 6-deck shoe, dealer stands on every 17 (including soft 17),
 * Blackjack pays 3:2, hit / stand / double, dealer peeks for Blackjack when
 * showing an Ace or a 10-value card. No split and no insurance.
 */

export type Suit = "♠" | "♥" | "♦" | "♣";
export type Rank =
  "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";

export interface Card {
  rank: Rank;
  suit: Suit;
  /** Unique within the shoe, so Svelte keyed blocks stay stable. */
  id: string;
}

export type HandResult = "win" | "lose" | "push" | "blackjack";
export type Phase = "player" | "done";

export interface BlackjackHand {
  shoe: Card[];
  player: Card[];
  dealer: Card[];
  /** The original bet, used by double-down. */
  wager: number;
  /** Total at risk: the original bet plus a double. */
  totalWager: number;
  phase: Phase;
  result: HandResult | null;
  /** Amount returned to the wallet (stake included). */
  payout: number;
  doubled: boolean;
}

export const SUITS: ReadonlyArray<Suit> = ["♠", "♥", "♦", "♣"];
export const RANKS: ReadonlyArray<Rank> = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

const TEN_VALUE = new Set<Rank>(["10", "J", "Q", "K"]);

export function createShoe(
  deckCount = 6,
  rng: () => number = Math.random,
): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ rank, suit, id: `${d}:${suit}:${rank}` });
      }
    }
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function handValue(cards: ReadonlyArray<Card>): {
  total: number;
  soft: boolean;
} {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === "A") {
      total += 1;
      aces++;
    } else if (TEN_VALUE.has(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }
  const soft = aces > 0 && total + 10 <= 21;
  return { total: soft ? total + 10 : total, soft };
}

export function isBlackjack(cards: ReadonlyArray<Card>): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

function draw(shoe: Card[]): { card: Card; shoe: Card[] } {
  if (shoe.length === 0) throw new Error("Blackjack shoe is empty");
  const next = [...shoe];
  const card = next.pop()!;
  return { card, shoe: next };
}

function resolve(hand: BlackjackHand): BlackjackHand {
  const player = handValue(hand.player).total;
  const dealer = handValue(hand.dealer).total;
  const playerBJ = isBlackjack(hand.player);
  const dealerBJ = isBlackjack(hand.dealer);
  const stake = hand.totalWager;

  let result: HandResult;
  let payout: number;
  if (player > 21) {
    result = "lose";
    payout = 0;
  } else if (dealer > 21) {
    result = "win";
    payout = stake * 2;
  } else if (playerBJ && dealerBJ) {
    result = "push";
    payout = stake;
  } else if (playerBJ) {
    result = "blackjack";
    // 3:2 on the stake, rounded down to whole XP.
    payout = Math.floor(stake + stake * 1.5);
  } else if (dealerBJ) {
    result = "lose";
    payout = 0;
  } else if (player > dealer) {
    result = "win";
    payout = stake * 2;
  } else if (player < dealer) {
    result = "lose";
    payout = 0;
  } else {
    result = "push";
    payout = stake;
  }

  return { ...hand, phase: "done", result, payout };
}

function dealerTurn(hand: BlackjackHand): BlackjackHand {
  let shoe = [...hand.shoe];
  const dealer = [...hand.dealer];
  while (handValue(dealer).total < 17) {
    const next = draw(shoe);
    dealer.push(next.card);
    shoe = next.shoe;
  }
  return { ...hand, dealer, shoe };
}

/**
 * Deal a hand. The caller should already have spent `wager`; `payout` is what
 * comes back on settle. Dealer Blackjack is revealed immediately (peek).
 */
export function startHand(
  shoe: ReadonlyArray<Card>,
  wager: number,
): BlackjackHand {
  if (!Number.isFinite(wager) || wager < 1)
    throw new Error("Blackjack wager must be at least 1 XP");
  const stake = Math.max(1, Math.floor(wager));
  let stock = shoe.length < 20 ? createShoe() : [...shoe];

  const player: Card[] = [];
  const dealer: Card[] = [];
  for (let i = 0; i < 2; i++) {
    const p = draw(stock);
    player.push(p.card);
    stock = p.shoe;
    const d = draw(stock);
    dealer.push(d.card);
    stock = d.shoe;
  }

  let hand: BlackjackHand = {
    shoe: stock,
    player,
    dealer,
    wager: stake,
    totalWager: stake,
    phase: "player",
    result: null,
    payout: 0,
    doubled: false,
  };

  if (isBlackjack(dealer) || isBlackjack(player)) return resolve(hand);
  return hand;
}

export function canDouble(hand: BlackjackHand): boolean {
  return hand.phase === "player" && !hand.doubled && hand.player.length === 2;
}

/** Take one card. Bust settles immediately; the dealer does not need to draw. */
export function hit(hand: BlackjackHand): BlackjackHand {
  if (hand.phase !== "player") return hand;
  const next = draw(hand.shoe);
  const player = [...hand.player, next.card];
  const updated = { ...hand, player, shoe: next.shoe };
  if (handValue(player).total > 21) return resolve(updated);
  return updated;
}

/** Stand: the dealer draws to 17 and the hand settles. */
export function stand(hand: BlackjackHand): BlackjackHand {
  if (hand.phase !== "player") return hand;
  return resolve(dealerTurn(hand));
}

/**
 * Double: the caller must spend another `wager` first. One card, then the
 * dealer plays and the hand settles.
 */
export function double(hand: BlackjackHand): BlackjackHand {
  if (!canDouble(hand)) return hand;
  const next = draw(hand.shoe);
  const player = [...hand.player, next.card];
  const updated: BlackjackHand = {
    ...hand,
    player,
    shoe: next.shoe,
    totalWager: hand.totalWager + hand.wager,
    doubled: true,
  };
  if (handValue(player).total > 21) return resolve(updated);
  return resolve(dealerTurn(updated));
}

/** Rebuild a persisted hand defensively (used by the local active-hand cache). */
export function restoreHand(raw: unknown): BlackjackHand | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Partial<BlackjackHand>;
  if (
    !Array.isArray(h.shoe) ||
    !Array.isArray(h.player) ||
    !Array.isArray(h.dealer) ||
    typeof h.wager !== "number" ||
    typeof h.totalWager !== "number" ||
    (h.phase !== "player" && h.phase !== "done")
  )
    return null;
  return {
    shoe: h.shoe as Card[],
    player: h.player as Card[],
    dealer: h.dealer as Card[],
    wager: h.wager,
    totalWager: h.totalWager,
    phase: h.phase,
    result: h.result ?? null,
    payout: typeof h.payout === "number" ? h.payout : 0,
    doubled: h.doubled === true,
  };
}
