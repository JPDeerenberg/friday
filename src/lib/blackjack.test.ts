import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { get } from "svelte/store";
import {
  canDouble,
  createShoe,
  double,
  handValue,
  hit,
  isBlackjack,
  stand,
  startHand,
  type Card,
  type Rank,
  type Suit,
} from "./blackjack.ts";
import { casino, emptyCasinoStats, recordHand } from "./casino-store.ts";

let nextId = 0;
const card = (rank: Rank, suit: Suit = "♠"): Card => ({
  rank,
  suit,
  id: `test-${nextId++}`,
});

/**
 * A shoe with enough filler that `startHand` does not replace it. Arguments are
 * in deal order: player, dealer, player, dealer, then extra draws.
 */
function shoeOf(...dealOrder: Card[]): Card[] {
  const filler = Array.from({ length: 24 }, (_, i) => ({
    rank: "5" as Rank,
    suit: "♣" as Suit,
    id: `filler-${i}`,
  }));
  return [...filler, ...dealOrder.reverse()];
}

describe("hand value", () => {
  it("counts aces as 11 while that stays under 22", () => {
    assert.deepEqual(handValue([card("A"), card("9")]), {
      total: 20,
      soft: true,
    });
    assert.deepEqual(handValue([card("A"), card("9"), card("5")]), {
      total: 15,
      soft: false,
    });
    assert.deepEqual(handValue([card("A"), card("A")]), {
      total: 12,
      soft: true,
    });
  });
  it("knows a natural blackjack", () => {
    assert.equal(isBlackjack([card("A"), card("K")]), true);
    assert.equal(isBlackjack([card("A"), card("9"), card("A")]), false);
    assert.equal(isBlackjack([card("10"), card("10")]), false);
  });
});

describe("shoe", () => {
  it("builds six decks with unique cards and shuffles deterministically", () => {
    const shoe = createShoe(6, () => 0.42);
    assert.equal(shoe.length, 312);
    assert.equal(new Set(shoe.map((c) => c.id)).size, 312);
    assert.deepEqual(
      shoe,
      createShoe(6, () => 0.42),
    );
  });
});

describe("settling hands", () => {
  it("pays a natural blackjack 3:2", () => {
    const hand = startHand(
      shoeOf(card("A"), card("9"), card("K"), card("7")),
      10,
    );
    assert.equal(hand.phase, "done");
    assert.equal(hand.result, "blackjack");
    assert.equal(hand.payout, 25);
  });

  it("pushes when both have blackjack", () => {
    const hand = startHand(
      shoeOf(card("A"), card("A"), card("K"), card("Q")),
      10,
    );
    assert.equal(hand.result, "push");
    assert.equal(hand.payout, 10);
  });

  it("loses to a dealer blackjack", () => {
    const hand = startHand(
      shoeOf(card("10"), card("A"), card("9"), card("K")),
      10,
    );
    assert.equal(hand.result, "lose");
    assert.equal(hand.payout, 0);
  });

  it("wins when the player stands on 19 against 17", () => {
    const hand = startHand(
      shoeOf(card("10"), card("10"), card("9"), card("7")),
      10,
    );
    assert.equal(hand.phase, "player");
    const settled = stand(hand);
    assert.equal(settled.result, "win");
    assert.equal(settled.payout, 20);
  });

  it("pushes equal totals", () => {
    const hand = startHand(
      shoeOf(card("10"), card("10"), card("8"), card("8")),
      10,
    );
    assert.equal(stand(hand).result, "push");
  });

  it("dealer stands on soft 17", () => {
    const hand = startHand(
      shoeOf(card("10"), card("A"), card("9"), card("6")),
      10,
    );
    const settled = stand(hand);
    assert.equal(settled.dealer.length, 2);
    assert.equal(handValue(settled.dealer).total, 17);
    assert.equal(settled.result, "win");
  });

  it("dealer draws until 17", () => {
    const hand = startHand(
      shoeOf(card("10"), card("10"), card("9"), card("6"), card("A")),
      10,
    );
    const settled = stand(hand);
    assert.equal(settled.dealer.length, 3);
    assert.equal(handValue(settled.dealer).total, 17);
  });

  it("busts immediately on hit", () => {
    const hand = startHand(
      shoeOf(card("10"), card("10"), card("9"), card("7"), card("K")),
      10,
    );
    const busted = hit(hand);
    assert.equal(busted.phase, "done");
    assert.equal(busted.result, "lose");
    assert.equal(busted.payout, 0);
    assert.equal(handValue(busted.player).total, 29);
  });
});

describe("double down", () => {
  it("only before a hit", () => {
    const hand = startHand(
      shoeOf(card("5"), card("10"), card("6"), card("7")),
      10,
    );
    assert.equal(canDouble(hand), true);
    const afterHit = hit(hand);
    assert.equal(canDouble(afterHit), false);
    assert.equal(double(afterHit), afterHit);
  });

  it("draws one card, doubles the stake and settles", () => {
    const hand = startHand(
      shoeOf(card("5"), card("10"), card("6"), card("7"), card("10")),
      10,
    );
    const doubled = double(hand);
    assert.equal(doubled.totalWager, 20);
    assert.equal(doubled.player.length, 3);
    assert.equal(handValue(doubled.player).total, 21);
    assert.equal(doubled.result, "win");
    assert.equal(doubled.payout, 40);
  });
});

describe("casino stats", () => {
  it("tracks hands, blackjacks, net and streaks", () => {
    casino.set({ version: 1, stats: emptyCasinoStats() });
    recordHand("win", 10, 20);
    recordHand("blackjack", 10, 25);
    recordHand("lose", 10, 0);
    recordHand("push", 10, 10);
    const stats = get(casino).stats;
    assert.equal(stats.hands, 4);
    assert.equal(stats.wins, 2);
    assert.equal(stats.losses, 1);
    assert.equal(stats.pushes, 1);
    assert.equal(stats.blackjacks, 1);
    assert.equal(stats.net, 15);
    assert.equal(stats.bestWin, 15);
    assert.equal(stats.streak, -1);
    assert.equal(stats.bestStreak, 2);
  });
});
