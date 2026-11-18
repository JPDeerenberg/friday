<script lang="ts">
  /**
   * The big "where is my next lesson?" card at the top of the home screen.
   * Just the next lesson — nothing else — in type that can be read at arm's
   * length between two lessons. Re-evaluates every 20 s so the countdown and the
   * choice of lesson stay right while the app is open.
   */
  import { onMount } from "svelte";
  import { currentPage } from "$lib/stores";
  import { formatTeacherName } from "$lib/api";
  import { formatTime } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";
  import { subjectTheme } from "$lib/cards";
  import { pickNextLesson, describeStart } from "$lib/next-lesson";
  import type { CalendarEvent } from "$lib/types";

  let {
    events,
    loading = false,
  }: { events: CalendarEvent[]; loading?: boolean } = $props();

  let now = $state(new Date());
  onMount(() => {
    const timer = setInterval(() => (now = new Date()), 20_000);
    return () => clearInterval(timer);
  });

  const next = $derived(pickNextLesson(events, now));
  const theme = $derived(next ? subjectTheme(next.subject) : null);
  const startText = $derived(next ? describeStart(next, now) : "");
  const tag = $derived(
    !next
      ? ""
      : next.phase === "now"
        ? "Nu"
        : next.phase === "later"
          ? startText
          : "Volgende les",
  );
  const teacher = $derived(
    next?.teacher ? formatTeacherName(next.teacher) : "",
  );
</script>

{#if loading && !next}
  <div class="hero skeleton" aria-hidden="true"></div>
{:else if next && theme}
  <button
    type="button"
    class="hero"
    style="--hue: {theme.hue}"
    onclick={() => currentPage.set("calendar")}
    aria-label="{tag}: {next.subject}, lokaal {next.room ??
      'onbekend'}, {formatTime(next.event.Start)}. {startText}"
  >
    <span class="glow" aria-hidden="true"></span>
    <span class="top">
      <span
        class="tag"
        class:live={next.phase === "now" || next.phase === "soon"}
      >
        {tag}
      </span>
      <span class="time tabular-nums">
        {formatTime(next.event.Start)} – {formatTime(next.event.Einde)}
      </span>
    </span>
    <span class="subject"
      ><Icon name={theme.icon} size={22} /> {next.subject}</span
    >
    <span class="room" class:noroom={!next.room}
      >{next.room ?? "Geen lokaal"}</span
    >
    <span class="bottom">
      <span class="when">{next.phase === "later" ? "" : startText}</span>
      {#if teacher}<span class="teacher">{teacher}</span>{/if}
    </span>
  </button>
{:else}
  <div class="hero empty">
    <span class="subject">Geen lessen meer gepland</span>
    <span class="teacher">Geniet ervan!</span>
  </div>
{/if}

<style>
  .hero {
    position: relative;
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 0.35rem;
    overflow: hidden;
    border-radius: 1.75rem;
    padding: 1.25rem 1.4rem 1.2rem;
    text-align: left;
    color: white;
    background:
      radial-gradient(
        120% 90% at 100% 0%,
        hsl(var(--hue, 270) 80% 55% / 0.35),
        transparent 60%
      ),
      color-mix(in oklch, var(--color-surface-900), transparent 15%);
    border: 1px solid hsl(var(--hue, 270) 70% 60% / 0.35);
    box-shadow: 0 24px 60px -24px hsl(var(--hue, 270) 80% 50% / 0.55);
    transition: transform 0.15s ease;
  }
  button.hero:active {
    transform: scale(0.985);
  }
  .glow {
    position: absolute;
    inset: auto -20% -60% auto;
    width: 60%;
    aspect-ratio: 1;
    border-radius: 9999px;
    background: hsl(var(--hue, 270) 80% 60% / 0.18);
    filter: blur(50px);
    pointer-events: none;
  }
  .top,
  .bottom {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .tag {
    border-radius: 9999px;
    padding: 0.2rem 0.7rem;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: hsl(var(--hue, 270) 70% 60% / 0.22);
    color: hsl(var(--hue, 270) 90% 85%);
  }
  .tag.live {
    background: rgb(16 185 129 / 0.22);
    color: rgb(110 231 183);
  }
  .time {
    font-size: 0.95rem;
    font-weight: 700;
    color: rgb(209 213 219);
  }
  .subject {
    position: relative;
    margin-top: 0.15rem;
    font-size: 1.25rem;
    font-weight: 800;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .room {
    position: relative;
    font-size: clamp(3.4rem, 17vw, 5.5rem);
    font-weight: 900;
    line-height: 1;
    letter-spacing: -0.03em;
    overflow-wrap: anywhere;
  }
  .room.noroom {
    font-size: 1.6rem;
    color: rgb(156 163 175);
  }
  .when {
    font-size: 1.05rem;
    font-weight: 700;
    color: hsl(var(--hue, 270) 90% 85%);
  }
  .teacher {
    font-size: 0.95rem;
    color: rgb(156 163 175);
    text-align: right;
    margin-left: auto;
  }
  .skeleton {
    min-height: 11rem;
    background: color-mix(in oklch, var(--color-surface-900), transparent 40%);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .empty {
    min-height: 7rem;
    justify-content: center;
    border-color: rgb(255 255 255 / 0.08);
  }
  @keyframes pulse {
    50% {
      opacity: 0.6;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
    .hero {
      transition: none;
    }
  }
</style>
