<script lang="ts">
  /**
   * Home-screen Blackjack table. Bets are paid from the shared season XP
   * wallet, so a hand can win or lose XP. The current hand stays local; only
   * the table statistics sync (see casino-store.ts).
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import { get } from "svelte/store";
  import Icon from "#lib/components/Icon.svelte";
  import { FxEngine } from "#lib/fx.ts";
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
  let fxCanvas: HTMLCanvasElement | undefined = $state();
  let feltEl: HTMLDivElement | undefined = $state();
  let flashTone = $state<"gold" | "red" | "blue" | null>(null);
  let flashKey = $state(0);
  let shake = $state<"win" | "loss" | null>(null);
  let shownWallet = $state(get(quests).xp);
  let fxCtx: FxEngine | undefined;
  let fxTimers: number[] = [];
  let walletRaf = 0;
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Deterministic indices; the CSS spreads the coins across the table. */
  const coinRain = Array.from({ length: 18 }, (_, i) => i);

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

  // Count the wallet up/down instead of snapping, so a payout visibly lands.
  $effect(() => {
    const target = $quests.xp;
    const from = untrack(() => shownWallet);
    if (from === target) return;
    cancelAnimationFrame(walletRaf);
    const started = performance.now();
    const duration = 480;
    const step = (now: number) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      shownWallet = Math.round(from + (target - from) * eased);
      if (p < 1) walletRaf = requestAnimationFrame(step);
    };
    walletRaf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(walletRaf);
  });

  // The canvas only exists while the table is open. Re-create the engine then.
  $effect(() => {
    if (!open || reduced || !fxCanvas) return;
    const engine = new FxEngine(fxCanvas);
    fxCtx = engine;
    return () => {
      if (fxCtx === engine) fxCtx = undefined;
      engine.destroy();
    };
  });

  onDestroy(() => {
    clearFxTimers();
    cancelAnimationFrame(walletRaf);
  });

  onMount(() => {
    const saved = get(activeHand);
    if (saved) {
      hand = saved;
      shoe = saved.shoe;
    }
  });

  function clearFxTimers(): void {
    fxTimers.forEach((id) => window.clearTimeout(id));
    fxTimers = [];
  }

  function afterFx(ms: number, fn: () => void): void {
    fxTimers.push(window.setTimeout(fn, ms));
  }

  function fxCenter(): { x: number; y: number } {
    const c = fxCanvas?.getBoundingClientRect();
    const f = feltEl?.getBoundingClientRect();
    if (!c || !f) return { x: 0, y: 0 };
    return {
      x: f.left - c.left + f.width / 2,
      y: f.top - c.top + f.height / 2,
    };
  }

  function clearOutcome(): void {
    clearFxTimers();
    fxCtx?.clear();
    flashTone = null;
    shake = null;
  }

  function playOutcomeFx(result: NonNullable<BlackjackHand["result"]>): void {
    const f = fxCtx;
    if (!f || reduced) return;
    clearFxTimers();
    f.clear();
    const { x, y } = fxCenter();
    flashKey++;
    flashTone = result === "lose" ? "red" : result === "push" ? "blue" : "gold";

    // Restart the shake even when the previous hand had the same result.
    shake = null;
    const shakeTone = result === "lose" ? "loss" : "win";
    afterFx(20, () => {
      shake = shakeTone;
    });
    afterFx(720, () => {
      shake = null;
    });
    afterFx(700, () => {
      flashTone = null;
    });

    if (result === "blackjack") {
      f.freeze(70);
      f.shockRing(x, y, "#fde68a", {
        radius: 10,
        speed: 1250,
        width: 4.5,
        life: 0.9,
      });
      f.shockRing(x, y, "#fff7d6", {
        radius: 4,
        speed: 760,
        width: 2.5,
        life: 0.7,
      });
      f.burst(x, y, {
        count: 170,
        color: "#fbbf24",
        color2: "#fff7d6",
        speed: 560,
        size: 6,
        life: 1.5,
        shape: "star",
      });
      f.burst(x, y, {
        count: 90,
        color: "#f472b6",
        color2: "#22d3ee",
        speed: 430,
        size: 5,
        gravity: 110,
        shape: "ribbon",
        life: 1.9,
      });
      f.confetti(150, [
        "#fbbf24",
        "#fde68a",
        "#fff7d6",
        "#f472b6",
        "#22d3ee",
        "#a7f3d0",
      ]);
      f.setLoop("goldrain", true, {
        rate: 48,
        color: "#fde68a",
        color2: "#fbbf24",
      });
      afterFx(3600, () => {
        if (fxCtx === f) f.setLoop("goldrain", false);
      });
      for (let i = 0; i < 7; i++) {
        afterFx(i * 90, () => {
          if (fxCtx !== f) return;
          f.bolt(
            x + (Math.random() - 0.5) * 120,
            y - 180,
            x + (Math.random() - 0.5) * 420,
            y + (Math.random() - 0.5) * 320,
            "#fde68a",
          );
        });
      }
    } else if (result === "win") {
      f.freeze(45);
      f.shockRing(x, y, "#6ee7b7", {
        radius: 8,
        speed: 900,
        width: 3.5,
        life: 0.8,
      });
      f.burst(x, y, {
        count: 120,
        color: "#fbbf24",
        color2: "#fff7d6",
        speed: 480,
        size: 5.5,
        life: 1.3,
        shape: "star",
      });
      f.burst(x, y, {
        count: 46,
        color: "#34d399",
        color2: "#a7f3d0",
        speed: 350,
        size: 4.5,
        gravity: 100,
        shape: "leaf",
        life: 1.7,
      });
      f.confetti(90, ["#fbbf24", "#fde68a", "#34d399", "#fff7d6"]);
      f.setLoop("goldrain", true, {
        rate: 26,
        color: "#fde68a",
        color2: "#fbbf24",
      });
      afterFx(2400, () => {
        if (fxCtx === f) f.setLoop("goldrain", false);
      });
    } else if (result === "push") {
      f.shockRing(x, y, "#93c5fd", {
        radius: 8,
        speed: 700,
        width: 3,
        life: 0.7,
      });
      f.burst(x, y, {
        count: 52,
        color: "#93c5fd",
        color2: "#e0f2fe",
        speed: 260,
        size: 4,
        gravity: 80,
        life: 1.1,
      });
    } else {
      f.freeze(50);
      f.shockRing(x, y, "#f87171", {
        radius: 8,
        speed: 900,
        width: 3.5,
        life: 0.8,
      });
      f.burst(x, y, {
        count: 90,
        color: "#ef4444",
        color2: "#fca5a5",
        speed: 460,
        size: 4.5,
        gravity: 620,
        shape: "shard",
        life: 1.2,
      });
      f.burst(x, y, {
        count: 34,
        color: "#7f1d1d",
        color2: "#ef4444",
        speed: 180,
        size: 5,
        gravity: 120,
        shape: "bokeh",
        life: 1.8,
      });
      f.setLoop("embers", true, {
        rate: 18,
        color: "#ef4444",
        color2: "#fca5a5",
      });
      afterFx(1700, () => {
        if (fxCtx === f) f.setLoop("embers", false);
      });
    }
  }

  function outcomeTitle(h: BlackjackHand): string {
    if (h.result === "blackjack") return "BLACKJACK";
    if (h.result === "win") return "GEWONNEN";
    if (h.result === "push") return "GELIJK";
    return "VERLOREN";
  }

  function outcomeKicker(h: BlackjackHand): string {
    if (h.result === "blackjack") return "Natuurlijke 21";
    if (h.result === "win") return "De dealer is verslagen";
    if (h.result === "push") return "Dealer en jij gelijk";
    return "De dealer wint deze";
  }

  function start(): void {
    const stake = Math.min(effectiveBet, wallet);
    if (stake < 1) return;
    clearOutcome();
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
    playOutcomeFx(next.result);
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
    clearOutcome();
    open = false;
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
    <span class="balance tabular-nums">{shownWallet} XP</span>
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
      class:win={hand?.result === "win"}
      class:loss={hand?.result === "lose"}
      class:push={hand?.result === "push"}
      class:jackpot={hand?.result === "blackjack"}
      role="dialog"
      aria-modal="true"
      aria-label="Blackjack"
      tabindex="-1"
    >
      <canvas bind:this={fxCanvas} class="fx" aria-hidden="true"></canvas>

      {#if hand?.result === "blackjack"}
        <div class="coin-rain" aria-hidden="true">
          {#each coinRain as i (i)}
            <span class="coin" style="--i:{i}"
              ><Icon name="coin" size={16} /></span
            >
          {/each}
        </div>
      {/if}

      {#if flashTone}
        {#key flashKey}
          <div class="flash {flashTone}" aria-hidden="true"></div>
        {/key}
      {/if}

      <header>
        <h3><Icon name="gamepad" size={18} /> Blackjack</h3>
        <span class="wallet tabular-nums"
          ><Icon name="coin" size={14} /> {shownWallet} XP</span
        >
        <button type="button" class="x" onclick={close} aria-label="Sluiten">
          <Icon name="x-circle" size={20} />
        </button>
      </header>

      <div
        class="felt"
        bind:this={feltEl}
        class:win={hand?.result === "win"}
        class:loss={hand?.result === "lose"}
        class:push={hand?.result === "push"}
        class:jackpot={hand?.result === "blackjack"}
        class:shake-win={shake === "win"}
        class:shake-loss={shake === "loss"}
      >
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
        <div class="cards dealer">
          {#if hand}
            {#each hand.dealer as card, i (card.id)}
              {#if i === 1 && hand.phase === "player"}
                <span
                  class="card back"
                  style="--i:{i}"
                  aria-label="Onbekende kaart"
                ></span>
              {:else}
                <span
                  class="card"
                  style="--i:{i}"
                  class:reveal={i === 1 && hand.phase !== "player"}
                  class:red={card.suit === "♥" || card.suit === "♦"}
                  aria-label="{card.rank} {card.suit}"
                >
                  <b>{card.rank}</b><i>{card.suit}</i>
                </span>
              {/if}
            {/each}
          {:else}
            <span class="card back" style="--i:0"></span><span
              class="card back"
              style="--i:1"
            ></span>
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
        <div class="cards player">
          {#if hand}
            {#each hand.player as card, i (card.id)}
              <span
                class="card"
                style="--i:{i}"
                class:red={card.suit === "♥" || card.suit === "♦"}
                aria-label="{card.rank} {card.suit}"
              >
                <b>{card.rank}</b><i>{card.suit}</i>
              </span>
            {/each}
          {:else}
            <span class="card back" style="--i:0"></span><span
              class="card back"
              style="--i:1"
            ></span>
          {/if}
        </div>

        {#if hand && hand.result}
          {#key hand}
            <div
              class="outcome"
              class:win={hand.result === "win"}
              class:loss={hand.result === "lose"}
              class:push={hand.result === "push"}
              class:jackpot={hand.result === "blackjack"}
              aria-live="polite"
            >
              <span class="outcome-kicker">{outcomeKicker(hand)}</span>
              <strong class="outcome-title">{outcomeTitle(hand)}</strong>
              <span
                class="outcome-xp tabular-nums"
                class:plus={net > 0}
                class:minus={net < 0}
              >
                {net > 0 ? "+" : ""}{net} XP
              </span>
              {#if hand.result === "push"}
                <span class="outcome-sub">Je inzet komt terug.</span>
              {/if}
            </div>
          {/key}
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
    position: relative;
    isolation: isolate;
    overflow: hidden;
    border-radius: 1.5rem;
    padding: 1.1rem 1.2rem 1rem;
    color: white;
    border: 1px solid color-mix(in oklch, white, transparent 92%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    transition:
      border-color 0.25s ease,
      box-shadow 0.25s ease;
  }
  .bj::before {
    content: "";
    position: absolute;
    inset: -55%;
    z-index: 0;
    pointer-events: none;
    background: conic-gradient(
      from 0deg,
      transparent 0deg,
      rgb(16 185 129 / 0.16) 55deg,
      transparent 120deg,
      rgb(251 191 36 / 0.1) 210deg,
      transparent 300deg
    );
    animation: bj-aura 9s linear infinite;
  }
  .bj > * {
    position: relative;
    z-index: 1;
  }
  .bj:hover {
    border-color: rgb(16 185 129 / 0.45);
    box-shadow: 0 18px 45px -28px rgb(16 185 129 / 0.8);
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
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border-radius: 0.9rem;
    padding: 0.6rem 0.9rem;
    font-weight: 800;
    background: linear-gradient(135deg, #059669, #10b981);
    color: white;
    transition:
      transform 0.16s ease,
      box-shadow 0.16s ease,
      filter 0.16s ease;
  }
  .play::after,
  .deal::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      110deg,
      transparent 30%,
      rgb(255 255 255 / 0.28) 50%,
      transparent 70%
    );
    transform: translateX(-130%);
    pointer-events: none;
  }
  .play:hover,
  .deal:hover {
    filter: brightness(1.08);
    box-shadow: 0 10px 26px -14px rgb(16 185 129 / 0.9);
  }
  .play:hover::after,
  .deal:hover::after {
    animation: button-shine 0.8s ease-out;
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
    isolation: isolate;
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
    transition:
      border-color 0.3s ease,
      box-shadow 0.3s ease;
  }
  .table.win {
    border-color: rgb(251 191 36 / 0.55);
    box-shadow:
      0 0 0 1px rgb(251 191 36 / 0.18),
      0 0 90px -28px rgb(251 191 36 / 0.85),
      0 30px 80px -20px rgb(0 0 0 / 0.8);
  }
  .table.loss {
    border-color: rgb(248 113 113 / 0.5);
    box-shadow:
      0 0 0 1px rgb(248 113 113 / 0.14),
      0 0 80px -28px rgb(239 68 68 / 0.75),
      0 30px 80px -20px rgb(0 0 0 / 0.8);
  }
  .table.push {
    border-color: rgb(147 197 253 / 0.45);
    box-shadow:
      0 0 0 1px rgb(147 197 253 / 0.12),
      0 0 70px -30px rgb(96 165 250 / 0.65),
      0 30px 80px -20px rgb(0 0 0 / 0.8);
  }
  .table.jackpot {
    border-color: rgb(253 230 138 / 0.85);
    animation: jackpot-border 1.3s ease-in-out infinite alternate;
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
    position: relative;
    isolation: isolate;
    overflow: hidden;
    border-radius: 1.2rem;
    padding: 0.9rem;
    background:
      radial-gradient(circle at 50% 0%, rgb(16 185 129 / 0.2), transparent 65%),
      linear-gradient(160deg, #064e3b, #022c22);
    border: 1px solid rgb(16 185 129 / 0.22);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    transition:
      border-color 0.35s ease,
      box-shadow 0.35s ease,
      filter 0.35s ease;
  }
  .felt::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: linear-gradient(
      115deg,
      transparent 30%,
      rgb(255 255 255 / 0.12) 48%,
      transparent 66%
    );
    transform: translateX(-130%);
  }
  .felt > * {
    position: relative;
    z-index: 1;
  }
  .felt.win {
    border-color: rgb(251 191 36 / 0.5);
    box-shadow: inset 0 0 70px rgb(251 191 36 / 0.12);
  }
  .felt.win::before,
  .felt.jackpot::before {
    animation: felt-sheen 1.6s ease-out;
  }
  .felt.loss {
    border-color: rgb(248 113 113 / 0.45);
    box-shadow: inset 0 0 70px rgb(239 68 68 / 0.16);
    filter: saturate(0.78);
  }
  .felt.push {
    border-color: rgb(147 197 253 / 0.4);
    box-shadow: inset 0 0 60px rgb(96 165 250 / 0.1);
  }
  .felt.jackpot {
    border-color: rgb(253 230 138 / 0.75);
    background:
      radial-gradient(circle at 50% 0%, rgb(251 191 36 / 0.3), transparent 60%),
      radial-gradient(
        circle at 50% 110%,
        rgb(16 185 129 / 0.35),
        transparent 65%
      ),
      linear-gradient(160deg, #064e3b, #022c22);
    box-shadow:
      inset 0 0 80px rgb(251 191 36 / 0.18),
      0 0 50px -18px rgb(251 191 36 / 0.65);
  }
  .felt.shake-win {
    animation: table-shake-win 0.62s cubic-bezier(0.36, 0.07, 0.19, 0.97);
  }
  .felt.shake-loss {
    animation: table-shake-loss 0.5s cubic-bezier(0.36, 0.07, 0.19, 0.97);
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
    perspective: 900px;
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
    transform-origin: center bottom;
    animation: deal-in 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.18) both;
    animation-delay: calc(var(--i, 0) * 45ms);
    transition:
      transform 0.18s ease,
      box-shadow 0.18s ease;
    will-change: transform, opacity;
  }
  .cards.dealer .card {
    animation-name: deal-in-dealer;
  }
  .cards.dealer .card.reveal {
    animation: card-reveal 0.44s cubic-bezier(0.2, 0.9, 0.25, 1.15) both;
  }
  .cards.player .card {
    animation-name: deal-in-player;
  }
  .card:hover {
    transform: translateY(-3px) rotate(-1deg);
    box-shadow: 0 12px 22px -10px rgb(0 0 0 / 0.9);
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
    box-shadow:
      inset 0 0 0 2px rgb(255 255 255 / 0.08),
      0 6px 16px -8px rgb(0 0 0 / 0.8);
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
  .outcome {
    position: relative;
    overflow: hidden;
    display: grid;
    justify-items: center;
    gap: 0.04rem;
    margin-top: 0.15rem;
    padding: 0.46rem 0.7rem 0.52rem;
    border-radius: 0.9rem;
    text-align: center;
    border: 1px solid rgb(255 255 255 / 0.1);
    background: radial-gradient(
      circle at 50% 0%,
      rgb(255 255 255 / 0.1),
      transparent 70%
    );
    animation: outcome-in 0.52s cubic-bezier(0.16, 1.35, 0.35, 1) both;
  }
  .outcome.win {
    border-color: rgb(251 191 36 / 0.4);
    background:
      radial-gradient(
        circle at 50% 0%,
        rgb(251 191 36 / 0.28),
        transparent 72%
      ),
      rgb(6 78 59 / 0.5);
    box-shadow:
      inset 0 0 30px rgb(251 191 36 / 0.14),
      0 0 34px -12px rgb(251 191 36 / 0.7);
  }
  .outcome.loss {
    border-color: rgb(248 113 113 / 0.4);
    background:
      radial-gradient(circle at 50% 0%, rgb(239 68 68 / 0.3), transparent 72%),
      rgb(69 10 10 / 0.45);
    box-shadow:
      inset 0 0 30px rgb(239 68 68 / 0.16),
      0 0 34px -14px rgb(239 68 68 / 0.7);
  }
  .outcome.push {
    border-color: rgb(147 197 253 / 0.35);
    background:
      radial-gradient(
        circle at 50% 0%,
        rgb(96 165 250 / 0.24),
        transparent 72%
      ),
      rgb(30 58 138 / 0.35);
  }
  .outcome.jackpot {
    border-color: rgb(253 230 138 / 0.65);
    background:
      radial-gradient(
        circle at 50% 0%,
        rgb(251 191 36 / 0.42),
        transparent 74%
      ),
      rgb(6 78 59 / 0.55);
    box-shadow:
      inset 0 0 40px rgb(251 191 36 / 0.22),
      0 0 44px -10px rgb(251 191 36 / 0.85);
  }
  .outcome.jackpot::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 26rem;
    height: 26rem;
    z-index: -1;
    pointer-events: none;
    background: repeating-conic-gradient(
      from 0deg,
      rgb(255 247 214 / 0.24) 0deg 7deg,
      transparent 7deg 19deg
    );
    mask-image: radial-gradient(circle, #000 0%, transparent 67%);
    animation: rays-spin 5.5s linear infinite;
  }
  .outcome.jackpot::after {
    content: "";
    position: absolute;
    inset: 0;
    border: 1px solid rgb(253 230 138 / 0.55);
    border-radius: inherit;
    pointer-events: none;
    animation: outcome-ring 1.5s ease-out infinite;
  }
  .outcome-kicker {
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgb(209 250 229 / 0.78);
  }
  .outcome-title {
    font-size: 1.42rem;
    font-weight: 900;
    line-height: 1;
    letter-spacing: 0.05em;
    color: #f8fafc;
    text-shadow: 0 2px 0 rgb(0 0 0 / 0.25);
    animation: outcome-title-in 0.46s 0.04s cubic-bezier(0.2, 1.6, 0.4, 1) both;
  }
  .outcome.win .outcome-title {
    color: #fde68a;
    text-shadow:
      0 1px 0 rgb(120 53 15 / 0.45),
      0 0 18px rgb(251 191 36 / 0.45);
  }
  .outcome.loss .outcome-title {
    color: #fca5a5;
    text-shadow: 0 0 16px rgb(239 68 68 / 0.35);
    animation: loss-slam 0.5s cubic-bezier(0.2, 1.2, 0.4, 1) both;
  }
  .outcome.jackpot .outcome-title {
    font-size: clamp(1.7rem, 8vw, 2.15rem);
    letter-spacing: 0.03em;
    color: transparent;
    background: linear-gradient(180deg, #fff7d6 8%, #fbbf24 58%, #f59e0b);
    -webkit-background-clip: text;
    background-clip: text;
    filter: drop-shadow(0 2px 0 rgb(120 53 15 / 0.55))
      drop-shadow(0 0 14px rgb(251 191 36 / 0.65));
    animation: jackpot-slam 0.82s cubic-bezier(0.16, 1.4, 0.3, 1) both;
  }
  .outcome-xp {
    font-size: 0.95rem;
    font-weight: 900;
    color: rgb(253 230 138);
    animation: xp-pop 0.6s 0.1s cubic-bezier(0.2, 1.5, 0.4, 1) both;
  }
  .outcome-xp.minus {
    color: rgb(252 165 165);
  }
  .outcome-sub {
    font-size: 0.68rem;
    color: rgb(191 219 254 / 0.8);
  }
  .fx {
    position: absolute;
    inset: 0;
    z-index: 30;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    pointer-events: none;
  }
  .coin-rain {
    position: absolute;
    inset: 0;
    z-index: 20;
    overflow: hidden;
    border-radius: inherit;
    pointer-events: none;
  }
  .coin {
    position: absolute;
    top: -1.5rem;
    left: calc(4% + (var(--i) * 5.2%));
    color: #fbbf24;
    filter: drop-shadow(0 0 7px rgb(251 191 36 / 0.8));
    animation: coin-fall 1.65s cubic-bezier(0.2, 0.7, 0.4, 1) both;
    animation-delay: calc(var(--i) * 55ms);
  }
  .flash {
    position: absolute;
    inset: 0;
    z-index: 40;
    border-radius: inherit;
    pointer-events: none;
    animation: flash-out 0.62s ease-out both;
  }
  .flash.gold {
    background: radial-gradient(
      circle at 50% 42%,
      rgb(255 247 214 / 0.95),
      rgb(251 191 36 / 0.38) 34%,
      transparent 70%
    );
  }
  .flash.red {
    background: radial-gradient(
      circle at 50% 45%,
      rgb(254 226 226 / 0.8),
      rgb(239 68 68 / 0.4) 38%,
      transparent 72%
    );
  }
  .flash.blue {
    background: radial-gradient(
      circle at 50% 45%,
      rgb(219 234 254 / 0.8),
      rgb(96 165 250 / 0.3) 38%,
      transparent 72%
    );
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
    transition:
      transform 0.15s ease,
      filter 0.15s ease,
      box-shadow 0.15s ease;
  }
  .actions button:hover:not(:disabled) {
    transform: translateY(-1px);
    filter: brightness(1.1);
    box-shadow: 0 8px 18px -12px rgb(0 0 0 / 0.9);
  }
  .actions button:active:not(:disabled) {
    transform: scale(0.97);
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
    transition:
      transform 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .chip:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: rgb(255 255 255 / 0.22);
  }
  .chip.active {
    border-color: rgb(252 211 77);
    color: rgb(252 211 77);
    box-shadow:
      inset 0 0 14px rgb(252 211 77 / 0.12),
      0 0 16px -8px rgb(252 211 77 / 0.85);
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
  @keyframes bj-aura {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes button-shine {
    from {
      transform: translateX(-130%);
    }
    to {
      transform: translateX(130%);
    }
  }
  @keyframes jackpot-border {
    from {
      border-color: rgb(253 230 138 / 0.45);
      box-shadow:
        0 0 0 1px rgb(253 230 138 / 0.1),
        0 0 60px -30px rgb(251 191 36 / 0.65),
        0 30px 80px -20px rgb(0 0 0 / 0.8);
    }
    to {
      border-color: rgb(253 230 138 / 0.95);
      box-shadow:
        0 0 0 1px rgb(253 230 138 / 0.3),
        0 0 110px -24px rgb(251 191 36 / 1),
        0 30px 80px -20px rgb(0 0 0 / 0.8);
    }
  }
  @keyframes felt-sheen {
    0% {
      transform: translateX(-130%);
    }
    100% {
      transform: translateX(130%);
    }
  }
  @keyframes deal-in-dealer {
    0% {
      opacity: 0;
      transform: translate3d(0, -2.4rem, 0) rotateY(-88deg) rotate(-14deg)
        scale(0.68);
      filter: blur(4px);
    }
    55% {
      opacity: 1;
    }
    100% {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes deal-in-player {
    0% {
      opacity: 0;
      transform: translate3d(0, 2.2rem, 0) rotateY(88deg) rotate(12deg)
        scale(0.68);
      filter: blur(4px);
    }
    55% {
      opacity: 1;
    }
    100% {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes card-reveal {
    0% {
      opacity: 0.35;
      transform: rotateY(88deg) scale(0.94);
      filter: brightness(1.6) blur(2px);
    }
    100% {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes deal-in {
    0% {
      opacity: 0;
      transform: translate3d(0, -1.6rem, 0) rotateY(-70deg) scale(0.7);
      filter: blur(4px);
    }
    100% {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes outcome-in {
    0% {
      opacity: 0;
      transform: translateY(12px) scale(0.72);
      filter: blur(7px);
    }
    60% {
      opacity: 1;
      transform: translateY(-1px) scale(1.03);
      filter: none;
    }
    100% {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes outcome-title-in {
    0% {
      opacity: 0;
      transform: scale(1.7);
    }
    65% {
      opacity: 1;
      transform: scale(0.95);
    }
    100% {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes jackpot-slam {
    0% {
      opacity: 0;
      transform: scale(2.8) rotate(-8deg);
      filter: blur(8px);
    }
    48% {
      opacity: 1;
      transform: scale(0.9) rotate(1.5deg);
      filter: none;
    }
    72% {
      transform: scale(1.06) rotate(-0.5deg);
    }
    100% {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes loss-slam {
    0% {
      opacity: 0;
      transform: translateY(-12px) scale(1.55);
    }
    58% {
      opacity: 1;
      transform: translateY(1px) scale(0.95);
    }
    100% {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes xp-pop {
    0% {
      opacity: 0;
      transform: translateY(8px) scale(0.55);
    }
    62% {
      opacity: 1;
      transform: translateY(-1px) scale(1.16);
    }
    100% {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes outcome-ring {
    0% {
      opacity: 0.8;
      transform: scale(0.96);
    }
    100% {
      opacity: 0;
      transform: scale(1.2);
    }
  }
  @keyframes rays-spin {
    from {
      transform: translate(-50%, -50%) rotate(0deg);
    }
    to {
      transform: translate(-50%, -50%) rotate(360deg);
    }
  }
  @keyframes coin-fall {
    0% {
      opacity: 0;
      transform: translate3d(0, -30px, 0) rotate(0deg) scale(0.5);
    }
    10% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: translate3d(0, 36rem, 0) rotate(540deg) scale(1);
    }
  }
  @keyframes flash-out {
    0% {
      opacity: 0;
    }
    10% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes table-shake-win {
    0%,
    100% {
      transform: none;
    }
    14% {
      transform: translate3d(-3px, 1px, 0) rotate(-0.35deg);
    }
    28% {
      transform: translate3d(3px, -2px, 0) rotate(0.35deg);
    }
    42% {
      transform: translate3d(-2px, 2px, 0) rotate(-0.2deg);
    }
    58% {
      transform: translate3d(2px, -1px, 0) rotate(0.2deg);
    }
    74% {
      transform: translate3d(-1px, 1px, 0);
    }
  }
  @keyframes table-shake-loss {
    0%,
    100% {
      transform: none;
    }
    12% {
      transform: translate3d(-7px, 2px, 0) rotate(-0.7deg);
    }
    26% {
      transform: translate3d(7px, -3px, 0) rotate(0.7deg);
    }
    40% {
      transform: translate3d(-5px, 3px, 0) rotate(-0.5deg);
    }
    56% {
      transform: translate3d(4px, -2px, 0) rotate(0.4deg);
    }
    72% {
      transform: translate3d(-2px, 1px, 0) rotate(-0.2deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bj::before,
    .fx,
    .coin-rain,
    .flash {
      display: none;
    }
    .card,
    .outcome,
    .outcome-title,
    .outcome.jackpot::before,
    .outcome.jackpot::after,
    .outcome-xp,
    .felt,
    .table,
    .play::after,
    .deal::after {
      animation: none !important;
    }
    .card,
    .chip,
    .actions button,
    .play,
    .deal {
      transition: none;
    }
    .card:hover,
    .actions button:hover:not(:disabled),
    .chip:hover:not(:disabled) {
      transform: none;
    }
  }
</style>
