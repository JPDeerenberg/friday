<script lang="ts">
  import { personId, userSettings, resumedAt } from '$lib/stores';
  import { getCalendarEvents, formatDate, getCalendarEvent, toggleCalendarEventDone, downloadFile, createCalendarEvent, deleteCalendarEvent } from '$lib/api';
  import { formatTime } from '$lib/format';
  let downloadingFile = $state<string | null>(null);

  import HtmlRenderer from '$lib/components/HtmlRenderer.svelte';
  import Button from '$lib/components/Button.svelte';
  import IconButton from '$lib/components/IconButton.svelte';
  import { on } from 'svelte/events';
  import { onMount } from 'svelte';
  import { fade, fly, slide, scale } from 'svelte/transition';
  import type { CalendarAttachment, CalendarEvent, Link } from '$lib/types';

  type DayAppointment = CalendarEvent & {
    IsCombined?: boolean;
    displayType?: 'break';
    Duration?: number;
    Lesuur?: string | number;
  };

  type BreakSeparator = {
    id: string;
    displayType: 'break';
    Duration: number;
    Start: string;
    Einde: string;
  };

  type NowMarker = {
    id: string;
    displayType: 'now';
  };

  type DayItem = DayAppointment | BreakSeparator | NowMarker;

  type WeekAppointment = CalendarEvent & {
    _column: number;
    _columnCount: number;
  };

  let appointments = $state<CalendarEvent[]>([]);
  let selectedDate = $state(new Date());
  let loading = $state(true);
  let showDetail = $state(false);
  let selectedAppointment = $state<CalendarEvent | null>(null);
  let loadingDetail = $state(false);
  let editMode = $state(false);
  let editContent = $state('');
  let isCreating = $state(false);

  // Week view state
  let isDesktop = $state(false);
  let now = $state(new Date());

  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => { isDesktop = mq.matches; };
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });

  $effect(() => {
    const t = setInterval(() => { now = new Date(); }, 60000);
    return () => clearInterval(t);
  });

  const showWeekView = $derived.by(() => {
    const mode = $userSettings.weekView ?? 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return isDesktop;
  });

  // New appointment state
  let newApp = $state({
    omschrijving: '',
    lokatie: '',
    inhoud: '',
    start: '',
    einde: '',
    duurtHeleDag: false
  });

  // Time calculator for "Nieuwe afspraak": appointment time + travel + visit
  // duration -> departure/return time, filled into newApp.start/einde.
  let showTimeCalculator = $state(false);
  let calcMode = $state<'lopen' | 'fiets' | 'auto'>('fiets');
  let calcTravelMinutes = $state(15);
  let calcVisitMinutes = $state(30);
  let calcAppointmentTime = $state('');

  const calcResult = $derived.by(() => {
    if (!/^\d{2}:\d{2}$/.test(calcAppointmentTime)) return null;
    const [h, m] = calcAppointmentTime.split(':').map(Number);
    const base = new Date(selectedDate);
    base.setHours(h, m, 0, 0);
    const depart = new Date(base.getTime() - calcTravelMinutes * 60000);
    const back = new Date(base.getTime() + (calcVisitMinutes + calcTravelMinutes) * 60000);
    return { depart, back };
  });

  function applyCalculatedTime() {
    if (!calcResult) return;
    const pad = (n: number) => String(n).padStart(2, '0');
    newApp.start = `${pad(calcResult.depart.getHours())}:${pad(calcResult.depart.getMinutes())}`;
    newApp.einde = `${pad(calcResult.back.getHours())}:${pad(calcResult.back.getMinutes())}`;
    const modeLabel = calcMode === 'lopen' ? 'Lopen' : calcMode === 'fiets' ? 'Fiets' : 'Auto';
    const note = `Vervoer: ${modeLabel} (${calcTravelMinutes} min heen, ${calcTravelMinutes} min terug), ${calcVisitMinutes} min ter plaatse.`;
    newApp.inhoud = newApp.inhoud ? `${newApp.inhoud}\n${note}` : note;
    showTimeCalculator = false;
  }

  $effect(() => {
    if (!isCreating) showTimeCalculator = false;
  });

  // Local overrides for homework/content
  let localOverrides = $state<Record<string, string>>({});

  onMount(async () => {
    const saved = localStorage.getItem('calendar_overrides');
    if (saved) {
      try { localOverrides = JSON.parse(saved); } catch (e) { console.error(e); }
    }
    await loadAppointments();
  });

  // Track the date range we have data for
  let loadedStart = $state<Date | null>(null);
  let loadedEnd = $state<Date | null>(null);

    // Foreground resume: force-refresh when app returns from background
  let resumedSeen = $state(false);
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) { resumedSeen = true; return; }
    if ($personId !== null) loadAppointments(true);
  });

  async function loadAppointments(force = false) {
    const pid = $personId;
    if (!pid) return;

    // Check if selectedDate is within already-loaded range (with 3-day buffer)
    if (!force && loadedStart && loadedEnd) {
      const bufferStart = new Date(loadedStart);
      bufferStart.setDate(bufferStart.getDate() + 3);
      const bufferEnd = new Date(loadedEnd);
      bufferEnd.setDate(bufferEnd.getDate() - 3);
      if (selectedDate >= bufferStart && selectedDate <= bufferEnd) {
        // We have the data, no need to reload
        return;
      }
    }

    loading = true;
    try {
      const start = new Date(selectedDate);
      start.setDate(start.getDate() - 14);
      const end = new Date(selectedDate);
      end.setDate(end.getDate() + 14);
      loadedStart = start;
      loadedEnd = end;
      appointments = await getCalendarEvents(pid, formatDate(start), formatDate(end));
    } catch (e) {
      console.error('Error loading appointments:', e);
    } finally {
      loading = false;
    }
  }

  const dayAppointments = $derived.by((): DayItem[] => {
    let filtered = appointments.filter(a => {
      if (!a.Start) return false;
      const d = new Date(a.Start);
      return !isNaN(d.getTime()) && d.toDateString() === selectedDate.toDateString();
    });

    // 1. Filter cancelled if setting is on
    if ($userSettings.hideCancelled) {
      filtered = filtered.filter(a => a.Status !== 4 && a.Status !== 5);
    }

    filtered.sort((a, b) => (a.Start ?? '').localeCompare(b.Start ?? ''));

    // `processed` mixes full events with synthetic break-separator entries, so
    // the pipeline stays loosely typed; the derived's public type is DayItem[].
    let processed: any[] = [];

    // 2. Combine lessons if setting is on
    if ($userSettings.combineLessons) {
      for (const app of filtered) {
        const last = processed[processed.length - 1];
        
        // Match same subject, teacher, location and exact consecutive timing
        const isSameSubject = last && 
                             (last.Vakken?.[0]?.Naam === app.Vakken?.[0]?.Naam) &&
                             (last.Docenten?.[0]?.Naam === app.Docenten?.[0]?.Naam) &&
                             (last.Lokatie === app.Lokatie);
        const isConsecutive = last && last.Einde && app.Start && last.Einde === app.Start;

        if (isSameSubject && isConsecutive) {
          last.Einde = app.Einde;
          last.LesuurTotMet = app.LesuurTotMet || app.LesuurVan;
          last.IsCombined = true;
        } else {
          processed.push({ ...app });
        }
      }
    } else {
      processed = [...filtered];
    }

    // 3. Add break separators if setting is on
    if ($userSettings.showBreakSeparator) {
      const withBreaks: any[] = [];
      for (let i = 0; i < processed.length; i++) {
        const current = processed[i];
        if (i > 0) {
          const prev = processed[i - 1];
          if (!prev.Einde || !current.Start) {
            withBreaks.push(current);
            continue;
          }
          const prevEnd = new Date(prev.Einde);
          const currStart = new Date(current.Start);
          const diffMs = currStart.getTime() - prevEnd.getTime();
          const diffMin = Math.round(diffMs / 60000);

          if (diffMin > 0 && diffMin < 240) { // Only show breaks shorter than 4 hours
            withBreaks.push({
              id: `break-${i}`,
              displayType: 'break',
              Duration: diffMin,
              Start: prev.Einde,
              Einde: current.Start
            });
          }
        }
        withBreaks.push(current);
      }
      processed = withBreaks;
    }

    const mapped = processed.map(a => {
      if (a.displayType === 'break') return a;
      return {
        ...a,
        Inhoud: localOverrides[a.Id] || a.Inhoud,
        Lesuur: (() => {
          const lv = a.LesuurVan ?? null;
          const lt = a.LesuurTotMet ?? null;
          if (a.IsCombined) {
            if (lv && lt) return `${lv}–${lt}`;
            if (lv) return `${lv}`;
            if (lt) return `${lt}`;
            return '—';
          }
          return lv || '—';
        })()
      };
    });

    const isToday = selectedDate.toDateString() === now.toDateString();
    if (isToday) {
      const nowMarker: DayItem = { id: 'now-marker', displayType: 'now' };
      let insertIdx = mapped.findIndex(item => {
        const start = item.Start ? new Date(item.Start) : null;
        return start !== null && !isNaN(start.getTime()) && start.getTime() > now.getTime();
      });
      if (insertIdx === -1) insertIdx = mapped.length;
      mapped.splice(insertIdx, 0, nowMarker);
    }

    return mapped;
  });


  // Swipe animation state
  let swipeOffset = $state(0);
  let isAnimating = $state(false);
  let noTransition = $state(false);
  let swipeDirection = $state(0); // -1 = left (next), 1 = right (prev)
  let dayKey = $state(0); // increment to trigger card re-animation

  async function navigateToDay(newDate: Date, force = false) {
    if (isAnimating && !force) return;
    selectedDate = newDate;
    dayKey++;
    await loadAppointments();
  }

  function nextDay(force = false) {
    if (isAnimating && !force) return;
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + 1);
    if (!$userSettings.showWeekend && (next.getDay() === 0 || next.getDay() === 6)) {
      next.setDate(next.getDate() + (next.getDay() === 6 ? 2 : 1));
    }
    navigateToDay(next, force);
  }

  function prevDay(force = false) {
    if (isAnimating && !force) return;
    const prev = new Date(selectedDate);
    prev.setDate(prev.getDate() - 1);
    if (!$userSettings.showWeekend && (prev.getDay() === 0 || prev.getDay() === 6)) {
      prev.setDate(prev.getDate() - (prev.getDay() === 0 ? 2 : 1));
    }
    navigateToDay(prev, force);
  }

  function nextWeek() {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + 7);
    navigateToDay(next);
  }

  function prevWeek() {
    const prev = new Date(selectedDate);
    prev.setDate(prev.getDate() - 7);
    navigateToDay(prev);
  }

  function goToToday() {
    navigateToDay(new Date());
  }

  async function handleDownload(bijlage: CalendarAttachment) {
    if (downloadingFile) return;
    try {
      const url = bijlage.Links?.find((l: Link) => l.Rel === 'Self')?.Href;
      if (!url) return;
      downloadingFile = bijlage.Naam;
      const downloadDir = $userSettings.downloadDir || '';
      const path = await downloadFile(url, bijlage.Naam, downloadDir);
      alert(`Bestand gedownload naar: ${path}`);
    } catch (e) {
      alert(`Download mislukt: ${e}`);
    } finally {
      downloadingFile = null;
    }
  }

  async function openDetail(app: DayItem) {
    if (app.displayType === 'break' || app.displayType === 'now') return;
    loadingDetail = true;
    showDetail = true;
    try {
      const pid = $personId;
      const eventId = app.Id;
      if (pid && eventId) {
        selectedAppointment = await getCalendarEvent(pid, eventId);
      } else {
        selectedAppointment = app;
      }
      // Apply local override even in detailed view
      if (selectedAppointment && localOverrides[selectedAppointment.Id]) {
          selectedAppointment.Inhoud = localOverrides[selectedAppointment.Id];
      }
      editContent = selectedAppointment?.Inhoud || '';
      editMode = false;
    } catch (e) {
      selectedAppointment = app as CalendarEvent;
      editContent = selectedAppointment?.Inhoud || '';
    } finally {
      loadingDetail = false;
    }
  }


  function saveLocalOverride() {
    const sel = selectedAppointment;
    if (!sel) return;
    localOverrides[sel.Id] = editContent;
    localStorage.setItem('calendar_overrides', JSON.stringify(localOverrides));
    sel.Inhoud = editContent;
    editMode = false;
    // Update main appointments array as well
    appointments = appointments.map(a => a.Id === sel.Id ? {...a, Inhoud: editContent} : a);
  }

  let createError = $state('');

  async function createAppointment() {
    const pid = $personId;
    if (!pid) return;
    createError = '';

    if (!newApp.omschrijving.trim()) {
      createError = 'Vul een omschrijving in.';
      return;
    }

    try {
      // Build start datetime: parse HH:MM or default to 09:00
      const startDate = new Date(selectedDate);
      startDate.setSeconds(0, 0);
      if (newApp.start && /^\d{2}:\d{2}$/.test(newApp.start)) {
        const [sh, sm] = newApp.start.split(':').map(Number);
        startDate.setHours(sh, sm);
      } else {
        startDate.setHours(9, 0);
      }

      const endDate = new Date(selectedDate);
      endDate.setSeconds(0, 0);
      if (newApp.einde && /^\d{2}:\d{2}$/.test(newApp.einde)) {
        const [eh, em] = newApp.einde.split(':').map(Number);
        endDate.setHours(eh, em);
      } else {
        endDate.setHours(startDate.getHours() + 1, startDate.getMinutes());
      }

      if (endDate <= startDate) {
        createError = 'Eindtijd moet na begintijd liggen.';
        return;
      }

      await createCalendarEvent({
        personId: pid,
        start: startDate.toISOString(),
        einde: endDate.toISOString(),
        duurtHeleDag: newApp.duurtHeleDag,
        omschrijving: newApp.omschrijving.trim(),
        lokatie: newApp.lokatie || undefined,
        inhoud: newApp.inhoud || undefined,
        eventType: 1 // Personal appointment
      });

      // Reset form
      newApp = { omschrijving: '', lokatie: '', inhoud: '', start: '', einde: '', duurtHeleDag: false };
      showTimeCalculator = false;
      isCreating = false;

      // Force a full reload so the new event appears
      loadedStart = null;
      loadedEnd = null;
      await loadAppointments(true);
    } catch (e) {
      console.error('Error creating appointment:', e);
      createError = `Fout bij aanmaken: ${e}`;
    }
  }

  let deletingAppointment = $state(false);

  async function deleteAppointment() {
    if (!selectedAppointment) return;
    const selfUrl = selectedAppointment.self_url
      || selectedAppointment.Links?.find((l: Link) => l.Rel === 'Self')?.Href?.replace('/api/', '');
    if (!selfUrl) {
      alert('Kan afspraak niet verwijderen: geen Self-URL gevonden.');
      return;
    }
    if (!confirm(`"${selectedAppointment.Omschrijving || 'Afspraak'}" verwijderen?`)) return;
    deletingAppointment = true;
    try {
      await deleteCalendarEvent(selfUrl);
      // Remove from local list immediately
      appointments = appointments.filter(a => a.Id !== selectedAppointment!.Id);
      selectedAppointment = null;
      editMode = false;
    } catch (e) {
      alert(`Verwijderen mislukt: ${e}`);
    } finally {
      deletingAppointment = false;
    }
  }

  async function toggleDone(app: DayAppointment) {
    try {
      // Find the app in appointments to ensure we have the latest ref
      const target = appointments.find(a => a.Id === app.Id);
      if (!target) return;
      
      await toggleCalendarEventDone(target);
      target.Afgerond = !target.Afgerond;
      appointments = [...appointments];
      if (selectedAppointment?.Id === target.Id) {
        selectedAppointment = { ...selectedAppointment, Afgerond: target.Afgerond };
      }
    } catch (e) {
      console.error('Error toggling done:', e);
    }
  }

  function getInfoColor(info: number) {
    if (info === 1) return 'border-primary-400/60 text-primary-200 bg-primary-500/25';
    if ([2, 3, 4, 5].includes(info)) return 'border-red-400/60 text-red-200 bg-red-500/25';
    return 'border-surface-600 text-gray-300 bg-surface-700/50';
  }

  function getInfoLabel(info: number) {
    if (info === 1) return 'Huiswerk';
    if (info === 2) return 'Toets';
    if (info === 3) return 'Tentamen';
    if (info === 4) return 'SO';
    if (info === 5) return 'Mondeling';
    return 'Afspraak';
  }

  const hiddenCancelledCount = $derived.by(() => {
    if (!$userSettings.hideCancelled) return 0;
    const currentDayStr = selectedDate.toDateString();
    return appointments.filter(a => {
      if (!a.Start) return false;
      const d = new Date(a.Start);
      const isToday = !isNaN(d.getTime()) && d.toDateString() === currentDayStr;
      const isCancelled = a.Status === 4 || a.Status === 5;
      return isToday && isCancelled;
    }).length;
  });

  // ===== Week view (desktop grid) =====
  const PX_PER_HOUR = 72;

  function minutesOf(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.getHours() * 60 + d.getMinutes();
  }

  function assignColumns(apps: CalendarEvent[]): WeekAppointment[] {
    const sorted = [...apps].sort((a, b) => {
      const sa = minutesOf(a.Start);
      const sb = minutesOf(b.Start);
      if (sa === null && sb === null) return 0;
      if (sa === null) return 1;
      if (sb === null) return -1;
      if (sa !== sb) return sa - sb;
      return (minutesOf(a.Einde) ?? sa + 50) - (minutesOf(b.Einde) ?? sb + 50);
    });

    const result: WeekAppointment[] = [];
    const clusters: { maxEnd: number; items: WeekAppointment[] }[] = [];

    for (const app of sorted) {
      const s = minutesOf(app.Start);
      if (s === null) {
        result.push({ ...app, _column: 0, _columnCount: 1 });
        continue;
      }
      const e = minutesOf(app.Einde) ?? s + 50;
      let cluster = clusters[clusters.length - 1];
      if (!cluster || s >= cluster.maxEnd) {
        cluster = { maxEnd: e, items: [] };
        clusters.push(cluster);
      } else {
        cluster.maxEnd = Math.max(cluster.maxEnd, e);
      }
      cluster.items.push({ ...app, _column: 0, _columnCount: 1 });
    }

    for (const cluster of clusters) {
      const lanes: number[] = [];
      for (const app of cluster.items) {
        const s = minutesOf(app.Start)!;
        const e = minutesOf(app.Einde) ?? s + 50;
        let lane = lanes.findIndex((end) => end <= s);
        if (lane === -1) {
          lane = lanes.length;
          lanes.push(e);
        } else {
          lanes[lane] = e;
        }
        app._column = lane;
      }
      for (const app of cluster.items) app._columnCount = lanes.length;
      result.push(...cluster.items);
    }
    return result;
  }

  const weekViewDays = $derived.by(() => {
    const d = new Date(selectedDate);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(d.setDate(diff));
    const length = $userSettings.showWeekend ? 7 : 5;

    return Array.from({ length }, (_, i) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + i);
      const dayStr = date.toDateString();

      let apps = appointments.filter(a => {
        if (!a.Start) return false;
        const ad = new Date(a.Start);
        return !isNaN(ad.getTime()) && ad.toDateString() === dayStr;
      });
      if ($userSettings.hideCancelled) {
        apps = apps.filter(a => a.Status !== 4 && a.Status !== 5);
      }

      return {
        date,
        isToday: dayStr === new Date().toDateString(),
        isSelected: dayStr === selectedDate.toDateString(),
        apps: assignColumns(apps)
      };
    });
  });

  // Replace weekData computation to reuse weekViewDays (keeps pill strip in sync)
  const weekData = $derived.by(() => weekViewDays.map(d => ({
    date: d.date,
    isToday: d.isToday,
    isSelected: d.isSelected,
    hasTest: d.apps.some(a => [2, 3, 4, 5].includes(a.InfoType)),
    hasHomework: d.apps.some(a => a.InfoType === 1 && !a.Afgerond)
  })));

  const grid = $derived.by(() => {
    let minH = 8;
    let maxH = 18;
    for (const day of weekViewDays) {
      for (const a of day.apps) {
        const s = minutesOf(a.Start);
        const e = minutesOf(a.Einde);
        if (s !== null) minH = Math.min(minH, Math.floor(s / 60));
        if (e !== null) maxH = Math.max(maxH, Math.ceil(e / 60));
      }
    }
    minH = Math.max(6, minH);
    maxH = Math.min(23, Math.max(18, maxH));
    const hours: number[] = [];
    for (let h = minH; h < maxH; h++) hours.push(h);
    return { minH, maxH, hours, heightPx: (maxH - minH) * PX_PER_HOUR };
  });

  function appTopPx(a: DayAppointment): number {
    const s = minutesOf(a.Start);
    if (s === null) return 0;
    return ((s - grid.minH * 60) / 60) * PX_PER_HOUR;
  }

  function appHeightPx(a: DayAppointment): number {
    const s = minutesOf(a.Start);
    const e = minutesOf(a.Einde);
    if (s === null) return 26;
    const dur = (e !== null ? e : s + 50) - s;
    return Math.max(24, Math.round((dur / 60) * PX_PER_HOUR) - 3);
  }

  const weekAppCount = $derived(weekViewDays.reduce((sum, d) => sum + d.apps.length, 0));

  const weekLabel = $derived.by(() => {
    if (weekViewDays.length === 0) return '';
    const first = weekViewDays[0].date;
    const last = weekViewDays[weekViewDays.length - 1].date;
    const f = first.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
    const l = last.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
    return `${f} – ${l}`;
  });

  const nowMinutes = $derived.by(() => {
    const d = now;
    return d.getHours() * 60 + d.getMinutes();
  });

  // Swipe handling with live drag tracking
  let touchStartX = 0;
  let touchStartY = 0;
  let isDragging = $state(false);
  let isHorizontalSwipe = false;
  let swipeOrigin: 'day-bar' | 'content' = 'content';

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isDragging = false;
    isHorizontalSwipe = false;
    swipeOrigin = (e.target as Element).closest?.('[data-daybar]') ? 'day-bar' : 'content';
  }

  function handleTouchMove(e: TouchEvent) {
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    
    // Determine swipe axis on first significant movement
    if (!isDragging && Math.hypot(dx, dy) > 5) {
      isHorizontalSwipe = Math.abs(dx) > Math.abs(dy) * 1.5;
      isDragging = true;
    }

    if (isHorizontalSwipe) {
      e.preventDefault();
      swipeOffset = dx;
    }
  }

  function handleTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (isHorizontalSwipe && Math.abs(dx) > 40) {
      // Slide all the way out
      swipeOffset = dx > 0 ? window.innerWidth : -window.innerWidth;
      isAnimating = true;
      // Navigate while off-screen, then snap back from opposite side
      setTimeout(() => {
        if (swipeOrigin === 'day-bar' || showWeekView) {
          // Week navigation does not accept a force flag, so release the
          // animation guard before entering navigateToDay().
          isAnimating = false;
          if (dx > 0) prevWeek(); else nextWeek();
        } else {
          if (dx > 0) prevDay(true); else nextDay(true);
        }

        // Disable transitions for the jump to the opposite side
        noTransition = true;
        swipeOffset = dx > 0 ? -window.innerWidth * 0.3 : window.innerWidth * 0.3;

        // Re-enable transitions and spring back in
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            noTransition = false;
            swipeOffset = 0;
            isAnimating = false;
          });
        });
      }, 200);
    } else {
      // Spring back
      swipeOffset = 0;
    }
    isDragging = false;
  }

  function swipeGesture(node: HTMLDivElement) {
    const removeTouchStart = on(node, 'touchstart', handleTouchStart, { passive: false });
    const removeTouchMove = on(node, 'touchmove', handleTouchMove, { passive: false });
    const removeTouchEnd = on(node, 'touchend', handleTouchEnd, { passive: false });

    return {
      destroy() {
        removeTouchStart();
        removeTouchMove();
        removeTouchEnd();
      }
    };
  }

</script>

<div use:swipeGesture class="flex flex-col h-full bg-surface-950" role="application">
  <!-- Header Section — compact on mobile (Agenda title removed, date moved up) -->
  <header class="sticky top-0 z-20 bg-surface-950/90 backdrop-blur-xl border-b border-surface-800/30 px-3 py-2 md:px-4 md:py-2.5">
    <!-- Single top row: date (replaces Agenda) + actions -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <label class="flex flex-col relative cursor-pointer group min-w-0 shrink">
          <input 
            type="date" 
            class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            style="color-scheme: dark;"
            value={selectedDate.toISOString().split('T')[0]}
            onchange={(e) => { 
              if (e.currentTarget.value) {
                selectedDate = new Date(e.currentTarget.value); 
                loadAppointments(); 
              }
            }}
          />
          {#if showWeekView}
            <p class="text-label-small text-primary-400 group-hover:text-primary-300 transition-colors leading-none truncate">
              Weekoverzicht
            </p>
            <h2 class="text-title-medium md:text-headline-small text-white leading-tight group-hover:text-gray-200 transition-colors truncate">
              {weekLabel}
            </h2>
          {:else}
            <p class="text-label-small text-primary-400 group-hover:text-primary-300 transition-colors leading-none truncate">
              {selectedDate.toLocaleDateString('nl-NL', { month: 'long' })}
            </p>
            <h2 class="text-title-medium md:text-headline-small text-white leading-tight group-hover:text-gray-200 transition-colors truncate">
              {selectedDate.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric' })}
            </h2>
          {/if}
        </label>
        <IconButton
          onclick={() => { appointments = []; loadedStart = null; loadedEnd = null; loadAppointments(true); }}
          class="hover:rotate-180 duration-500 shrink-0"
          title="Verversen"
          aria-label="Verversen"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </IconButton>
        <IconButton
          onclick={() => $userSettings.hideCancelled = !$userSettings.hideCancelled}
          class="{$userSettings.hideCancelled ? 'text-gray-600' : 'text-primary-400'} hover:text-primary-300 shrink-0"
          title={$userSettings.hideCancelled ? 'Uitgevallen lessen tonen' : 'Uitgevallen lessen verbergen'}
        >
          {#if $userSettings.hideCancelled}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"/></svg>
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          {/if}
        </IconButton>
        <IconButton
          onclick={() => $userSettings.weekView = showWeekView ? 'off' : 'on'}
          class="{showWeekView ? 'text-primary-400' : 'text-gray-500'} hover:text-primary-300 shrink-0"
          title={showWeekView ? 'Naar dagweergave' : 'Naar weekweergave'}
          aria-label={showWeekView ? 'Naar dagweergave' : 'Naar weekweergave'}
        >
          {#if showWeekView}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="10" x2="9" y2="20"/><line x1="15" y1="10" x2="15" y2="20"/></svg>
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/><circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none"/></svg>
          {/if}
        </IconButton>
        <IconButton
          onclick={() => $userSettings.compactView = !$userSettings.compactView}
          class="{$userSettings.compactView ? 'text-primary-400' : 'text-gray-500'} hover:text-primary-300 shrink-0"
          title={$userSettings.compactView ? 'Normale weergave' : 'Compacte weergave'}
          aria-label={$userSettings.compactView ? 'Normale weergave' : 'Compacte weergave'}
        >
          {#if $userSettings.compactView}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="5" x2="20" y2="5"/><line x1="4" y1="10" x2="20" y2="10"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="4" y1="20" x2="20" y2="20"/></svg>
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
          {/if}
        </IconButton>
        <!-- Desktop week nav moved here to avoid extra row -->
        <div class="hidden md:flex items-center bg-surface-900 rounded-m3-sm p-0.5 border border-white/5 shrink-0 ml-1">
          <IconButton size="sm" onclick={prevWeek} class="w-8! h-8!" title="Vorige week">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </IconButton>
          <div class="h-3 w-px bg-surface-700 mx-0.5"></div>
          <IconButton size="sm" onclick={nextWeek} class="w-8! h-8!" title="Volgende week">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </IconButton>
        </div>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <IconButton
          onclick={() => isCreating = true}
          aria-label="Nieuwe afspraak toevoegen"
          class="bg-primary-500/15! border! border-primary-500/25! text-primary-400 hover:bg-primary-500/25!"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </IconButton>
        <Button
          variant="tonal"
          onclick={goToToday}
          class="px-4 h-8!"
        >
          Vandaag
        </Button>
      </div>
    </div>

    <!-- Quick Week Picker — smaller pills (day view only; week grid shows its own day columns) -->
    <div data-daybar class="{showWeekView ? 'hidden' : ''} mt-2 flex justify-between gap-1 overflow-x-auto no-scrollbar" style="touch-action: pan-y;">
      {#each weekData as { date, isToday, isSelected, hasTest, hasHomework }}
        <button
          onclick={() => { selectedDate = new Date(date); loadAppointments(); }}
          class="flex-1 flex flex-col items-center py-1.5 px-0.5 rounded-m3-sm transition-all border min-w-[38px] relative {isSelected ? 'bg-primary-500 border-primary-400 text-white shadow-md shadow-primary-500/25' : 'bg-surface-800/60 border-white/5 text-gray-400 hover:bg-surface-700 hover:text-gray-200'}"
        >
          <span class="text-label-small opacity-60">
            {date.toLocaleDateString('nl-NL', { weekday: 'short' }).slice(0, 2)}
          </span>
          <span class="text-title-small leading-none">{date.getDate()}</span>
          
          <div class="flex gap-0.5 mt-0.5">
            {#if hasTest}
               <div class="w-1 h-1 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]"></div>
            {:else if hasHomework}
              <div class="w-1 h-1 rounded-full bg-primary-400 shadow-[0_0_6px_rgba(var(--color-primary-400),0.6)]"></div>
            {:else if isToday && !isSelected}
              <div class="w-1 h-1 rounded-full bg-primary-500 animate-pulse"></div>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  </header>

  <!-- Main Content -->
  <main 
    class="flex-1 overflow-y-auto p-2 md:p-3 space-y-2 md:space-y-3 custom-scrollbar"
    style="transform: translateX({swipeOffset}px); transition: {isDragging || noTransition ? 'none' : 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)'}; will-change: transform; touch-action: pan-y;"
  >
    {#if hiddenCancelledCount > 0 && !loading}
      <div class="bg-red-500/10 border border-red-500/20 rounded-m3-md p-2.5 md:p-3 flex items-center justify-between mb-2" transition:slide>
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-m3-sm bg-red-500/20 text-red-400 flex items-center justify-center shrink-0">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </div>
          <div>
            <p class="text-label-medium text-red-400">{hiddenCancelledCount} les{hiddenCancelledCount !== 1 ? 'sen' : ''} uitgevallen</p>
            <p class="text-label-small text-gray-500">Zijn momenteel verborgen</p>
          </div>
        </div>
        <Button
          variant="tonal"
          onclick={() => $userSettings.hideCancelled = false}
          class="px-4 h-8! bg-surface-800! text-gray-300! hover:text-white! hover:bg-surface-700!"
        >
          Tonen
        </Button>
      </div>
    {/if}

    {#if loading}
      <div class="flex flex-col items-center justify-center py-16 gap-3">
        <div class="w-10 h-10 border-3 border-primary-500 border-t-transparent rounded-full animate-spin shadow-[0_0_20px_rgba(var(--color-primary-500),0.3)]"></div>
        <p class="text-label-medium text-gray-600 animate-pulse">Lessen ophalen...</p>
      </div>
    {:else if showWeekView}
      {#if weekAppCount === 0}
        <div class="flex-1 flex flex-col items-center justify-center py-16 text-center space-y-4">
          <div class="w-20 h-20 rounded-full bg-surface-800/80 border border-surface-700/50 flex items-center justify-center">
            <svg class="w-8 h-8 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M18 22 13 17l-3 3-5-5"/></svg>
          </div>
          <div>
            <h3 class="text-headline-small text-white mb-1">Geen lessen deze week</h3>
            <p class="text-body-medium text-gray-500 max-w-[200px] leading-relaxed">
              Geniet van je vrije week!
            </p>
          </div>
        </div>
      {:else if isDesktop}
        <div class="md:rounded-m3-lg md:border border-surface-800/40 overflow-hidden">
          <div class="overflow-x-auto custom-scrollbar">
            <div class="min-w-full flex">
              <!-- Time gutter -->
              <div class="w-16 shrink-0 flex flex-col">
                <!-- Corner spacer -->
                <div class="shrink-0 h-[52px] border-b border-surface-800/40 bg-surface-900/40"></div>
                <!-- Hour labels -->
                <div class="relative" style="height: {grid.heightPx}px;">
                  {#each grid.hours as h}
                    <div class="absolute right-2 -translate-y-1/2 text-label-medium text-gray-500 tabular-nums" style="top: {(h - grid.minH) * PX_PER_HOUR}px;">
                      {String(h).padStart(2, '0')}:00
                    </div>
                  {/each}
                </div>
              </div>

              <!-- Day columns -->
              {#each weekViewDays as day}
                <div class="flex-1 min-w-[140px] border-l border-surface-800/30">
                  <!-- Day header -->
                  <button
                    onclick={() => { selectedDate = new Date(day.date); loadAppointments(); }}
                    class="w-full flex flex-col items-center justify-center gap-0.5 h-[52px] border-b border-surface-800/40 transition-colors {day.isSelected ? 'bg-primary-container text-on-primary-container' : day.isToday ? 'bg-primary-500/10' : 'bg-surface-900/40 hover:bg-surface-800/40'}"
                  >
                    <span class="text-label-medium {day.isSelected ? 'text-on-primary-container' : 'text-gray-500'}">
                      {day.date.toLocaleDateString('nl-NL', { weekday: 'short' })}
                    </span>
                    <span class="text-title-medium {day.isSelected ? 'text-on-primary-container' : 'text-white'} leading-none">
                      {day.date.getDate()}
                    </span>
                    <span class="flex gap-0.5 h-1">
                      {#if day.apps.some(a => [2, 3, 4, 5].includes(a.InfoType))}
                        <span class="w-1 h-1 rounded-full bg-red-500"></span>
                      {:else if day.apps.some(a => a.InfoType === 1 && !a.Afgerond)}
                        <span class="w-1 h-1 rounded-full bg-primary-400"></span>
                      {/if}
                    </span>
                  </button>

                  <!-- Time column -->
                  <div class="relative" style="height: {grid.heightPx}px;">
                    <!-- Hour grid lines -->
                    {#each grid.hours as h}
                      <div class="absolute left-0 right-0 border-t border-surface-800/30 pointer-events-none" style="top: {(h - grid.minH) * PX_PER_HOUR}px;"></div>
                    {/each}

                    <!-- Today highlight -->
                    {#if day.isToday}
                      <div class="absolute inset-0 bg-primary-500/5 pointer-events-none"></div>
                    {/if}

                    <!-- Now indicator -->
                    {#if day.isToday && nowMinutes >= grid.minH * 60 && nowMinutes <= grid.maxH * 60}
                      <div class="absolute left-0 right-0 z-10 pointer-events-none" style="top: {((nowMinutes - grid.minH * 60) / 60) * PX_PER_HOUR}px;">
                        <div class="h-0.5 bg-red-500 rounded-full relative">
                          <div class="absolute -left-1 -top-[4px] w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></div>
                        </div>
                      </div>
                    {/if}

                    <!-- Appointments -->
                    {#each day.apps as app}
                      <button
                        onclick={() => openDetail(app)}
                        class="absolute rounded-m3-sm border px-2 py-1.5 text-left overflow-hidden transition-all active:scale-[0.98] hover:brightness-125 cursor-pointer {app.InfoType === 1 && app.Afgerond! ? 'bg-primary-500/15 border-primary-500/30' : app.Status === 4 || app.Status === 5 ? 'bg-red-500/10 border-red-500/30' : app.Afgerond ? 'bg-surface-800/50 border-surface-700/40 opacity-70' : 'bg-surface-800/80 border-surface-700/50 hover:bg-surface-700/70'}"
                        style="top: {appTopPx(app)}px; height: {appHeightPx(app)}px; left: calc({app._column} / {app._columnCount} * 100% + 4px); width: calc(100% / {app._columnCount} - 8px);"
                        title="{(app.Vakken?.[0]?.Naam || app.Omschrijving || 'Vrij')} · {formatTime(app.Start)} – {formatTime(app.Einde)}"
                      >
                        <div class="flex flex-col min-w-0 h-full">
                          <p class="text-title-small leading-tight truncate {app.Status === 4 || app.Status === 5 ? 'text-red-400 line-through' : app.Afgerond ? 'text-gray-400 line-through' : 'text-white'}">
{app.Vakken?.[0]?.Naam || app.Omschrijving || 'Vrij'}
                          </p>
                          <div class="flex items-center gap-1 text-label-medium text-gray-400 mt-0.5">
                            <span class="tabular-nums shrink-0">{formatTime(app.Start)}</span>
                            {#if app.Lokatie}
                              <span class="truncate">· {app.Lokatie}</span>
                            {/if}
                          </div>
                        </div>
                        {#if app.InfoType === 1 && !app.Afgerond}
                          <div class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary-400"></div>
                        {:else if [2, 3, 4, 5].includes(app.InfoType)}
                          <div class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500"></div>
                        {/if}
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          {#each weekViewDays as day}
            <div class="rounded-m3-md overflow-hidden border {day.isToday ? 'border-primary-500/40 bg-primary-500/5' : 'border-surface-800/40 bg-surface-900/30'}">
              <button
                onclick={() => { selectedDate = new Date(day.date); loadAppointments(); }}
                class="w-full flex items-center justify-between px-3 py-2 {day.isToday ? 'bg-primary-500/10' : 'bg-surface-900/50'}"
              >
                <span class="flex items-center gap-2">
                  <span class="text-label-medium {day.isToday ? 'text-primary-300' : 'text-gray-500'}">
                    {day.date.toLocaleDateString('nl-NL', { weekday: 'long' })}
                  </span>
                  <span class="text-title-small {day.isToday ? 'text-white' : 'text-gray-300'}">{day.date.getDate()}</span>
                </span>
                {#if day.isToday}
                  <span class="text-label-small text-primary-400 px-2 py-0.5 rounded-m3-full bg-primary-500/15">Vandaag</span>
                {/if}
              </button>
              <div class="divide-y divide-surface-800/40">
                {#each day.apps as app}
                  <button
                    onclick={() => openDetail(app)}
                    class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-800/40 transition-colors"
                  >
                    <span class="text-label-small tabular-nums {app.Status === 4 || app.Status === 5 ? 'text-red-400' : 'text-primary-300'} w-10 shrink-0">{formatTime(app.Start)}</span>
                    <span class="flex-1 min-w-0 text-title-small truncate {app.Status === 4 || app.Status === 5 ? 'text-red-400 line-through' : 'text-white'}">{app.Vakken?.[0]?.Naam || app.Omschrijving || 'Vrij'}</span>
                    {#if app.Lokatie}
                      <span class="text-label-small text-gray-500 shrink-0">{app.Lokatie}</span>
                    {/if}
                  </button>
                {:else}
                  <p class="px-3 py-2.5 text-label-small text-gray-600">Geen lessen</p>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if dayAppointments.length === 0}
      <div class="flex-1 flex flex-col items-center justify-center py-16 text-center space-y-4">
        <div class="w-20 h-20 rounded-full bg-surface-800/80 border border-surface-700/50 flex items-center justify-center">
          <svg class="w-8 h-8 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M18 22 13 17l-3 3-5-5"/></svg>
        </div>
        <div>
          <h3 class="text-headline-small text-white mb-1">Geen lessen gepland</h3>
          <p class="text-body-medium text-gray-500 max-w-[200px] leading-relaxed">
            Geniet van je vrije dag!
          </p>
        </div>
      </div>
    {:else}
      {#each dayAppointments as app, i}
        {#if app.displayType === 'break'}
          <div class="flex items-center gap-3 px-4 py-1 opacity-40 group hover:opacity-100 transition-opacity">
            <div class="w-8 flex flex-col items-center">
              <div class="h-3 w-0.5 bg-surface-700"></div>
            </div>
            <div class="flex-1 flex items-center gap-2">
              <div class="h-[1px] flex-1 bg-gradient-to-r from-surface-700 to-transparent"></div>
              <span class="text-label-small text-gray-500 whitespace-nowrap">
                {app.Duration} min pauze
              </span>
              <div class="h-[1px] flex-1 bg-gradient-to-l from-surface-700 to-transparent"></div>
            </div>
          </div>
        {:else if app.displayType === 'now'}
            <div class="flex items-center gap-2 px-1" aria-hidden="true">
              <span class="w-2 h-2 rounded-full bg-red-500 shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></span>
              <div class="h-0.5 flex-1 bg-red-500 rounded-full"></div>
              <span class="text-label-small text-red-400 tabular-nums shrink-0">Nu · {formatTime(now.toISOString())}</span>
            </div>
        {:else}
          <div
            role="button"
            tabindex="0"
            onclick={() => openDetail(app)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(app); } }}
            in:fly={{ y: 12, duration: 200, delay: i * 20, easing: (t) => 1 - Math.pow(1-t, 3) }}
            class="w-full text-left rounded-m3-md {$userSettings.compactView ? 'p-2 flex gap-2' : 'p-3 md:p-4 flex gap-3 md:gap-4'} transition-all active:scale-[0.98] hover:scale-[1.005] relative overflow-hidden cursor-pointer border {app.InfoType === 1 && app.Afgerond! ? 'bg-primary-500/10 border-primary-500/30 shadow-sm shadow-primary-500/10' : app.Status === 4 || app.Status === 5 ? 'bg-red-500/8 border-red-500/30' : app.Afgerond ? 'bg-surface-800/50 border-surface-700/40 opacity-70' : 'bg-surface-800/60 border-surface-700/40 hover:bg-surface-700/60 hover:border-surface-600/50'}"
          >
            <!-- Soft background glow -->
            {#if app.InfoType === 1 && !app.Afgerond}
              <div class="absolute top-0 right-0 w-24 h-24 bg-primary-500/10 blur-2xl -mr-12 -mt-12 pointer-events-none"></div>
            {/if}
            
            <!-- Time/Period -->
            <div class="flex flex-col items-center justify-center min-w-[36px] md:min-w-[42px] gap-0.5 relative z-10">
              <span class="text-label-small {app.Status === 4 || app.Status === 5 ? 'text-red-400' : 'text-primary-400'}">
                {app.IsCombined ? 'Uren' : 'Les'}
              </span>
              <span class="{$userSettings.compactView ? 'text-title-medium' : 'text-title-large'} {app.Status === 4 || app.Status === 5 ? 'text-red-400' : 'text-white'} leading-none">{app.Lesuur}</span>
              <div class="h-px w-4 {app.Status === 4 || app.Status === 5 ? 'bg-red-500/30' : 'bg-surface-600'} my-0.5"></div>
              <span class="text-label-small {app.Status === 4 || app.Status === 5 ? 'text-red-400/70' : 'text-primary-300/80'}">{formatTime(app.Start)}</span>
            </div>

            <!-- Vertical Divider -->
            <div class="w-px {app.Status === 4 || app.Status === 5 ? 'bg-red-500/20' : 'bg-surface-600/50'} my-1"></div>

            <!-- Info -->
            <div class="flex-1 min-w-0 flex flex-col justify-center relative z-10">
              <div class="flex items-center justify-between gap-1.5 mb-0.5">
                <span class="text-title-medium {app.Status === 4 || app.Status === 5 ? 'text-red-400 line-through' : 'text-white'} truncate">
                  {app.Vakken?.[0]?.Naam || app.Omschrijving || 'Vrij'}
                </span>
                {#if app.Docenten?.[0] && !$userSettings.compactView}
                  <span class="text-label-small text-gray-500 shrink-0 bg-surface-900/60 px-1.5 py-0.5 rounded-m3-sm border border-white/5">
                    {app.Docenten[0].Naam}
                  </span>
                {/if}
              </div>

              <div class="flex items-center gap-2.5 text-label-small {app.Status === 4 || app.Status === 5 ? 'text-red-400/60' : 'text-gray-400'}">
                <div class="flex items-center gap-1">
                  <svg class="w-2.5 h-2.5 md:w-3 md:h-3 currentcolor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                  <span class="truncate">{app.Lokatie || '—'}</span>
                </div>
                <div class="flex items-center gap-1">
                  <svg class="w-2.5 h-2.5 md:w-3 md:h-3 currentcolor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                  <span>Tot {formatTime(app.Einde)}</span>
                </div>
              </div>

              {#if app.Status === 4 || app.Status === 5}
                <div class="mt-1.5 flex">
                  <span class="px-2 py-0.5 rounded-m3-sm text-label-small border border-red-500/40 text-red-400 bg-red-500/10">
                    Uitgevallen
                  </span>
                </div>
              {:else if app.InfoType && app.InfoType !== 0}
                <div class="mt-1.5 flex">
                  <span class="px-2 py-0.5 rounded-m3-sm text-label-small border {getInfoColor(app.InfoType)}">
                    {getInfoLabel(app.InfoType)}
                  </span>
                </div>
              {/if}

              {#if app.Aantekening && !$userSettings.compactView}
                <div class="mt-1.5 text-body-small text-gray-500 bg-surface-900/50 p-1.5 rounded-m3-sm border border-white/5 line-clamp-1">
                  {app.Aantekening}
                </div>
              {/if}
            </div>

            <!-- Status Indicators -->
            <div class="flex flex-col items-center justify-center gap-1.5 shrink-0 relative z-10">
              {#if app.InfoType === 1}
                <button 
                  onclick={(e) => { e.stopPropagation(); toggleDone(app); }}
                  aria-label={app.Afgerond ? 'Markeer als niet afgerond' : 'Markeer als afgerond'}
                  class="w-7 h-7 md:w-8 md:h-8 rounded-full border-2 transition-all flex items-center justify-center {app.Afgerond ? 'bg-emerald-500 border-emerald-400 text-white shadow-sm shadow-emerald-500/30' : 'bg-surface-900 border-surface-600 text-transparent hover:border-primary-500 hover:bg-surface-800 active:scale-110'}"
                >
                  <svg class="w-3.5 h-3.5 md:w-4 md:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M20 6L9 17L4 12"/></svg>
                </button>
              {:else if app.Status === 4 || app.Status === 5} <!-- Cancelled -->
                <div class="w-6 h-6 md:w-7 md:h-7 rounded-full bg-red-500/20 border border-red-400/40 flex items-center justify-center text-red-400">
                  <svg class="w-3 h-3 md:w-3.5 md:h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </div>
              {:else if app.Inhoud || app.HeeftBijlagen} <!-- Content or Attachments present -->
                 <div class="w-6 h-6 md:w-7 md:h-7 rounded-full bg-surface-800 border border-surface-600/50 flex items-center justify-center text-gray-500">
                  <svg class="w-3 h-3 md:w-3.5 md:h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    {#if app.HeeftBijlagen}
                      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.51a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    {:else}
                      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>
                    {/if}
                  </svg>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {/each}

    {/if}
  </main>
</div>

<!-- Appointment Detail Drawer -->
{#if selectedAppointment}
  <div class="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-6" transition:fade={{ duration: 150 }}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div role="presentation" class="absolute inset-0 bg-black/70 backdrop-blur-sm" onclick={() => { selectedAppointment = null; editMode = false; }}></div>
    
    <div 
      class="relative w-full max-w-lg elevation-3 border-t md:border border-white/10 rounded-t-m3-xl md:rounded-m3-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] z-10"
      transition:fly={{ y: 30, duration: 300, easing: (t) => 1 - Math.pow(1 - t, 3) }}
    >
      <!-- Top Handle -->
      <div class="md:hidden flex justify-center py-2">
        <div class="w-8 h-1 rounded-full bg-surface-600"></div>
      </div>

      <div class="p-4 md:p-7 overflow-y-auto custom-scrollbar space-y-4 md:space-y-6">
        <!-- Title area -->
        <div class="space-y-2 md:space-y-3">
          <div class="flex items-center justify-between">
             <span class="px-2 py-0.5 rounded-m3-sm text-label-small border {getInfoColor(selectedAppointment.InfoType)}">
              {getInfoLabel(selectedAppointment.InfoType)}
            </span>
            <div class="flex items-center gap-1.5">
              <IconButton
                onclick={() => editMode = !editMode}
                class="bg-surface-800! text-gray-400 hover:text-white!"
                title="Bewerken"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
              </IconButton>
              {#if selectedAppointment.Type === 1}
                <IconButton
                  onclick={deleteAppointment}
                  disabled={deletingAppointment}
                  class="bg-red-500/10! text-red-400! hover:bg-red-500/20! hover:text-red-300! disabled:opacity-50!"
                  title="Afspraak verwijderen"
                >
                  {#if deletingAppointment}
                    <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>
                  {/if}
                </IconButton>
              {/if}
              <IconButton onclick={() => { selectedAppointment = null; editMode = false; }} aria-label="Sluiten">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </IconButton>
            </div>
          </div>
          <h2 class="text-headline-medium text-white leading-tight">
            {selectedAppointment.Vakken?.[0]?.Naam || selectedAppointment.Omschrijving || 'Vrij'}
          </h2>
          <div class="flex flex-wrap gap-1.5 md:gap-2">
            <span class="flex items-center gap-1.5 text-label-small text-gray-300 bg-surface-800/80 px-2 py-1 rounded-m3-sm border border-white/5">
              <svg class="w-2.5 h-2.5 md:w-3 md:h-3 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {selectedAppointment.Docenten?.[0]?.Naam || 'Geen docent'}
            </span>
            <span class="flex items-center gap-1.5 text-label-small text-gray-300 bg-surface-800/80 px-2 py-1 rounded-m3-sm border border-white/5">
              <svg class="w-2.5 h-2.5 md:w-3 md:h-3 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
              {selectedAppointment.Lokatie || 'Onbekend'}
            </span>
          </div>
        </div>

        <!-- Times and Details -->
        <div class="grid grid-cols-2 gap-2 md:gap-3">
          <div class="bg-surface-800/50 p-2.5 md:p-3 rounded-m3-sm border border-white/5">
            <p class="text-label-small text-gray-500 mb-0.5">Begin</p>
            <p class="text-title-large text-white">{formatTime(selectedAppointment.Start)}</p>
          </div>
          <div class="bg-surface-800/50 p-2.5 md:p-3 rounded-m3-sm border border-white/5">
            <p class="text-label-small text-gray-500 mb-0.5">Einde</p>
            <p class="text-title-large text-white">{formatTime(selectedAppointment.Einde)}</p>
          </div>
        </div>

        <div class="space-y-3">
          <h3 class="text-label-medium text-gray-100 flex items-center gap-2">
            <div class="w-1 h-3 bg-primary-500 rounded-full"></div>
            Huiswerk & Inhoud
          </h3>
          {#if editMode}
            <div class="space-y-2 md:space-y-3" in:slide>
              <textarea
                bind:value={editContent}
                class="w-full h-32 md:h-40 bg-surface-950 border border-primary-500/30 rounded-m3-xs p-3 md:p-4 text-body-large text-gray-200 focus:outline-none focus:border-primary-500 transition-colors"
                placeholder="Huiswerk bewerken..."
              ></textarea>
              <Button
                variant="filled"
                onclick={saveLocalOverride}
                class="w-full"
              >
                Opslaan (Lokaal)
              </Button>
            </div>
          {:else if selectedAppointment.Inhoud}
             {#if selectedAppointment.InfoType === 1}
               <Button
                variant="filled"
                onclick={() => toggleDone(selectedAppointment!)}
                class="w-full mb-3 {selectedAppointment.Afgerond ? 'bg-emerald-500/10! text-emerald-400! border-2 border-emerald-500/50!' : 'bg-primary-500! text-white! shadow-md shadow-primary-500/20'}"
              >
                <div class="w-5 h-5 rounded-full border-2 border-current flex items-center justify-center">
                  {#if selectedAppointment.Afgerond}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M20 6L9 17L4 12"/></svg>
                  {/if}
                </div>
                <span class="text-label-large">
                  {selectedAppointment.Afgerond ? 'Huiswerk voltooid' : 'Markeren als klaar'}
                </span>
              </Button>
             {/if}
            <div class="p-4 md:p-5 rounded-m3-md bg-surface-950 border border-white/5 prose prose-sm prose-invert max-w-none shadow-inner">
               <HtmlRenderer html={selectedAppointment.Inhoud} />
            </div>
          {:else}
            <p class="text-body-medium text-gray-600 px-1">Geen inhoud beschikbaar.</p>
          {/if}
        </div>

        {#if selectedAppointment.Aantekening && !editMode}
          <div class="space-y-1.5 md:space-y-2">
            <h3 class="text-label-medium text-gray-100 flex items-center gap-2">
              <div class="w-1 h-2.5 md:h-3 bg-accent-500 rounded-full"></div>
              Aantekening
            </h3>
            <div class="p-3 md:p-4 rounded-m3-md bg-surface-950 border border-white/5 text-body-medium text-gray-500 leading-relaxed">
              {selectedAppointment.Aantekening}
            </div>
          </div>
        {/if}
        {#if selectedAppointment.Bijlagen && selectedAppointment.Bijlagen.length > 0}
          <div class="space-y-2 md:space-y-3 pb-2 md:pb-4">
            <h3 class="text-label-medium text-gray-100 flex items-center gap-2">
              <div class="w-1 h-2.5 md:h-3 bg-blue-500 rounded-full"></div>
              Bijlagen ({selectedAppointment.Bijlagen.length})
            </h3>
            <div class="grid gap-1.5 md:gap-2">
              {#each selectedAppointment.Bijlagen as bijlage}
                <div class="flex items-center justify-between p-2.5 md:p-3 rounded-m3-md bg-surface-950 border border-white/5 transition-all hover:border-white/10 group">
                  <div class="flex items-center gap-2.5 md:gap-3 overflow-hidden">
                    <div class="w-7 h-7 md:w-8 md:h-8 rounded-m3-sm bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                      <svg class="w-3.5 h-3.5 md:w-4 md:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.51a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    </div>
                    <div class="flex flex-col min-w-0">
                      <span class="text-body-medium text-gray-200 truncate">{bijlage.Naam}</span>
                      <span class="text-label-small text-gray-600">{bijlage.Grootte ? Math.round(bijlage.Grootte / 1024) + ' KB' : '—'}</span>
                    </div>
                  </div>
                  <IconButton
                    onclick={() => handleDownload(bijlage)}
                    disabled={downloadingFile === bijlage.Naam}
                    class="bg-surface-800! text-gray-400 hover:text-white! hover:bg-surface-700! disabled:opacity-50!"
                    aria-label="Download"
                  >
                    {#if downloadingFile === bijlage.Naam}
                      <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    {:else}
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    {/if}
                  </IconButton>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      
      <!-- Footer Button (Close) -->
      <div class="p-3 pt-0 shrink-0 md:hidden">
        <Button 
          variant="tonal"
          onclick={() => { showDetail = false; selectedAppointment = null; editMode = false; }}
          class="w-full"
        >
          Sluiten
        </Button>
      </div>
    </div>
  </div>
{/if}


<!-- New Appointment Modal -->
{#if isCreating}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-4" transition:fade={{ duration: 150 }}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div role="presentation" class="absolute inset-0 bg-black/80 backdrop-blur-sm" onclick={() => isCreating = false}></div>
    
    <div 
      class="relative w-full max-w-md elevation-3 border border-white/10 rounded-m3-xl shadow-2xl overflow-hidden flex flex-col z-10"
      transition:scale={{ start: 0.95, duration: 250 }}
    >
      <div class="p-4 md:p-6 space-y-4 md:space-y-6">
        <div class="flex items-center justify-between">
          <h2 class="text-title-large text-white">Nieuwe Afspraak</h2>
          <IconButton onclick={() => isCreating = false} aria-label="Sluiten">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </IconButton>
        </div>

        <div class="space-y-3 md:space-y-4">
          <div class="space-y-1">
            <label for="newAppOmschrijving" class="text-label-medium text-gray-500 ml-1">Omschrijving</label>
            <input 
              id="newAppOmschrijving"
              bind:value={newApp.omschrijving}
              type="text" 
              class="w-full bg-surface-950 border border-white/5 rounded-m3-xs px-3 md:px-4 py-2.5 md:py-3 text-body-large text-white focus:outline-none focus:border-primary-500/50 transition-colors"
              placeholder="Bijv. Projectoverleg"
            />
          </div>

            <div>
              <button
                type="button"
                onclick={() => showTimeCalculator = !showTimeCalculator}
                class="text-label-medium text-primary-400 hover:text-primary-300 ml-1 flex items-center gap-1"
              >
                <svg class="w-3 h-3 transition-transform {showTimeCalculator ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                Tijd berekenen
              </button>

              {#if showTimeCalculator}
                <div class="mt-2 p-3 rounded-m3-sm bg-surface-950 border border-white/5 space-y-3" transition:slide={{ duration: 200 }}>
                  <div class="flex gap-1.5">
                    <button type="button" onclick={() => calcMode = 'lopen'} class="flex-1 py-1.5 rounded-m3-xs text-label-medium border transition-colors {calcMode === 'lopen' ? 'bg-primary-500/15 border-primary-500/40 text-primary-400' : 'bg-surface-900 border-white/5 text-gray-500'}">Lopen</button>
                    <button type="button" onclick={() => calcMode = 'fiets'} class="flex-1 py-1.5 rounded-m3-xs text-label-medium border transition-colors {calcMode === 'fiets' ? 'bg-primary-500/15 border-primary-500/40 text-primary-400' : 'bg-surface-900 border-white/5 text-gray-500'}">Fiets</button>
                    <button type="button" onclick={() => calcMode = 'auto'} class="flex-1 py-1.5 rounded-m3-xs text-label-medium border transition-colors {calcMode === 'auto' ? 'bg-primary-500/15 border-primary-500/40 text-primary-400' : 'bg-surface-900 border-white/5 text-gray-500'}">Auto</button>
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    <div class="space-y-1">
                      <label for="calcTravel" class="text-label-small text-gray-500 ml-1">Reistijd (enkele reis, min)</label>
                      <input id="calcTravel" type="number" min="0" bind:value={calcTravelMinutes} class="w-full bg-surface-900 border border-white/5 rounded-m3-xs px-3 py-2 text-body-medium text-white focus:outline-none" />
                    </div>
                    <div class="space-y-1">
                      <label for="calcVisit" class="text-label-small text-gray-500 ml-1">Duur ter plaatse (min)</label>
                      <input id="calcVisit" type="number" min="0" bind:value={calcVisitMinutes} class="w-full bg-surface-900 border border-white/5 rounded-m3-xs px-3 py-2 text-body-medium text-white focus:outline-none" />
                    </div>
                  </div>

                  <div class="space-y-1">
                    <label for="calcAppTime" class="text-label-small text-gray-500 ml-1">Tijd van de afspraak</label>
                    <input id="calcAppTime" type="time" bind:value={calcAppointmentTime} class="w-full bg-surface-900 border border-white/5 rounded-m3-xs px-3 py-2 text-body-medium text-white focus:outline-none" style="color-scheme: dark" />
                  </div>

                  {#if calcResult}
                    <p class="text-label-small text-gray-400">
                      Weg om <span class="text-primary-400 tabular-nums">{formatTime(calcResult.depart.toISOString())}</span>,
                      terug om <span class="text-primary-400 tabular-nums">{formatTime(calcResult.back.toISOString())}</span>
                    </p>
                  {/if}

                  <Button
                    variant="tonal"
                    type="button"
                    disabled={!calcResult}
                    onclick={applyCalculatedTime}
                    class="w-full h-9!"
                  >
                    Toepassen
                  </Button>
                </div>
              {/if}
            </div>

          <div class="grid grid-cols-2 gap-3 md:gap-4">
            <div class="space-y-1">
              <label for="newAppBegin" class="text-label-medium text-gray-500 ml-1">Begin</label>
              <input 
                id="newAppBegin"
                bind:value={newApp.start}
                type="time" 
                class="w-full bg-surface-950 border border-white/5 rounded-m3-xs px-3 md:px-4 py-2.5 md:py-3 text-body-large text-white focus:outline-none"
                style="color-scheme: dark"
              />
            </div>
            <div class="space-y-1">
              <label for="newAppEinde" class="text-label-medium text-gray-500 ml-1">Einde</label>
              <input 
                id="newAppEinde"
                bind:value={newApp.einde}
                type="time" 
                class="w-full bg-surface-950 border border-white/5 rounded-m3-xs px-3 md:px-4 py-2.5 md:py-3 text-body-large text-white focus:outline-none"
                style="color-scheme: dark"
              />
            </div>
          </div>

          <div class="space-y-1">
            <label for="newAppLocatie" class="text-label-medium text-gray-500 ml-1">Locatie</label>
            <input 
              id="newAppLocatie"
              bind:value={newApp.lokatie}
              type="text" 
              class="w-full bg-surface-950 border border-white/5 rounded-m3-xs px-3 md:px-4 py-2.5 md:py-3 text-body-large text-white focus:outline-none focus:border-primary-500/50 transition-colors"
              placeholder="Bijv. Kantine"
            />
          </div>

          <div class="space-y-1">
            <label for="newAppInhoud" class="text-label-medium text-gray-500 ml-1">Inhoud</label>
            <textarea 
              id="newAppInhoud"
              bind:value={newApp.inhoud}
              class="w-full h-20 md:h-24 bg-surface-950 border border-white/5 rounded-m3-xs px-3 md:px-4 py-2.5 md:py-3 text-body-large text-white focus:outline-none focus:border-primary-500/50 transition-colors resize-none"
              placeholder="Details..."
            ></textarea>
          </div>
        </div>

        {#if createError}
          <p class="text-body-small text-red-400 bg-red-500/10 border border-red-500/20 rounded-m3-sm px-3 py-2">{createError}</p>
        {/if}
        <Button 
          variant="filled"
          onclick={createAppointment}
          class="w-full"
        >
          Toevoegen
        </Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .glass {
    background: rgba(40, 50, 70, 0.5);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.4);
  }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  .custom-scrollbar::-webkit-scrollbar { width: 3px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
  input[type="time"]::-webkit-calendar-picker-indicator {
    filter: invert(1);
  }
</style>
