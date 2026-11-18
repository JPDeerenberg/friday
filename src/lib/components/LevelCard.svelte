<script lang="ts">
  /**
   * Home-screen progress card: this school year's level, XP bar and what is waiting
   * to be opened. The level is per school year (see cards.ts) so everyone starts
   * level 1 each August. Tapping it opens the grades page, where the album lives.
   */
  import { untrack } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { personId, userSettings, currentPage } from "$lib/stores";
  import { gradeRevealState } from "$lib/grade-reveal";
  import { loadCurrentYearGrades } from "$lib/current-year-grades";
  import {
    buildCards,
    levelInfo,
    seasonLabel,
    seasonOf,
    seasonXp,
    careerInfo,
  } from "$lib/cards";
  import type { Grade } from "$lib/types";

  let grades = $state<Grade[]>([]);
  let loading = $state(true);

  const cards = $derived([
    ...buildCards(grades, {
      threshold: $userSettings.insufficientThreshold ?? 5.5,
      includeLetters: $userSettings.lettersGetCards === true,
    }).values(),
  ]);
  const opened = $derived(new Set($gradeRevealState.opened));
  const season = seasonOf(null);
  const xp = $derived(seasonXp(cards, opened, season));
  const li = $derived(levelInfo(xp));
  const career = $derived(careerInfo($gradeRevealState.tally.xp));
  const hidden = $derived(cards.filter((c) => !opened.has(c.id)).length);

  $effect(() => {
    const pid = $personId;
    if (pid === null) return;
    untrack(async () => {
      try {
        grades = await loadCurrentYearGrades(pid);
      } catch (e) {
        console.warn("LevelCard: cijfers laden mislukt", e);
      } finally {
        loading = false;
      }
    });
  });
</script>

<button
  type="button"
  class="lvl"
  onclick={() => currentPage.set("grades")}
  aria-label="Level {li.level}, {li.title}. {xp} XP dit seizoen. Open je kaarten."
>
  <span class="badge" aria-hidden="true">{loading ? "…" : li.level}</span>
  <span class="body">
    <span class="line1">
      <b>{li.title}</b>
      <small>seizoen {seasonLabel(season)}</small>
    </span>
    <span class="bar" aria-hidden="true"
      ><i style="width:{li.pct * 100}%"></i></span
    >
    <span class="line3 tabular-nums">
      <span>{li.into} / {li.need} XP</span>
      <span>
        {#if hidden > 0}<span class="stat"
            ><Icon name="gift" size={12} /> {hidden} te openen</span
          >{:else}<span class="stat"
            ><Icon name="trophy" size={12} /> {career.rank}</span
          >{/if}
      </span>
    </span>
  </span>
</button>

<style>
  .lvl {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    width: 100%;
    text-align: left;
    border-radius: 1.5rem;
    padding: 1rem 1.2rem;
    color: white;
    border: 1px solid color-mix(in oklch, white, transparent 92%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 25%);
    transition: transform 0.15s ease;
  }
  .lvl:active {
    transform: scale(0.985);
  }
  .badge {
    flex: none;
    display: grid;
    place-items: center;
    width: 3.4rem;
    height: 3.4rem;
    border-radius: 1.1rem;
    font-size: 1.6rem;
    font-weight: 900;
    background: linear-gradient(135deg, #a855f7, #6366f1);
    box-shadow: 0 10px 24px -10px #a855f7;
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .line1 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .line1 b {
    font-size: 1.05rem;
    font-weight: 800;
  }
  .line1 small {
    font-size: 0.72rem;
    color: rgb(156 163 175);
  }
  .bar {
    height: 0.55rem;
    border-radius: 9999px;
    background: color-mix(in oklch, white, transparent 90%);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #a855f7, #22d3ee);
    transition: width 0.5s ease;
  }
  .line3 {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: rgb(156 163 175);
  }
  @media (prefers-reduced-motion: reduce) {
    .lvl,
    .bar i {
      transition: none;
    }
  }
</style>
