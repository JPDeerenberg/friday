<script lang="ts">
  import {
    personId,
    accountInfo,
    userSettings,
    currentPage,
    resumedAt,
  } from "#lib/stores.ts";
  import { get } from "svelte/store";
  import { untrack } from "svelte";
  import {
    getCalendarEvents,
    getGrades,
    getSchoolyears,
    getRecentGrades,
    getMessageFolders,
    getAssignments,
    formatDate,
    toggleCalendarEventDone,
  } from "#lib/api.ts";
  import { formatTime } from "#lib/format.ts";
  import { cacheGet, cacheRefresh } from "#lib/cache.ts";
  import {
    createSingleFlight,
    shouldRefresh,
    DASHBOARD_MIN_INTERVAL_MS,
  } from "#lib/singleflight.ts";
  import { fade, fly } from "svelte/transition";
  import Button from "#lib/components/Button.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import PendingGradesBanner from "#lib/components/PendingGradesBanner.svelte";
  import NextLessonHero from "#lib/components/NextLessonHero.svelte";
  import { displayTeacherName } from "#lib/teachers.ts";
  import TranslateButton from "#lib/components/TranslateButton.svelte";
  import LevelCard from "#lib/components/LevelCard.svelte";
  import QuickGradeSliders from "#lib/components/QuickGradeSliders.svelte";
  import QuestsCard from "#lib/components/QuestsCard.svelte";
  import FriendsCard from "#lib/components/FriendsCard.svelte";
  import WrappedCard from "#lib/components/WrappedCard.svelte";
  import WrappedStory from "#lib/components/WrappedStory.svelte";
  import { recordQuestEvent } from "#lib/quests-store.ts";
  import {
    gradePeek,
    gradeRevealState,
    openPackIntent,
    splitGrades,
  } from "#lib/grade-reveal.ts";
  import type { Assignment, CalendarEvent, Grade } from "#lib/types.ts";
  import {
    computeWeekStats,
    getMonday,
    EMPTY_WEEK_STATS,
    type WeekStats,
  } from "#lib/weekStats.ts";

  // Svelte 5 State
  let heroEvents = $state<CalendarEvent[]>([]);
  let showWrapped = $state(false);
  // While grade reveal is on, every grade stays hidden until its card is opened
  // (see #lib/grade-reveal); the dashboard offers a banner instead. Opening a
  // pack happens on the grades page, where cards are built from the full list.
  let allLatestGrades = $state<Grade[]>([]);
  const revealEnabled = $derived($userSettings.gradeReveal !== false);
  const latestSplit = $derived(
    splitGrades(
      allLatestGrades,
      revealEnabled,
      $gradeRevealState,
      $gradePeek,
      $userSettings.lettersGetCards === true,
    ),
  );
  const pendingGrades = $derived(latestSplit.hidden);
  function openPack() {
    openPackIntent.set(true);
    currentPage.set("grades");
  }
  let unreadCount = $state(0);

  // Section-specific loading states
  let loadingEvents = $state(true);
  let loadingMessages = $state(true);

  let tomorrowEvents = $state<CalendarEvent[]>([]);
  let tomorrowAssignments = $state<Assignment[]>([]);
  let nextSchoolDayDate = $state<string>("");
  let loadingTomorrow = $state(true);
  let weekStats = $state<WeekStats>(EMPTY_WEEK_STATS);
  let loadingWeekStats = $state(true);
  let expandedLesson = $state<number | null>(null);

  // Single-flight + min-interval gate: one hidden→visible transition must
  // produce exactly one load, and a resume within 45 s of a good load is a
  // no-op. The in-flight promise is shared so concurrent triggers reuse it.
  const dashboardFlight = createSingleFlight<void>();
  let lastDashboardSuccessAt: number | null = null;

  // Derived greeting
  const greeting = $derived(() => {
    const hour = new Date().getHours();
    if (hour < 6) return "Goedenacht";
    if (hour < 12) return "Goedemorgen";
    if (hour < 18) return "Goedemiddag";
    return "Goedenavond";
  });

  // Watch for personId availability and local storage hydration.
  // untrack: state read inside the loader must not become an effect dep.
  $effect(() => {
    const pid = $personId;
    if (pid !== null) {
      untrack(() => loadDashboardData(false));
    }
  });

  // Foreground resume: hidden→visible triggers a force-refresh through the
  // same loader. untrack keeps the loader's internal state reads out of
  // this effect's dependency set so it fires exactly once per resume.
  let resumedSeen = false;
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) {
      resumedSeen = true;
      return;
    }
    untrack(() => loadDashboardData(true));
  });

  async function fetchDashboardData(pid: number) {
    const now = new Date();
    const today = formatDate(now);
    const tomorrowStr = formatDate(new Date(now.getTime() + 86400000));
    const nextWeek = formatDate(new Date(now.getTime() + 7 * 86400000));
    // Single 21-day window (last Monday … next Sunday) that covers today,
    // tomorrow … today+7 and the week-stats range in every case.
    const thisMonday = getMonday(now);
    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const nextSunday = new Date(thisMonday);
    nextSunday.setDate(nextSunday.getDate() + 13);
    const rangeStart = formatDate(lastMonday);
    const rangeEnd = formatDate(nextSunday);
    const result: {
      heroEvents: CalendarEvent[];
      latestGrades: Grade[];
      unreadCount: number;
      tomorrowEvents: CalendarEvent[];
      tomorrowAssignments: Assignment[];
      nextSchoolDayDate: string;
      weekStats: WeekStats;
    } = {
      heroEvents: [],
      latestGrades: [],
      unreadCount: 0,
      tomorrowEvents: [],
      tomorrowAssignments: [],
      nextSchoolDayDate: tomorrowStr,
      weekStats: EMPTY_WEEK_STATS,
    };

    let allEvents: CalendarEvent[] = [];
    let allAssignments: Assignment[] = [];

    await Promise.allSettled([
      // 1. Calendar — ONE fetch; today/tomorrow/week-stats are derived locally.
      (async () => {
        try {
          const events = await getCalendarEvents(pid, rangeStart, rangeEnd);
          allEvents = events
            .filter((e) => e.Status !== 4 && e.Status !== 5)
            .sort((a, b) => a.Start.localeCompare(b.Start));
          // The "next lesson" card looks at the whole 3-week window, so it can
          // move on to tomorrow by itself once today's lessons are over.
          result.heroEvents = allEvents;
          result.weekStats = computeWeekStats(allEvents, now);
          // Next school day: first date >= tomorrow with events.
          const eventsByDate: Record<string, CalendarEvent[]> = {};
          for (const event of allEvents) {
            const date = event.Start.substring(0, 10);
            if (date < tomorrowStr) continue;
            if (!eventsByDate[date]) eventsByDate[date] = [];
            eventsByDate[date].push(event);
          }
          const sortedDates = Object.keys(eventsByDate).sort();
          if (sortedDates.length > 0) {
            result.nextSchoolDayDate = sortedDates[0];
            result.tomorrowEvents = eventsByDate[result.nextSchoolDayDate];
          } else {
            result.nextSchoolDayDate = tomorrowStr;
            result.tomorrowEvents = [];
          }
        } catch (e) {
          console.error("Dashboard: Calendar fetch failed", e);
        }
      })(),

      // 2. Messages
      (async () => {
        try {
          const folders = await getMessageFolders();
          result.unreadCount = folders.reduce(
            (sum, f) => sum + (f.aantalOngelezen ?? 0),
            0,
          );
        } catch (e) {
          console.error("Dashboard: Messages fetch failed", e);
        }
      })(),

      // 3. Grades — fallback only when the recent endpoint SUCCEEDS with an
      //    empty list (fresh account). Never on error (esp. rate-limit):
      //    retrying via schoolyears+grades would amplify the storm.
      (async () => {
        let recentGrades: Grade[] | null = null;
        let recentOk = false;
        try {
          const recent = await getRecentGrades(pid, 5);
          recentOk = true;
          if (recent && recent.length > 0) {
            recentGrades = recent.filter((g) => g.CijferStr);
          }
        } catch (e) {
          console.warn(
            "Dashboard: getRecentGrades failed, skipping fallback",
            e,
          );
          return;
        }
        // Fallback only on success-with-empty (not on error).
        if (recentOk && (!recentGrades || recentGrades.length === 0)) {
          try {
            const schoolyears = await getSchoolyears(pid, "2020-01-01", today);
            if (schoolyears.length > 0) {
              const currentYear =
                schoolyears.find((y) => {
                  if (!y.begin || !y.einde) return false;
                  return new Date(y.begin) <= now && new Date(y.einde) >= now;
                }) || schoolyears[schoolyears.length - 1];
              if (currentYear?.id) {
                const fetchedGrades = await getGrades(
                  pid,
                  currentYear.id,
                  currentYear.einde,
                );
                recentGrades = fetchedGrades
                  .filter((g) => g.CijferStr && g.CijferKolom?.KolomSoort === 1)
                  .sort((a, b) =>
                    (b.DatumIngevoerd ?? "").localeCompare(
                      a.DatumIngevoerd ?? "",
                    ),
                  )
                  .slice(0, 5);
              }
            }
          } catch (e) {
            console.error("Dashboard: Grades fallback fetch failed", e);
          }
        }
        if (recentGrades) result.latestGrades = recentGrades;
      })(),

      // 4. Assignments — ONE fetch; upcoming + tomorrow lists are derived.
      (async () => {
        try {
          const assignments = await getAssignments(pid, today, nextWeek);
          allAssignments = assignments;
          result.tomorrowAssignments = assignments.filter(
            (a) => !a.Afgesloten && !a.IngeleverdOp,
          );
        } catch (e) {
          console.error("Dashboard: Assignments fetch failed", e);
        }
      })(),
    ]);

    return result;
  }

  async function loadDashboardDataInner(force: boolean) {
    const pid = get(personId);
    if (pid === null) return;

    console.info(
      `[Dashboard] loadDashboardData triggered: ${force ? "resume/manual" : "mount"}`,
    );
    if (force) {
      // Ignore a resume refresh if the last successful load finished < 45 s ago.
      if (!shouldRefresh(lastDashboardSuccessAt, Date.now())) {
        console.info(
          "[Dashboard] loadDashboardData skipped: within min interval",
        );
        return;
      }
      loadingEvents = true;
      loadingMessages = true;
      loadingTomorrow = true;
      loadingWeekStats = true;
    }

    try {
      const data = force
        ? await cacheRefresh(
            `dashboard_${pid}`,
            () => fetchDashboardData(pid),
            5 * 60 * 1000,
          )
        : await cacheGet(
            `dashboard_${pid}`,
            () => fetchDashboardData(pid),
            5 * 60 * 1000,
          );

      // `heroEvents` is missing in a copy cached by an older version.
      heroEvents = data.heroEvents ?? [];
      allLatestGrades = data.latestGrades;
      unreadCount = data.unreadCount;
      tomorrowEvents = data.tomorrowEvents;
      tomorrowAssignments = data.tomorrowAssignments;
      nextSchoolDayDate = data.nextSchoolDayDate;
      weekStats = data.weekStats;
      lastDashboardSuccessAt = Date.now();
    } finally {
      loadingEvents = false;
      loadingMessages = false;
      loadingTomorrow = false;
      loadingWeekStats = false;
    }
  }

  function loadDashboardData(force: boolean): Promise<void> {
    return dashboardFlight.run(() => loadDashboardDataInner(force));
  }

  function handleRefresh() {
    loadDashboardData(true);
  }

  // Format the next school day as a readable label
  const nextSchoolDayLabel = $derived(() => {
    if (!nextSchoolDayDate) return "";
    const date = new Date(nextSchoolDayDate + "T00:00:00");
    return date.toLocaleDateString("nl-NL", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  });

  // Short day name (e.g. "maandag") for the badge
  const nextSchoolDayShortLabel = $derived(() => {
    if (!nextSchoolDayDate) return "";
    const date = new Date(nextSchoolDayDate + "T00:00:00");
    return date.toLocaleDateString("nl-NL", { weekday: "long" });
  });

  // Whether we're skipping free days (tomorrow is not the next school day)
  const isSkippingDays = $derived(() => {
    const tomorrowDate = formatDate(new Date(Date.now() + 86400000));
    return tomorrowDate !== nextSchoolDayDate;
  });

  // Returns all tomorrow lessons up to the first break.
  // If no break is found, returns all lessons.
  // The break threshold (in minutes) is configurable in settings.
  const lessonsBeforeBreak = $derived(() => {
    if (tomorrowEvents.length === 0) return [];
    const threshold = $userSettings.breakThresholdMinutes ?? 20;
    for (let i = 0; i < tomorrowEvents.length - 1; i++) {
      const endCurrent = new Date(
        tomorrowEvents[i].Einde ?? tomorrowEvents[i].Start,
      );
      const startNext = new Date(tomorrowEvents[i + 1].Start);
      const gapMinutes = (startNext.getTime() - endCurrent.getTime()) / 60000;
      if (gapMinutes > threshold) return tomorrowEvents.slice(0, i + 1);
    }
    return tomorrowEvents;
  });

  // Check if a calendar event has open homework (in Inhoud or a matching open assignment)
  function lessonHasHomework(event: CalendarEvent): boolean {
    if (event.Afgerond) return false;
    if (event.Inhoud && event.Inhoud.trim().length > 0) return true;
    const subjectName = event.Vakken?.[0]?.Naam?.toLowerCase() ?? "";
    if (!subjectName) return false;
    return tomorrowAssignments.some((a) => {
      const assignmentSubject = (a.Vak ?? a.Titel ?? "").toLowerCase();
      return (
        assignmentSubject.includes(subjectName) ||
        subjectName.includes(assignmentSubject)
      );
    });
  }

  // Lessons AFTER the break that have homework — shown as its own section
  // so "before break" and "after break" are two clearly separate, non-
  // overlapping lists (previously this recomputed across the WHOLE day,
  // silently duplicating every before-break lesson that was already shown
  // above it).
  const lessonsAfterBreakWithHomework = $derived(() => {
    const beforeCount = lessonsBeforeBreak().length;
    const result: {
      type: "packed" | "extra";
      subject: string;
      lessonHour: string | number;
      index: number;
      event: any;
      hw: {
        inhoud: string | null;
        aantekening: string | null;
        opmerking: string | null;
        assignments: any[];
        isCompleted: boolean;
      };
    }[] = [];

    for (let i = beforeCount; i < tomorrowEvents.length; i++) {
      const event = tomorrowEvents[i];
      const hw = getLessonHomework(event);
      if (!hw.inhoud && hw.assignments.length === 0) continue; // skip if no homework at all

      result.push({
        type: event.Afgerond ? "packed" : "extra",
        subject: event.Vakken?.[0]?.Naam ?? "Onbekend",
        lessonHour: event.LesuurVan ?? "—",
        index: i,
        event,
        hw,
      });
    }

    return result;
  });

  // Get extended homework info for a lesson: Inhoud + matching assignments
  function getLessonHomework(event: CalendarEvent): {
    inhoud: string | null;
    aantekening: string | null;
    opmerking: string | null;
    assignments: any[];
    isCompleted: boolean;
  } {
    const inhoud = event.Inhoud?.trim() || null;
    const aantekening = event.Aantekening?.trim() || null;
    const opmerking = event.Opmerking?.trim() || null;
    const subjectName = event.Vakken?.[0]?.Naam?.toLowerCase() ?? "";
    const assignments = subjectName
      ? tomorrowAssignments.filter((a) => {
          const assignmentSubject = (a.Vak ?? a.Titel ?? "").toLowerCase();
          return (
            assignmentSubject.includes(subjectName) ||
            subjectName.includes(assignmentSubject)
          );
        })
      : [];
    return {
      inhoud,
      aantekening,
      opmerking,
      assignments,
      isCompleted: !!event.Afgerond,
    };
  }

  function toggleLesson(index: number) {
    expandedLesson = expandedLesson === index ? null : index;
  }

  async function markLessonDone(event: CalendarEvent, index: number) {
    try {
      await toggleCalendarEventDone(event);
      // Toggle the local Afgerond flag so UI updates immediately
      event.Afgerond = !event.Afgerond;
      // If marked as done, collapse the lesson
      if (event.Afgerond) {
        expandedLesson = null;
        recordQuestEvent("homework_done");
      }
    } catch (e) {
      console.error("Failed to toggle lesson done:", e);
    }
  }

  function stripHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent || "";
  }

</script>

<div
  class="flex flex-col bg-surface-950 min-h-screen selection:bg-primary-500/30"
>
  <!-- Sticky Header -->
  <header
    class="sticky top-0 z-40 bg-surface-950/80 backdrop-blur-2xl border-b border-white/5 px-6 py-6 md:py-8 transition-all duration-500 overflow-hidden"
  >
    <!-- Animated background pulse for header -->
    <div
      class="absolute inset-x-0 -top-24 h-48 bg-primary-500/5 blur-[100px] rounded-full animate-header-pulse"
    ></div>

    <div
      class="flex flex-col md:flex-row md:items-center justify-between gap-6 max-w-7xl mx-auto w-full relative z-10"
    >
      <div class="flex items-center gap-6" in:fly={{ x: -20, duration: 800 }}>
        <div class="relative group">
          <div
            class="w-16 h-16 rounded-m3-md bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-on-fill text-3xl font-black shadow-2xl shadow-primary-500/30 group-hover:rotate-6 group-hover:scale-105 transition-all duration-500 cursor-help"
          >
            {$accountInfo?.Persoon?.Roepnaam?.[0] ?? "U"}
          </div>
          <div
            class="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-emerald-500 border-4 border-surface-950 shadow-lg animate-pulse"
          ></div>
        </div>
        <div>
          <h1
            class="text-display-small text-white leading-none flex flex-wrap items-baseline gap-x-3"
          >
            <span class="opacity-60 text-headline-small">{greeting()}</span>
            <span
              class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 via-primary-200 to-primary-500 animate-gradient-x"
            >
              {$accountInfo?.Persoon?.Roepnaam ?? "Gebruiker"}
            </span>
          </h1>
          <p
            class="text-gray-400 text-label-medium mt-2 flex items-center gap-2"
          >
            <span
              class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981]"
            ></span>
            {new Date().toLocaleDateString("nl-NL", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3 md:gap-5">
        <Button
          variant="tonal"
          onclick={() => currentPage.set("messages")}
          aria-label={`${unreadCount} ongelezen berichten`}
          class="px-5 relative overflow-hidden"
        >
          <span class="relative">
            <svg
              class="w-5 h-5 text-primary-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              ><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /><rect
                width="20"
                height="14"
                x="2"
                y="5"
                rx="2"
              /></svg
            >
            {#if unreadCount > 0}
              <span class="absolute -top-1.5 -right-1.5 flex h-3 w-3">
                <span
                  class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"
                ></span>
                <span
                  class="relative inline-flex rounded-full h-3 w-3 bg-red-500"
                ></span>
              </span>
            {/if}
          </span>
          <span class="text-label-large text-primary-400 relative z-10"
            >{unreadCount} berichten</span
          >
        </Button>
        <IconButton
          onclick={handleRefresh}
          class="bg-surface-800/40! border border-white/5! hover:bg-surface-700/60! shadow-2xl"
          aria-label="Vernieuwen"
        >
          <svg
            class="w-5 h-5 group-hover:rotate-180 transition-transform duration-1000 ease-in-out"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            ><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path
              d="M21 3v5h-5"
            /></svg
          >
        </IconButton>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 md:px-8 w-full py-8 pb-28">
    <!-- The one thing students open the app for: where is my next lesson? -->
    <section class="mb-6" in:fly={{ y: -10, duration: 500 }}>
      <NextLessonHero events={heroEvents} loading={loadingEvents} />
    </section>

    <!-- Hidden grades: the card packs are the hook, so they stay on the home screen. -->
    {#if revealEnabled && $gradePeek}
      <button
        type="button"
        onclick={() => gradePeek.set(false)}
        class="mb-6 w-full rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-left text-label-large text-amber-300 transition-colors hover:bg-amber-500/15"
      >
        Alle cijfers zichtbaar · tik om weer te verbergen
      </button>
    {:else if pendingGrades.length > 0}
      <PendingGradesBanner
        count={pendingGrades.length}
        onopen={openPack}
        onpeek={() => gradePeek.set(true)}
        class="mb-6"
      />
    {/if}

    <!-- Pack for Tomorrow -->
    <section in:fly={{ y: -20, duration: 700 }} class="mb-14">
      <div
        class="glass rounded-m3-md p-6 md:p-10 relative overflow-hidden border-white/5 shadow-2xl group"
      >
        <!-- Ambient glow -->
        <div
          class="absolute inset-0 bg-gradient-to-r from-emerald-500/8 via-transparent to-primary-500/8 opacity-60 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"
        ></div>

        <div class="flex items-center justify-start mb-6 md:mb-8 relative z-10">
          <h2 class="text-headline-small text-white flex items-center gap-3">
            <div
              class="w-2 h-7 bg-emerald-500 rounded-full shadow-[0_0_20px_rgba(16,185,129,0.7)] animate-pulse shrink-0"
            ></div>
            Morgenklaar
            {#if !loadingTomorrow && nextSchoolDayDate}
              <span
                class="text-label-medium text-emerald-400/80 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-full ml-1"
              >
                {nextSchoolDayShortLabel()}
              </span>
            {/if}
          </h2>
        </div>

        {#if loadingTomorrow}
          <div class="relative z-10 space-y-3">
            {#each Array(3) as _}
              <div
                class="rounded-m3-md bg-surface-800/50 animate-pulse border border-white/5 h-20"
              ></div>
            {/each}
          </div>
        {:else if tomorrowEvents.length === 0}
          <div
            class="relative z-10 flex flex-col items-center justify-center py-12 text-center"
            in:fade
          >
            <svg
              class="w-12 h-12 text-emerald-500/40 mb-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              ><path d="M8 2v4" /><path d="M16 2v4" /><rect
                width="18"
                height="18"
                x="3"
                y="4"
                rx="2"
              /><path d="M3 10h18" /></svg
            >
            <p class="text-white text-headline-small">Voorlopig geen lessen</p>
            <p
              class="text-body-medium text-gray-500 mt-2 max-w-xs leading-relaxed"
            >
              Er staan de komende dagen geen lessen gepland. Tijd om uit te
              rusten!
            </p>
          </div>
        {:else}
          <div class="relative z-10 space-y-5">
            {#if isSkippingDays()}
              <div
                class="flex items-center gap-2 text-emerald-400/70 border border-emerald-500/10 bg-emerald-500/5 rounded-m3-full px-5 py-3"
                in:fly={{ y: 8, duration: 400 }}
              >
                <svg
                  class="w-4 h-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  ><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path
                    d="M12 8h.01"
                  /></svg
                >
                <span class="text-label-medium">
                  Morgen is een vrije dag. Pak voor {nextSchoolDayShortLabel()}:
                </span>
              </div>
            {/if}

            <!-- Vertical lesson list -->
            <div class="flex items-center gap-2 mb-1">
              <span class="text-label-medium text-white/50">Voor de pauze</span>
              <div class="h-px flex-1 bg-white/5"></div>
            </div>
            <div class="space-y-2">
              {#each lessonsBeforeBreak() as event, i (event.Id || i)}
                {@const hw = getLessonHomework(event)}
                {@const hasHw = !!(hw.inhoud || hw.assignments.length > 0)}
                {@const isOpen = expandedLesson === i}
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div
                  in:fly={{ y: 10, delay: i * 60, duration: 400 }}
                  class="rounded-m3-md border transition-all overflow-hidden {hasHw
                    ? 'bg-amber-500/8 border-amber-500/20 hover:border-amber-500/40 cursor-pointer'
                    : 'bg-surface-800/40 border-white/5'} {isOpen
                    ? 'border-amber-500/50'
                    : ''}"
                  role={hasHw ? "button" : undefined}
                  tabindex={hasHw ? 0 : undefined}
                  onclick={() => hasHw && toggleLesson(i)}
                  onkeydown={(e) => {
                    if (hasHw && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      toggleLesson(i);
                    }
                  }}
                >
                  <!-- Lesson header row -->
                  <div class="flex items-center gap-4 px-5 py-4">
                    <!-- Time badge -->
                    <div
                      class="shrink-0 flex flex-col items-center min-w-[52px]"
                    >
                      <span
                        class="text-title-large leading-none {hasHw
                          ? 'text-amber-400'
                          : 'text-gray-400'}"
                      >
                        {event.LesuurVan ?? "—"}
                      </span>
                      <span class="text-label-small text-gray-600 mt-1">
                        {formatTime(event.Start)}
                      </span>
                    </div>

                    <!-- Subject & room -->
                    <div class="flex-1 min-w-0">
                      <p class="text-title-small text-white truncate">
                        {event.Vakken?.[0]?.Naam ??
                          event.Omschrijving ??
                          "Afspraak"}
                      </p>
                      <div class="flex items-center gap-2 mt-1">
                        <span
                          class="flex items-center gap-1 text-label-small {hasHw
                            ? 'text-amber-500/70'
                            : 'text-gray-500'}"
                        >
                          <svg
                            class="w-2.5 h-2.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            ><path
                              d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"
                            /><circle cx="12" cy="10" r="3" /></svg
                          >
                          {event.Lokalen?.[0]?.Naam ?? "??"}
                        </span>
                        {#if event.Docenten?.[0]?.Naam}
                          <span class="text-label-small text-gray-600"
                            >· {displayTeacherName(event.Docenten[0].Naam)}</span
                          >
                        {/if}
                      </div>
                    </div>

                    <!-- Indicators -->
                    <div class="shrink-0 flex items-center gap-2">
                      {#if hasHw}
                        <div
                          class="flex items-center gap-1.5 px-2.5 py-1 rounded-m3-sm bg-amber-500/15 border border-amber-500/25"
                        >
                          <span
                            class="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)] animate-pulse"
                          ></span>
                          <span class="text-label-small text-amber-400"
                            >{hw.assignments.length > 0
                              ? `${hw.assignments.length} taak`
                              : "HW"}</span
                          >
                        </div>
                        <svg
                          class="w-4 h-4 text-gray-500 transition-transform duration-300 {isOpen
                            ? 'rotate-180'
                            : ''}"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.5"><path d="m6 9 6 6 6-6" /></svg
                        >
                      {/if}
                    </div>
                  </div>

                  <!-- Expanded homework section -->
                  {#if isOpen && hasHw}
                    <div
                      class="mx-5 mb-4 pt-3 border-t {hasHw
                        ? 'border-amber-500/15'
                        : 'border-white/10'} space-y-3"
                      in:fly={{ y: -5, duration: 200 }}
                    >
                      <!-- Always show homework content, even when completed -->
                      {#if hw.inhoud}
                        <div
                          class="text-body-small text-gray-300 leading-relaxed whitespace-pre-wrap {hw.isCompleted
                            ? 'line-through opacity-50'
                            : ''}"
                        >
                          {stripHtml(hw.inhoud)}
                        </div>
                        <TranslateButton source={hw.inhoud} />
                      {/if}
                      {#if hw.aantekening}
                        <div
                          class="flex items-start gap-2 text-body-small leading-relaxed"
                        >
                          <span
                            class="shrink-0 mt-0.5 text-label-small font-semibold text-accent-400 uppercase tracking-wide"
                            >Aantekening</span
                          >
                          <span class="text-gray-300 whitespace-pre-wrap"
                            >{hw.aantekening}</span
                          >
                        </div>
                      {/if}
                      {#if hw.opmerking}
                        <div
                          class="flex items-start gap-2 text-body-small leading-relaxed"
                        >
                          <span
                            class="shrink-0 mt-0.5 text-label-small font-semibold text-accent-400 uppercase tracking-wide"
                            >Opmerking</span
                          >
                          <span class="text-gray-300 whitespace-pre-wrap"
                            >{hw.opmerking}</span
                          >
                        </div>
                      {/if}
                      {#each hw.assignments as a, j}
                        <div
                          class="bg-white/5 rounded-m3-sm px-4 py-3 border border-white/5 {hw.isCompleted
                            ? 'opacity-50'
                            : ''}"
                        >
                          <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                              <p class="text-label-medium text-white">
                                {a.Titel || "Opdracht"}
                              </p>
                              {#if a.Omschrijving}
                                <p
                                  class="text-body-small text-gray-400 mt-1.5 leading-relaxed line-clamp-3"
                                >
                                  {stripHtml(a.Omschrijving)}
                                </p>
                              {/if}
                            </div>
                            {#if a.InleverenVoor}
                              <span
                                class="shrink-0 text-label-small text-amber-400 whitespace-nowrap"
                              >
                                {new Date(a.InleverenVoor).toLocaleDateString(
                                  "nl-NL",
                                  { day: "numeric", month: "short" },
                                )}
                              </span>
                            {/if}
                          </div>
                          <div class="flex items-center gap-2 mt-2">
                            {#if a.IngeleverdOp}
                              <span
                                class="text-label-small text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-m3-sm"
                                >Ingediend</span
                              >
                            {:else if a.Beoordeling}
                              <span
                                class="text-label-small text-primary-400 bg-primary-500/10 px-2 py-0.5 rounded-m3-sm"
                                >Beoordeeld</span
                              >
                            {:else}
                              <span
                                class="text-label-small text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-m3-sm"
                                >Open</span
                              >
                            {/if}
                          </div>
                        </div>
                      {/each}

                      {#if hw.isCompleted}
                        <div
                          class="flex items-center gap-2 text-emerald-500/70 pt-1"
                        >
                          <svg
                            class="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            ><path
                              d="M22 11.08V12a10 10 0 1 1-5.93-9.14"
                            /><polyline points="22 4 12 14.01 9 11.01" /></svg
                          >
                          <span class="text-label-medium"
                            >Huiswerk afgerond</span
                          >
                        </div>
                      {:else}
                        <Button
                          variant="filled"
                          onclick={() => markLessonDone(event, i)}
                          class="w-full bg-emerald-500/15! text-emerald-400! border border-emerald-500/30! hover:bg-emerald-500/25! hover:text-emerald-300!"
                        >
                          <svg
                            class="w-3.5 h-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="3"><path d="M20 6 9 17l-5-5" /></svg
                          >
                          Huiswerk afgerond
                        </Button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>

            <!-- Overige vakken met huiswerk (na de pauze) -->
            {#if lessonsAfterBreakWithHomework().length > 0}
              <div
                class="space-y-2"
                in:fly={{ y: 8, delay: 300, duration: 400 }}
              >
                <div class="flex items-center gap-2 mb-1 mt-3">
                  <span class="text-label-medium text-white/50"
                    >Overige vakken met huiswerk</span
                  >
                  <div class="h-px flex-1 bg-white/5"></div>
                </div>
                {#each lessonsAfterBreakWithHomework() as item, bi (item.event.Id || bi)}
                  {@const isExpanded = expandedLesson === 1000 + bi}
                  <div
                    class="rounded-m3-md border overflow-hidden transition-all {item.type ===
                    'packed'
                      ? 'bg-emerald-500/5 border-emerald-500/15'
                      : 'bg-amber-500/5 border-amber-500/15'} {isExpanded
                      ? item.type === 'packed'
                        ? 'border-emerald-500/30'
                        : 'border-amber-500/30'
                      : ''}"
                  >
                    <!-- Header (clickable) -->
                    <button
                      onclick={() => toggleLesson(1000 + bi)}
                      class="w-full flex items-center gap-3 px-4 py-3 text-left"
                    >
                      <div
                        class="shrink-0 w-7 h-7 rounded-m3-sm {item.type ===
                        'packed'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-amber-500/15 text-amber-400'} flex items-center justify-center"
                      >
                        {#if item.type === "packed"}
                          <svg
                            class="w-3.5 h-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            ><path
                              d="M22 11.08V12a10 10 0 1 1-5.93-9.14"
                            /><polyline points="22 4 12 14.01 9 11.01" /></svg
                          >
                        {:else}
                          <svg
                            class="w-3.5 h-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            ><path d="M12 2v20M2 12h20" /></svg
                          >
                        {/if}
                      </div>
                      <div class="flex-1 min-w-0">
                        <p
                          class="text-label-medium text-white truncate flex items-center gap-2"
                        >
                          {item.subject}
                          <span
                            class="text-label-small text-gray-500 normal-case"
                            >les {item.lessonHour}</span
                          >
                        </p>
                        <p
                          class="text-label-small {item.type === 'packed'
                            ? 'text-emerald-500/70'
                            : 'text-amber-500/70'} mt-0.5"
                        >
                          {item.type === "packed"
                            ? "✓ Ingepakt"
                            : item.hw.assignments.length > 0
                              ? `${item.hw.assignments.length} openstaande ta(a)k(en)`
                              : "Huiswerk"}
                        </p>
                      </div>
                      <svg
                        class="w-3.5 h-3.5 text-gray-500 transition-transform duration-300 shrink-0 {isExpanded
                          ? 'rotate-180'
                          : ''}"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"><path d="m6 9 6 6 6-6" /></svg
                      >
                    </button>

                    <!-- Expanded homework content -->
                    {#if isExpanded}
                      <div
                        class="px-4 pb-4 space-y-2"
                        in:fly={{ y: -5, duration: 150 }}
                      >
                        <div
                          class="pt-2 border-t {item.type === 'packed'
                            ? 'border-emerald-500/10'
                            : 'border-amber-500/10'} space-y-2.5"
                        >
                          {#if item.hw.inhoud}
                            <div
                              class="text-body-small text-gray-300 leading-relaxed whitespace-pre-wrap {item
                                .hw.isCompleted
                                ? 'line-through opacity-50'
                                : ''}"
                            >
                              {stripHtml(item.hw.inhoud)}
                            </div>
                            <TranslateButton source={item.hw.inhoud} />
                          {/if}
                          {#each item.hw.assignments as a}
                            <div
                              class="bg-black/20 rounded-m3-sm px-3 py-2 {item
                                .hw.isCompleted
                                ? 'opacity-50'
                                : ''}"
                            >
                              <div
                                class="flex items-start justify-between gap-2"
                              >
                                <p class="text-label-medium text-white">
                                  {a.Titel || "Opdracht"}
                                </p>
                                {#if a.InleverenVoor}
                                  <span
                                    class="shrink-0 text-label-small text-amber-400"
                                    >{new Date(
                                      a.InleverenVoor,
                                    ).toLocaleDateString("nl-NL", {
                                      day: "numeric",
                                      month: "short",
                                    })}</span
                                  >
                                {/if}
                              </div>
                              {#if a.Omschrijving}
                                <p
                                  class="text-body-small text-gray-400 mt-1 line-clamp-2"
                                >
                                  {stripHtml(a.Omschrijving)}
                                </p>
                              {/if}
                            </div>
                          {/each}

                          {#if item.hw.isCompleted}
                            <div
                              class="flex items-center gap-1.5 text-emerald-500/70 pt-1"
                            >
                              <svg
                                class="w-3 h-3"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2.5"
                                ><path
                                  d="M22 11.08V12a10 10 0 1 1-5.93-9.14"
                                /><polyline
                                  points="22 4 12 14.01 9 11.01"
                                /></svg
                              >
                              <span class="text-label-medium"
                                >Huiswerk afgerond</span
                              >
                            </div>
                          {:else}
                            <Button
                              variant="filled"
                              onclick={() =>
                                markLessonDone(item.event, item.index)}
                              class="w-full bg-emerald-500/15! text-emerald-400! border border-emerald-500/30! hover:bg-emerald-500/25! {item.type ===
                              'packed'
                                ? 'bg-emerald-500/15!'
                                : 'bg-emerald-500/10! border border-emerald-500/20! hover:bg-emerald-500/20!'}"
                            >
                              <svg
                                class="w-3 h-3"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="3"
                                ><path d="M20 6 9 17l-5-5" /></svg
                              >
                              Afvinken als ingepakt
                            </Button>
                          {/if}
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else if !lessonsBeforeBreak().some(lessonHasHomework)}
              <div
                class="flex items-center gap-2 text-emerald-400/70 pt-1"
                in:fly={{ y: 8, delay: 300, duration: 400 }}
              >
                <svg
                  class="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  ><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline
                    points="22 4 12 14.01 9 11.01"
                  /></svg
                >
                <span class="text-label-medium"
                  >Geen openstaand huiswerk voor {nextSchoolDayShortLabel()}</span
                >
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </section>

    <section in:fly={{ y: -20, duration: 700, delay: 100 }} class="mb-14">
      <div class="flex items-center justify-between px-1 mb-4">
        <h2 class="text-headline-small text-white flex items-center gap-3">
          <div
            class="w-2 h-7 bg-primary-500 rounded-full shadow-[0_0_20px_rgba(200,100,255,0.6)]"
          ></div>
          Weekoverzicht
        </h2>
      </div>
      <div class="grid grid-cols-3 gap-2 md:gap-4">
        {#if loadingWeekStats}
          {#each Array(3) as _}
            <div
              class="glass rounded-m3-md p-3 md:p-5 h-24 md:h-28 animate-pulse"
            ></div>
          {/each}
        {:else}
          <div
            class="glass rounded-m3-md p-3 md:p-5 text-center border-white/5"
          >
            <p class="text-label-small text-gray-500 mb-1">Vorige week</p>
            <p class="text-headline-medium text-white number-count">
              {weekStats.lastWeek.tussenuren}
            </p>
            <p class="text-label-small text-primary-400 mb-2">tussenuren</p>
            <p class="text-title-medium text-gray-300 number-count">
              {weekStats.lastWeek.lessons}
            </p>
            <p class="text-label-small text-gray-500">lessen</p>
          </div>
          <div
            class="glass rounded-m3-md p-3 md:p-5 text-center border border-primary-500/30"
          >
            <p class="text-label-small text-gray-500 mb-1">Deze week</p>
            <p class="text-headline-medium text-white number-count">
              {weekStats.thisWeek.tussenuren}
            </p>
            <p class="text-label-small text-primary-400 mb-2">tussenuren</p>
            <p class="text-title-medium text-gray-300 number-count">
              {weekStats.thisWeek.lessons}
            </p>
            <p class="text-label-small text-gray-500">lessen</p>
          </div>
          <div
            class="glass rounded-m3-md p-3 md:p-5 text-center border-white/5"
          >
            <p class="text-label-small text-gray-500 mb-1">Volgende week</p>
            <p class="text-headline-medium text-white number-count">
              {weekStats.nextWeek.tussenuren}
            </p>
            <p class="text-label-small text-primary-400 mb-2">tussenuren</p>
            <p class="text-title-medium text-gray-300 number-count">
              {weekStats.nextWeek.lessons}
            </p>
            <p class="text-label-small text-gray-500">lessen</p>
          </div>
        {/if}
      </div>
    </section>

    <!-- Things to play with -->
    <section class="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
      <LevelCard />
      <QuickGradeSliders />
      <QuestsCard />
      <FriendsCard events={heroEvents} />
      <div class="md:col-span-2"><WrappedCard onopen={() => (showWrapped = true)} /></div>
    </section>
    {#if showWrapped}
      <WrappedStory onclose={() => (showWrapped = false)} />
    {/if}
  </main>
</div>

<style>
  /* Custom Animations & UI Extensions */

  @keyframes gradient-x {
    0%,
    100% {
      background-position: 0% 50%;
    }
    50% {
      background-position: 100% 50%;
    }
  }
  .animate-gradient-x {
    background-size: 200% 100%;
    animation: gradient-x 12s ease infinite;
  }

  @keyframes header-pulse {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.05;
    }
    50% {
      transform: scale(1.1);
      opacity: 0.1;
    }
  }
  .animate-header-pulse {
    animation: header-pulse 10s ease-in-out infinite;
  }





  .glass {
    background: color-mix(in oklch, var(--color-surface-900), transparent 40%);
    backdrop-filter: blur(40px) saturate(180%);
    -webkit-backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid color-mix(in oklch, white, transparent 94%);
    box-shadow:
      0 30px 60px -12px rgba(0, 0, 0, 0.6),
      inset 0 1px 1px rgba(255, 255, 255, 0.05);
  }

  :global(body) {
    background-color: var(--color-surface-950);
    overflow-x: hidden;
  }


</style>
