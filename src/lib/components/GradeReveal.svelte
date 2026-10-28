<script lang="ts">
  /**
   * Full-screen "open your grade" overlay.
   *
   * Flow per grade: a floating "?" card (ready) → a short charge-up with a
   * growing glow (charging) → flash, card flip and particle burst, then the
   * grade rolls into place (revealed). The animation is identical for every
   * grade, so it never hints at the value.
   *
   * `items` must be a stable list captured when the overlay opens — revealing a
   * grade removes it from the "hidden" set in the parent, which would otherwise
   * shift the queue while it is being walked through.
   */
  import { onDestroy, tick } from "svelte";
  import { fade } from "svelte/transition";
  import { userSettings } from "$lib/stores";
  import type { RevealItem } from "$lib/grade-reveal";

  let {
    items,
    onrevealed,
    onclose,
    preview = false,
  }: {
    items: RevealItem[];
    /** Called once per grade, the moment its value is shown. */
    onrevealed?: (id: number) => void;
    onclose: () => void;
    /** Demo mode: nothing is marked as opened. */
    preview?: boolean;
  } = $props();

  type Stage = "ready" | "charging" | "revealed";

  const CHARGE_MS = 1500;
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let index = $state(0);
  let stage = $state<Stage>("ready");
  let shown = $state("");

  const item = $derived(items[index]);
  const isLast = $derived(index >= items.length - 1);
  const remaining = $derived(items.length - index);
  const failing = $derived(
    !!item && !item.passed && $userSettings.highlightFailing !== false,
  );

  const revealedIds = new Set<number>();
  let timers: ReturnType<typeof setTimeout>[] = [];
  let rollTimer: ReturnType<typeof setInterval> | undefined;

  // Same burst every time: 18 particles flying outwards.
  const PARTICLES = Array.from({ length: 18 }, (_, i) => {
    const angle = (i / 18) * Math.PI * 2 + (i % 2 ? 0.14 : 0);
    const distance = 110 + (i % 3) * 38;
    return {
      tx: Math.round(Math.cos(angle) * distance),
      ty: Math.round(Math.sin(angle) * distance),
      size: 6 + (i % 3) * 4,
      delay: (i % 4) * 35,
    };
  });

  function later(fn: () => void, ms: number) {
    timers.push(setTimeout(fn, ms));
  }

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
    if (rollTimer !== undefined) clearInterval(rollTimer);
    rollTimer = undefined;
  }

  onDestroy(clearTimers);

  function buzz(pattern: number | number[]) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* haptics are optional */
    }
  }

  function markRevealed() {
    if (!item || revealedIds.has(item.id)) return;
    revealedIds.add(item.id);
    if (!preview) onrevealed?.(item.id);
  }

  /** Digits spin like a slot machine and settle left to right. */
  function startRoll(final: string) {
    if (reducedMotion) {
      shown = final;
      return;
    }
    const chars = [...final];
    let frameNo = 0;
    const frame = () => {
      const settled = Math.floor(frameNo / 5);
      shown = chars
        .map((c, i) =>
          /\d/.test(c) && i >= settled
            ? String(Math.floor(Math.random() * 10))
            : c,
        )
        .join("");
      if (settled >= chars.length) {
        shown = final;
        if (rollTimer !== undefined) clearInterval(rollTimer);
        rollTimer = undefined;
      }
      frameNo++;
    };
    frame();
    rollTimer = setInterval(frame, 55);
  }

  function open() {
    if (stage !== "ready" || !item) return;
    stage = "charging";
    buzz(15);
    later(
      () => {
        stage = "revealed";
        markRevealed();
        startRoll(item.value);
        buzz([30, 40, 70]);
      },
      reducedMotion ? 120 : CHARGE_MS,
    );
  }

  function next() {
    if (stage !== "revealed") return;
    if (isLast) {
      onclose();
      return;
    }
    clearTimers();
    index += 1;
    stage = "ready";
    shown = "";
  }

  function primary() {
    if (stage === "ready") open();
    else if (stage === "revealed") next();
  }

  /** Skip the show: reveal everything that is left and close. */
  function revealAllNow() {
    clearTimers();
    for (let i = index; i < items.length; i++) {
      if (!revealedIds.has(items[i].id)) {
        revealedIds.add(items[i].id);
        if (!preview) onrevealed?.(items[i].id);
      }
    }
    onclose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "Enter") {
      // Enter on the focused button would also click it; handle it once here.
      e.preventDefault();
      primary();
    }
  }

  // Keep keyboard focus on the main action as the stage changes.
  $effect(() => {
    void stage;
    void index;
    tick().then(() => document.getElementById("reveal-primary")?.focus());
  });
</script>

<svelte:window onkeydown={onKey} />

{#if item}
  <div
    class="reveal-root fixed inset-0 z-[200] flex items-center justify-center px-5 py-8"
    role="dialog"
    aria-modal="true"
    aria-label="Cijfer onthullen"
    transition:fade|global={{ duration: 220 }}
  >
    <div class="absolute inset-0 bg-black/85 backdrop-blur-md"></div>
    <div class="backdrop-glow absolute inset-0" aria-hidden="true"></div>

    <button
      type="button"
      onclick={onclose}
      aria-label="Sluiten"
      class="absolute right-4 top-[calc(env(safe-area-inset-top,0px)+12px)] z-20 flex h-10 w-10 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
    >
      <svg
        class="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg
      >
    </button>

    <div
      class="relative z-10 flex w-full max-w-sm flex-col items-center gap-7 text-center"
    >
      <p class="text-label-large tabular-nums text-gray-400">
        {#if preview}
          Voorbeeld
        {:else if items.length > 1}
          Cijfer {index + 1} van {items.length}
        {:else}
          Nieuw cijfer
        {/if}
      </p>

      <div class="scene" aria-hidden="true">
        <div
          class="aura"
          class:ready={stage === "ready"}
          class:charging={stage === "charging"}
          class:revealed={stage === "revealed"}
        ></div>

        {#if stage === "revealed"}
          <div class="flash"></div>
          {#each PARTICLES as p}
            <span
              class="particle"
              style="--tx:{p.tx}px;--ty:{p.ty}px;--s:{p.size}px;--delay:{p.delay}ms"
            ></span>
          {/each}
        {/if}

        <div
          class="mover"
          class:float={stage === "ready"}
          class:shake={stage === "charging"}
          class:pop={stage === "revealed"}
        >
          <div class="card" class:flipped={stage === "revealed"}>
            <div class="face front">
              <span class="shine"></span>
              <span class="qmark">?</span>
            </div>
            <div class="face back" class:fail={failing}>
              <span class="value">{shown}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Read out the result once for screen readers. -->
      <span class="sr-only" aria-live="polite">
        {stage === "revealed" ? `${item.subject}: ${item.value}` : ""}
      </span>

      <div class="min-h-[4.5rem] space-y-1">
        <p class="text-headline-small text-white">{item.subject}</p>
        <p class="text-body-medium text-gray-400">
          {item.title}{#if stage === "revealed" && item.weight}&nbsp;· weging ×{item.weight}{/if}
        </p>
      </div>

      <div class="flex w-full flex-col items-center gap-3">
        <button
          type="button"
          id="reveal-primary"
          class="primary-btn"
          onclick={primary}
          disabled={stage === "charging"}
        >
          {#if stage === "ready"}
            Open cijfer
          {:else if stage === "charging"}
            Bezig…
          {:else if isLast}
            Klaar
          {:else}
            Volgende cijfer
          {/if}
        </button>

        <!-- Fixed height so the layout doesn't jump when the link disappears. -->
        <div class="flex h-5 items-center">
          {#if !preview && stage === "ready" && remaining > 1}
            <button
              type="button"
              onclick={revealAllNow}
              class="text-label-medium text-gray-500 underline-offset-4 transition-colors hover:text-gray-300 hover:underline"
            >
              Alles direct tonen
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop-glow {
    background: radial-gradient(
      ellipse at 50% 42%,
      color-mix(in srgb, var(--color-primary-500) 18%, transparent),
      transparent 60%
    );
    pointer-events: none;
  }

  .primary-btn {
    height: 3rem;
    min-width: 12rem;
    padding: 0 2rem;
    border-radius: 9999px;
    font-size: 0.9375rem;
    font-weight: 600;
    background: var(--m3-primary, #d8b4fe);
    color: var(--m3-on-primary, #4c1d95);
    box-shadow: 0 8px 28px -8px
      color-mix(in srgb, var(--color-primary-500) 70%, transparent);
    transition:
      filter 0.15s,
      transform 0.15s,
      opacity 0.15s;
  }
  .primary-btn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .primary-btn:active:not(:disabled) {
    transform: scale(0.96);
  }
  .primary-btn:disabled {
    opacity: 0.45;
  }
  .primary-btn:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 3px;
  }

  .scene {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 15rem;
    height: 19rem;
    perspective: 1000px;
  }

  .mover {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .card {
    position: relative;
    width: 100%;
    height: 100%;
    transform-style: preserve-3d;
    transition: transform 0.8s cubic-bezier(0.2, 0.9, 0.25, 1.1);
  }
  .card.flipped {
    transform: rotateY(180deg);
  }

  .face {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 1.75rem;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  .front {
    background: linear-gradient(
      155deg,
      color-mix(
        in srgb,
        var(--color-primary-500) 32%,
        var(--color-surface-800)
      ),
      var(--color-surface-900) 72%
    );
    border: 1px solid
      color-mix(in srgb, var(--color-primary-400) 45%, transparent);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.04) inset,
      0 24px 60px -12px
        color-mix(in srgb, var(--color-primary-500) 55%, transparent);
  }

  .back {
    transform: rotateY(180deg);
    background: radial-gradient(
      circle at 50% 35%,
      color-mix(
        in srgb,
        var(--color-primary-500) 30%,
        var(--color-surface-800)
      ),
      var(--color-surface-900) 78%
    );
    border: 1px solid
      color-mix(in srgb, var(--color-primary-400) 55%, transparent);
    box-shadow: 0 24px 60px -12px
      color-mix(in srgb, var(--color-primary-500) 60%, transparent);
  }
  .back.fail {
    background: radial-gradient(
      circle at 50% 35%,
      color-mix(in srgb, #ef4444 28%, var(--color-surface-800)),
      var(--color-surface-900) 78%
    );
    border-color: rgba(248, 113, 113, 0.5);
    box-shadow: 0 24px 60px -12px rgba(239, 68, 68, 0.45);
  }

  .qmark {
    position: relative;
    font-size: 8rem;
    font-weight: 900;
    line-height: 1;
    color: var(--color-primary-400);
    text-shadow: 0 0 40px
      color-mix(in srgb, var(--color-primary-400) 70%, transparent);
  }

  .value {
    font-size: 6.5rem;
    font-weight: 900;
    line-height: 1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
    color: #fff;
    text-shadow: 0 0 36px
      color-mix(in srgb, var(--color-primary-400) 80%, transparent);
  }
  .back.fail .value {
    color: #fecaca;
    text-shadow: 0 0 36px rgba(248, 113, 113, 0.7);
  }

  .shine {
    position: absolute;
    inset: -50%;
    background: linear-gradient(
      115deg,
      transparent 40%,
      rgba(255, 255, 255, 0.16) 50%,
      transparent 60%
    );
    animation: sweep 2.8s ease-in-out infinite;
  }

  .aura {
    position: absolute;
    width: 22rem;
    height: 22rem;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      color-mix(in srgb, var(--color-primary-500) 60%, transparent) 0%,
      transparent 65%
    );
    opacity: 0.35;
    transform: scale(0.7);
    pointer-events: none;
  }
  .aura.ready {
    animation: aura-idle 3.2s ease-in-out infinite;
  }
  .aura.charging {
    animation: aura-charge 1.5s cubic-bezier(0.5, 0, 0.9, 0.6) forwards;
  }
  .aura.revealed {
    animation: aura-burst 1.1s ease-out forwards;
  }

  .flash {
    position: absolute;
    width: 30rem;
    height: 30rem;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      rgba(255, 255, 255, 0.95),
      rgba(255, 255, 255, 0) 60%
    );
    pointer-events: none;
    animation: flash 0.7s ease-out forwards;
  }

  .particle {
    position: absolute;
    top: 50%;
    left: 50%;
    width: var(--s);
    height: var(--s);
    margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
    border-radius: 50%;
    background: var(--color-primary-400);
    box-shadow: 0 0 12px var(--color-primary-400);
    opacity: 0;
    pointer-events: none;
    animation: burst 1.1s cubic-bezier(0.1, 0.8, 0.3, 1) var(--delay) both;
  }
  .particle:nth-child(even) {
    background: #fff;
    box-shadow: 0 0 14px #fff;
  }

  .float {
    animation: float 3.2s ease-in-out infinite;
  }
  .shake {
    animation: shake 1.5s ease-in forwards;
  }
  .pop {
    animation: pop 0.7s ease-out;
  }

  @keyframes float {
    0%,
    100% {
      transform: translateY(0) rotate(-0.6deg);
    }
    50% {
      transform: translateY(-10px) rotate(0.6deg);
    }
  }
  @keyframes sweep {
    0%,
    30% {
      transform: translateX(-60%);
    }
    70%,
    100% {
      transform: translateX(60%);
    }
  }
  @keyframes shake {
    0% {
      transform: translate(0, 0) rotate(0) scale(1);
    }
    10% {
      transform: translate(-2px, 1px) rotate(-1deg) scale(1.01);
    }
    20% {
      transform: translate(3px, -1px) rotate(1.2deg) scale(1.02);
    }
    30% {
      transform: translate(-4px, 2px) rotate(-1.6deg) scale(1.03);
    }
    40% {
      transform: translate(5px, -2px) rotate(2deg) scale(1.04);
    }
    50% {
      transform: translate(-6px, 2px) rotate(-2.4deg) scale(1.06);
    }
    60% {
      transform: translate(7px, -3px) rotate(2.8deg) scale(1.07);
    }
    70% {
      transform: translate(-7px, 3px) rotate(-3deg) scale(1.09);
    }
    85% {
      transform: translate(8px, -3px) rotate(3.2deg) scale(1.11);
    }
    100% {
      transform: translate(0, 0) rotate(0) scale(1.14);
    }
  }
  @keyframes pop {
    0% {
      transform: scale(1.14);
    }
    45% {
      transform: scale(0.94);
    }
    100% {
      transform: scale(1);
    }
  }
  @keyframes aura-idle {
    0%,
    100% {
      opacity: 0.3;
      transform: scale(0.7);
    }
    50% {
      opacity: 0.5;
      transform: scale(0.85);
    }
  }
  @keyframes aura-charge {
    0% {
      opacity: 0.35;
      transform: scale(0.7);
    }
    100% {
      opacity: 1;
      transform: scale(1.35);
    }
  }
  @keyframes aura-burst {
    0% {
      opacity: 1;
      transform: scale(1.35);
    }
    40% {
      opacity: 1;
      transform: scale(2.2);
    }
    100% {
      opacity: 0.4;
      transform: scale(1);
    }
  }
  @keyframes flash {
    0% {
      opacity: 0.95;
      transform: scale(0.3);
    }
    100% {
      opacity: 0;
      transform: scale(1.4);
    }
  }
  @keyframes burst {
    0% {
      opacity: 1;
      transform: translate(0, 0) scale(1);
    }
    65% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: translate(var(--tx), var(--ty)) scale(0.3);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .float,
    .shake,
    .pop,
    .aura,
    .shine {
      animation: none !important;
    }
    .flash,
    .particle {
      display: none;
    }
    .card {
      transition: none;
    }
  }
</style>
