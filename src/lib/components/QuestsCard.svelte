<script lang="ts">
  /**
   * Home-screen missions: today's three small goals, this week's two, the season
   * pass and the week streak. Friendly by design — nothing is ever taken away.
   * Opening the home screen counts as the daily check-in.
   */
  import { onMount } from "svelte";
  import Icon from "#lib/components/Icon.svelte";
  import { quests, recordQuestEvent } from "#lib/quests-store.ts";
  import {
    tierInfo,
    todaysRows,
    weekRows,
    weekStreak,
    DAILY_XP_CAP,
  } from "#lib/quests.ts";

  onMount(() => recordQuestEvent("app_open"));

  let now = $state(new Date());
  onMount(() => {
    const t = setInterval(() => (now = new Date()), 60_000);
    return () => clearInterval(t);
  });

  const today = $derived(todaysRows($quests, now));
  const week = $derived(weekRows($quests, now));
  const tier = $derived(tierInfo($quests.xp));
  const streak = $derived(weekStreak($quests, now));
  const allDone = $derived(today.every((r) => r.done));
</script>

<section class="quests" aria-label="Missies">
  <div class="head">
    <h2><Icon name="target" size={18} /> Missies</h2>
    <span class="tier" title="Missiepunten dit seizoen">
      {tier.title}
      <small class="tabular-nums">{$quests.xp} MP</small>
    </span>
  </div>

  <div class="bar" aria-hidden="true">
    <i style="width:{tier.pct * 100}%"></i>
  </div>
  <p class="sub tabular-nums">
    Nog {tier.need - tier.into} MP tot {tier.tier + 1 > 10
      ? "de volgende rang"
      : "rang " + (tier.tier + 1)}
  </p>

  <ul class="list" aria-label="Missies van vandaag">
    {#each today as row (row.def.id)}
      <li class:done={row.done}>
        <span class="quest-icon"
          ><Icon
            name={row.done ? "check-circle" : row.def.icon}
            size={16}
          /></span
        >
        <span class="title">{row.def.title}</span>
        <span class="meta tabular-nums">
          {#if row.def.target > 1 && !row.done}{row.progress}/{row.def
              .target}{/if}
          <b>+{row.def.xp}</b>
        </span>
      </li>
    {/each}
  </ul>
  {#if allDone}
    <p class="done-note">
      <Icon name="party" size={16} /> Alles voor vandaag gedaan. Tot morgen!
    </p>
  {/if}

  <h3>Deze week</h3>
  <ul class="list weekly" aria-label="Missies van deze week">
    {#each week as row (row.def.id)}
      <li class:done={row.done}>
        <span class="quest-icon"
          ><Icon
            name={row.done ? "check-circle" : row.def.icon}
            size={16}
          /></span
        >
        <span class="title">{row.def.title}</span>
        <span class="meta tabular-nums">
          {#if !row.done}{row.progress}/{row.def.target}{/if}
          <b>+{row.def.xp}</b>
        </span>
      </li>
    {/each}
  </ul>

  <p class="foot">
    {#if streak > 0}<span class="streak"
        ><Icon name="flame" size={12} />
        {streak}
        {streak === 1 ? "week" : "weken"} op rij actief</span
      > ·{/if}
    max. {DAILY_XP_CAP} MP per dag
  </p>
</section>

<style>
  .quests {
    border-radius: 1.5rem;
    padding: 1.1rem 1.2rem 1rem;
    color: white;
    border: 1px solid color-mix(in oklch, white, transparent 92%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
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
  h3 {
    margin-top: 0.4rem;
    font-size: 0.78rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: rgb(156 163 175);
  }
  .tier {
    font-size: 0.85rem;
    font-weight: 800;
    color: rgb(196 181 253);
  }
  .tier small {
    margin-left: 0.3rem;
    font-weight: 600;
    color: rgb(156 163 175);
  }
  .bar {
    height: 0.5rem;
    border-radius: 9999px;
    overflow: hidden;
    background: color-mix(in oklch, white, transparent 90%);
  }
  .bar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #a855f7, #f59e0b);
    transition: width 0.5s ease;
  }
  .sub {
    font-size: 0.72rem;
    color: rgb(156 163 175);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .list li {
    display: grid;
    grid-template-columns: 1.6rem 1fr auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.65rem;
    border-radius: 0.9rem;
    background: color-mix(in oklch, white, transparent 94%);
    font-size: 0.9rem;
  }
  .list li.done {
    opacity: 0.65;
  }
  .list li.done .title {
    text-decoration: line-through;
    text-decoration-color: rgb(255 255 255 / 0.3);
  }
  .quest-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgb(196 181 253);
  }
  .list li.done .quest-icon {
    color: rgb(110 231 183);
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: rgb(156 163 175);
  }
  .meta b {
    color: rgb(252 211 77);
    font-weight: 800;
  }
  .done-note {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
    font-weight: 700;
    color: rgb(110 231 183);
  }
  .streak {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .foot {
    margin-top: 0.2rem;
    font-size: 0.72rem;
    color: rgb(107 114 128);
  }
  @media (prefers-reduced-motion: reduce) {
    .bar i {
      transition: none;
    }
  }
</style>
