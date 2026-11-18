<script lang="ts">
  /**
   * Home-screen friends card: who is free right now, and a nudge to share a new
   * QR when your own schedule changed. Everything comes from links friends shared
   * — no server involved (see friends-share.ts).
   */
  import { onMount } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { currentPage } from "$lib/stores";
  import { friends, pendingFriendLink } from "$lib/friends-store";
  import { buildSnapshot, defaultWindowStart } from "$lib/friends-share";
  import {
    changeNotice,
    describeNotice,
    friendsAsPeople,
  } from "$lib/friends-state";
  import { describePresence, presenceOf } from "$lib/friends-compare";
  import type { CalendarEvent } from "$lib/types";

  let { events }: { events: CalendarEvent[] } = $props();

  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const people = $derived(friendsAsPeople($friends));
  const entries = $derived(presenceOf(people, now));
  const free = $derived(
    entries.filter(
      (e) =>
        e.presence.kind === "gap" ||
        e.presence.kind === "done" ||
        e.presence.kind === "before",
    ),
  );
  const inLesson = $derived(
    entries.filter((e) => e.presence.kind === "in-lesson").length,
  );

  const notice = $derived.by(() => {
    if (events.length === 0) return null;
    const windowStart = defaultWindowStart(new Date(now));
    const snap = buildSnapshot({
      id: $friends.myId,
      name: "Ik",
      events,
      windowStart,
      days: 14,
    });
    return changeNotice($friends, { windowStart, lessons: snap.lessons });
  });

  const go = () => currentPage.set("friends");
</script>

<button type="button" class="card" onclick={go} aria-label="Open vrienden">
  <span class="head">
    <b class="title"><Icon name="users" size={16} /> Vrienden</b>
    {#if people.length > 0}<small
        >{people.length} {people.length === 1 ? "vriend" : "vrienden"}</small
      >{/if}
  </span>

  {#if $pendingFriendLink}
    <span class="notice"
      ><Icon name="mail" size={14} /> Je hebt een vriendenlink ontvangen. Tik om hem
      te bekijken.</span
    >
  {/if}

  {#if people.length === 0}
    <span class="cta">
      Vergelijk je rooster met vrienden en zie meteen jullie tussenuren. Deel
      een QR, klaar.
    </span>
  {:else if free.length > 0}
    <ul>
      {#each free.slice(0, 3) as e (e.person.id)}
        <li style="--hue:{e.person.hue}">
          <i class="dot"></i>
          <b>{e.person.name}</b>
          <span>{describePresence(e.presence)}</span>
        </li>
      {/each}
    </ul>
    {#if free.length > 3}<small class="more">+{free.length - 3} meer</small
      >{/if}
  {:else}
    <span class="cta">
      {inLesson > 0
        ? "Je vrienden zitten nu allemaal in de les."
        : "Vandaag geen lessen bij je vrienden."}
    </span>
  {/if}

  {#if notice}
    <span class="notice"
      ><Icon name="bell" size={14} /> {describeNotice(notice)}</span
    >
  {/if}
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    width: 100%;
    text-align: left;
    border-radius: 1.5rem;
    padding: 1.1rem 1.2rem;
    color: white;
    border: 1px solid color-mix(in oklch, white, transparent 92%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 25%);
    transition: transform 0.15s ease;
  }
  .card:active {
    transform: scale(0.985);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 1.15rem;
  }
  .head b {
    font-weight: 800;
  }
  small,
  .cta {
    font-size: 0.85rem;
    color: rgb(156 163 175);
    line-height: 1.45;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  li span {
    color: rgb(156 163 175);
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 9999px;
    align-self: center;
    background: hsl(var(--hue) 70% 60%);
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: rgb(199 210 254);
    background: rgb(99 102 241 / 0.14);
    border: 1px solid rgb(99 102 241 / 0.3);
    border-radius: 0.9rem;
    padding: 0.45rem 0.65rem;
  }
  @media (prefers-reduced-motion: reduce) {
    .card {
      transition: none;
    }
  }
</style>
