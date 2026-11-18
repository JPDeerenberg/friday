<script lang="ts">
  /**
   * Friends: compare your schedule with friends' schedules. Read-only and serverless:
   * each person shares a link/QR that contains their lesson times; nothing is
   * uploaded and nobody's data is stored anywhere except on the devices of the
   * people who scanned it. See friends-share.ts.
   */
  import { onMount, untrack } from "svelte";
  import { Bell } from "@lucide/svelte";
  import { get } from "svelte/store";
  import { personId } from "$lib/stores";
  import { getCalendarEvents, formatDate } from "$lib/api";
  import {
    friends,
    friendsActions,
    pendingFriendLink,
  } from "$lib/friends-store";
  import {
    absoluteLessons,
    buildSnapshot,
    defaultWindowStart,
    makeShareLink,
    readShareLink,
    scheduleSignature,
    FriendLinkError,
    type ScheduleSnapshot,
  } from "$lib/friends-share";
  import {
    ageText,
    changeNotice,
    describeNotice,
    freshness,
    friendLabel,
    friendsAsPeople,
  } from "$lib/friends-state";
  import {
    clock,
    commonFreeSlots,
    dayTimeline,
    describePresence,
    presenceOf,
    upcomingSchoolDays,
    type Person,
  } from "$lib/friends-compare";
  import { recordQuestEvent } from "$lib/quests-store";
  import QrCode from "$lib/components/QrCode.svelte";
  import type { CalendarEvent } from "$lib/types";

  const windowStart = defaultWindowStart();
  const windowDays = 14;

  let events = $state<CalendarEvent[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  // ── my schedule ─────────────────────────────────────────────────────────
  async function loadEvents() {
    const pid = get(personId);
    if (pid === null) return;
    try {
      const [y, m, d] = windowStart.split("-").map(Number);
      const start = new Date(y, m - 1, d);
      const end = new Date(y, m - 1, d + windowDays);
      events = await getCalendarEvents(pid, formatDate(start), formatDate(end));
      loadError = null;
    } catch (e) {
      loadError = `Je rooster laden mislukt: ${e instanceof Error ? e.message : e}`;
    } finally {
      loading = false;
    }
  }
  onMount(loadEvents);

  const mySnapshot = $derived<ScheduleSnapshot>(
    buildSnapshot({
      id: $friends.myId,
      name: $friends.myName || "Ik",
      events,
      windowStart,
      days: windowDays,
    }),
  );
  const mySignature = $derived(scheduleSignature(mySnapshot.lessons));
  const notice = $derived(
    loading
      ? null
      : changeNotice($friends, { windowStart, lessons: mySnapshot.lessons }),
  );

  // ── sharing ─────────────────────────────────────────────────────────────
  let shareLink = $state("");
  let showQr = $state(false);
  let copied = $state(false);
  let shareError = $state<string | null>(null);
  let linkSeq = 0;

  $effect(() => {
    const snap = mySnapshot;
    if (loading) return;
    const mine = ++linkSeq;
    makeShareLink(snap)
      .then((link) => {
        if (mine === linkSeq) {
          shareLink = link;
          shareError = null;
        }
      })
      .catch((e) => {
        if (mine === linkSeq) {
          shareLink = "";
          shareError = e instanceof Error ? e.message : String(e);
        }
      });
  });

  function markShared() {
    friendsActions.markShared(
      { windowStart: mySnapshot.windowStart, lessons: mySnapshot.lessons },
      mySignature,
    );
    recordQuestEvent("friend_shared");
  }

  function toggleQr() {
    showQr = !showQr;
    if (showQr) markShared();
  }

  async function copyLink() {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
    } catch {
      const area = document.createElement("textarea");
      area.value = shareLink;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    copied = true;
    setTimeout(() => (copied = false), 2000);
    markShared();
  }

  async function shareNative() {
    if (!shareLink) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Mijn rooster op Friday",
          text: `${mySnapshot.name} deelt het rooster. Open de link in Friday:`,
          url: shareLink,
        });
        markShared();
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    await copyLink();
  }

  // ── adding a friend ─────────────────────────────────────────────────────
  let pasted = $state("");
  let incoming = $state<ScheduleSnapshot | null>(null);
  let importError = $state<string | null>(null);
  let importNote = $state<string | null>(null);

  async function stage(text: string) {
    importError = null;
    importNote = null;
    incoming = null;
    try {
      incoming = await readShareLink(text);
    } catch (e) {
      importError =
        e instanceof FriendLinkError
          ? e.message
          : "Deze link kon niet gelezen worden.";
    }
  }

  // A link opened from outside (QR scan, WhatsApp) arrives through this store.
  $effect(() => {
    const link = $pendingFriendLink;
    if (!link) return;
    untrack(() => {
      pendingFriendLink.set(null);
      void stage(link);
    });
  });

  function confirmAdd() {
    if (!incoming) return;
    const name = incoming.name;
    const status = friendsActions.add(incoming);
    incoming = null;
    pasted = "";
    importNote =
      status === "added"
        ? `${name} is toegevoegd.`
        : status === "updated"
          ? `Het rooster van ${name} is bijgewerkt.`
          : status === "older"
            ? `Je hebt al een nieuwere versie van ${name}.`
            : status === "self"
              ? "Dit is je eigen link."
              : "Je lijst is vol. Verwijder eerst een vriend.";
    if (status === "added") recordQuestEvent("friend_added");
  }

  // ── comparing ───────────────────────────────────────────────────────────
  const days = $derived(
    upcomingSchoolDays(new Date(now), 10).filter((d) => {
      const [y, m, dd] = windowStart.split("-").map(Number);
      const from = new Date(y, m - 1, dd).getTime();
      return d.getTime() >= from && d.getTime() < from + windowDays * 86400000;
    }),
  );
  let dayIndex = $state(0);
  const day = $derived(
    days[Math.min(dayIndex, Math.max(0, days.length - 1))] ?? new Date(now),
  );
  const isToday = $derived(day.toDateString() === new Date(now).toDateString());

  const me = $derived<Person>({
    id: $friends.myId,
    name: "Jij",
    hue: 270,
    lessons: absoluteLessons(mySnapshot),
  });
  const friendPeople = $derived(friendsAsPeople($friends));
  const people = $derived([me, ...friendPeople]);
  const timeline = $derived(dayTimeline(people, day));
  const common = $derived(commonFreeSlots(people, day, 20));
  const presence = $derived(presenceOf(people, now));
  const span = $derived(timeline.endMin - timeline.startMin);
  const hours = $derived(
    Array.from({ length: span / 60 + 1 }, (_, i) => timeline.startMin / 60 + i),
  );
  const pct = (ms: number) => {
    const d = new Date(ms);
    return (
      ((d.getHours() * 60 + d.getMinutes() - timeline.startMin) / span) * 100
    );
  };
  const nowPct = $derived(isToday ? pct(now) : -1);

  const weekday = (d: Date) =>
    d.toLocaleDateString("nl-NL", { weekday: "short" });
  const dayLabel = (d: Date) =>
    d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
</script>

<div class="page">
  <header class="head">
    <h1>Vrienden</h1>
    <p>
      Vergelijk je rooster met dat van je vrienden. Alleen jij bepaalt wat je
      deelt: tijden en vakken, geen cijfers of lokalen.
    </p>
  </header>

  {#if loadError}
    <p class="banner bad" role="alert">{loadError}</p>
  {/if}

  {#if incoming}
    <section class="card confirm" aria-live="polite">
      <h2>{incoming.name} toevoegen?</h2>
      <p class="muted">
        Rooster van {incoming.lessons.length} lessen in {incoming.days === 7
          ? "1 week"
          : "2 weken"}, gedeeld {ageText(incoming.createdAt, now)}. Je ziet
        alleen lestijden en vakken.
      </p>
      <div class="row">
        <button type="button" class="btn primary" onclick={confirmAdd}
          >Toevoegen</button
        >
        <button type="button" class="btn" onclick={() => (incoming = null)}
          >Annuleren</button
        >
      </div>
    </section>
  {/if}
  {#if importError}
    <p class="banner bad" role="alert">{importError}</p>
  {/if}
  {#if importNote}
    <p class="banner good" role="status">{importNote}</p>
  {/if}

  {#if notice}
    <section class="banner notice" role="status">
      <Bell size={16} class="shrink-0" />
      <span>{describeNotice(notice)}</span>
      <button
        type="button"
        class="btn small"
        onclick={() => {
          showQr = true;
          markShared();
          document
            .getElementById("share")
            ?.scrollIntoView({ behavior: "smooth" });
        }}
      >
        Nieuwe QR tonen
      </button>
    </section>
  {/if}

  <!-- Compare -->
  <section class="card">
    <div class="between">
      <h2>Wie heeft wanneer les?</h2>
    </div>

    {#if friendPeople.length === 0}
      <p class="muted">
        Nog geen vrienden toegevoegd. Laat een vriend zijn QR zien of plak zijn
        link hieronder, dan zie je meteen jullie tussenuren.
      </p>
    {:else}
      <div class="days no-scrollbar" role="tablist" aria-label="Dag">
        {#each days as d, i (d.getTime())}
          <button
            type="button"
            role="tab"
            aria-selected={i === dayIndex}
            class="day"
            class:on={i === dayIndex}
            onclick={() => (dayIndex = i)}
          >
            <b>{weekday(d)}</b>
            <small>{dayLabel(d)}</small>
          </button>
        {/each}
      </div>

      {#if isToday}
        <ul class="now">
          {#each presence as e (e.person.id)}
            <li style="--hue:{e.person.hue}">
              <i class="dot"></i>
              <b>{e.person.name}</b>
              <span class="muted">{describePresence(e.presence)}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="tl" aria-label="Tijdlijn van {weekday(day)} {dayLabel(day)}">
        <div class="axis">
          <span class="who"></span>
          <span class="track">
            {#each hours as h, i (h)}
              <em style="left:{(i * 60 * 100) / span}%">{h}</em>
            {/each}
          </span>
        </div>
        <div class="rows">
          <div class="overlay">
            <span class="who"></span>
            <span class="track">
              {#each common.slots as s (s.start)}
                <i
                  class="free"
                  style="left:{pct(s.start)}%;width:{pct(s.end) -
                    pct(s.start)}%"
                  title="Samen vrij {clock(s.start)}–{clock(s.end)}"
                ></i>
              {/each}
              {#if nowPct >= 0 && nowPct <= 100}
                <i class="nowline" style="left:{nowPct}%"></i>
              {/if}
            </span>
          </div>
          {#each timeline.rows as row (row.person.id)}
            <div class="line" style="--hue:{row.person.hue}">
              <span class="who" title={row.person.name}>{row.person.name}</span>
              <span class="track">
                {#each row.blocks as b (b.start)}
                  <i
                    class="block"
                    style="left:{pct(b.start)}%;width:{pct(b.end) -
                      pct(b.start)}%"
                    title="{b.subject} {clock(b.start)}–{clock(b.end)}"
                  >
                    <span>{b.subject}</span>
                  </i>
                {/each}
                {#if row.blocks.length === 0}
                  <span class="nolessons">Geen les</span>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      </div>

      <div class="free-list">
        <h3>Samen vrij</h3>
        {#if common.withLessons === 0}
          <p class="muted">Niemand heeft les op deze dag.</p>
        {:else if common.slots.length === 0}
          <p class="muted">
            Nooit tegelijk een tussenuur.
            {#if common.allDoneAt}Na {clock(common.allDoneAt)} is iedereen klaar.{/if}
          </p>
        {:else}
          <ul>
            {#each common.slots as s (s.start)}
              <li>
                <b class="tabular-nums">{clock(s.start)} – {clock(s.end)}</b>
                <span class="muted">{s.minutes} min</span>
              </li>
            {/each}
          </ul>
          {#if common.allDoneAt}
            <p class="muted">Na {clock(common.allDoneAt)} is iedereen klaar.</p>
          {/if}
        {/if}
      </div>
    {/if}
  </section>

  <!-- Share -->
  <section class="card" id="share">
    <h2>Deel mijn rooster</h2>
    <p class="muted">
      Je rooster zit in de link zelf. Er wordt niets geüpload en niemand kan
      iets van je aanpassen. Verandert je rooster? Dan deel je gewoon een nieuwe
      QR.
    </p>
    <label class="field">
      <span>Jouw naam voor vrienden</span>
      <input
        type="text"
        maxlength="24"
        placeholder="Bijv. Joris"
        value={$friends.myName}
        onchange={(e) => friendsActions.setMyName(e.currentTarget.value)}
      />
    </label>
    {#if loading}
      <p class="muted">Je rooster wordt geladen…</p>
    {:else if !$friends.myName.trim()}
      <p class="muted">Vul eerst je naam in, dan maken we je link.</p>
    {:else if shareError}
      <p class="banner bad">{shareError}</p>
    {:else if mySnapshot.lessons.length === 0}
      <p class="muted">
        Er staan geen lessen in je rooster voor deze en volgende week, dus er
        valt niets te delen.
      </p>
    {:else}
      <div class="row">
        <button
          type="button"
          class="btn primary"
          onclick={shareNative}
          disabled={!shareLink}>Deel link</button
        >
        <button
          type="button"
          class="btn"
          onclick={copyLink}
          disabled={!shareLink}
        >
          {copied ? "Gekopieerd ✓" : "Kopieer link"}
        </button>
        <button
          type="button"
          class="btn"
          onclick={toggleQr}
          disabled={!shareLink}
        >
          {showQr ? "Verberg QR" : "Toon QR"}
        </button>
      </div>
      {#if showQr && shareLink}
        <div class="qrbox">
          <QrCode text={shareLink} size={300} label="QR-code met je rooster" />
          <p class="muted">
            Laat je vriend deze QR scannen met zijn camera. De link opent Friday
            en vraagt of hij je wil toevoegen.
          </p>
        </div>
      {/if}
      <p class="fine">
        Gedeeld: lestijden en vakken van {mySnapshot.lessons.length} lessen in deze
        en volgende week. Niet gedeeld: cijfers, docenten, lokalen, huiswerk.
      </p>
    {/if}
  </section>

  <!-- Add -->
  <section class="card">
    <h2>Vriend toevoegen</h2>
    <p class="muted">
      Scan zijn QR met je camera, of plak hier de link die hij je stuurde.
    </p>
    <div class="row">
      <input
        type="text"
        class="grow"
        placeholder="Plak de link van je vriend"
        aria-label="Link van je vriend"
        bind:value={pasted}
        onkeydown={(e) => e.key === "Enter" && stage(pasted)}
      />
      <button
        type="button"
        class="btn primary"
        onclick={() => stage(pasted)}
        disabled={!pasted.trim()}
      >
        Controleren
      </button>
    </div>
  </section>

  <!-- List -->
  {#if $friends.friends.length > 0}
    <section class="card">
      <h2>Mijn vrienden</h2>
      <ul class="list">
        {#each $friends.friends as f (f.id)}
          {@const fresh = freshness(f.snapshot, now)}
          <li>
            <label class="check">
              <input
                type="checkbox"
                checked={f.enabled}
                onchange={(e) =>
                  friendsActions.setEnabled(f.id, e.currentTarget.checked)}
                aria-label="Toon {friendLabel(f)} in de vergelijking"
              />
              <span class="name">{friendLabel(f)}</span>
            </label>
            <span class="age" class:warn={fresh !== "fresh"}>
              {#if fresh === "expired"}
                Verlopen — vraag een nieuwe QR
              {:else if fresh === "old"}
                {ageText(f.snapshot.createdAt, now)} · misschien verouderd
              {:else}
                {ageText(f.snapshot.createdAt, now)}
              {/if}
            </span>
            <input
              class="nick"
              type="text"
              maxlength="24"
              placeholder="Eigen naam"
              value={f.nickname}
              aria-label="Eigen naam voor {f.name}"
              onchange={(e) =>
                friendsActions.rename(f.id, e.currentTarget.value)}
            />
            <button
              type="button"
              class="btn small danger"
              onclick={() => friendsActions.remove(f.id)}
              aria-label="Verwijder {friendLabel(f)}"
            >
              Verwijder
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .page {
    max-width: 44rem;
    margin: 0 auto;
    padding: 1.5rem 1rem 7rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    color: white;
  }
  .head h1 {
    font-size: 1.6rem;
    font-weight: 900;
  }
  .head p,
  .muted {
    color: rgb(156 163 175);
    font-size: 0.9rem;
    line-height: 1.5;
  }
  .fine {
    color: rgb(107 114 128);
    font-size: 0.75rem;
    margin-top: 0.6rem;
  }
  .card {
    border-radius: 1.5rem;
    padding: 1.1rem 1.2rem;
    border: 1px solid color-mix(in oklch, white, transparent 92%);
    background: color-mix(in oklch, var(--color-surface-900), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .card h2 {
    font-size: 1.1rem;
    font-weight: 800;
  }
  .card h3 {
    font-size: 0.85rem;
    font-weight: 800;
    color: rgb(209 213 219);
  }
  .between {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    border-radius: 1rem;
    padding: 0.7rem 0.9rem;
    font-size: 0.88rem;
  }
  .banner.bad {
    color: rgb(252 165 165);
    background: rgb(239 68 68 / 0.12);
    border: 1px solid rgb(239 68 68 / 0.25);
  }
  .banner.good {
    color: rgb(110 231 183);
    background: rgb(16 185 129 / 0.12);
    border: 1px solid rgb(16 185 129 / 0.25);
  }
  .banner.notice {
    color: rgb(199 210 254);
    background: rgb(99 102 241 / 0.14);
    border: 1px solid rgb(99 102 241 / 0.3);
  }
  .confirm {
    border-color: rgb(99 102 241 / 0.4);
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .btn {
    padding: 0.55rem 1rem;
    border-radius: 9999px;
    font-size: 0.85rem;
    font-weight: 700;
    color: white;
    background: color-mix(in oklch, white, transparent 90%);
    border: 1px solid transparent;
  }
  .btn.primary {
    background: var(--color-primary-500, #8b5cf6);
  }
  .btn.small {
    padding: 0.3rem 0.7rem;
    font-size: 0.75rem;
  }
  .btn.danger {
    color: rgb(252 165 165);
  }
  .btn:disabled {
    opacity: 0.5;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.78rem;
    color: rgb(156 163 175);
  }
  input[type="text"] {
    width: 100%;
    padding: 0.55rem 0.8rem;
    border-radius: 0.8rem;
    color: white;
    font-size: 0.9rem;
    background: color-mix(in oklch, white, transparent 92%);
    border: 1px solid color-mix(in oklch, white, transparent 88%);
  }
  input.grow {
    flex: 1;
    min-width: 12rem;
  }
  .qrbox {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    text-align: center;
  }

  /* day tabs */
  .days {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
  }
  .day {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.4rem 0.8rem;
    border-radius: 1rem;
    color: rgb(209 213 219);
    background: color-mix(in oklch, white, transparent 94%);
    border: 1px solid transparent;
  }
  .day small {
    font-size: 0.7rem;
    color: rgb(156 163 175);
  }
  .day.on {
    border-color: var(--color-primary-500, #8b5cf6);
    background: color-mix(
      in oklch,
      var(--color-primary-500, #8b5cf6),
      transparent 80%
    );
  }

  /* presence list */
  .now {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .now li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.88rem;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 9999px;
    background: hsl(var(--hue) 70% 60%);
    flex: none;
    align-self: center;
  }

  /* timeline */
  .tl {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.75rem;
  }
  .axis,
  .line,
  .overlay {
    display: grid;
    grid-template-columns: 4.5rem 1fr;
    align-items: center;
    gap: 0.5rem;
  }
  .rows {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
  }
  .overlay .track {
    height: 100%;
  }
  .who {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 700;
    color: rgb(209 213 219);
  }
  .track {
    position: relative;
    height: 2.1rem;
    border-radius: 0.6rem;
    background: color-mix(in oklch, white, transparent 95%);
  }
  .axis .track {
    height: 1rem;
    background: none;
  }
  .axis em {
    position: absolute;
    transform: translateX(-50%);
    font-style: normal;
    color: rgb(107 114 128);
  }
  .block {
    position: absolute;
    top: 0.15rem;
    bottom: 0.15rem;
    border-radius: 0.4rem;
    overflow: hidden;
    background: hsl(var(--hue) 60% 42% / 0.9);
    border: 1px solid hsl(var(--hue) 70% 65% / 0.5);
    display: flex;
    align-items: center;
    padding: 0 0.25rem;
  }
  .block span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.62rem;
    font-weight: 700;
  }
  .free {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgb(16 185 129 / 0.22);
    border-left: 1px dashed rgb(16 185 129 / 0.7);
    border-right: 1px dashed rgb(16 185 129 / 0.7);
  }
  .nowline {
    position: absolute;
    top: -0.2rem;
    bottom: -0.2rem;
    width: 2px;
    background: rgb(251 191 36);
  }
  .nolessons {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: rgb(107 114 128);
  }
  .free-list ul {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.3rem;
  }
  .free-list li {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    font-size: 0.9rem;
    color: rgb(110 231 183);
  }

  /* friends list */
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .list li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.3rem 0.6rem;
    align-items: center;
    padding-bottom: 0.7rem;
    border-bottom: 1px solid color-mix(in oklch, white, transparent 94%);
  }
  .list li:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .name {
    font-weight: 700;
  }
  .age {
    font-size: 0.75rem;
    color: rgb(156 163 175);
    text-align: right;
  }
  .age.warn {
    color: rgb(252 211 77);
  }
  .nick {
    grid-column: 1;
  }
</style>
