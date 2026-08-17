<script lang="ts">
  import { personId, accountInfo, userSettings, currentPage } from '$lib/stores';
  import { getCalendarEvents, getGrades, getSchoolyears, getRecentGrades, getMessageFolders, getAssignments, formatDate, formatTeacherName, toggleCalendarEventDone } from '$lib/api';
  import { getSubjectIcon } from '$lib/icons';
  import { formatTime } from '$lib/format';
  import { tryAiInsight, getAiConfig } from '$lib/ai';
  import { cacheGet, cacheRefresh } from '$lib/cache';
  import { fade, fly, scale } from 'svelte/transition';
  import type { Assignment, CalendarEvent, Grade } from '$lib/types';

  // Svelte 5 State
  let todayEvents = $state<CalendarEvent[]>([]);
  let latestGrades = $state<Grade[]>([]);
  let unreadCount = $state(0);
  let upcomingAssignments = $state<Assignment[]>([]);

  // Section-specific loading states
  let loadingEvents = $state(true);
  let loadingGrades = $state(true);
  let loadingMessages = $state(true);
  let loadingAssignments = $state(true);

  let tomorrowEvents = $state<CalendarEvent[]>([]);
  let tomorrowAssignments = $state<Assignment[]>([]);
  let nextSchoolDayDate = $state<string>('');
  let loadingTomorrow = $state(true);
  let expandedLesson = $state<number | null>(null);

  let refreshTrigger = $state(0);

  // AI Dashboard Insight
  let aiInsight = $state<string | null>(null);
  let aiInsightLoading = $state(false);
  let aiConfigured = $state(false);
  let aiInsightError = $state(false);

  $effect(() => {
    checkAiAndLoadInsight();
  });

  async function checkAiAndLoadInsight() {
    try {
      const config = await getAiConfig();
      aiConfigured = config.enabled && config.has_api_key;
      if (aiConfigured && refreshTrigger >= 0) {
        loadAiInsight();
      }
    } catch {
      aiConfigured = false;
    }
  }

  async function loadAiInsight() {
    if (aiInsightLoading) return;
    aiInsightLoading = true;
    aiInsightError = false;

    const pid = $personId;
    if (pid === null) {
      aiInsightLoading = false;
      return;
    }

    // Gather available data for context
    const data = {
      todayEvents: todayEvents.map(e => ({
        subject: e.Vakken?.[0]?.Naam,
        time: e.LesuurVan,
        location: e.Lokalen?.[0]?.Naam,
        hasHomework: !!e.Inhoud,
      })),
      grades: latestGrades.map(g => ({
        subject: g.Vak?.Omschrijving,
        grade: g.CijferStr,
        date: g.DatumIngevoerd,
      })),
      assignments: upcomingAssignments.map(a => ({
        title: a.Titel,
        subject: a.Vak,
        deadline: a.InleverenVoor,
      })),
      unreadMessages: unreadCount,
    };

    try {
      const result = await tryAiInsight(
        "dashboard",
        data,
        "Geef een korte, behulpzame samenvatting van mijn dag in 2-3 zinnen. Noem geen cijfers of vakken tenzij relevant."
      );
      if (result) {
        aiInsight = result;
      } else {
        aiInsight = null;
      }
    } catch {
      aiInsightError = true;
      aiInsight = null;
    } finally {
      aiInsightLoading = false;
    }
  }

  // Derived greeting
  const greeting = $derived(() => {
    const hour = new Date().getHours();
    if (hour < 6) return 'Goedenacht';
    if (hour < 12) return 'Goedemorgen';
    if (hour < 18) return 'Goedemiddag';
    return 'Goedenavond';
  });

  // Watch for personId availability and local storage hydration
  $effect(() => {
    if ($personId !== null && refreshTrigger >= 0) {
      loadDashboardData();
    }
  });

  async function fetchDashboardData(pid: number) {
    const now = new Date();
    const today = formatDate(now);
    const nextWeek = formatDate(new Date(now.getTime() + 7 * 86400000));
    const result: {
      todayEvents: CalendarEvent[];
      latestGrades: Grade[];
      unreadCount: number;
      upcomingAssignments: Assignment[];
      tomorrowEvents: CalendarEvent[];
      tomorrowAssignments: Assignment[];
      nextSchoolDayDate: string;
    } = {
      todayEvents: [], latestGrades: [], unreadCount: 0, upcomingAssignments: [],
      tomorrowEvents: [], tomorrowAssignments: [],
      nextSchoolDayDate: formatDate(new Date(now.getTime() + 86400000)),
    };

    await Promise.allSettled([
      // 1. Calendar
      (async () => {
        try {
          const events = await getCalendarEvents(pid, today, today);
          result.todayEvents = events
            .filter(e => e.Status !== 4 && e.Status !== 5)
            .sort((a, b) => a.Start.localeCompare(b.Start));
        } catch (e) {
          console.error('Dashboard: Calendar fetch failed', e);
        }
      })(),

      // 2. Messages
      (async () => {
        try {
          const folders = await getMessageFolders();
          result.unreadCount = folders.reduce((sum, f) => sum + (f.aantalOngelezen ?? 0), 0);
        } catch (e) {
          console.error('Dashboard: Messages fetch failed', e);
        }
      })(),

      // 3. Grades — use the dedicated recent grades endpoint, fall back to
      //    school-year lookup if it returns nothing or throws (e.g. fresh account).
      (async () => {
        let recentGrades: Grade[] | null = null;
        try {
          const recent = await getRecentGrades(pid, 5);
          if (recent && recent.length > 0) {
            recentGrades = recent.filter((g) => g.CijferStr);
          }
        } catch (e) {
          console.warn('Dashboard: getRecentGrades failed, trying fallback', e);
        }
        // Fallback: if recent endpoint returned nothing or errored, fetch via school year
        if (!recentGrades || recentGrades.length === 0) {
          try {
            const schoolyears = await getSchoolyears(pid, '2020-01-01', today);
            if (schoolyears.length > 0) {
              const currentYear = schoolyears.find((y) => {
                if (!y.begin || !y.einde) return false;
                return new Date(y.begin) <= now && new Date(y.einde) >= now;
              }) || schoolyears[schoolyears.length - 1];
              if (currentYear?.id) {
                const fetchedGrades = await getGrades(pid, currentYear.id, currentYear.einde);
                recentGrades = fetchedGrades
                  .filter((g) => g.CijferStr && g.CijferKolom?.KolomSoort === 1)
                  .sort((a, b) => (b.DatumIngevoerd ?? '').localeCompare(a.DatumIngevoerd ?? ''))
                  .slice(0, 5);
              }
            }
          } catch (e) {
            console.error('Dashboard: Grades fallback fetch failed', e);
          }
        }
        if (recentGrades) result.latestGrades = recentGrades;
      })(),

      // 5. Next school day's schedule + open assignments
      (async () => {
        try {
          const tomorrow = formatDate(new Date(now.getTime() + 86400000));
          const weekLater = formatDate(new Date(now.getTime() + 7 * 86400000));
          const [events, assignments] = await Promise.all([
            getCalendarEvents(pid, tomorrow, weekLater),
            getAssignments(pid, tomorrow, weekLater),
          ]);

          const filtered = events
            .filter(e => e.Status !== 4 && e.Status !== 5)
            .sort((a, b) => a.Start.localeCompare(b.Start));

          // Group by date and find the first day with events
          const eventsByDate: Record<string, CalendarEvent[]> = {};
          for (const event of filtered) {
            const date = event.Start.substring(0, 10);
            if (!eventsByDate[date]) eventsByDate[date] = [];
            eventsByDate[date].push(event);
          }

          const sortedDates = Object.keys(eventsByDate).sort();
          if (sortedDates.length > 0) {
            result.nextSchoolDayDate = sortedDates[0];
            result.tomorrowEvents = eventsByDate[result.nextSchoolDayDate];
          } else {
            result.nextSchoolDayDate = tomorrow;
            result.tomorrowEvents = [];
          }

          // Store all open assignments (not date-filtered since homework can span days)
          result.tomorrowAssignments = assignments.filter(a => !a.Afgesloten && !a.IngeleverdOp);
        } catch (e) {
          console.error('Dashboard: Next school day fetch failed', e);
        }
      })(),

      // 4. Assignments
      (async () => {
        try {
          const assignments = await getAssignments(pid, today, nextWeek);
          result.upcomingAssignments = assignments
            .filter(a => !a.Afgesloten)
            .sort((a, b) => a.InleverenVoor.localeCompare(b.InleverenVoor))
            .slice(0, 3);
        } catch (e) {
          console.error('Dashboard: Assignments fetch failed', e);
        }
      })()
    ]);

    return result;
  }

  async function loadDashboardData() {
    const pid = $personId;
    if (pid === null) return;

    const forcing = refreshTrigger > 0;
    // Set all to loading if we are manually refreshing
    if (forcing) {
        loadingEvents = true;
        loadingGrades = true;
        loadingMessages = true;
        loadingAssignments = true;
        loadingTomorrow = true;
    }

    try {
      const data = forcing
        ? await cacheRefresh(`dashboard_${pid}`, () => fetchDashboardData(pid), 5 * 60 * 1000)
        : await cacheGet(`dashboard_${pid}`, () => fetchDashboardData(pid), 5 * 60 * 1000);

      todayEvents = data.todayEvents;
      latestGrades = data.latestGrades;
      unreadCount = data.unreadCount;
      upcomingAssignments = data.upcomingAssignments;
      tomorrowEvents = data.tomorrowEvents;
      tomorrowAssignments = data.tomorrowAssignments;
      nextSchoolDayDate = data.nextSchoolDayDate;
    } finally {
      loadingEvents = false;
      loadingGrades = false;
      loadingMessages = false;
      loadingAssignments = false;
      loadingTomorrow = false;
    }
  }

  function handleRefresh() {
    refreshTrigger++;
  }

  // Format the next school day as a readable label
  const nextSchoolDayLabel = $derived(() => {
    if (!nextSchoolDayDate) return '';
    const date = new Date(nextSchoolDayDate + 'T00:00:00');
    return date.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  });

  // Short day name (e.g. "maandag") for the badge
  const nextSchoolDayShortLabel = $derived(() => {
    if (!nextSchoolDayDate) return '';
    const date = new Date(nextSchoolDayDate + 'T00:00:00');
    return date.toLocaleDateString('nl-NL', { weekday: 'long' });
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
      const endCurrent = new Date(tomorrowEvents[i].Einde ?? tomorrowEvents[i].Start);
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
    const subjectName = event.Vakken?.[0]?.Naam?.toLowerCase() ?? '';
    if (!subjectName) return false;
    return tomorrowAssignments.some(a => {
      const assignmentSubject = (a.Vak ?? a.Titel ?? '').toLowerCase();
      return assignmentSubject.includes(subjectName) || subjectName.includes(assignmentSubject);
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
      type: 'packed' | 'extra';
      subject: string;
      lessonHour: string | number;
      index: number;
      event: any;
      hw: { inhoud: string | null; assignments: any[]; isCompleted: boolean };
    }[] = [];

    for (let i = beforeCount; i < tomorrowEvents.length; i++) {
      const event = tomorrowEvents[i];
      const hw = getLessonHomework(event);
      if (!hw.inhoud && hw.assignments.length === 0) continue; // skip if no homework at all

      result.push({
        type: event.Afgerond ? 'packed' : 'extra',
        subject: event.Vakken?.[0]?.Naam ?? 'Onbekend',
        lessonHour: event.LesuurVan ?? '—',
        index: i,
        event,
        hw,
      });
    }

    return result;
  });

  // Get extended homework info for a lesson: Inhoud + matching assignments
  function getLessonHomework(event: CalendarEvent): { inhoud: string | null; assignments: any[]; isCompleted: boolean } {
    const inhoud = (event.Inhoud?.trim()) || null;
    const subjectName = event.Vakken?.[0]?.Naam?.toLowerCase() ?? '';
    const assignments = subjectName
      ? tomorrowAssignments.filter(a => {
          const assignmentSubject = (a.Vak ?? a.Titel ?? '').toLowerCase();
          return assignmentSubject.includes(subjectName) || subjectName.includes(assignmentSubject);
        })
      : [];
    return { inhoud, assignments, isCompleted: !!event.Afgerond };
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
      if (event.Afgerond) expandedLesson = null;
    } catch (e) {
      console.error('Failed to toggle lesson done:', e);
    }
  }

  function stripHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent || '';
  }

  function isVoldoende(grade: Grade): boolean {
    const val = parseFloat((grade.CijferStr ?? '0').replace(',', '.'));
    // Non-numeric grade strings (e.g. "Vrijgesteld"/"V" for exempted, "n.b.") parse
    // to NaN, and NaN >= threshold is always false in JS — so these were silently
    // rendered as failing/red whenever highlightFailing is on, even though they're
    // not a numeric grade at all. Treat "can't parse it as a number" as neutral.
    if (isNaN(val)) return true;
    return val >= ($userSettings.insufficientThreshold ?? 5.5);
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-screen selection:bg-primary-500/30">
  <!-- Sticky Header -->
  <header class="sticky top-0 z-40 bg-surface-950/80 backdrop-blur-2xl border-b border-white/5 px-6 py-6 md:py-8 transition-all duration-500 overflow-hidden">
    <!-- Animated background pulse for header -->
    <div class="absolute inset-x-0 -top-24 h-48 bg-primary-500/5 blur-[100px] rounded-full animate-header-pulse"></div>

    <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 max-w-7xl mx-auto w-full relative z-10">
      <div class="flex items-center gap-6" in:fly={{ x: -20, duration: 800 }}>
        <div class="relative group">
          <div class="w-16 h-16 rounded-m3-md bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white text-3xl font-black shadow-2xl shadow-primary-500/30 group-hover:rotate-6 group-hover:scale-105 transition-all duration-500 cursor-help">
            {$accountInfo?.Persoon?.Roepnaam?.[0] ?? 'U'}
          </div>
          <div class="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-emerald-500 border-4 border-surface-950 shadow-lg animate-pulse"></div>
        </div>
        <div>
          <h1 class="text-display-small text-white leading-none flex flex-wrap items-baseline gap-x-3">
             <span class="opacity-60 text-headline-small">{greeting()}</span>
             <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 via-primary-200 to-primary-500 animate-gradient-x">
                {$accountInfo?.Persoon?.Roepnaam ?? 'Gebruiker'}
             </span>
          </h1>
          <p class="text-gray-400 text-label-medium mt-2 flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981]"></span>
            {new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3 md:gap-5">
        <button
           onclick={() => currentPage.set('messages')}
           aria-label={`${unreadCount} ongelezen berichten`}
           class="glass px-5 py-3 rounded-m3-full flex items-center gap-3 border-primary-500/10 group transition-all hover:bg-primary-500/20 hover:border-primary-500/40 active:scale-95 shadow-xl shadow-black/40 relative overflow-hidden"
        >
          <div class="absolute inset-0 bg-gradient-to-r from-primary-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
          <div class="relative">
            <svg class="w-5 h-5 text-primary-400 group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><rect width="20" height="14" x="2" y="5" rx="2"/></svg>
            {#if unreadCount > 0}
              <span class="absolute -top-1.5 -right-1.5 flex h-3 w-3">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
              </span>
            {/if}
          </div>
          <span class="text-label-large text-primary-400 relative z-10">{unreadCount} berichten</span>
        </button>
        <button
          onclick={handleRefresh}
          class="p-4 rounded-m3-full bg-surface-800/40 text-gray-400 hover:text-white border border-white/5 transition-all hover:bg-surface-700/60 active:scale-90 shadow-2xl group overflow-hidden relative"
          aria-label="Vernieuwen"
        >
          <div class="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
          <svg class="w-5 h-5 group-hover:rotate-180 transition-transform duration-1000 ease-in-out relative z-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 md:px-8 w-full py-8 pb-28">

    <!-- AI Insight Card -->
    {#if aiConfigured}
      {#if aiInsightLoading}
        <div class="mb-6 glass rounded-m3-md p-5 border-primary-500/10 flex items-center gap-4" in:fade>
          <div class="w-8 h-8 rounded-m3-sm bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center animate-pulse">
            <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"/><path d="M12 14l-2 6h4l-2-6z"/></svg>
          </div>
          <div class="flex-1">
            <div class="h-4 bg-surface-700/50 rounded-full w-3/4 animate-pulse mb-2"></div>
            <div class="h-3 bg-surface-700/30 rounded-full w-1/2 animate-pulse"></div>
          </div>
        </div>
      {:else if aiInsight}
        <div class="mb-6 glass rounded-m3-md p-5 border-primary-500/20 bg-gradient-to-r from-primary-500/5 to-transparent" in:fly={{ y: -10, duration: 500 }}>
          <div class="flex items-start gap-4">
            <div class="w-8 h-8 rounded-m3-sm bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center shrink-0 shadow-lg shadow-primary-500/20">
              <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"/><path d="M12 14l-2 6h4l-2-6z"/></svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-label-medium text-primary-400 mb-2 flex items-center gap-2">
                <span class="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse"></span>
                AI Inzicht
              </p>
              <p class="text-body-medium text-gray-200 leading-relaxed">{aiInsight}</p>
            </div>
            <button
              onclick={loadAiInsight}
              class="shrink-0 p-2 rounded-m3-full text-gray-500 hover:text-primary-400 hover:bg-surface-800/50 transition-all"
              title="Vernieuw inzicht"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
            </button>
          </div>
        </div>
      {/if}
    {:else if !aiConfigured && refreshTrigger >= 0}
      <!-- Show a subtle "configure AI" prompt -->
      <div class="mb-6 glass rounded-m3-md p-4 border-dashed border-primary-500/10" in:fade>
        <button
          onclick={() => currentPage.set('settings')}
          class="flex items-center gap-3 w-full text-left group"
        >
          <div class="w-7 h-7 rounded-m3-sm bg-primary-500/10 flex items-center justify-center shrink-0">
            <svg class="w-3.5 h-3.5 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"/><path d="M12 14l-2 6h4l-2-6z"/></svg>
          </div>
          <p class="text-body-medium text-gray-500 group-hover:text-gray-300 transition-colors">
            <span class="text-label-medium text-primary-400">Configureer AI</span> voor persoonlijke daginzichten en studiedvies
          </p>
          <svg class="w-3.5 h-3.5 text-gray-600 ml-auto group-hover:translate-x-1 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
    {/if}

    <!-- Pack for Tomorrow -->
    <section in:fly={{ y: -20, duration: 700 }} class="mb-14">
      <div class="glass rounded-m3-md p-6 md:p-10 relative overflow-hidden border-white/5 shadow-2xl group">
        <!-- Ambient glow -->
        <div class="absolute inset-0 bg-gradient-to-r from-emerald-500/8 via-transparent to-primary-500/8 opacity-60 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"></div>

        <div class="flex items-center justify-between mb-6 md:mb-8 relative z-10">
          <h2 class="text-headline-small text-white flex items-center gap-3">
            <div class="w-2 h-7 bg-emerald-500 rounded-full shadow-[0_0_20px_rgba(16,185,129,0.7)] animate-pulse shrink-0"></div>
            Morgenklaar
            {#if !loadingTomorrow && nextSchoolDayDate}
              <span class="text-label-medium text-emerald-400/80 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-full ml-1">
                {nextSchoolDayShortLabel()}
              </span>
            {/if}
          </h2>
          <button
            onclick={() => currentPage.set('calendar')}
            class="text-label-large text-emerald-400 hover:text-emerald-300 flex items-center gap-2 group/link transition-all bg-emerald-500/5 hover:bg-emerald-500/10 border border-emerald-500/10 hover:border-emerald-500/25 px-4 py-2 rounded-m3-full"
          >
            Rooster <svg class="w-3.5 h-3.5 group-hover/link:translate-x-1 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>

        {#if loadingTomorrow}
          <div class="relative z-10 space-y-3">
            {#each Array(3) as _}
              <div class="rounded-m3-md bg-surface-800/50 animate-pulse border border-white/5 h-20"></div>
            {/each}
          </div>
        {:else if tomorrowEvents.length === 0}
          <div class="relative z-10 flex flex-col items-center justify-center py-12 text-center" in:fade>
            <svg class="w-12 h-12 text-emerald-500/40 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>
            <p class="text-white text-headline-small">Voorlopig geen lessen</p>
            <p class="text-body-medium text-gray-500 mt-2 max-w-xs leading-relaxed">Er staan de komende dagen geen lessen gepland. Tijd om uit te rusten!</p>
          </div>
        {:else}
          <div class="relative z-10 space-y-5">
            {#if isSkippingDays()}
              <div class="flex items-center gap-2 text-emerald-400/70 border border-emerald-500/10 bg-emerald-500/5 rounded-m3-full px-5 py-3" in:fly={{ y: 8, duration: 400 }}>
                <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
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
                  class="rounded-m3-md border transition-all overflow-hidden
 {hasHw
 ? 'bg-amber-500/8 border-amber-500/20 hover:border-amber-500/40 cursor-pointer'
 : 'bg-surface-800/40 border-white/5'}
 {isOpen ? 'border-amber-500/50' : ''}"
                  role={hasHw ? 'button' : undefined}
                  tabindex={hasHw ? 0 : undefined}
                  onclick={() => hasHw && toggleLesson(i)}
                  onkeydown={(e) => { if (hasHw && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleLesson(i); } }}
                >
                  <!-- Lesson header row -->
                  <div class="flex items-center gap-4 px-5 py-4">
                    <!-- Time badge -->
                    <div class="shrink-0 flex flex-col items-center min-w-[52px]">
                      <span class="text-title-large leading-none {hasHw ? 'text-amber-400' : 'text-gray-400'}">
                        {event.LesuurVan ?? '—'}
                      </span>
                      <span class="text-label-small text-gray-600 mt-1">
                        {formatTime(event.Start)}
                      </span>
                    </div>

                    <!-- Subject & room -->
                    <div class="flex-1 min-w-0">
                      <p class="text-title-small text-white truncate">
                        {event.Vakken?.[0]?.Naam ?? event.Omschrijving ?? 'Afspraak'}
                      </p>
                      <div class="flex items-center gap-2 mt-1">
                        <span class="flex items-center gap-1 text-label-small {hasHw ? 'text-amber-500/70' : 'text-gray-500'}">
                          <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                          {event.Lokalen?.[0]?.Naam ?? '??'}
                        </span>
                        {#if event.Docenten?.[0]?.Naam}
                          <span class="text-label-small text-gray-600">· {event.Docenten[0].Naam}</span>
                        {/if}
                      </div>
                    </div>

                    <!-- Indicators -->
                    <div class="shrink-0 flex items-center gap-2">
                      {#if hasHw}
                        <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-m3-sm bg-amber-500/15 border border-amber-500/25">
                          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)] animate-pulse"></span>
                          <span class="text-label-small text-amber-400">{hw.assignments.length > 0 ? `${hw.assignments.length} taak` : 'HW'}</span>
                        </div>
                        <svg class="w-4 h-4 text-gray-500 transition-transform duration-300 {isOpen ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
                      {/if}
                    </div>
                  </div>

                  <!-- Expanded homework section -->
                  {#if isOpen && hasHw}
                    <div class="mx-5 mb-4 pt-3 border-t {hasHw ? 'border-amber-500/15' : 'border-white/10'} space-y-3" in:fly={{ y: -5, duration: 200 }}>
                      <!-- Always show homework content, even when completed -->
                      {#if hw.inhoud}
                        <div class="text-body-small text-gray-300 leading-relaxed whitespace-pre-wrap {hw.isCompleted ? 'line-through opacity-50' : ''}">
                          {stripHtml(hw.inhoud)}
                        </div>
                      {/if}
                      {#each hw.assignments as a, j}
                        <div class="bg-white/5 rounded-m3-sm px-4 py-3 border border-white/5 {hw.isCompleted ? 'opacity-50' : ''}">
                          <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                              <p class="text-label-medium text-white">{a.Titel || 'Opdracht'}</p>
                              {#if a.Omschrijving}
                                <p class="text-body-small text-gray-400 mt-1.5 leading-relaxed line-clamp-3">{stripHtml(a.Omschrijving)}</p>
                              {/if}
                            </div>
                            {#if a.InleverenVoor}
                              <span class="shrink-0 text-label-small text-amber-400 whitespace-nowrap">
                                {new Date(a.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                              </span>
                            {/if}
                          </div>
                          <div class="flex items-center gap-2 mt-2">
                            {#if a.IngeleverdOp}
                              <span class="text-label-small text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-m3-sm">Ingediend</span>
                            {:else if a.Beoordeling}
                              <span class="text-label-small text-primary-400 bg-primary-500/10 px-2 py-0.5 rounded-m3-sm">Beoordeeld</span>
                            {:else}
                              <span class="text-label-small text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-m3-sm">Open</span>
                            {/if}
                          </div>
                        </div>
                      {/each}

                      {#if hw.isCompleted}
                        <div class="flex items-center gap-2 text-emerald-500/70 pt-1">
                          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                          <span class="text-label-medium">Huiswerk afgerond</span>
                        </div>
                      {:else}
                        <button
                          onclick={() => markLessonDone(event, i)}
                          class="w-full flex items-center justify-center gap-2 py-2.5 rounded-m3-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 hover:text-emerald-300 transition-all text-label-large active:scale-[0.98]"
                        >
                          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>
                          Huiswerk afgerond
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>

            <!-- Overige vakken met huiswerk (na de pauze) -->
            {#if lessonsAfterBreakWithHomework().length > 0}
              <div class="space-y-2" in:fly={{ y: 8, delay: 300, duration: 400 }}>
                <div class="flex items-center gap-2 mb-1 mt-3">
                  <span class="text-label-medium text-white/50">Overige vakken met huiswerk</span>
                  <div class="h-px flex-1 bg-white/5"></div>
                </div>
                {#each lessonsAfterBreakWithHomework() as item, bi (item.event.Id || bi)}
                  {@const isExpanded = expandedLesson === 1000 + bi}
                  <div class="rounded-m3-md border overflow-hidden transition-all {item.type === 'packed' ? 'bg-emerald-500/5 border-emerald-500/15' : 'bg-amber-500/5 border-amber-500/15'} {isExpanded ? (item.type === 'packed' ? 'border-emerald-500/30' : 'border-amber-500/30') : ''}">
                    <!-- Header (clickable) -->
                    <button
                      onclick={() => toggleLesson(1000 + bi)}
                      class="w-full flex items-center gap-3 px-4 py-3 text-left"
                    >
                      <div class="shrink-0 w-7 h-7 rounded-m3-sm {item.type === 'packed' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'} flex items-center justify-center">
                        {#if item.type === 'packed'}
                          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        {:else}
                          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M2 12h20"/></svg>
                        {/if}
                      </div>
                      <div class="flex-1 min-w-0">
                        <p class="text-label-medium text-white truncate flex items-center gap-2">
                          {item.subject}
                          <span class="text-label-small text-gray-500 normal-case">les {item.lessonHour}</span>
                        </p>
                        <p class="text-label-small {item.type === 'packed' ? 'text-emerald-500/70' : 'text-amber-500/70'} mt-0.5">
                          {item.type === 'packed'
                            ? '✓ Ingepakt'
                            : (item.hw.assignments.length > 0 ? `${item.hw.assignments.length} openstaande ta(a)k(en)` : 'Huiswerk')}
                        </p>
                      </div>
                      <svg class="w-3.5 h-3.5 text-gray-500 transition-transform duration-300 shrink-0 {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
                    </button>

                    <!-- Expanded homework content -->
                    {#if isExpanded}
                      <div class="px-4 pb-4 space-y-2" in:fly={{ y: -5, duration: 150 }}>
                        <div class="pt-2 border-t {item.type === 'packed' ? 'border-emerald-500/10' : 'border-amber-500/10'} space-y-2.5">
                          {#if item.hw.inhoud}
                            <div class="text-body-small text-gray-300 leading-relaxed whitespace-pre-wrap {item.hw.isCompleted ? 'line-through opacity-50' : ''}">
                              {stripHtml(item.hw.inhoud)}
                            </div>
                          {/if}
                          {#each item.hw.assignments as a}
                            <div class="bg-black/20 rounded-m3-sm px-3 py-2 {item.hw.isCompleted ? 'opacity-50' : ''}">
                              <div class="flex items-start justify-between gap-2">
                                <p class="text-label-medium text-white">{a.Titel || 'Opdracht'}</p>
                                {#if a.InleverenVoor}
                                  <span class="shrink-0 text-label-small text-amber-400">{new Date(a.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}</span>
                                {/if}
                              </div>
                              {#if a.Omschrijving}
                                <p class="text-body-small text-gray-400 mt-1 line-clamp-2">{stripHtml(a.Omschrijving)}</p>
                              {/if}
                            </div>
                          {/each}

                          {#if item.hw.isCompleted}
                            <div class="flex items-center gap-1.5 text-emerald-500/70 pt-1">
                              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                              <span class="text-label-medium">Huiswerk afgerond</span>
                            </div>
                          {:else}
                            <button
                              onclick={() => markLessonDone(item.event, item.index)}
                              class="w-full flex items-center justify-center gap-1.5 py-2 rounded-m3-full text-label-large transition-all {item.type === 'packed' ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20'} active:scale-[0.98]"
                            >
                              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>
                              Afvinken als ingepakt
                            </button>
                          {/if}
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else if !lessonsBeforeBreak().some(lessonHasHomework)}
              <div class="flex items-center gap-2 text-emerald-400/70 pt-1" in:fly={{ y: 8, delay: 300, duration: 400 }}>
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                <span class="text-label-medium">Geen openstaand huiswerk voor {nextSchoolDayShortLabel()}</span>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-10">

      <!-- Left Column: Schedule -->
      <div class="lg:col-span-7 space-y-8">
        <section in:fly={{ y: 30, duration: 800 }} class="space-y-3">
          <div class="flex items-center justify-between px-1 mb-4">
            <h2 class="text-headline-small text-white flex items-center gap-3">
              <div class="w-2 h-7 bg-primary-500 rounded-full shadow-[0_0_20px_rgba(200,100,255,0.6)] animate-pulse"></div>
              Jouw Rooster
            </h2>
            <button
              onclick={() => currentPage.set('calendar')}
              class="text-label-large text-primary-400 hover:text-primary-300 transition-all hover:gap-4 flex items-center gap-3 group/all bg-primary-500/5 px-5 py-2.5 rounded-m3-full border border-primary-500/10 hover:border-primary-500/30"
            >
              Bekijk alles <svg class="w-4 h-4 group-hover/all:translate-x-1 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>

          <div class="rounded-m3-md p-3 md:p-5 relative overflow-hidden group border border-white/10 bg-surface-800/50 min-h-[300px] flex flex-col">
             <div class="absolute inset-0 bg-gradient-to-br from-primary-500/8 via-transparent to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"></div>

             {#if loadingEvents}
               <div class="space-y-6 relative z-10 w-full p-4">
                  {#each Array(4) as _}
                    <div class="flex items-center gap-7 p-6 rounded-m3-md bg-surface-900/30 animate-pulse border border-white/10">
                       <div class="w-20 h-20 rounded-m3-md bg-surface-800"></div>
                       <div class="flex-1 space-y-3">
                          <div class="h-6 bg-surface-800 rounded-full w-2/3"></div>
                          <div class="h-4 bg-surface-800/50 rounded-full w-1/3"></div>
                       </div>
                    </div>
                  {/each}
               </div>
             {:else if todayEvents.length === 0}
              <div class="flex-1 flex flex-col items-center justify-center text-center py-16" in:fade>
                <svg class="w-12 h-12 text-gray-600 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>
                <p class="text-white text-headline-small">Vrije dag!</p>
                <p class="text-body-medium text-gray-500 mt-2 max-w-xs leading-relaxed">Geen geplande lessen vandaag.</p>
              </div>
            {:else}
              <div class="space-y-2 relative z-10 w-full">
                {#each todayEvents as event, i (event.Id || i)}
                  <button
                    onclick={() => currentPage.set('calendar')}
                    in:fly={{ x: -30, delay: i * 100, duration: 600 }}
                    class="w-full flex flex-row items-center gap-4 md:gap-5 p-4 sm:p-5 rounded-m3-md bg-surface-800/60 border border-white/10 group/event transition-all hover:bg-surface-700/60 hover:border-primary-500/40 hover:scale-[1.01] active:scale-95 shadow-md"
                  >
                    <div class="flex flex-col items-center justify-center min-w-[60px] md:min-w-[75px] py-3 rounded-m3-sm bg-surface-900/80 border border-surface-700/60 group-hover/event:border-primary-500/50 transition-all shadow-md relative overflow-hidden shrink-0">
                      <div class="absolute inset-0 bg-primary-500/5 opacity-0 group-hover/event:opacity-100 transition-opacity"></div>
                       <span class="text-title-large text-primary-400 leading-none relative z-10">{event.LesuurVan || '—'}</span>
                       <span class="text-label-small text-gray-400 mt-1 relative z-10">{formatTime(event.Start)}</span>
                    </div>
                    <div class="flex-1 min-w-0 text-left">
                       <p class="text-title-medium text-white truncate group-hover/event:text-primary-400 transition-colors">
                        {event.Vakken?.[0]?.Naam ?? event.Omschrijving ?? 'Afspraak'}
                      </p>
                      <div class="flex flex-wrap md:flex-nowrap items-center gap-2 md:gap-5 mt-2 md:mt-4">
                         <span class="flex items-center gap-1.5 text-label-medium text-gray-300 px-3 py-1.5 rounded-m3-full bg-surface-800/80 border border-white/8">
                          <svg class="w-3 md:w-3.5 h-3 md:h-3.5 text-primary-500 inline-block mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                          {event.Lokalen?.[0]?.Naam ?? '??'}
                        </span>
                         <span class="text-label-medium text-gray-400 truncate bg-white/6 px-2.5 py-1 rounded-m3-full border border-white/8">{formatTeacherName(event.Docenten?.[0]?.Naam) ?? 'Geen docent'}</span>
                      </div>
                    </div>
                    {#if event.Inhoud}
                      <div class="w-10 h-10 md:w-14 md:h-14 rounded-full flex items-center justify-center bg-primary-500/10 text-primary-400 shrink-0 opacity-40 group-hover/event:opacity-100 transition-all border border-primary-500/20 group-hover/event:rotate-90 group-hover/event:scale-110 shadow-lg">
                        <svg class="w-5 h-5 md:w-7 md:h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M12 5v14M5 12h14"/></svg>
                      </div>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </section>

        <!-- Middle Section: Recent Grades -->
        <section in:fly={{ y: 30, delay: 200, duration: 800 }} class="space-y-4">
          <div class="flex items-center justify-between px-1 mb-4">
            <h2 class="text-headline-small text-white flex items-center gap-3">
              <div class="w-2 h-7 bg-accent-500 rounded-full shadow-[0_0_20px_rgba(200,100,255,0.6)]"></div>
              Resultaten
            </h2>
            <button
              onclick={() => currentPage.set('grades')}
              class="text-label-large text-accent-400 hover:text-accent-300 transition-all hover:gap-3 md:hover:gap-4 flex items-center gap-2 md:gap-3 group/grades bg-accent-500/5 px-4 md:px-5 py-2 md:py-2.5 rounded-m3-full border border-accent-500/10 hover:border-accent-500/30"
            >
              Alle cijfers <svg class="w-3.5 h-3.5 md:w-4 md:h-4 group-hover/grades:translate-x-1 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-5">
            {#if loadingGrades}
               {#each Array(4) as _}
                 <div class="p-4 md:p-5 rounded-m3-md glass animate-pulse border border-white/5 h-20 md:h-24 flex items-center gap-4">
                    <div class="w-10 h-10 rounded-m3-sm bg-surface-800"></div>
                    <div class="flex-1 space-y-2">
                       <div class="h-4 bg-surface-800 rounded-full w-2/3"></div>
                       <div class="h-3 bg-surface-800/50 rounded-full w-1/3"></div>
                    </div>
                 </div>
               {/each}
            {:else}
              {#each latestGrades as grade, i (grade.CijferId || i)}
                <button
                  onclick={() => currentPage.set('grades')}
                  in:scale={{ delay: i * 120, duration: 600, start: 0.9 }}
                  class="flex items-center gap-3 p-4 md:p-5 rounded-m3-md glass border border-white/5 hover:scale-[1.03] hover:border-accent-500/40 transition-all group/grade active:scale-95 shadow-lg relative overflow-hidden w-full text-left"
                >
                  <div class="absolute -right-4 -bottom-4 w-20 h-20 bg-accent-500/5 blur-2xl rounded-full group-hover/grade:bg-accent-500/15 transition-all duration-700"></div>
                  <!-- Subject icon -->
                  <div class="w-10 h-10 rounded-m3-sm bg-surface-900 border border-surface-700/40 flex items-center justify-center text-primary-400 shrink-0 group-hover/grade:border-accent-500/60 transition-all duration-500 group-hover/grade:rotate-6 group-hover/grade:scale-110 relative z-10">
                    {@html getSubjectIcon(grade.Vak?.Omschrijving ?? '')}
                  </div>
                  <!-- Subject info -->
                  <div class="min-w-0 flex-1 relative z-10">
                    <p class="text-title-small text-gray-100 truncate leading-tight group-hover/grade:text-accent-400 transition-colors">{grade.Vak?.Omschrijving ?? 'Onbekend'}</p>
                    <p class="text-label-small text-gray-500 mt-1 truncate">{formatDate(grade.DatumIngevoerd || '')}</p>
                  </div>
                  <!-- Grade number -->
                  <div class="shrink-0 relative z-10">
                    <span class="text-headline-large leading-none transition-transform group-hover/grade:scale-110 block {$userSettings.highlightFailing && !isVoldoende(grade) ? 'text-red-400' : 'text-accent-300'}">
                      {grade.CijferStr}
                    </span>
                  </div>
                </button>
              {:else}
                <div class="sm:col-span-2 py-10 rounded-m3-md flex flex-col items-center justify-center text-center border border-dashed border-white/15 bg-surface-800/30" in:fade>
                  <svg class="w-10 h-10 text-gray-600 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
                  <p class="text-title-small text-gray-400">Nog geen cijfers</p>
                  <button onclick={() => currentPage.set('grades')} class="mt-3 text-label-medium text-primary-400 hover:text-primary-300 flex items-center gap-1">
                    Bekijk cijferpagina <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
                  </button>
                </div>
              {/each}
            {/if}
          </div>
        </section>
      </div>

      <div class="lg:col-span-5 space-y-6 md:space-y-8">
        <section in:fly={{ x: 30, delay: 400, duration: 800 }} class="space-y-6 md:space-y-10">
          <h2 class="text-headline-small text-white flex items-center gap-3 px-1">
            <div class="w-2 h-7 bg-red-500 rounded-full shadow-[0_0_20px_rgba(239,68,68,0.6)] animate-pulse"></div>
            Deadlines
          </h2>

          <div class="glass rounded-m3-md p-4 md:p-8 shadow-2xl md:shadow-3xl relative overflow-hidden group border-white/5 flex flex-col min-h-[350px] md:min-h-[450px]">
            <div class="absolute inset-0 bg-gradient-to-br from-red-500/10 via-transparent to-transparent opacity-40 group-hover:opacity-60 transition-opacity duration-700"></div>

            {#if loadingAssignments}
               <div class="space-y-4 md:space-y-6 relative z-10 w-full p-2 md:p-4">
                  {#each Array(3) as _}
                    <div class="p-6 md:p-8 rounded-m3-md bg-surface-900/30 animate-pulse border border-white/10 h-24 md:h-32"></div>
                  {/each}
               </div>
            {:else if upcomingAssignments.length === 0}
              <div class="flex-1 flex flex-col items-center justify-center text-center opacity-70 py-16 md:py-24 px-4 md:px-8" in:fade>
                  <div class="w-24 h-24 md:w-36 md:h-36 rounded-m3-lg bg-surface-900/80 flex items-center justify-center mb-6 md:mb-10 text-gray-500 border border-white/10 shadow-2xl md:shadow-3xl group-hover:scale-110 transition-all duration-700 relative">
                      <div class="absolute inset-0 bg-emerald-500/5 blur-3xl rounded-full animate-pulse"></div>
                      <svg class="w-10 h-10 md:w-16 md:h-16 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  </div>
                  <p class="text-headline-small text-emerald-400/80 mb-4">Helemaal Bij!</p>
              </div>
            {:else}
              <div class="space-y-4 md:space-y-6 mb-8 md:mb-12 relative z-10 p-1 md:p-2">
                {#each upcomingAssignments as assignment, i (assignment.Id || i)}
                  <button
                    onclick={() => currentPage.set('assignments')}
                    in:fly={{ x: 30, delay: i * 150, duration: 600 }}
                    class="w-full p-5 md:p-8 rounded-m3-md bg-surface-900/50 border border-white/5 group/assign transition-all hover:bg-surface-800/90 hover:border-red-500/40 text-left shadow-xl md:shadow-2xl overflow-hidden relative active:scale-95 hover:scale-[1.02] flex flex-col sm:flex-row justify-between sm:items-center gap-4 sm:gap-8"
                  >
                    <div class="absolute -right-3 -top-3 w-16 h-16 md:w-20 md:h-20 bg-red-500/10 blur-2xl rounded-full group-hover/assign:bg-red-500/20 transition-all duration-700"></div>
                    <div class="min-w-0 relative z-10">
                      <p class="text-title-large text-gray-100 truncate group-hover/assign:text-red-400 transition-colors leading-tight">{assignment.Titel}</p>
                      <p class="text-label-small text-gray-500 mt-2 md:mt-3.5 bg-red-500/5 px-2 py-1 rounded-m3-xs inline-block">{assignment.Vak ?? 'Algemeen'}</p>
                    </div>
                    <div class="align-self-start sm:align-self-auto shrink-0 px-3 md:px-5 py-2 md:py-3 rounded-m3-full bg-red-500/15 border border-red-500/30 text-label-medium text-red-500 shadow-xl group-hover/assign:scale-110 group-hover/assign:-rotate-2 transition-all relative z-10">
                      {new Date(assignment.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                    </div>
                  </button>
                {/each}
              </div>
            {/if}

            <button
              onclick={() => currentPage.set('assignments')}
              class="w-full py-5 md:py-7 rounded-m3-full bg-gradient-to-r from-primary-600 to-primary-400 text-white text-label-large shadow-2xl md:shadow-3xl shadow-primary-500/40 hover:scale-[1.03] hover:brightness-110 transition-all active:scale-95 border border-white/20 ring-[6px] md:ring-8 ring-primary-500/10 relative overflow-hidden group/btn mt-auto"
            >
              <div class="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover/btn:translate-x-[100%] transition-transform duration-1000 skew-x-12"></div>
              <span class="relative z-10 flex items-center justify-center gap-4">
                 Open Portaal <svg class="w-6 h-6 animate-bounce-horizontal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </span>
            </button>
          </div>
        </section>

        <!-- Motivation card -->
        <section in:fly={{ x: 30, delay: 600, duration: 800 }} class="glass rounded-m3-md p-12 relative overflow-hidden bg-gradient-to-br from-primary-950/60 via-surface-950 to-accent-950/60 border-l-[6px] border-primary-500/50 shadow-3xl group">
           <div class="relative z-20 flex flex-col items-center justify-center text-center py-6">
              <div class="w-24 h-24 rounded-m3-lg bg-primary-500/20 flex items-center justify-center mb-10 group-hover:rotate-12 group-hover:scale-110 transition-all duration-700 shadow-3xl border border-primary-500/30 relative">
                  <div class="absolute inset-0 bg-primary-400/20 blur-2xl animate-pulse"></div>
                  <svg class="w-12 h-12 text-primary-400 relative z-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
              </div>
              <h3 class="text-display-small text-white mb-6 leading-none animate-float">Investeer in jezelf!</h3>
              <p class="text-body-medium text-primary-200/80 max-w-[320px] leading-loose opacity-90">
                Jouw inzet bepaalt de uitkomst. Maak er een legendarische dag van!
              </p>
           </div>
           <!-- Decorative layers for absolute premium feel -->
           <div class="absolute -top-32 -right-32 w-80 h-80 bg-primary-500/20 blur-[120px] rounded-full animate-pulse-slow"></div>
           <div class="absolute -bottom-32 -left-32 w-80 h-80 bg-accent-500/20 blur-[120px] rounded-full animate-pulse-slow-reverse"></div>
           <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-grid-white/[0.02] mask-radial-gradient"></div>
        </section>
      </div>
    </div>
  </main>
</div>

<style>
  /* Custom Animations & UI Extensions */

  @keyframes gradient-x {
    0%, 100% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
  }
  .animate-gradient-x {
    background-size: 200% 100%;
    animation: gradient-x 12s ease infinite;
  }

  @keyframes header-pulse {
    0%, 100% { transform: scale(1); opacity: 0.05; }
    50% { transform: scale(1.1); opacity: 0.1; }
  }
  .animate-header-pulse {
    animation: header-pulse 10s ease-in-out infinite;
  }

  @keyframes pulse-slow {
    0%, 100% { transform: scale(1); opacity: 0.3; }
    50% { transform: scale(1.2); opacity: 0.5; }
  }
  .animate-pulse-slow {
    animation: pulse-slow 15s ease-in-out infinite;
  }

  @keyframes pulse-slow-reverse {
    0%, 100% { transform: scale(1.2); opacity: 0.5; }
    50% { transform: scale(1); opacity: 0.3; }
  }
  .animate-pulse-slow-reverse {
    animation: pulse-slow-reverse 15s ease-in-out infinite;
  }

  @keyframes bounce-horizontal {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(6px); }
  }
  .animate-bounce-horizontal {
    animation: bounce-horizontal 1.5s infinite;
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
  }
  .animate-float {
    animation: float 6s ease-in-out infinite;
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

  .shadow-3xl {
    box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.7);
  }

  .mask-radial-gradient {
    mask-image: radial-gradient(circle at center, black, transparent 80%);
  }
</style>
