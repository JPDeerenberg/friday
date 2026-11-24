<script lang="ts">
  /**
   * Home-screen Blackjack table. Bets are paid from the shared season XP
   * wallet, so a hand can win or lose XP. The current hand stays local; only
   * the table statistics sync (see casino-store.ts).
   */
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import Icon from "#lib/components/Icon.svelte";
  import {
    quests,
    spendXp,
    awardXp,
    recordQuestEvent,
  } from "#lib/quests-store.ts";
  import {
    activeHand,
    casino,
    clearActiveHand,
    recordHand,
  } from "#lib/casino-store.ts";
  import {
    canDouble,
    createShoe,
    double,
    handValue,
    hit,
    stand,
    startHand,
    type BlackjackHand,
    type Card,
  } from "#lib/blackjack.ts";

  let open = $state(false);
  let hand = $state<BlackjackHand | null>(null);
  let shoe = $state<Card[]>(createShoe());
  let bet = $state(10);

  const wallet = $derived($quests.xp);
  const stats = $derived($casino.stats);
  const playerValue = $derived(hand ? handValue(hand.player) : null);
  const dealerValue = $derived(
    hand
      ? handValue(
          hand.phase === "player" ? hand.dealer.slice(0, 1) : hand.dealer,
        )
      : null,
  );
  const finished = $derived(hand?.phase === "done");
  const inProgress = $derived(hand?.phase === "player");
  const net = $derived(hand && hand.result ? hand.payout - hand.totalWager : 0);
  const effectiveBet = $derived(
    wallet < 1 ? 0 : Math.min(wallet, Math.max(1, Math.floor(bet))),
  );

  onMount(() => {
    const saved = get(activeHand);
    if (saved) {
      hand = saved;
      shoe = saved.shoe;
    }
  });

  function start(): void {
    const stake = Math.min(effectiveBet, wallet);
    if (stake < 1) return;
    bet = stake;
    if (!spendXp(stake)) return;
    const next = startHand(shoe, stake);
    shoe = next.shoe;
    setHand(next);
    recordQuestEvent("blackjack_played");
  }

  function setHand(next: BlackjackHand): void {
    hand = next;
    if (next.phase === "player") activeHand.set(next);
    else settle(next);
  }

  function settle(next: BlackjackHand): void {
    if (!next.result) return;
    awardXp(next.payout);
    recordHand(next.result, next.totalWager, next.payout);
    if (next.result === "win" || next.result === "blackjack")
      recordQuestEvent("blackjack_won");
    activeHand.set(null);
  }

  function doHit(): void {
    if (hand) setHand(hit(hand));
  }
  function doStand(): void {
    if (hand) setHand(stand(hand));
  }
  function doDouble(): void {
    if (!hand || !canDouble(hand)) return;
    if (!spendXp(hand.wager)) return;
    setHand(double(hand));
  }

  function close(): void {
    open = false;
  }

  function resultText(h: BlackjackHand): string {
    const diff = h.payout - h.totalWager;
    if (h.result === "blackjack") return `Blackjack! +${diff} XP`;
    if (h.result === "win") return `Gewonnen! +${diff} XP`;
    if (h.result === "push") return "Gelijk. Je inzet komt terug.";
    if (h.result === "lose") return `Verloren. −${h.totalWager} XP`;
    return "";
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && open) close();
  }}
/>

<section class="bj" aria-label="Blackjack">
  <div class="head">
    <h2><Icon name="gamepad" size={18} /> Blackjack</h2>
    <span class="balance tabular-nums">{$quests.xp} XP</span>
  </div>
  <p class="blurb">
    Waag een paar XP, versla de dealer en win er meer. Verlies je? Dan gaat er
    XP van je seizoen af.
  </p>
  <div class="mini-stats tabular-nums">
    <span><b>{stats.wins}</b> gewonnen</span>
    <span><b>{stats.losses}</b> verloren</span>
    <span><b>{stats.pushes}</b> gelijk</span>
  </div>
  <button
    type="button"
    class="play"
    onclick={() => {
      open = true;
      hand = get(activeHand);
      if (hand) shoe = hand.shoe;
    }}
  >
    <Icon name="cards" size={16} />
    {inProgress ? "Ga verder" : "Speel Blackjack"}
  </button>
</section>

{#if open}
  <div class="overlay">
    <button type="button" class="backdrop" aria-label="Sluiten" onclick={close}
    ></button>
    <div
      class="table"
      role="dialog"
      aria-modal="true"
      aria-label="Blackjack"
      tabindex="-1"
    >
      <header>
        <h3><Icon name="gamepad" size={18} /> Blackjack</h3>
        <span class="wallet tabular-nums"
          ><Icon name="coin" size={14} /> {wallet} XP</span
        >
        <button type="button" class="x" onclick={close} aria-label="Sluiten">
          <Icon name="x-circle" size={20} />
        </button>
      </header>

      <div class="felt">
        <div class="side">
          <span class="label">Dealer</span>
          <span class="value tabular-nums">
            {#if dealerValue}
              {dealerValue.total}{dealerValue.soft ? " zacht" : ""}
              {#if hand?.phase === "player"}<span class="hidden-total">+ ?</span
                >{/if}
            {:else}—{/if}
          </span>
        </div>
        <div class="cards">
          {#if hand}
            {#each hand.dealer as card, i (card.id)}
              {#if i === 1 && hand.phase === "player"}
                <span class="card back" aria-label="Onbekende kaart"></span>
              {:else}
                <span
                  class="card"
                  class:red={card.suit === "♥" || card.suit === "♦"}
                  aria-label="{card.rank} {card.suit}"
                >
                  <b>{card.rank}</b><i>{card.suit}</i>
                </span>
              {/if}
            {/each}
          {:else}
            <span class="card back"></span><span class="card back"></span>
          {/if}
        </div>

        <div class="side player">
          <span class="label">Jij</span>
          <span class="value tabular-nums">
            {#if playerValue}
              {playerValue.total}{playerValue.soft ? " zacht" : ""}
            {:else}—{/if}
          </span>
        </div>
        <div class="cards">
          {#if hand}
            {#each hand.player as card (card.id)}
              <span
                class="card"
                class:red={card.suit === "♥" || card.suit === "♦"}
                aria-label="{card.rank} {card.suit}"
              >
                <b>{card.rank}</b><i>{card.suit}</i>
              </span>
            {/each}
          {:else}
            <span class="card back"></span><span class="card back"></span>
          {/if}
        </div>

        {#if hand?.result}
          <p class="result" class:good={net > 0} class:bad={net < 0}>
            {resultText(hand)}
          </p>
        {:else if hand}
          <p class="result muted tabular-nums">
            Inzet {hand.totalWager} XP · nog {hand.shoe.length} kaarten in de shoe
          </p>
        {/if}
      </div>

      {#if hand && hand.phase === "player"}
        <div class="actions">
          <button type="button" class="hit" onclick={doHit}>
            <Icon name="plus" size={16} /> Kaart
          </button>
          <button type="button" class="stay" onclick={doStand}>
            <Icon name="stop" size={16} /> Pas
          </button>
          <button
            type="button"
            class="dbl"
            onclick={doDouble}
            disabled={!canDouble(hand) || wallet < hand.wager}
          >
            <Icon name="zap" size={16} /> Dubbel
          </button>
        </div>
      {:else}
        <div class="betting">
          <p class="bet-label">
            {#if finished}Nog een potje?{:else}Kies je inzet{/if}
            <b class="tabular-nums">{effectiveBet} XP</b>
          </p>
          <div class="chips">
            {#each [5, 10, 25, 50] as amount (amount)}
              <button
                type="button"
                class="chip"
                class:active={effectiveBet === amount}
                disabled={amount > wallet}
                onclick={() => (bet = amount)}
              >
                {amount}
              </button>
            {/each}
            <button
              type="button"
              class="chip all"
              class:active={effectiveBet === wallet && wallet > 0}
              disabled={wallet < 1}
              onclick={() => (bet = wallet)}
            >
              All-in
            </button>
          </div>
          <button
            type="button"
            class="deal"
            disabled={wallet < 1 || effectiveBet < 1}
            onclick={start}
          >
            <Icon name="cards" size={16} />
            {finished ? "Deel opnieuw" : "Deel kaarten"}
          </button>
          {#if wallet < 1}
            <p class="broke">
              Je hebt geen XP meer. Verdien er een paar met missies of cijfers.
            </p>
          {/if}
        </div>
      {/if}

      <footer class="stats tabular-nums">
        <span><b>{stats.hands}</b> potjes</span>
        <span><b>{stats.blackjacks}</b> blackjacks</span>
        <span>
          netto <b class:good={stats.net > 0} class:bad={stats.net < 0}
            >{stats.net >= 0 ? "+" : ""}{stats.net}</b
          >
        </span>
        {#if stats.bestStreak > 1}<span><b>{stats.bestStreak}</b> op rij</span
          >{/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .bj {
    border-radius: 1.5rem;
    padding: 1.1rem 1.2rem 1rem;
    color: white;
    border: 1px solid color-mix(in oklch, white, transparent 92%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }
  h2 {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 1.15rem;
    font-weight: 800;
  }
  .balance {
    font-size: 0.85rem;
    font-weight: 700;
    color: rgb(252 211 77);
  }
  .blurb {
    font-size: 0.8rem;
    line-height: 1.35;
    color: rgb(156 163 175);
  }
  .mini-stats {
    display: flex;
    gap: 0.7rem;
    font-size: 0.72rem;
    color: rgb(156 163 175);
  }
  .mini-stats b {
    color: rgb(229 231 235);
  }
  .play,
  .deal {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border-radius: 0.9rem;
    padding: 0.6rem 0.9rem;
    font-weight: 800;
    background: linear-gradient(135deg, #059669, #10b981);
    color: white;
  }
  .play:active,
  .deal:active {
    transform: scale(0.98);
  }
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(0 0 0 / 0.68);
    backdrop-filter: blur(4px);
  }
  .backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: default;
  }
  .table {
    position: relative;
    width: min(34rem, 100%);
    max-height: min(46rem, 92vh);
    overflow-y: auto;
    border-radius: 1.6rem;
    padding: 1rem;
    color: white;
    border: 1px solid color-mix(in oklch, white, transparent 88%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 8%);
    box-shadow: 0 30px 80px -20px rgb(0 0 0 / 0.8);
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  header h3 {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 1.1rem;
    font-weight: 800;
  }
  .wallet {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.82rem;
    font-weight: 700;
    color: rgb(252 211 77);
  }
  .x {
    color: rgb(156 163 175);
    padding: 0.2rem;
  }
  .felt {
    border-radius: 1.2rem;
    padding: 0.9rem;
    background:
      radial-gradient(circle at 50% 0%, rgb(16 185 129 / 0.2), transparent 65%),
      linear-gradient(160deg, #064e3b, #022c22);
    border: 1px solid rgb(16 185 129 / 0.22);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .side {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 0.75rem;
    color: rgb(167 243 208);
  }
  .side.player {
    margin-top: 0.3rem;
    color: rgb(196 181 253);
  }
  .label {
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .value {
    font-weight: 800;
    color: white;
  }
  .hidden-total {
    color: rgb(167 243 208 / 0.7);
    font-weight: 600;
  }
  .cards {
    display: flex;
    gap: 0.4rem;
    min-height: 4.6rem;
  }
  .card {
    width: 3.2rem;
    height: 4.5rem;
    border-radius: 0.55rem;
    background: #f8fafc;
    color: #111827;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.1rem;
    font-weight: 900;
    box-shadow: 0 6px 16px -8px rgb(0 0 0 / 0.8);
  }
  .card b {
    font-size: 1.15rem;
    line-height: 1;
  }
  .card i {
    font-style: normal;
    font-size: 1rem;
    line-height: 1;
  }
  .card.red {
    color: #dc2626;
  }
  .card.back {
    background: repeating-linear-gradient(
      45deg,
      #4338ca 0 4px,
      #3730a3 4px 8px
    );
    border: 2px solid #c7d2fe;
  }
  .result {
    text-align: center;
    font-weight: 800;
    font-size: 0.95rem;
  }
  .result.good {
    color: rgb(110 231 183);
  }
  .result.bad {
    color: rgb(252 165 165);
  }
  .result.muted {
    color: rgb(167 243 208 / 0.75);
    font-weight: 600;
    font-size: 0.75rem;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.45rem;
  }
  .actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    border-radius: 0.8rem;
    padding: 0.65rem 0.4rem;
    font-weight: 800;
    font-size: 0.85rem;
    color: white;
  }
  .hit {
    background: #2563eb;
  }
  .stay {
    background: #7c3aed;
  }
  .dbl {
    background: #b45309;
  }
  .actions button:disabled,
  .deal:disabled,
  .chip:disabled {
    opacity: 0.4;
  }
  .betting {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .bet-label {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: rgb(156 163 175);
  }
  .bet-label b {
    color: rgb(252 211 77);
  }
  .chips {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .chip {
    flex: 1;
    min-width: 3rem;
    border-radius: 9999px;
    padding: 0.45rem 0.5rem;
    font-size: 0.8rem;
    font-weight: 800;
    color: rgb(229 231 235);
    background: color-mix(in oklch, white, transparent 90%);
    border: 1px solid transparent;
  }
  .chip.active {
    border-color: rgb(252 211 77);
    color: rgb(252 211 77);
  }
  .chip.all {
    flex-basis: 100%;
  }
  .broke {
    font-size: 0.75rem;
    color: rgb(252 165 165);
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem;
    font-size: 0.72rem;
    color: rgb(156 163 175);
  }
  .stats b {
    color: rgb(229 231 235);
  }
  .good {
    color: rgb(110 231 183);
  }
  .bad {
    color: rgb(252 165 165);
  }
</style>
