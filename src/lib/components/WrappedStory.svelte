<script lang="ts">
  /**
   * Full-screen "Wrapped" story: tap through your school year so far. Only shows
   * grades you can see and cards you opened, and only good news (see wrapped.ts).
   * Left/right tap or arrow keys to move, Escape to close.
   */
  import { onMount, untrack } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { fade, fly } from "svelte/transition";
  import { personId, userSettings } from "$lib/stores";
  import { gradePeek, gradeRevealState, splitGrades } from "$lib/grade-reveal";
  import { loadCurrentYearGrades } from "$lib/current-year-grades";
  import {
    buildCards,
    careerInfo,
    levelInfo,
    RARITY_META,
    seasonLabel,
    seasonOf,
    seasonXp,
  } from "$lib/cards";
  import { quests, recordQuestEvent } from "$lib/quests-store";
  import { tierInfo, weekStreak } from "$lib/quests";
  import {
    buildWrapped,
    wrappedShareText,
    type WrappedSlide,
  } from "$lib/wrapped";
  import type { Grade } from "$lib/types";

  let { onclose }: { onclose: () => void } = $props();

  let grades = $state<Grade[]>([]);
  let loading = $state(true);
  let index = $state(0);
  let copied = $state(false);
  const season = seasonOf(null);

  const revealEnabled = $derived($userSettings.gradeReveal !== false);
  const visible = $derived(
    splitGrades(
      grades,
      revealEnabled,
      $gradeRevealState,
      $gradePeek,
      $userSettings.lettersGetCards === true,
    ).visible,
  );
  const cards = $derived([
    ...buildCards(grades, {
      threshold: $userSettings.insufficientThreshold ?? 5.5,
      includeLetters: $userSettings.lettersGetCards === true,
    }).values(),
  ]);
  const opened = $derived(new Set($gradeRevealState.opened));
  const li = $derived(levelInfo(seasonXp(cards, opened, season)));
  const slides = $derived<WrappedSlide[]>(
    buildWrapped({
      season,
      now: new Date(),
      grades: visible,
      cards,
      opened,
      level: li.level,
      levelTitle: li.title,
      missionPoints: $quests.xp,
      missionTier: tierInfo($quests.xp).title,
      weekStreak: weekStreak($quests, new Date()),
    }),
  );
  const career = $derived(careerInfo($gradeRevealState.tally.xp));
  const slide = $derived(slides[Math.min(index, slides.length - 1)]);
  const last = $derived(index >= slides.length - 1);
  const HUES: Record<string, number> = {
    intro: 265,
    grades: 200,
    best: 150,
    highest: 25,
    improved: 170,
    cards: 300,
    missions: 45,
    outro: 265,
  };
  const hue = $derived(HUES[slide?.kind ?? "intro"] ?? 265);
  const nl = (n: number, d = 1) => n.toFixed(d).replace(".", ",");
  const dateText = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString("nl-NL", {
          day: "numeric",
          month: "long",
        })
      : "";

  onMount(() => {
    recordQuestEvent("wrapped_viewed");
    const pid = $personId;
    if (pid !== null) {
      untrack(async () => {
        try {
          grades = await loadCurrentYearGrades(pid);
        } catch (e) {
          console.warn("Wrapped: cijfers laden mislukt", e);
        } finally {
          loading = false;
        }
      });
    } else loading = false;
  });

  function next() {
    if (index < slides.length - 1) index++;
  }
  function prev() {
    if (index > 0) index--;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === " ") next();
    else if (e.key === "ArrowLeft") prev();
    else if (e.key === "Escape") onclose();
  }

  async function share() {
    const text = wrappedShareText(slides, season);
    if (navigator.share) {
      try {
        await navigator.share({ title: "Mijn Friday Wrapped", text });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // clipboard blocked: nothing else to do
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="overlay"
  style="--hue:{hue}"
  role="dialog"
  aria-modal="true"
  aria-label="Jouw Wrapped"
  transition:fade={{ duration: 200 }}
>
  <div class="bars" aria-hidden="true">
    {#each slides as _, i}
      <i class:on={i <= index}></i>
    {/each}
  </div>
  <button type="button" class="close" onclick={onclose} aria-label="Sluiten"
    >✕</button
  >

  <button type="button" class="zone left" onclick={prev} aria-label="Vorige"
  ></button>
  <button type="button" class="zone right" onclick={next} aria-label="Volgende"
  ></button>

  <div class="stage" aria-live="polite">
    {#if loading}
      <p class="small">Je jaar wordt samengesteld…</p>
    {:else if slide}
      {#key index}
        <div class="slide" in:fly={{ y: 24, duration: 350 }}>
          {#if slide.kind === "intro"}
            <p class="small">Friday Wrapped</p>
            <h1>Jouw schooljaar {seasonLabel(slide.season)}</h1>
            <p class="lead">
              {slide.daysIn} dagen onderweg. Dit is je verhaal tot nu toe.
            </p>
          {:else if slide.kind === "grades"}
            <p class="small">Dit jaar haalde je</p>
            <div class="huge tabular-nums">{slide.count}</div>
            <p class="lead">
              cijfers in {slide.subjects}
              {slide.subjects === 1 ? "vak" : "vakken"}
            </p>
            {#if slide.average !== null}<p class="small">
                Gemiddeld een {nl(slide.average)}
              </p>{/if}
          {:else if slide.kind === "best"}
            <p class="small">Jouw beste vak</p>
            <h1>{slide.subject}</h1>
            <div class="big tabular-nums">{nl(slide.average)}</div>
          {:else if slide.kind === "highest"}
            <p class="small">Je hoogste cijfer</p>
            <div class="huge tabular-nums">{nl(slide.value)}</div>
            <p class="lead">voor {slide.subject}</p>
            {#if slide.date}<p class="small">{dateText(slide.date)}</p>{/if}
          {:else if slide.kind === "improved"}
            <p class="small">Meest gestegen</p>
            <h1>{slide.subject}</h1>
            <div class="big tabular-nums">
              {nl(slide.from)} → {nl(slide.to)}
            </div>
            <p class="lead">Dat is groei <Icon name="trend-up" size={15} /></p>
          {:else if slide.kind === "cards"}
            <p class="small">Je kaarten</p>
            <div class="huge tabular-nums">{slide.opened}</div>
            <p class="lead">
              {slide.opened === 1 ? "kaart" : "kaarten"} geopend
            </p>
            {#if slide.rarest}<p class="small">
                Zeldzaamste: <b>{RARITY_META[slide.rarest].label}</b>
              </p>{/if}
            <p class="small">Level {slide.level} · {slide.title}</p>
          {:else if slide.kind === "missions"}
            <p class="small">Je missies</p>
            <div class="huge tabular-nums">{slide.points}</div>
            <p class="lead">missiepunten · {slide.tier}</p>
            {#if slide.weeks > 0}<p class="small">
                <Icon name="flame" size={14} />
                {slide.weeks}
                {slide.weeks === 1 ? "week" : "weken"} op rij actief
              </p>{/if}
          {:else}
            <p class="small">Jij bent</p>
            <h1>Level {slide.level}</h1>
            <p class="lead">{slide.title}</p>
            <p class="small">Carrière: {career.rank}</p>
          {/if}
        </div>
      {/key}
    {/if}
  </div>

  {#if last && !loading}
    <div class="actions">
      <button type="button" class="btn primary" onclick={share}
        >{copied ? "Gekopieerd ✓" : "Deel"}</button
      >
      <button type="button" class="btn" onclick={onclose}>Sluiten</button>
    </div>
  {:else}
    <p class="hint">Tik rechts voor verder</p>
  {/if}
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: white;
    padding: env(safe-area-inset-top, 0px) 1.5rem
      env(safe-area-inset-bottom, 0px);
    background:
      radial-gradient(
        120% 80% at 80% 0%,
        hsl(var(--hue) 80% 45% / 0.5),
        transparent 60%
      ),
      linear-gradient(
        170deg,
        hsl(var(--hue) 60% 22%),
        hsl(calc(var(--hue) + 40) 55% 8%)
      );
    transition: background 0.4s ease;
  }
  .bars {
    position: absolute;
    top: calc(0.8rem + env(safe-area-inset-top, 0px));
    left: 1rem;
    right: 4rem;
    display: flex;
    gap: 0.3rem;
    z-index: 3;
  }
  .bars i {
    flex: 1;
    height: 0.2rem;
    border-radius: 9999px;
    background: rgb(255 255 255 / 0.25);
  }
  .bars i.on {
    background: white;
  }
  .close {
    position: absolute;
    top: calc(0.4rem + env(safe-area-inset-top, 0px));
    right: 0.8rem;
    z-index: 4;
    width: 2.6rem;
    height: 2.6rem;
    font-size: 1.1rem;
  }
  .zone {
    position: absolute;
    top: 3rem;
    bottom: 5rem;
    width: 50%;
    z-index: 2;
  }
  .zone.left {
    left: 0;
  }
  .zone.right {
    right: 0;
  }
  .stage {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 30rem;
    text-align: center;
    pointer-events: none;
  }
  .slide {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }
  h1 {
    font-size: clamp(2rem, 9vw, 3.2rem);
    font-weight: 900;
    line-height: 1.1;
    overflow-wrap: anywhere;
  }
  .huge {
    font-size: clamp(5rem, 28vw, 9rem);
    font-weight: 900;
    line-height: 1;
  }
  .big {
    font-size: clamp(3rem, 16vw, 5rem);
    font-weight: 900;
    line-height: 1.05;
  }
  .lead {
    font-size: 1.3rem;
    font-weight: 700;
    color: rgb(255 255 255 / 0.9);
  }
  .small {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.95rem;
    color: rgb(255 255 255 / 0.72);
  }
  .hint {
    position: absolute;
    bottom: calc(1.4rem + env(safe-area-inset-bottom, 0px));
    font-size: 0.78rem;
    color: rgb(255 255 255 / 0.5);
  }
  .actions {
    position: absolute;
    bottom: calc(1.4rem + env(safe-area-inset-bottom, 0px));
    z-index: 5;
    display: flex;
    gap: 0.6rem;
  }
  .btn {
    padding: 0.7rem 1.4rem;
    border-radius: 9999px;
    font-weight: 800;
    color: white;
    background: rgb(255 255 255 / 0.18);
  }
  .btn.primary {
    color: black;
    background: white;
  }
  @media (prefers-reduced-motion: reduce) {
    .overlay {
      transition: none;
    }
  }
</style>
