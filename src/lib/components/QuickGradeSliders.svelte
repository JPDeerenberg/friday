<script lang="ts">
  /**
   * Home-screen grade simulator: pick a subject, drag the slider to the grade you
   * might get on the next test, and see what it does to your average — and what you
   * would need to reach a target. Uses only grades you can see (hidden ones stay
   * hidden), and is a "what if", never a verdict: the wording stays encouraging.
   */
  import { untrack } from "svelte";
  import Icon from "#lib/components/Icon.svelte";
  import { personId, userSettings } from "#lib/stores.ts";
  import { loadCurrentYearGrades } from "#lib/current-year-grades.ts";
  import { recordQuestEvent } from "#lib/quests-store.ts";
  import { gradePeek, gradeRevealState, splitGrades } from "#lib/grade-reveal.ts";
  import {
    subjectTotals,
    averageWith,
    neededGrade,
    oneDecimal,
    reactionFor,
    type SubjectTotals,
  } from "#lib/quick-grades.ts";
  import type { Grade } from "#lib/types.ts";

  let allGrades = $state<Grade[]>([]);
  let loading = $state(true);
  let failed = $state(false);

  const revealEnabled = $derived($userSettings.gradeReveal !== false);
  const visible = $derived(
    splitGrades(
      allGrades,
      revealEnabled,
      $gradeRevealState,
      $gradePeek,
      $userSettings.lettersGetCards === true,
    ).visible,
  );
  const subjects = $derived(subjectTotals(visible));
  const decimals = $derived($userSettings.decimalPoints ?? 1);
  const threshold = $derived($userSettings.insufficientThreshold ?? 5.5);

  let selectedName = $state<string | null>(null);
  const subject = $derived<SubjectTotals | null>(
    subjects.find((s) => s.name === selectedName) ?? subjects[0] ?? null,
  );

  let value = $state(7);
  let weight = $state(1);
  let target = $state(6);
  const TARGETS = [5.5, 6, 7, 8];

  // Start the slider near the subject's current average, and when the subject changes.
  let lastSeen: string | null = null;
  $effect(() => {
    const s = subject;
    if (!s) return;
    if (s.name !== lastSeen) {
      lastSeen = s.name;
      const start = s.average !== null ? Math.round(s.average * 2) / 2 : 7;
      value = Math.min(10, Math.max(1, start));
    }
  });

  // Moving the slider counts once for the daily "simulator" mission.
  let used = false;
  function noteUse() {
    if (used) return;
    used = true;
    recordQuestEvent("simulator_used");
  }

  const nl = (n: number) =>
    oneDecimal(n, decimals).toFixed(decimals).replace(".", ",");

  const result = $derived.by(() => {
    if (!subject) return null;
    const next = averageWith(subject, value, weight);
    const delta = subject.average === null ? 0 : next - subject.average;
    return {
      next,
      delta,
      reaction: reactionFor(next, subject.average, threshold),
      needed: neededGrade(subject, target, weight),
    };
  });

  async function load(pid: number) {
    try {
      allGrades = await loadCurrentYearGrades(pid);
    } catch (e) {
      console.warn("Simulator: cijfers laden mislukt", e);
      failed = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const pid = $personId;
    if (pid !== null) untrack(() => load(pid));
  });
</script>

<section class="sim" aria-label="Cijfer-simulator">
  <div class="head">
    <h2><Icon name="sliders" size={18} /> Wat als…</h2>
    <span class="est">schatting</span>
  </div>

  {#if loading}
    <div class="skeleton" aria-hidden="true"></div>
  {:else if failed || subjects.length === 0}
    <p class="hint">
      {failed
        ? "Cijfers laden lukt nu niet."
        : "Zodra je zichtbare cijfers hebt kun je hier spelen met je gemiddelde."}
    </p>
  {:else if subject && result}
    <div class="chips" role="tablist" aria-label="Kies een vak">
      {#each subjects as s (s.name)}
        <button
          type="button"
          role="tab"
          aria-selected={s.name === subject.name}
          class="chip"
          class:on={s.name === subject.name}
          onclick={() => (selectedName = s.name)}
        >
          {s.name}
          {#if s.average !== null}<b>{nl(s.average)}</b>{/if}
        </button>
      {/each}
    </div>

    <div class="grade-row">
      <span class="label">Je volgende cijfer</span>
      <output class="big tabular-nums" for="sim-slider">{nl(value)}</output>
    </div>
    <input
      id="sim-slider"
      class="slider"
      type="range"
      min="1"
      max="10"
      step="0.1"
      bind:value
      oninput={noteUse}
      aria-label="Cijfer voor de volgende toets"
    />

    <div class="weights" role="group" aria-label="Weging">
      <span class="label">Weging</span>
      {#each [1, 2, 3] as w}
        <button
          type="button"
          class="pill"
          class:on={weight === w}
          onclick={() => (weight = w)}>{w}×</button
        >
      {/each}
    </div>

    <div class="result">
      <div>
        <span class="label">Nieuw gemiddelde</span>
        <div class="avg tabular-nums">
          {nl(result.next)}
          {#if subject.average !== null && Math.abs(result.delta) >= 0.05}
            <small class:up={result.delta > 0}>
              {result.delta > 0 ? "▲" : "▼"}
              {nl(Math.abs(result.delta))}
            </small>
          {/if}
        </div>
      </div>
      <div class="react" aria-live="polite">
        <span class="reaction-icon"
          ><Icon name={result.reaction.icon} size={16} /></span
        >
        <span>{result.reaction.text}</span>
      </div>
    </div>

    <div class="need">
      <span class="label">Nodig voor een</span>
      {#each TARGETS as t}
        <button
          type="button"
          class="pill"
          class:on={target === t}
          onclick={() => (target = t)}>{String(t).replace(".", ",")}</button
        >
      {/each}
      <span class="answer">
        {#if result.needed.kind === "grade"}
          een <b>{nl(result.needed.value)}</b>
        {:else if result.needed.kind === "safe"}
          <b class="ok">haal je al</b> <Icon name="check" size={13} />
        {:else}
          <b>niet haalbaar</b> met 1 toets
        {/if}
      </span>
    </div>
  {/if}
</section>

<style>
  .sim {
    border-radius: 1.5rem;
    padding: 1.1rem 1.2rem 1.2rem;
    border: 1px solid color-mix(in oklch, white, transparent 92%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 25%);
    color: white;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 1.15rem;
    font-weight: 800;
  }
  .est {
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgb(156 163 175);
  }
  .hint {
    color: rgb(156 163 175);
    font-size: 0.95rem;
  }
  .skeleton {
    height: 9rem;
    border-radius: 1rem;
    background: color-mix(in oklch, white, transparent 94%);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
  .chips {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
    padding-bottom: 0.2rem;
    scrollbar-width: none;
  }
  .chips::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: none;
    display: inline-flex;
    gap: 0.4rem;
    align-items: baseline;
    border-radius: 9999px;
    padding: 0.35rem 0.8rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: rgb(209 213 219);
    background: color-mix(in oklch, white, transparent 92%);
    border: 1px solid transparent;
  }
  .chip b {
    font-weight: 800;
    color: white;
  }
  .chip.on {
    border-color: var(--color-primary-500, #a855f7);
    background: color-mix(
      in oklch,
      var(--color-primary-500, #a855f7),
      transparent 78%
    );
  }
  .label {
    font-size: 0.78rem;
    color: rgb(156 163 175);
  }
  .grade-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .big {
    font-size: 2.6rem;
    font-weight: 900;
    line-height: 1;
  }
  .slider {
    width: 100%;
    height: 2.6rem;
    accent-color: var(--color-primary-500, #a855f7);
    touch-action: pan-y;
  }
  .weights,
  .need {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .weights .label,
  .need .label {
    margin-right: 0.2rem;
  }
  .pill {
    min-width: 2.4rem;
    border-radius: 9999px;
    padding: 0.3rem 0.65rem;
    font-size: 0.85rem;
    font-weight: 700;
    color: rgb(209 213 219);
    background: color-mix(in oklch, white, transparent 92%);
    border: 1px solid transparent;
  }
  .pill.on {
    color: white;
    border-color: var(--color-primary-500, #a855f7);
    background: color-mix(
      in oklch,
      var(--color-primary-500, #a855f7),
      transparent 70%
    );
  }
  .result {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.8rem;
    border-radius: 1rem;
    padding: 0.7rem 0.9rem;
    background: color-mix(in oklch, white, transparent 95%);
  }
  .avg {
    font-size: 1.9rem;
    font-weight: 900;
    line-height: 1.1;
  }
  .avg small {
    font-size: 0.85rem;
    font-weight: 700;
    color: rgb(165 180 252);
    margin-left: 0.3rem;
  }
  .avg small.up {
    color: rgb(110 231 183);
  }
  .react {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.9rem;
    font-weight: 600;
    text-align: right;
  }
  .reaction-icon {
    display: inline-flex;
    color: rgb(165 180 252);
  }
  .ok {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .answer :global(svg) {
    color: rgb(110 231 183);
    vertical-align: -0.15em;
  }
  .answer {
    font-size: 0.95rem;
    margin-left: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
</style>
