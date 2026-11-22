<script lang="ts">
  /**
   * Friends: compare your schedule with friends' schedules. Read-only and serverless:
   * each person shares a link/QR that contains their lesson times; nothing is
   * uploaded and nobody's data is stored anywhere except on the devices of the
   * people who scanned it. See friends-share.ts for the format and
   * friends-compare.ts for the schedule maths.
   *
   * Everything is local and defensive: links are untrusted input, snapshots can
   * be expired or cover only one week, and a friend can turn their schedule off.
   */
  import { onMount, untrack } from "svelte";
  import { get } from "svelte/store";
  import {
    Bell,
    CalendarDays,
    Check,
    Clock,
    Copy,
    Link2,
    QrCode as QrCodeIcon,
    RefreshCw,
    Share2,
    Sparkles,
    Star,
    UserPlus,
    Users,
  } from "@lucide/svelte";
  import { personId, resumedAt } from "#lib/stores.ts";
  import { getCalendarEvents, formatDate } from "#lib/api.ts";
  import {
    friends,
    friendsActions,
    pendingFriendLink,
  } from "#lib/friends-store.ts";
  import {
    absoluteLessons,
    buildSnapshot,
    defaultWindowStart,
    makeShareLink,
    readShareLink,
    scheduleSignature,
    snapshotRange,
    FriendLinkError,
    type ScheduleSnapshot,
  } from "#lib/friends-share.ts";
  import {
    ageText,
    changeNotice,
    describeNotice,
    freshness,
    friendLabel,
    friendsAsPeople,
    MAX_FRIENDS,
    type FriendRecord,
  } from "#lib/friends-state.ts";
  import {
    availability,
    bestMoment,
    bestMomentFor,
    clock,
    commonFreeSlots,
    coversDay,
    dayTimeline,
    describePresence,
    hueForId,
    joinNames,
    lessonsOnDay,
    presenceOf,
    sharedFreeSlots,
    upcomingSchoolDays,
    type Person,
    type Presence,
  } from "#lib/friends-compare.ts";
  import { recordQuestEvent } from "#lib/quests-store.ts";
  import Button from "#lib/components/Button.svelte";
  import Switch from "#lib/components/Switch.svelte";
  import QrCode from "#lib/components/QrCode.svelte";
  import type { CalendarEvent } from "#lib/types.ts";

  const windowDays = 14;
  /** Shortest shared gap that is worth showing. */
  const MIN_FREE = 10;

  let events = $state<CalendarEvent[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let loadedWindow = $state<string | null>(null);
  let loadSeq = 0;

  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  // ── my schedule ─────────────────────────────────────────────────────────
  // Recomputed at midnight so the page rolls over to the new week by itself.
  const windowStart = $derived(defaultWindowStart(new Date(now)));

  async function loadEvents(ws: string, force = false, silent = false) {
    const pid = get(personId);
    if (pid === null) {
      loading = false;
      return;
    }
    if (!force && loadedWindow === ws) return;
    const seq = ++loadSeq;
    if (!silent) loading = true;
    try {
      const [y, m, d] = ws.split("-").map(Number);
      const start = new Date(y, m - 1, d);
      const end = new Date(y, m - 1, d + windowDays);
      const next = await getCalendarEvents(
        pid,
        formatDate(start),
        formatDate(end),
      );
      if (seq !== loadSeq) return;
      events = next;
      loadedWindow = ws;
      loadError = null;
    } catch (e) {
      if (seq !== loadSeq) return;
      loadError = `Je rooster laden mislukt: ${e instanceof Error ? e.message : e}`;
    } finally {
      if (seq === loadSeq && !silent) loading = false;
    }
  }

  $effect(() => {
    const ws = windowStart;
    untrack(() => void loadEvents(ws));
  });

  // Coming back to the app (desktop resume, Android foreground) refreshes quietly.
  let lastResume = get(resumedAt);
  $effect(() => {
    const r = $resumedAt;
    if (r === lastResume) return;
    lastResume = r;
    now = Date.now();
    untrack(() => {
      if (loadedWindow) void loadEvents(loadedWindow, true, true);
    });
  });

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
  const myRange = $derived(snapshotRange(mySnapshot));
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
  let actionError = $state<string | null>(null);
  let linkSeq = 0;

  // Local draft so a trailing space is not trimmed out from under the cursor,
  // while the store (and therefore the link) updates on every keystroke.
  let nameDraft = $state($friends.myName);
  function updateName() {
    friendsActions.setMyName(nameDraft);
  }

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

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  async function copyLink() {
    if (!shareLink) return;
    const ok = await copyText(shareLink);
    if (!ok) {
      actionError =
        "Kopiëren lukte niet. Selecteer de link en kopieer hem zelf.";
      return;
    }
    actionError = null;
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
          text: `${mySnapshot.name} deelt het rooster op Friday. Open de link en voeg me toe:`,
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

  function scrollTo(id: string) {
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── adding a friend ─────────────────────────────────────────────────────
  let pasted = $state("");
  let incoming = $state<ScheduleSnapshot | null>(null);
  /** Set when the incoming link belongs to someone already in the list. */
  let incomingExisting = $state<FriendRecord | null>(null);
  let importError = $state<string | null>(null);
  let importNote = $state<string | null>(null);

  function noteForStatus(name: string, status: string): string {
    return status === "added"
      ? `${name} is toegevoegd.`
      : status === "updated"
        ? `Het rooster van ${name} is bijgewerkt.`
        : status === "older"
          ? `Je hebt al een nieuwere versie van ${name}.`
          : status === "self"
            ? "Dit is je eigen link."
            : "Je lijst is vol. Verwijder eerst een vriend.";
  }

  async function stage(text: string) {
    importError = null;
    importNote = null;
    incoming = null;
    incomingExisting = null;
    if (!text.trim()) return;
    try {
      const snapshot = await readShareLink(text);
      const state = get(friends);
      if (snapshot.id === state.myId) {
        importNote = "Dit is je eigen link.";
        return;
      }
      // Known friend: a new link updates the existing entry, never adds a second.
      const known = state.friends.find((f) => f.id === snapshot.id);
      if (known) {
        if (snapshot.createdAt > known.snapshot.createdAt) {
          friendsActions.add(snapshot);
          importNote = `Rooster van ${friendLabel(known)} is bijgewerkt.`;
        } else {
          importNote = `Je hebt al de nieuwste versie van ${friendLabel(known)}.`;
        }
        return;
      }
      // Same name, different id (reinstall or another device): offer to update
      // that friend instead of quietly creating a duplicate.
      const name = snapshot.name.trim().toLowerCase();
      const sameName = state.friends.filter(
        (f) => f.snapshot.name.trim().toLowerCase() === name,
      );
      if (sameName.length === 1) {
        const existing = sameName[0];
        if (snapshot.createdAt <= existing.snapshot.createdAt) {
          importNote = `Je hebt al de nieuwste versie van ${friendLabel(existing)}.`;
          return;
        }
        incomingExisting = existing;
      }
      incoming = snapshot;
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
    const snapshot = incoming;
    const existing = incomingExisting;
    incoming = null;
    incomingExisting = null;
    pasted = "";
    if (existing) {
      friendsActions.adopt(existing.id, snapshot);
      importNote = `Rooster van ${friendLabel(existing)} is bijgewerkt.`;
      return;
    }
    const status = friendsActions.add(snapshot);
    importNote = noteForStatus(snapshot.name, status);
    if (status === "added") recordQuestEvent("friend_added");
  }

  /** "Dit is iemand anders": keep the same-named friend and add this link as new. */
  function addAsNew() {
    if (!incoming) return;
    const snapshot = incoming;
    incoming = null;
    incomingExisting = null;
    pasted = "";
    const status = friendsActions.add(snapshot);
    importNote = noteForStatus(snapshot.name, status);
    if (status === "added") recordQuestEvent("friend_added");
  }

  // ── comparing ───────────────────────────────────────────────────────────
  const days = $derived.by(() => {
    const range = snapshotRange({ windowStart, days: windowDays });
    return upcomingSchoolDays(new Date(now), 14).filter(
      (d) => d.getTime() >= range.from && d.getTime() < range.to,
    );
  });

  const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const me = $derived<Person>({
    id: $friends.myId,
    name: "Jij",
    hue: 270,
    lessons: absoluteLessons(mySnapshot),
  });
  const friendPeople = $derived(friendsAsPeople($friends));
  const people = $derived([me, ...friendPeople]);

  let pickedDay = $state<string | null>(null);
  const firstCovered = $derived(
    days.findIndex((d) => friendPeople.some((p) => coversDay(p, d))),
  );
  const activeIndex = $derived.by(() => {
    if (days.length === 0) return 0;
    const picked = pickedDay
      ? days.findIndex((d) => dayKey(d) === pickedDay)
      : -1;
    return picked >= 0 ? picked : Math.max(0, firstCovered);
  });
  const day = $derived(days[activeIndex] ?? new Date(now));
  const isToday = $derived(day.toDateString() === new Date(now).toDateString());

  const dayPeople = $derived(people.filter((p) => coversDay(p, day)));
  const missingPeople = $derived(
    friendPeople.filter((p) => !coversDay(p, day)),
  );
  const timeline = $derived(dayTimeline(dayPeople, day));
  const span = $derived(timeline.endMin - timeline.startMin);
  const hourCount = $derived(Math.max(1, span / 60));
  const hourLabels = $derived(
    Array.from({ length: hourCount + 1 }, (_, i) => {
      const h = Math.round(timeline.startMin / 60) + i;
      return `${String(h).padStart(2, "0")}:00`;
    }),
  );
  const pct = (ms: number) => {
    const d = new Date(ms);
    return (
      ((d.getHours() * 60 + d.getMinutes() - timeline.startMin) / span) * 100
    );
  };
  const nowPct = $derived(isToday ? pct(now) : -1);

  const common = $derived(commonFreeSlots(dayPeople, day, MIN_FREE));
  const windows = $derived(availability(dayPeople, day, MIN_FREE));
  const best = $derived(bestMoment(windows));
  const alternatives = $derived(
    windows
      .filter((w) => !best || w.start !== best.start || w.end !== best.end)
      .sort((a, b) => b.minutes - a.minutes || a.start - b.start),
  );
  const presence = $derived(presenceOf(dayPeople, now));

  // Best moment per day, shown as a small badge on the day tabs.
  const weekBest = $derived(
    days.map((d) => bestMomentFor(people, d, MIN_FREE)),
  );

  const nameOf = (p: Person) => (p.id === me.id ? "jij" : p.name);
  const namesOf = (ps: ReadonlyArray<Person>) => {
    const s = joinNames(ps.map(nameOf));
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const currentWindow = $derived(
    isToday
      ? (windows.find((w) => now >= w.start && now < w.end) ?? null)
      : null,
  );

  const nowInfo = $derived.by(() => {
    if (!isToday || dayPeople.length < 2) return null;
    const mine = presence[0]?.presence;
    if (!mine) return null;
    const freeFriends = currentWindow
      ? currentWindow.free.filter((p) => p.id !== me.id)
      : presence
          .slice(1)
          .filter((e) => e.presence.kind !== "in-lesson")
          .map((e) => e.person);
    const freeText = freeWindowText(mine);

    if (mine.kind === "in-lesson") {
      return {
        tone: "busy" as const,
        headline: `Je hebt nu ${mine.subject ?? "les"} tot ${clock(mine.until!)}`,
        sub:
          freeFriends.length > 0
            ? `${namesOf(freeFriends)} ${freeFriends.length === 1 ? "is" : "zijn"} nu vrij.`
            : "Je vrienden zitten nu ook in de les.",
      };
    }
    if (freeFriends.length > 0) {
      // How long does this exact group stay free together? A friend whose
      // next lesson starts sooner than yours cuts the shared window short.
      const nextStarts = [me, ...freeFriends].flatMap((p) =>
        lessonsOnDay(p.lessons, day.getTime())
          .filter((l) => l.start > now)
          .map((l) => l.start),
      );
      const until = currentWindow
        ? currentWindow.end
        : nextStarts.length > 0
          ? Math.min(...nextStarts)
          : null;
      return {
        tone: "good" as const,
        headline: `Je bent nu vrij met ${joinNames(freeFriends.map(nameOf))}`,
        sub: until ? `Samen vrij tot ${clock(until)}.` : "De rest van de dag.",
      };
    }
    return {
      tone: "neutral" as const,
      headline: "Je bent nu vrij",
      sub: freeText ?? "Je vrienden zitten nu in de les.",
    };
  });

  const nextWindow = $derived(
    isToday ? (windows.find((w) => w.start > now) ?? null) : null,
  );

  function freeWindowText(p: Presence): string {
    switch (p.kind) {
      case "gap":
      case "before":
        return `Tot ${clock(p.until!)}.`;
      case "done":
        return "De rest van de dag.";
      case "no-school":
        return "De hele dag.";
      default:
        return "";
    }
  }

  function freeWindow(w: { start: number; end: number }): string {
    return `${clock(w.start)}–${clock(w.end)}`;
  }

  const weekday = (d: Date) =>
    d.toLocaleDateString("nl-NL", { weekday: "short" });
  const dayLabel = (d: Date) =>
    d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
  const dayLong = (d: Date) =>
    d.toLocaleDateString("nl-NL", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

  const rangeEndLabel = (f: FriendRecord) => {
    const last = new Date(snapshotRange(f.snapshot).to);
    last.setDate(last.getDate() - 1);
    return last.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
  };

  const friendPeopleWithData = $derived(
    friendPeople.filter((p) => (p.coversTo ?? Number.POSITIVE_INFINITY) > now),
  );
  const expiredFriends = $derived(
    $friends.friends.filter(
      (f) => f.enabled && freshness(f.snapshot, now) === "expired",
    ),
  );

  // ── friend list ─────────────────────────────────────────────────────────
  let confirmRemove = $state<string | null>(null);
  let removeTimer: ReturnType<typeof setTimeout> | undefined;

  function askRemove(id: string) {
    if (confirmRemove === id) {
      clearTimeout(removeTimer);
      confirmRemove = null;
      friendsActions.remove(id);
      return;
    }
    confirmRemove = id;
    clearTimeout(removeTimer);
    removeTimer = setTimeout(() => (confirmRemove = null), 4000);
  }

  $effect(() => () => clearTimeout(removeTimer));

  const incomingExpired = $derived(
    incoming ? freshness(incoming, now) === "expired" : false,
  );
  const lastDay = (to: number) => {
    const d = new Date(to);
    d.setDate(d.getDate() - 1);
    return d;
  };
  const incomingEnd = $derived(
    incoming ? lastDay(snapshotRange(incoming).to) : null,
  );

  const shareValidUntil = $derived(
    lastDay(myRange.to).toLocaleDateString("nl-NL", {
      weekday: "short",
      day: "numeric",
      month: "short",
    }),
  );
</script>

<div class="page">
  <header class="head">
    <div class="head-copy">
      <h1>Vrienden</h1>
      <p>
        Vergelijk je rooster met dat van je vrienden en zie meteen wanneer
        jullie samen vrij zijn. Alleen jij bepaalt wat je deelt: lestijden en
        vakken, geen cijfers, docenten of lokalen.
      </p>
    </div>
    <button
      type="button"
      class="icon-btn"
      onclick={() => {
        now = Date.now();
        void loadEvents(windowStart, true);
      }}
      disabled={loading}
      aria-label="Rooster vernieuwen"
      title="Rooster vernieuwen"
    >
      <span class="refresh-icon" class:spinning={loading}>
        <RefreshCw size={18} />
      </span>
    </button>
  </header>

  {#if loadError}
    <div class="banner bad" role="alert">
      <span>{loadError}</span>
      <button
        type="button"
        class="text-btn"
        onclick={() => {
          now = Date.now();
          void loadEvents(windowStart, true);
        }}
      >
        Opnieuw proberen
      </button>
    </div>
  {/if}

  {#if incoming}
    <section class="card confirm" aria-live="polite">
      <div class="card-head">
        <h2>
          {incomingExisting
            ? `${friendLabel(incomingExisting)} bijwerken?`
            : `${incoming.name} toevoegen?`}
        </h2>
        <span class="pill primary">
          <UserPlus size={14} />
          {incomingExisting ? "Bijwerken" : "Nieuwe vriend"}
        </span>
      </div>
      {#if incomingExisting}
        <p class="fine">
          Er staat al een vriend met de naam {incoming.name}. Bijwerken vervangt
          het oude rooster; er komt geen tweede bij.
        </p>
      {/if}
      <p class="muted">
        Rooster van {incoming.lessons.length}
        {incoming.lessons.length === 1 ? "les" : "lessen"} in
        {incoming.days === 7
          ? "1 week"
          : incoming.days === 14
            ? "2 weken"
            : `${incoming.days} dagen`}, gedeeld {ageText(
          incoming.createdAt,
          now,
        )}.
        {#if incomingEnd}Geldig tot {dayLabel(incomingEnd)}.{/if}
      </p>
      {#if incomingExpired}
        <div class="banner warn" role="status">
          <span
            >Dit rooster is van een eerdere week. Je kunt het
            {incomingExisting ? "bijwerken" : "toevoegen"}, maar het verschijnt
            pas weer als {incoming.name} een nieuwe link deelt.</span
          >
        </div>
      {:else}
        <p class="fine">Je ziet alleen lestijden en vakken.</p>
      {/if}
      <div class="row">
        <Button onclick={confirmAdd}
          >{incomingExisting ? "Bijwerken" : "Toevoegen"}</Button
        >
        {#if incomingExisting}
          <Button variant="text" onclick={addAsNew}>Dit is iemand anders</Button
          >
        {/if}
        <Button
          variant="text"
          onclick={() => {
            incoming = null;
            incomingExisting = null;
          }}>Annuleren</Button
        >
      </div>
    </section>
  {/if}

  {#if notice}
    <section class="banner notice" role="status">
      <Bell size={16} class="shrink-0" />
      <span>{describeNotice(notice)}</span>
      <button
        type="button"
        class="text-btn"
        onclick={() => {
          showQr = true;
          markShared();
          scrollTo("share");
        }}
      >
        Nieuwe QR tonen
      </button>
    </section>
  {/if}

  <!-- Compare -->
  <section class="card compare" aria-labelledby="compare-title">
    <div class="card-head">
      <div>
        <h2 id="compare-title">Wie heeft wanneer les?</h2>
        <p class="sub muted">
          {dayLong(day)} · tik op een dag om te wisselen<span class="days-hint"
            >{" · veeg voor meer dagen"}</span
          >
        </p>
      </div>
      {#if friendPeople.length > 0}
        <div class="legend" aria-hidden="true">
          <span><i class="sw band"></i> iedereen vrij</span>
          <span><i class="sw shared"></i> jij + deze persoon</span>
        </div>
      {/if}
    </div>

    {#if loading}
      <div class="loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        Je rooster wordt geladen…
      </div>
    {:else if $friends.friends.length > 0 && friendPeople.length === 0}
      <div class="empty">
        <span class="empty-icon warn"><Users size={22} /></span>
        <div>
          <h3>Alle vrienden staan uit</h3>
          <p class="muted">
            Zet bij “Mijn vrienden” minstens één vriend aan om zijn rooster hier
            te vergelijken.
          </p>
        </div>
        <div class="row">
          <Button variant="tonal" onclick={() => scrollTo("friends")}>
            Naar mijn vrienden
          </Button>
        </div>
      </div>
    {:else if friendPeople.length === 0}
      <div class="empty">
        <span class="empty-icon"><Users size={22} /></span>
        <div>
          <h3>Nog geen vrienden</h3>
          <p class="muted">
            Deel je rooster met een vriend en voeg zijn link toe. Daarna zie je
            hier elkaars lessen, tussenuren en de momenten waarop jullie allebei
            vrij zijn.
          </p>
        </div>
        <div class="row">
          <Button onclick={() => scrollTo("share")}>
            <Share2 size={16} /> Mijn rooster delen
          </Button>
          <Button variant="tonal" onclick={() => scrollTo("add")}>
            <UserPlus size={16} /> Vriend toevoegen
          </Button>
        </div>
        <p class="fine">Alleen lestijden en vakken; niets wordt geüpload.</p>
      </div>
    {:else if friendPeopleWithData.length === 0}
      <div class="empty">
        <span class="empty-icon warn"><Clock size={22} /></span>
        <div>
          <h3>De gedeelde roosters zijn verlopen</h3>
          <p class="muted">
            Je vrienden deelden een rooster van een eerdere week. Vraag een
            nieuwe QR of link, dan kun je weer vergelijken.
          </p>
        </div>
        <div class="row">
          <Button variant="tonal" onclick={() => scrollTo("friends")}>
            Bekijk mijn vrienden
          </Button>
          <Button variant="text" onclick={() => scrollTo("share")}>
            Mijn eigen QR
          </Button>
        </div>
      </div>
    {:else}
      <div class="days no-scrollbar" role="tablist" aria-label="Kies een dag">
        {#each days as d, i (d.getTime())}
          {@const wb = weekBest[i]}
          <button
            type="button"
            role="tab"
            aria-selected={i === activeIndex}
            class="day"
            class:on={i === activeIndex}
            onclick={() => (pickedDay = dayKey(d))}
            title="{dayLong(d)}{wb ? ` — ${wb.minutes} min samen vrij` : ''}"
          >
            <b>{weekday(d)}</b>
            <small>{dayLabel(d)}</small>
            {#if wb}
              <em class:all={wb.busy.length === 0}>{wb.minutes}m</em>
            {:else}
              <em class="none">–</em>
            {/if}
          </button>
        {/each}
      </div>

      {#if isToday && dayPeople.length > 1}
        <ul class="presence no-scrollbar" aria-label="Status van nu">
          {#each presence as e (e.person.id)}
            <li style="--hue:{e.person.hue}" class:me={e.person.id === me.id}>
              <i class="dot" aria-hidden="true"></i>
              <b>{e.person.name}</b>
              <span class="muted">{describePresence(e.presence)}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if nowInfo}
        <div
          class="now-box"
          class:good={nowInfo.tone === "good"}
          class:busy={nowInfo.tone === "busy"}
        >
          <Clock size={16} class="shrink-0" />
          <div>
            <b>{nowInfo.headline}</b>
            {#if nowInfo.sub}<small>{nowInfo.sub}</small>{/if}
          </div>
        </div>
        {#if nextWindow}
          <p class="next">
            <Sparkles size={14} />
            <span>
              Eerstvolgende moment samen vrij:
              <b>{freeWindow(nextWindow)}</b> met {joinNames(
                nextWindow.free
                  .filter((p) => p.id !== me.id)
                  .map((p) => p.name),
              )}.
            </span>
          </p>
        {/if}
      {/if}

      {#if dayPeople.length === 1}
        <div class="banner info" role="status">
          <span>Je vrienden deelden geen rooster dat deze dag dekt.</span>
          {#if firstCovered >= 0}
            <button
              type="button"
              class="text-btn"
              onclick={() => (pickedDay = dayKey(days[firstCovered]))}
            >
              Ga naar een dag met gegevens
            </button>
          {/if}
        </div>
      {/if}

      <div class="tl-wrap">
        <div class="tl" style="--hour-count:{hourCount}">
          <div class="tl-row axis" aria-hidden="true">
            <span class="who"></span>
            <span class="track">
              {#each hourLabels as label, i (label)}
                <em style="left:{(i * 100) / hourCount}%">{label}</em>
              {/each}
            </span>
          </div>

          <div class="tl-row band">
            <span class="who"><span class="band-label">Iedereen</span></span>
            <span class="track">
              {#each common.slots as s (s.start)}
                <i
                  class="free"
                  style="left:{pct(s.start)}%;width:{pct(s.end) -
                    pct(s.start)}%"
                  title="Samen vrij {clock(s.start)}–{clock(s.end)}"
                ></i>
              {/each}
              {#if common.slots.length === 0}
                <span class="hint">
                  {common.withLessons === 0
                    ? "niemand heeft les"
                    : "geen gaatje tussen de lessen"}
                </span>
              {/if}
            </span>
          </div>

          {#each timeline.rows as row (row.person.id)}
            {@const shared =
              row.person.id === me.id
                ? []
                : sharedFreeSlots(me, row.person, day)}
            <div class="tl-row line" style="--hue:{row.person.hue}">
              <span class="who" title={row.person.name}>
                <i class="dot" aria-hidden="true"></i>
                <span>{row.person.name}</span>
              </span>
              <span class="track">
                {#each shared as f (f.start)}
                  <i
                    class="shared"
                    style="left:{pct(f.start)}%;width:{pct(f.end) -
                      pct(f.start)}%"
                    title="Jij en {row.person.name} vrij {clock(
                      f.start,
                    )}–{clock(f.end)}"
                  ></i>
                {/each}
                {#each row.blocks as b (b.key)}
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
                  <span class="hint">Geen les</span>
                {/if}
              </span>
            </div>
          {/each}

          {#if nowPct >= 0 && nowPct <= 100}
            <div class="now-layer" aria-hidden="true">
              <i class="nowline" style="left:{nowPct}%" title="Nu, {clock(now)}"
              ></i>
            </div>
          {/if}
        </div>
      </div>
      <p class="fine tl-hint">Veeg opzij om de hele dag te zien.</p>

      {#if missingPeople.length > 0}
        <p class="fine">
          Geen gegevens voor deze dag van
          {joinNames(missingPeople.map((p) => p.name))}. Hun rooster dekt deze
          week niet.
        </p>
      {/if}

      <div class="summary">
        {#if best}
          <div class="best" class:all={best.busy.length === 0}>
            <span class="best-label"><Star size={14} /> Beste moment</span>
            <span class="best-time">{freeWindow(best)}</span>
            <span class="best-who">
              {namesOf(best.free)} · {best.minutes} min
              {#if best.busy.length > 0}
                · {namesOf(best.busy)}
                {best.busy.length === 1 ? "heeft" : "hebben"} les
              {/if}
            </span>
          </div>
        {:else}
          <div class="best none">
            <span class="best-label"><Clock size={14} /> Samen vrij</span>
            <span class="best-time">–</span>
            <span class="best-who">
              {#if dayPeople.length === 1}
                Geen vrienden met gegevens voor deze dag.
              {:else if common.withLessons === 0}
                Niemand heeft les op deze dag.
              {:else}
                Geen moment van minstens {MIN_FREE} min waarin jij en een vriend tegelijk
                vrij zijn.
                {#if common.allDoneAt}Na {clock(common.allDoneAt)} is iedereen klaar.{/if}
              {/if}
            </span>
          </div>
        {/if}

        {#if alternatives.length > 0}
          <ul class="windows" aria-label="Andere vrije momenten">
            {#each alternatives as w (w.start)}
              <li class:all={w.busy.length === 0}>
                <span class="w-time">{freeWindow(w)}</span>
                <span class="w-dur">{w.minutes} min</span>
                <span class="w-who">{namesOf(w.free)}</span>
                <span class="w-tag" class:ok={w.busy.length === 0}>
                  {w.busy.length === 0
                    ? "iedereen"
                    : `${w.busy.length} ${w.busy.length === 1 ? "persoon" : "mensen"} in les`}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if common.allDoneAt && common.slots.length > 0}
        <p class="fine">
          Na {clock(common.allDoneAt)} is iedereen klaar. Alleen momenten van minstens
          {MIN_FREE} minuten staan hierboven.
        </p>
      {/if}

      <details class="agenda">
        <summary>
          <CalendarDays size={15} />
          Agenda per persoon
        </summary>
        <div class="agenda-list">
          {#each timeline.rows as row (row.person.id)}
            {@const free =
              row.person.id === me.id
                ? []
                : sharedFreeSlots(me, row.person, day)}
            <div class="agenda-person" style="--hue:{row.person.hue}">
              <div class="agenda-head">
                <i class="dot" aria-hidden="true"></i>
                <b>{row.person.name}</b>
                <span class="muted">
                  {row.blocks.length === 0
                    ? "Geen les"
                    : `${row.blocks.length} ${row.blocks.length === 1 ? "les" : "lessen"}`}
                </span>
              </div>
              <ul>
                {#each row.blocks as b (b.key)}
                  <li>
                    <span class="time">{clock(b.start)}–{clock(b.end)}</span>
                    <span>{b.subject}</span>
                  </li>
                {/each}
                {#each free as f (f.start)}
                  <li class="free-line">
                    <span class="time">{clock(f.start)}–{clock(f.end)}</span>
                    <span>Samen vrij</span>
                  </li>
                {/each}
                {#if row.blocks.length === 0 && free.length === 0}
                  <li class="muted">Geen lessen vandaag.</li>
                {/if}
              </ul>
            </div>
          {/each}
        </div>
      </details>
    {/if}
  </section>

  <div class="lower">
    {#if $friends.friends.length > 0}
      <section
        class="card friends"
        id="friends"
        aria-labelledby="friends-title"
      >
        <div class="card-head">
          <h2 id="friends-title">Mijn vrienden</h2>
          <span class="pill">
            {$friends.friends.length} van {MAX_FRIENDS}
          </span>
        </div>
        {#if expiredFriends.length > 0}
          <p class="fine warn-text">
            {expiredFriends.length === 1
              ? "Eén vriend deelt een verlopen rooster."
              : `${expiredFriends.length} vrienden delen een verlopen rooster.`}
            Vraag een nieuwe link om weer te kunnen vergelijken.
          </p>
        {/if}
        <ul class="friends-list">
          {#each $friends.friends as f (f.id)}
            {@const fresh = freshness(f.snapshot, now)}
            <li class="friend" class:disabled={!f.enabled}>
              <div class="friend-head">
                <i class="dot" style="--hue:{hueForId(f.id)}" aria-hidden="true"
                ></i>
                <div class="friend-titles">
                  <b>{friendLabel(f)}</b>
                  <small>
                    {f.snapshot.lessons.length} lessen · t/m {rangeEndLabel(f)}
                  </small>
                </div>
                <span
                  class="tag"
                  class:ok={fresh === "fresh"}
                  class:warn={fresh === "old"}
                  class:bad={fresh === "expired"}
                  title="Gedeeld {ageText(f.snapshot.createdAt, now)}"
                >
                  {fresh === "fresh"
                    ? "actueel"
                    : fresh === "old"
                      ? "misschien oud"
                      : "verlopen"}
                </span>
              </div>
              <div class="friend-actions">
                <label class="nick">
                  <span>Naam</span>
                  <input
                    type="text"
                    class="input small"
                    maxlength="24"
                    autocomplete="off"
                    aria-label="Naam voor {f.name}"
                    value={f.nickname}
                    placeholder={f.snapshot.name}
                    onchange={(e) =>
                      friendsActions.rename(f.id, e.currentTarget.value)}
                  />
                </label>
                <div class="toggle">
                  <Switch
                    checked={f.enabled}
                    ariaLabel="Toon {friendLabel(f)} in de vergelijking"
                    onCheckedChange={(on) =>
                      friendsActions.setEnabled(f.id, on)}
                  />
                  <span>Toon in vergelijking</span>
                </div>
                <button
                  type="button"
                  class="remove"
                  class:confirm={confirmRemove === f.id}
                  aria-label={confirmRemove === f.id
                    ? `Bevestig verwijderen van ${f.name}`
                    : `Verwijder ${f.name}`}
                  onclick={() => askRemove(f.id)}
                >
                  {confirmRemove === f.id ? "Zeker weten?" : "Verwijder"}
                </button>
              </div>
            </li>
          {/each}
        </ul>
        <p class="fine">
          Alles staat alleen op dit apparaat. Je kunt een vriend altijd
          tijdelijk uitzetten of verwijderen.
        </p>
      </section>
    {/if}

    <div class="side">
      <!-- Share -->
      <section class="card" id="share" aria-labelledby="share-title">
        <div class="card-head">
          <h2 id="share-title">Deel mijn rooster</h2>
          <span class="pill primary"><QrCodeIcon size={14} /> QR of link</span>
        </div>
        <p class="muted">
          Je rooster zit in de link zelf. Er wordt niets geüpload en niemand kan
          iets aanpassen. Verandert je rooster? Deel dan gewoon een nieuwe QR.
        </p>
        <label class="field">
          <span>Jouw naam voor vrienden</span>
          <input
            type="text"
            class="input"
            maxlength="24"
            autocomplete="off"
            placeholder="Bijv. Joris"
            bind:value={nameDraft}
            oninput={updateName}
            onchange={updateName}
          />
        </label>
        {#if loading}
          <p class="muted">Je rooster wordt geladen…</p>
        {:else if !$friends.myName.trim()}
          <p class="muted">Vul eerst je naam in, dan maken we je link.</p>
        {:else if shareError}
          <p class="banner bad" role="alert">{shareError}</p>
        {:else if mySnapshot.lessons.length === 0}
          <p class="muted">
            Er staan geen lessen in je rooster voor deze en volgende week, dus
            er valt niets te delen.
          </p>
        {:else}
          <div class="row">
            <Button onclick={shareNative} disabled={!shareLink}>
              <Share2 size={16} /> Deel link
            </Button>
            <Button variant="tonal" onclick={copyLink} disabled={!shareLink}>
              {#if copied}<Check size={16} /> Gekopieerd{:else}<Copy
                  size={16}
                /> Kopieer{/if}
            </Button>
            <Button variant="outlined" onclick={toggleQr} disabled={!shareLink}>
              <QrCodeIcon size={16} />
              {showQr ? "Verberg QR" : "Toon QR"}
            </Button>
          </div>
          {#if actionError}
            <p class="banner bad" role="alert">{actionError}</p>
          {/if}
          {#if showQr && shareLink}
            <div class="qrbox">
              <QrCode
                text={shareLink}
                size={260}
                label="QR-code met je rooster"
              />
              <p class="fine">
                Laat je vriend deze QR scannen. De link opent Friday en vraagt
                of hij je wil toevoegen.
              </p>
            </div>
          {/if}
          <p class="fine">
            Geldig t/m {shareValidUntil}. Gedeeld: lestijden en vakken van
            {mySnapshot.lessons.length} lessen. Niet gedeeld: cijfers, docenten, lokalen,
            huiswerk.
          </p>
        {/if}
        <p class="fine link-hint">
          <Link2 size={13} /> Geen camera? Deel de link via WhatsApp of kopieer hem.
        </p>
      </section>

      <!-- Add -->
      <section class="card" id="add" aria-labelledby="add-title">
        <div class="card-head">
          <h2 id="add-title">Vriend toevoegen</h2>
        </div>
        <p class="muted">
          Scan zijn QR met je camera, of plak hier de link die hij je stuurde.
        </p>
        <div class="add-row">
          <input
            type="text"
            class="input"
            placeholder="Plak de link van je vriend"
            aria-label="Link van je vriend"
            bind:value={pasted}
            onkeydown={(e) => e.key === "Enter" && stage(pasted)}
          />
          <Button onclick={() => stage(pasted)} disabled={!pasted.trim()}>
            Controleren
          </Button>
        </div>
        {#if importError}
          <p class="banner bad" role="alert">{importError}</p>
        {/if}
        {#if importNote}
          <p class="banner good" role="status">{importNote}</p>
        {/if}
      </section>
    </div>
  </div>
</div>

<style>
  .page {
    --card: var(--color-surface-900);
    --border: color-mix(in oklch, var(--color-gray-100) 12%, transparent);
    --muted: var(--color-gray-400);
    --grid: color-mix(in oklch, var(--color-gray-100) 10%, transparent);
    --ok: #34d399;
    --ok-bg: rgb(16 185 129 / 0.13);
    --warn: #fbbf24;
    --warn-bg: rgb(251 191 36 / 0.12);
    --bad: #f87171;
    --bad-bg: rgb(248 113 113 / 0.12);

    width: 100%;
    max-width: 64rem;
    margin: 0 auto;
    padding: clamp(1rem, 2.5vw, 2rem) clamp(0.8rem, 3vw, 1.75rem) 3rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    color: var(--color-gray-100);
  }
  :global(html.mode-light) .page {
    --border: color-mix(in oklch, var(--color-gray-100) 14%, transparent);
    --muted: var(--color-gray-500);
    --grid: color-mix(in oklch, var(--color-gray-100) 12%, transparent);
    --ok: #047857;
    --ok-bg: rgb(5 150 105 / 0.12);
    --warn: #b45309;
    --warn-bg: rgb(180 83 9 / 0.1);
    --bad: #b91c1c;
    --bad-bg: rgb(185 28 28 / 0.09);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .head-copy {
    min-width: 0;
  }
  h1 {
    font-size: clamp(1.6rem, 4vw, 2.2rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }
  .head p {
    margin-top: 0.4rem;
    max-width: 46rem;
    color: var(--muted);
    font-size: 0.88rem;
    line-height: 1.5;
  }
  .icon-btn {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--color-gray-300);
    transition: background 0.15s ease;
  }
  .icon-btn:hover {
    background: color-mix(in oklch, var(--color-primary-500) 16%, var(--card));
  }
  .icon-btn:disabled {
    opacity: 0.5;
  }
  .icon-btn:focus-visible,
  .day:focus-visible,
  .text-btn:focus-visible,
  .remove:focus-visible,
  .agenda summary:focus-visible {
    outline: 2px solid var(--color-primary-500);
    outline-offset: 2px;
  }
  .refresh-icon {
    display: grid;
    place-items: center;
  }
  .refresh-icon.spinning {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .card {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 1.25rem;
    background: var(--card);
    padding: clamp(1rem, 2.5vw, 1.4rem);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  h2 {
    font-size: 1.05rem;
    font-weight: 750;
    letter-spacing: -0.01em;
  }
  h3 {
    font-size: 0.95rem;
    font-weight: 700;
  }
  .sub {
    margin-top: 0.15rem;
    font-size: 0.78rem;
  }
  .days-hint {
    display: none;
  }
  @media (max-width: 34rem) {
    .days-hint {
      display: inline;
    }
  }
  .muted {
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.5;
  }
  .fine {
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.5;
  }
  .fine.warn-text {
    color: var(--warn);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .no-scrollbar {
    scrollbar-width: none;
  }
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  #share,
  #add,
  #friends {
    scroll-margin-top: 1rem;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.55rem;
    border-radius: 9999px;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .pill.primary {
    border-color: color-mix(
      in oklch,
      var(--color-primary-500) 40%,
      transparent
    );
    background: color-mix(in oklch, var(--color-primary-500) 14%, transparent);
    color: var(--color-primary-400);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.65rem 0.8rem;
    border-radius: 0.8rem;
    border: 1px solid var(--border);
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .banner.bad {
    border-color: color-mix(in oklch, var(--bad) 40%, transparent);
    background: var(--bad-bg);
    color: var(--bad);
  }
  .banner.good {
    border-color: color-mix(in oklch, var(--ok) 40%, transparent);
    background: var(--ok-bg);
    color: var(--ok);
  }
  .banner.warn {
    border-color: color-mix(in oklch, var(--warn) 40%, transparent);
    background: var(--warn-bg);
    color: var(--warn);
  }
  .banner.info {
    border-color: color-mix(
      in oklch,
      var(--color-primary-500) 35%,
      transparent
    );
    background: color-mix(in oklch, var(--color-primary-500) 10%, transparent);
    color: var(--color-gray-200);
  }
  .banner.notice {
    border-color: color-mix(
      in oklch,
      var(--color-primary-500) 35%,
      transparent
    );
    background: color-mix(in oklch, var(--color-primary-500) 12%, transparent);
    color: var(--color-gray-200);
  }
  .banner span {
    flex: 1 1 12rem;
    min-width: 0;
  }
  .text-btn {
    flex: 0 0 auto;
    min-height: 2.5rem;
    padding: 0.35rem 0.6rem;
    border-radius: 0.6rem;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    font-size: 0.75rem;
    font-weight: 700;
  }
  .text-btn:hover {
    background: color-mix(in oklch, currentColor 12%, transparent);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted);
  }
  .input {
    width: 100%;
    min-width: 0;
    min-height: 2.6rem;
    padding: 0.5rem 0.7rem;
    border-radius: 0.75rem;
    border: 1px solid var(--border);
    background: color-mix(in oklch, var(--color-surface-950), transparent 20%);
    color: var(--color-gray-100);
    font-size: 1rem; /* 16px prevents iOS zoom on focus */
    outline: none;
  }
  .input::placeholder {
    color: var(--muted);
  }
  .input:focus-visible {
    border-color: var(--color-primary-500);
    box-shadow: 0 0 0 3px
      color-mix(in oklch, var(--color-primary-500) 25%, transparent);
  }
  .input.small {
    min-height: 2.2rem;
    padding: 0.3rem 0.55rem;
    font-size: 0.85rem;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 1.5rem 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .spinner {
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 9999px;
    border: 2px solid var(--border);
    border-top-color: var(--color-primary-500);
    animation: spin 0.8s linear infinite;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.4rem 0;
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 2.7rem;
    height: 2.7rem;
    border-radius: 0.9rem;
    background: color-mix(in oklch, var(--color-primary-500) 16%, transparent);
    color: var(--color-primary-400);
  }
  .empty-icon.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }

  /* day tabs */
  .days {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
    padding-bottom: 0.2rem;
    scroll-snap-type: x proximity;
  }
  .day {
    flex: 0 0 auto;
    min-width: 4.6rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.05rem;
    padding: 0.45rem 0.6rem;
    border-radius: 0.9rem;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    scroll-snap-align: start;
    transition: background 0.15s ease;
  }
  .day b {
    font-size: 0.78rem;
    text-transform: capitalize;
    color: var(--color-gray-200);
  }
  .day small {
    font-size: 0.68rem;
  }
  .day em {
    font-style: normal;
    font-size: 0.66rem;
    font-weight: 800;
    color: var(--muted);
  }
  .day em.all {
    color: var(--ok);
  }
  .day em.none {
    opacity: 0.55;
  }
  .day.on {
    border-color: color-mix(
      in oklch,
      var(--color-primary-500) 55%,
      transparent
    );
    background: color-mix(in oklch, var(--color-primary-500) 18%, transparent);
    color: var(--color-gray-200);
  }
  .day.on b {
    color: var(--color-gray-100);
  }

  .presence {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.1rem 0;
  }
  .presence li {
    flex: 0 1 auto;
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: color-mix(in oklch, var(--color-surface-950), transparent 45%);
    font-size: 0.76rem;
    white-space: nowrap;
  }
  .presence li b {
    font-weight: 700;
  }
  .presence li.me {
    border-color: color-mix(
      in oklch,
      var(--color-primary-500) 40%,
      transparent
    );
  }
  .dot {
    display: inline-block;
    flex: 0 0 auto;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 9999px;
    background: hsl(var(--hue, 270) 70% 60%);
    align-self: center;
  }

  .now-box {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.65rem 0.8rem;
    border-radius: 0.9rem;
    border: 1px solid var(--border);
    background: color-mix(in oklch, var(--color-surface-950), transparent 45%);
    font-size: 0.84rem;
  }
  .now-box b {
    display: block;
    font-weight: 700;
  }
  .now-box small {
    display: block;
    margin-top: 0.1rem;
    color: var(--muted);
    font-size: 0.76rem;
  }
  .now-box.good {
    border-color: color-mix(in oklch, var(--ok) 40%, transparent);
    background: var(--ok-bg);
  }
  .now-box.good b {
    color: var(--ok);
  }
  .now-box.busy {
    border-color: color-mix(in oklch, var(--warn) 35%, transparent);
    background: var(--warn-bg);
  }
  .next {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .next b {
    color: var(--color-gray-200);
    font-variant-numeric: tabular-nums;
  }

  /* timeline */
  .tl-wrap {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    margin: 0 -0.2rem;
    padding: 0 0.2rem 0.3rem;
    overscroll-behavior-x: contain;
  }
  .tl {
    --who-w: 4.4rem;
    position: relative;
    min-width: 30rem;
  }
  @media (min-width: 30rem) {
    .tl {
      --who-w: 5.5rem;
    }
  }
  @media (min-width: 48rem) {
    .tl {
      --who-w: 7rem;
    }
  }
  .tl-row {
    display: grid;
    grid-template-columns: var(--who-w) minmax(0, 1fr);
    align-items: stretch;
  }
  .who {
    position: sticky;
    left: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    padding-right: 0.5rem;
    background: var(--card);
    color: var(--muted);
    font-size: 0.75rem;
  }
  .who span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track {
    position: relative;
    height: 2.1rem;
    border-left: 1px solid var(--grid);
    background-image: linear-gradient(
      to right,
      var(--grid) 1px,
      transparent 1px
    );
    background-size: calc(100% / var(--hour-count)) 100%;
  }
  .axis .track {
    height: 1.55rem;
    border-left: 0;
    background: none;
  }
  .axis em {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    font-style: normal;
    font-size: 0.62rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .axis em:first-child {
    transform: none;
  }
  .axis em:last-child {
    transform: translateX(-100%);
  }
  .band {
    border-top: 1px solid var(--grid);
  }
  .band .track {
    height: 2.4rem;
  }
  .line {
    border-top: 1px solid var(--grid);
  }
  .band-label {
    display: inline-flex;
    align-items: center;
    padding: 0.1rem 0.4rem;
    border-radius: 0.4rem;
    background: var(--ok-bg);
    color: var(--ok);
    font-size: 0.66rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .free,
  .shared,
  .block {
    position: absolute;
  }
  .free {
    top: 0.4rem;
    bottom: 0.4rem;
    border-radius: 0.45rem;
    background: color-mix(in oklch, var(--ok) 55%, transparent);
    box-shadow: inset 0 0 0 1px var(--ok);
    z-index: 1;
  }
  .shared {
    top: 0.35rem;
    bottom: 0.35rem;
    border-radius: 0.4rem;
    background: color-mix(in oklch, var(--ok) 19%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--ok) 42%, transparent);
    z-index: 0;
  }
  .block {
    top: 0.28rem;
    bottom: 0.28rem;
    z-index: 2;
    display: flex;
    align-items: center;
    padding: 0 0.35rem;
    border-radius: 0.45rem;
    background: hsl(var(--hue, 270) 55% 42%);
    color: #fff;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.35);
    font-size: 0.65rem;
    font-weight: 700;
    overflow: hidden;
    white-space: nowrap;
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.14);
    container-type: inline-size;
  }
  .block span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @container (max-width: 2.3rem) {
    .block span {
      display: none;
    }
  }
  .hint {
    position: absolute;
    left: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.68rem;
    color: var(--muted);
    white-space: nowrap;
    pointer-events: none;
  }
  .now-layer {
    position: absolute;
    left: var(--who-w);
    right: 0;
    top: 1.55rem;
    bottom: 0.3rem;
    z-index: 4;
    pointer-events: none;
  }
  .nowline {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 2px dashed var(--warn);
  }
  .tl-hint {
    margin-top: -0.4rem;
  }
  @media (min-width: 36rem) {
    .tl-hint {
      display: none;
    }
  }
  .nowline::before {
    content: "";
    position: absolute;
    top: -0.25rem;
    left: -0.32rem;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 9999px;
    background: var(--warn);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.8rem;
    font-size: 0.68rem;
    color: var(--muted);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .sw {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 0.2rem;
  }
  .sw.band {
    background: color-mix(in oklch, var(--ok) 55%, transparent);
    box-shadow: inset 0 0 0 1px var(--ok);
  }
  .sw.shared {
    background: var(--ok-bg);
    box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--ok) 45%, transparent);
  }

  /* shared moments */
  .summary {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: minmax(0, 1fr);
  }
  @media (min-width: 46rem) {
    .summary {
      grid-template-columns: minmax(12rem, 0.8fr) minmax(0, 1.5fr);
      align-items: start;
    }
  }
  .best {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.7rem 0.85rem;
    border-radius: 0.9rem;
    border: 1px solid color-mix(in oklch, var(--ok) 35%, transparent);
    background: var(--ok-bg);
  }
  .best.all {
    border-color: color-mix(in oklch, var(--ok) 65%, transparent);
  }
  .best.none {
    border-color: var(--border);
    background: color-mix(in oklch, var(--color-surface-950), transparent 45%);
  }
  .best-label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.65rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--ok);
  }
  .best.none .best-label {
    color: var(--muted);
  }
  .best-time {
    font-size: 1.25rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .best-who {
    font-size: 0.76rem;
    color: var(--color-gray-300);
    line-height: 1.4;
  }
  .windows {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .windows li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.2rem 0.55rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.6rem;
    background: color-mix(in oklch, var(--color-surface-950), transparent 55%);
    font-size: 0.78rem;
  }
  .windows li.all {
    background: var(--ok-bg);
  }
  .w-time {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .w-dur {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .w-who {
    flex: 1 1 8rem;
    min-width: 0;
    color: var(--color-gray-300);
  }
  .w-tag {
    margin-left: auto;
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--color-gray-100) 8%, transparent);
    color: var(--muted);
    font-size: 0.64rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .w-tag.ok {
    background: color-mix(in oklch, var(--ok) 16%, transparent);
    color: var(--ok);
  }

  /* per-person agenda */
  .agenda {
    border-top: 1px solid var(--border);
    padding-top: 0.6rem;
  }
  .agenda summary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 2.25rem;
    cursor: pointer;
    list-style: none;
    color: var(--muted);
    font-size: 0.78rem;
    font-weight: 700;
  }
  .agenda summary::-webkit-details-marker {
    display: none;
  }
  .agenda summary:hover {
    color: var(--color-gray-200);
  }
  .agenda-list {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.55rem;
    padding: 0.35rem 0 0.15rem;
  }
  @media (min-width: 42rem) {
    .agenda-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .agenda-person {
    min-width: 0;
    padding: 0.55rem 0.65rem;
    border-radius: 0.7rem;
    background: color-mix(in oklch, var(--color-surface-950), transparent 55%);
  }
  .agenda-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
  }
  .agenda-head b {
    font-weight: 700;
  }
  .agenda-head .muted {
    margin-left: auto;
    font-size: 0.68rem;
  }
  .agenda-person ul {
    margin-top: 0.35rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .agenda-person li {
    display: flex;
    gap: 0.5rem;
    font-size: 0.74rem;
    min-width: 0;
  }
  .agenda-person li .time {
    flex: 0 0 5.2rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .agenda-person li.free-line {
    color: var(--ok);
  }

  /* lower grid */
  .lower {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 1rem;
  }
  .lower > .friends {
    flex: 1.15 1 22rem;
  }
  .lower > .side {
    flex: 1 1 20rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    align-content: start;
    gap: 1rem;
    min-width: 0;
  }

  /* friends list */
  .friends-list {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .friend {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 0.85rem;
  }
  .friend.disabled {
    opacity: 0.65;
  }
  .friend-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .friend-titles {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .friend-titles b {
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .friend-titles small {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .tag {
    flex: 0 0 auto;
    padding: 0.12rem 0.45rem;
    border-radius: 9999px;
    font-size: 0.62rem;
    font-weight: 800;
    white-space: nowrap;
  }
  .tag.ok {
    background: var(--ok-bg);
    color: var(--ok);
  }
  .tag.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .tag.bad {
    background: var(--bad-bg);
    color: var(--bad);
  }
  .friend-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.8rem;
  }
  .nick {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: 1 1 9rem;
    min-width: 0;
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 600;
  }
  .nick .input {
    flex: 1;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .remove {
    min-height: 2.5rem;
    padding: 0 0.3rem;
    border: 0;
    background: none;
    color: var(--muted);
    font-size: 0.7rem;
    font-weight: 700;
  }
  .remove:hover {
    color: var(--bad);
  }
  .remove.confirm {
    color: var(--bad);
    text-decoration: underline;
  }

  .add-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .add-row .input {
    flex: 1 1 12rem;
  }
  .qrbox {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.9rem;
    background: color-mix(in oklch, var(--color-surface-950), transparent 45%);
  }
  .qrbox .fine {
    text-align: center;
    max-width: 22rem;
  }
  .link-hint {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .refresh-icon.spinning,
    .spinner {
      animation: none;
    }
  }
</style>
