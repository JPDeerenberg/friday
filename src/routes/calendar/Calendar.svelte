<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { getCalendarEvents, formatDate, getCalendarEvent, toggleCalendarEventDone, downloadFile, createCalendarEvent, deleteCalendarEvent } from '$lib/api';
  let downloadingFile = $state<string | null>(null);

  import HtmlRenderer from '$lib/components/HtmlRenderer.svelte';
  import { onMount } from 'svelte';
  import { fade, fly, slide, scale } from 'svelte/transition';

  let appointments = $state<any[]>([]);
  let selectedDate = $state(new Date());
  let loading = $state(true);
  let showDetail = $state(false);
  let selectedAppointment = $state<any>(null);
  let loadingDetail = $state(false);
  let editMode = $state(false);
  let editContent = $state('');
  let isCreating = $state(false);

  // New appointment state
  let newApp = $state({
    omschrijving: '',
    lokatie: '',
    inhoud: '',
    start: '',
    einde: '',
    duurtHeleDag: false
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

  const dayAppointments = $derived.by(() => {
    let filtered = appointments.filter(a => {
      const d = new Date(a.Start);
      return d.toDateString() === selectedDate.toDateString();
    });

    // 1. Filter cancelled if setting is on
    if ($userSettings.hideCancelled) {
      filtered = filtered.filter(a => a.Status !== 4 && a.Status !== 5);
    }

    filtered.sort((a, b) => a.Start.localeCompare(b.Start));

    let processed: any[] = [];

    // 2. Combine lessons if setting is on
    if ($userSettings.combineLessons) {
      for (const app of filtered) {
        const last = processed[processed.length - 1];
        
        // Match same subject, teacher, location and exact consecutive timing
        const isSameSubject = last && 
                             (last.Vakken?.[0]?.Omschrijving === app.Vakken?.[0]?.Omschrijving) &&
                             (last.Docenten?.[0]?.Naam === app.Docenten?.[0]?.Naam) &&
                             (last.Lokatie === app.Lokatie);
        const isConsecutive = last && last.Einde === app.Start;

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

    return processed.map(a => {
      if (a.displayType === 'break') return a;
      return {
        ...a,
        Inhoud: localOverrides[a.Id] || a.Inhoud,
        Lesuur: a.IsCombined 
          ? `${a.LesuurVan}–${a.LesuurTotMet || a.LesuurVan}`
          : (a.LesuurVan || '—')
      };
    });
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

  async function handleDownload(bijlage: any) {
    if (downloadingFile) return;
    try {
      const url = bijlage.Links.find((l: any) => l.Rel === 'Self')?.Href;
      if (!url) return;
      downloadingFile = bijlage.Naam;
      const path = await downloadFile(url, bijlage.Naam);
      alert(`Bestand gedownload naar: ${path}`);
    } catch (e) {
      alert(`Download mislukt: ${e}`);
    } finally {
      downloadingFile = null;
    }
  }

  async function openDetail(app: any) {
    if (app.displayType === 'break') return;
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
      if (localOverrides[selectedAppointment.Id]) {
          selectedAppointment.Inhoud = localOverrides[selectedAppointment.Id];
      }
      editContent = selectedAppointment.Inhoud || '';
      editMode = false;
    } catch (e) {
      selectedAppointment = app;
      editContent = selectedAppointment.Inhoud || '';
    } finally {
      loadingDetail = false;
    }
  }


  function saveLocalOverride() {
    if (!selectedAppointment) return;
    localOverrides[selectedAppointment.Id] = editContent;
    localStorage.setItem('calendar_overrides', JSON.stringify(localOverrides));
    selectedAppointment.Inhoud = editContent;
    editMode = false;
    // Update main appointments array as well
    appointments = appointments.map(a => a.Id === selectedAppointment.Id ? {...a, Inhoud: editContent} : a);
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
    const selfUrl = selectedAppointment.SelfUrl
      || selectedAppointment.self_url
      || selectedAppointment.Links?.find((l: any) => l.Rel === 'Self')?.Href?.replace('/api/', '');
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

  async function toggleDone(app: any) {
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

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function getInfoColor(info: number) {
    if (info === 1) return 'border-blue-500/40 text-blue-400 bg-blue-500/10';
    if ([2, 3, 4, 5].includes(info)) return 'border-red-500/40 text-red-400 bg-red-500/10';
    return 'border-surface-700 text-gray-400 bg-surface-800/40';
  }

  function getInfoLabel(info: number) {
    if (info === 1) return 'Huiswerk';
    if (info === 2) return 'Toets';
    if (info === 3) return 'Tentamen';
    if (info === 4) return 'SO';
    if (info === 5) return 'Mondeling';
    return 'Afspraak';
  }

  const weekData = $derived(() => {
    const d = new Date(selectedDate);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(d.setDate(diff));
    const length = $userSettings.showWeekend ? 7 : 5;
    
    return Array.from({ length }, (_, i) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + i);
      const dayStr = date.toDateString();
      const dayApps = appointments.filter(a => new Date(a.Start).toDateString() === dayStr);
      
      return {
        date,
        isToday: dayStr === new Date().toDateString(),
        isSelected: dayStr === selectedDate.toDateString(),
        hasTest: dayApps.some(a => [2, 3, 4, 5].includes(a.InfoType)),
        hasHomework: dayApps.some(a => a.InfoType === 1 && !a.Afgerond)
      };
    });
  });

  const hiddenCancelledCount = $derived.by(() => {
    if (!$userSettings.hideCancelled) return 0;
    const currentDayStr = selectedDate.toDateString();
    return appointments.filter(a => {
      const isToday = new Date(a.Start).toDateString() === currentDayStr;
      const isCancelled = a.Status === 4 || a.Status === 5;
      return isToday && isCancelled;
    }).length;
  });

  // Swipe handling with live drag tracking
  let touchStartX = 0;
  let touchStartY = 0;
  let isDragging = $state(false);
  let isHorizontalSwipe = false;

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isDragging = false;
    isHorizontalSwipe = false;
  }

  function handleTouchMove(e: TouchEvent) {
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    
    // Determine swipe axis on first significant movement
    if (!isDragging && Math.hypot(dx, dy) > 8) {
      isHorizontalSwipe = Math.abs(dx) > Math.abs(dy);
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
        if (dx > 0) prevDay(true); else nextDay(true);

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

</script>

<div class="flex flex-col h-full bg-surface-950" ontouchstart={handleTouchStart} ontouchmove={handleTouchMove} ontouchend={handleTouchEnd}>
  <!-- Header Section -->
  <header class="sticky top-0 z-20 bg-surface-950/95 backdrop-blur-xl border-b border-surface-800/50 px-4 py-3">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-black text-white italic tracking-tighter">Agenda</h1>
        <button
          onclick={() => { appointments = []; loadedStart = null; loadedEnd = null; loadAppointments(true); }}
          class="p-1.5 text-gray-400 hover:text-primary-400 transition-all hover:rotate-180 duration-500"
          title="Verversen"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
        <button
          onclick={() => $userSettings.hideCancelled = !$userSettings.hideCancelled}
          class="p-1.5 {$userSettings.hideCancelled ? 'text-gray-600' : 'text-primary-400'} hover:text-primary-300 transition-all"
          title={$userSettings.hideCancelled ? 'Uitgevallen lessen tonen' : 'Uitgevallen lessen verbergen'}
        >
          {#if $userSettings.hideCancelled}
            <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"/></svg>
          {:else}
            <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          {/if}
        </button>
      </div>

      <div class="flex items-center gap-2">
        <button
          onclick={() => isCreating = true}
          class="p-2 rounded-xl bg-primary-500/10 border border-primary-500/20 text-primary-400 hover:bg-primary-500/20 transition-all"
        >
          <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button
          onclick={goToToday}
          class="px-2.5 py-1.5 rounded-xl bg-surface-800 text-gray-300 text-[10px] font-black uppercase tracking-widest hover:bg-surface-700 transition-all"
        >
          Vandaag
        </button>
      </div>
    </div>

    <!-- Date Display & Navigation -->
    <div class="mt-3 flex items-center justify-between">
      <label class="flex flex-col relative cursor-pointer group">
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
        <p class="text-[10px] font-black text-primary-400 uppercase tracking-[0.2em] group-hover:text-primary-300 transition-colors">
          {selectedDate.toLocaleDateString('nl-NL', { month: 'short', year: 'numeric' })}
        </p>
        <h2 class="text-xl font-black text-white italic tracking-tighter leading-tight group-hover:text-gray-200 transition-colors">
          {selectedDate.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric' })}
        </h2>
      </label>

      <!-- Compact Navigation Arrows -->
      <div class="flex items-center bg-surface-900 rounded-xl p-0.5 border border-white/5">
        <button onclick={prevWeek} class="p-2 text-gray-500 hover:text-white transition-colors" title="Vorige week">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/></svg>
        </button>
        <div class="h-4 w-px bg-surface-700 mx-0.5"></div>
        <button onclick={nextWeek} class="p-2 text-gray-500 hover:text-white transition-colors" title="Volgende week">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m13 17 5-5-5-5M6 17l5-5-5-5"/></svg>
        </button>
      </div>
    </div>

    <!-- Quick Week Picker (Horizontal) -->
    <div class="mt-4 flex justify-between gap-1.5 overflow-x-auto no-scrollbar pb-1">
      {#each weekData() as { date, isToday, isSelected, hasTest, hasHomework }}
        <button
          onclick={() => { selectedDate = new Date(date); loadAppointments(); }}
          class="flex-1 flex flex-col items-center py-2 px-1 rounded-xl transition-all border min-w-[45px] relative
                 {isSelected 
                   ? 'bg-primary-500 border-primary-400 text-white shadow-lg shadow-primary-500/20' 
                   : 'bg-surface-900/40 border-white/5 text-gray-500 hover:bg-surface-800'}"
        >
          <span class="text-[9px] font-black uppercase tracking-tighter mb-0.5 opacity-60">
            {date.toLocaleDateString('nl-NL', { weekday: 'short' }).slice(0, 2)}
          </span>
          <span class="text-base font-black leading-none">{date.getDate()}</span>
          
          <div class="flex gap-0.5 mt-1">
            {#if hasTest}
               <div class="w-1 h-1 rounded-full bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.5)]"></div>
            {:else if hasHomework}
              <div class="w-1 h-1 rounded-full bg-blue-400 shadow-[0_0_5px_rgba(96,165,250,0.5)]"></div>
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
    class="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar"
    style="transform: translateX({swipeOffset}px); transition: {isDragging || noTransition ? 'none' : 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)'}; will-change: transform; touch-action: pan-y;"
  >
    {#if hiddenCancelledCount > 0 && !loading}
      <div class="glass p-3 rounded-3xl flex items-center justify-between border-red-500/10 bg-red-500/5 mb-3" transition:slide>
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </div>
          <div>
            <p class="text-xs font-black text-red-400 uppercase tracking-widest">{hiddenCancelledCount} les{hiddenCancelledCount !== 1 ? 'sen' : ''} uitgevallen</p>
            <p class="text-[9px] text-gray-500 font-bold">Zijn momenteel verborgen</p>
          </div>
        </div>
        <button 
          onclick={() => $userSettings.hideCancelled = false}
          class="px-3 py-1.5 rounded-xl bg-surface-800 text-[10px] font-black text-gray-300 hover:text-white hover:bg-surface-700 transition-all uppercase tracking-widest"
        >
          Tonen
        </button>
      </div>
    {/if}

    {#if loading}
      <div class="flex flex-col items-center justify-center py-24 gap-4">
        <div class="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin shadow-[0_0_20px_rgba(var(--color-primary-500),0.3)]"></div>
        <p class="text-xs font-black text-gray-600 uppercase tracking-widest animate-pulse">Lessen ophalen...</p>
      </div>
    {:else if dayAppointments.length === 0}
      <div class="flex flex-col items-center justify-center py-20 text-center space-y-6">
        <div class="w-24 h-24 rounded-full bg-surface-900 border border-surface-800 flex items-center justify-center shadow-2xl">
          <svg class="w-10 h-10 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M18 22 13 17l-3 3-5-5"/></svg>
        </div>
        <div>
          <h3 class="text-lg font-black text-white italic tracking-tight mb-2">Geen lessen gepland</h3>
          <p class="text-xs font-bold text-gray-600 uppercase tracking-widest max-w-[200px] leading-relaxed">
            Geniet van je vrije tijd of bekijk een andere dag!
          </p>
        </div>
      </div>
    {:else}
      {#each dayAppointments as app, i}
        {#if app.displayType === 'break'}
          <div class="flex items-center gap-4 px-6 py-2 opacity-40 group hover:opacity-100 transition-opacity">
            <div class="w-10 flex flex-col items-center">
              <div class="h-4 w-0.5 bg-surface-700"></div>
            </div>
            <div class="flex-1 flex items-center gap-3">
              <div class="h-[1px] flex-1 bg-gradient-to-r from-surface-800 to-transparent"></div>
              <span class="text-[9px] font-black uppercase tracking-[0.2em] text-gray-500 whitespace-nowrap">
                {app.Duration} min pauze
              </span>
              <div class="h-[1px] flex-1 bg-gradient-to-l from-surface-800 to-transparent"></div>
            </div>
          </div>
        {:else}
          <div
            role="button"
            tabindex="0"
            onclick={() => openDetail(app)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(app); } }}
            in:fly={{ y: 16, duration: 200, delay: i * 25, easing: (t) => 1 - Math.pow(1-t, 3) }}
            class="w-full text-left glass rounded-3xl p-4 flex gap-4 transition-all active:scale-[0.98] group relative overflow-hidden cursor-pointer
                   {app.InfoType === 1 && !app.Afgerond ? 'border-primary-500/30' : ''}
                   {app.Status === 4 || app.Status === 5 ? 'border-red-500/40 bg-red-500/5' : ''}
                   {app.Afgerond ? 'opacity-60' : ''}"
          >
            <!-- Background accent -->
            {#if app.Status === 4 || app.Status === 5}
              <div class="absolute inset-0 bg-gradient-to-r from-red-500/10 to-transparent opacity-100 transition-opacity"></div>
            {:else}
              <div class="absolute inset-0 bg-gradient-to-r from-primary-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            {/if}

            {#if app.InfoType === 1 && !app.Afgerond}
              <div class="absolute top-0 right-0 w-32 h-32 bg-primary-500/5 blur-3xl -mr-16 -mt-16"></div>
            {/if}
            
            <!-- Time/Period -->
            <div class="flex flex-col items-center justify-center min-w-[42px] gap-0.5 relative z-10">
              <span class="text-[9px] font-black {app.Status === 4 || app.Status === 5 ? 'text-red-400' : 'text-gray-600'} uppercase tracking-tight">
                {app.IsCombined ? 'Uren' : 'Les'}
              </span>
              <span class="text-xl font-black {app.Status === 4 || app.Status === 5 ? 'text-red-400' : 'text-white'} italic leading-none">{app.Lesuur}</span>
              <div class="h-px w-5 {app.Status === 4 || app.Status === 5 ? 'bg-red-500/30' : 'bg-surface-700'} my-1"></div>
              <span class="text-[9px] font-bold {app.Status === 4 || app.Status === 5 ? 'text-red-400/70' : 'text-gray-500'}">{formatTime(app.Start)}</span>
            </div>

            <!-- Vertical Divider -->
            <div class="w-px {app.Status === 4 || app.Status === 5 ? 'bg-red-500/20' : 'bg-surface-800/80'} my-1"></div>

            <!-- Info -->
            <div class="flex-1 min-w-0 flex flex-col justify-center relative z-10">
              <div class="flex items-center justify-between gap-2 mb-1">
                <span class="text-sm font-black {app.Status === 4 || app.Status === 5 ? 'text-red-400 line-through' : 'text-primary-400'} uppercase tracking-tight truncate">
                  {app.Vakken?.[0]?.Omschrijving || app.Omschrijving || 'Vrij'}
                </span>
                {#if app.Docenten?.[0]}
                  <span class="text-[9px] font-bold {app.Status === 4 || app.Status === 5 ? 'text-red-400/60' : 'text-gray-600'} shrink-0 bg-surface-900/50 px-1.5 py-0.5 rounded-md border border-white/5">
                    {app.Docenten[0].Naam}
                  </span>
                {/if}
              </div>

              <div class="flex items-center gap-3 text-[10px] font-bold {app.Status === 4 || app.Status === 5 ? 'text-red-400/60' : 'text-gray-500'}">
                <div class="flex items-center gap-1">
                  <svg class="w-3 h-3 currentcolor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                  <span class="truncate">{app.Lokatie || '—'}</span>
                </div>
                <div class="flex items-center gap-1">
                  <svg class="w-3 h-3 currentcolor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                  <span>Tot {formatTime(app.Einde)}</span>
                </div>
              </div>

              {#if app.Status === 4 || app.Status === 5}
                <div class="mt-2 flex">
                  <span class="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest border border-red-500/40 text-red-400 bg-red-500/10">
                    Uitgevallen
                  </span>
                </div>
              {:else if app.InfoType && app.InfoType !== 0}
                <div class="mt-2 flex">
                  <span class="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest border {getInfoColor(app.InfoType)}">
                    {getInfoLabel(app.InfoType)}
                  </span>
                </div>
              {/if}

              {#if app.Aantekening}
                <div class="mt-2 text-[10px] text-gray-600 italic bg-surface-900/40 p-1.5 rounded-lg border border-white/5 line-clamp-1">
                  {app.Aantekening}
                </div>
              {/if}
            </div>

            <!-- Status Indicators -->
            <div class="flex flex-col items-center justify-center gap-1.5 shrink-0 relative z-10">
              {#if app.InfoType === 1}
                <button 
                  onclick={(e) => { e.stopPropagation(); toggleDone(app); }}
                  class="w-8 h-8 rounded-full border-2 transition-all flex items-center justify-center
                         {app.Afgerond 
                           ? 'bg-emerald-500 border-emerald-400 text-white' 
                           : 'bg-surface-900 border-surface-700 text-transparent hover:border-primary-500 focus:scale-110'}"
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M20 6L9 17L4 12"/></svg>
                </button>
              {:else if app.Status === 4 || app.Status === 5} <!-- Cancelled -->
                <div class="w-7 h-7 rounded-full bg-red-500 border border-red-400 flex items-center justify-center text-white shadow-lg shadow-red-500/20 animate-pulse">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </div>
              {:else if app.Inhoud || app.HeeftBijlagen} <!-- Content or Attachments present -->
                 <div class="w-7 h-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-500">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
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
  <div class="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-6" transition:fade={{ duration: 200 }}>
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" onclick={() => { selectedAppointment = null; editMode = false; }}></div>
    
    <div 
      class="relative w-full max-w-lg bg-surface-900 border-t md:border border-white/10 rounded-t-[2rem] md:rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] z-10"
      transition:fly={{ y: 50, duration: 400, easing: (t) => 1 - Math.pow(1 - t, 3) }}
    >
      <!-- Top Handle -->
      <div class="md:hidden flex justify-center py-3">
        <div class="w-10 h-1 rounded-full bg-surface-700"></div>
      </div>

      <div class="p-5 md:p-7 overflow-y-auto custom-scrollbar space-y-6">
        <!-- Title area -->
        <div class="space-y-3">
          <div class="flex items-center justify-between">
             <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border {getInfoColor(selectedAppointment.InfoType)}">
              {getInfoLabel(selectedAppointment.InfoType)}
            </span>
            <div class="flex items-center gap-2">
              <button 
                onclick={() => editMode = !editMode}
                class="p-2 rounded-xl bg-surface-800 text-gray-400 hover:text-white transition-colors"
                title="Bewerken"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
              </button>
              {#if selectedAppointment.Type === 1}
                <button 
                  onclick={deleteAppointment}
                  disabled={deletingAppointment}
                  class="p-2 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors disabled:opacity-50"
                  title="Afspraak verwijderen"
                >
                  {#if deletingAppointment}
                    <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {:else}
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>
                  {/if}
                </button>
              {/if}
              <button onclick={() => { selectedAppointment = null; editMode = false; }} class="p-2 text-gray-500 hover:text-white transition-colors">
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <h2 class="text-2xl font-black text-white italic leading-tight tracking-tighter">
            {selectedAppointment.Vakken?.[0]?.Omschrijving || selectedAppointment.Omschrijving || 'Vrij'}
          </h2>
          <div class="flex flex-wrap gap-2">
            <span class="flex items-center gap-1.5 text-[10px] font-bold text-gray-300 bg-surface-800 px-2.5 py-1 rounded-lg border border-white/5">
              <svg class="w-3 h-3 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {selectedAppointment.Docenten?.[0]?.Naam || 'Geen docent'}
            </span>
            <span class="flex items-center gap-1.5 text-[10px] font-bold text-gray-300 bg-surface-800 px-2.5 py-1 rounded-lg border border-white/5">
              <svg class="w-3 h-3 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
              {selectedAppointment.Lokatie || 'Onbekend'}
            </span>
          </div>
        </div>

        <!-- Times and Details -->
        <div class="grid grid-cols-2 gap-3">
          <div class="bg-surface-800/30 p-3 rounded-2xl border border-white/5">
            <p class="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-0.5">Begin</p>
            <p class="text-lg font-black text-white italic">{formatTime(selectedAppointment.Start)}</p>
          </div>
          <div class="bg-surface-800/30 p-3 rounded-2xl border border-white/5">
            <p class="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-0.5">Einde</p>
            <p class="text-lg font-black text-white italic">{formatTime(selectedAppointment.Einde)}</p>
          </div>
        </div>

        <div class="space-y-3">
          <h3 class="text-[10px] font-black text-gray-100 uppercase tracking-widest flex items-center gap-2">
            <div class="w-1 h-3 bg-primary-500 rounded-full"></div>
            Huiswerk & Inhoud
          </h3>
          {#if editMode}
            <div class="space-y-3" in:slide>
              <textarea
                bind:value={editContent}
                class="w-full h-40 bg-surface-950 border border-primary-500/30 rounded-2xl p-4 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors"
                placeholder="Huiswerk bewerken..."
              ></textarea>
              <button
                onclick={saveLocalOverride}
                class="w-full py-3 rounded-xl bg-primary-500 text-white font-black text-xs uppercase tracking-widest hover:bg-primary-400 transition-all shadow-lg shadow-primary-500/20"
              >
                Opslaan (Lokaal)
              </button>
            </div>
          {:else if selectedAppointment.Inhoud}
             {#if selectedAppointment.InfoType === 1}
               <button 
                onclick={() => toggleDone(selectedAppointment)}
                class="w-full flex items-center justify-center gap-3 py-4 rounded-2xl border-2 transition-all mb-4
                       {selectedAppointment.Afgerond 
                         ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' 
                         : 'bg-primary-500 border-primary-400 text-white shadow-lg shadow-primary-500/20'}"
               >
                 <div class="w-6 h-6 rounded-full border-2 border-current flex items-center justify-center">
                   {#if selectedAppointment.Afgerond}
                     <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M20 6L9 17L4 12"/></svg>
                   {/if}
                 </div>
                 <span class="text-xs font-black uppercase tracking-widest">
                   {selectedAppointment.Afgerond ? 'Huiswerk voltooid' : 'Markeren als klaar'}
                 </span>
               </button>
             {/if}
            <div class="p-5 rounded-3xl bg-surface-950 border border-white/5 prose prose-sm prose-invert max-w-none shadow-inner">
               <HtmlRenderer html={selectedAppointment.Inhoud} />
            </div>
          {:else}
            <p class="text-[10px] text-gray-600 italic px-2">Geen inhoud beschikbaar.</p>
          {/if}
        </div>

        {#if selectedAppointment.Aantekening && !editMode}
          <div class="space-y-2">
            <h3 class="text-[10px] font-black text-gray-100 uppercase tracking-widest flex items-center gap-2">
              <div class="w-1 h-3 bg-accent-500 rounded-full"></div>
              Aantekening
            </h3>
            <div class="p-4 rounded-2xl bg-surface-950 border border-white/5 text-xs text-gray-500 italic leading-relaxed">
              {selectedAppointment.Aantekening}
            </div>
          </div>
        {/if}
        {#if selectedAppointment.Bijlagen && selectedAppointment.Bijlagen.length > 0}
          <div class="space-y-3 pb-4">
            <h3 class="text-[10px] font-black text-gray-100 uppercase tracking-widest flex items-center gap-2">
              <div class="w-1 h-3 bg-blue-500 rounded-full"></div>
              Bijlagen ({selectedAppointment.Bijlagen.length})
            </h3>
            <div class="grid gap-2">
              {#each selectedAppointment.Bijlagen as bijlage}
                <div class="flex items-center justify-between p-3 rounded-2xl bg-surface-950 border border-white/5 transition-all hover:border-white/10 group">
                  <div class="flex items-center gap-3 overflow-hidden">
                    <div class="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.51a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    </div>
                    <div class="flex flex-col min-w-0">
                      <span class="text-xs font-bold text-gray-200 truncate">{bijlage.Naam}</span>
                      <span class="text-[10px] text-gray-600 font-medium">{bijlage.Grootte ? Math.round(bijlage.Grootte / 1024) + ' KB' : '—'}</span>
                    </div>
                  </div>
                  <button 
                    onclick={() => handleDownload(bijlage)}
                    disabled={downloadingFile === bijlage.Naam}
                    class="p-2.5 rounded-xl bg-surface-800 text-gray-400 hover:text-white hover:bg-surface-700 disabled:opacity-50 transition-all active:scale-90"
                  >
                    {#if downloadingFile === bijlage.Naam}
                      <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    {:else}
                      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    {/if}
                  </button>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      
      <!-- Footer Button (Close) -->
      <div class="p-4 pt-0 shrink-0 md:hidden">
        <button 
          onclick={() => { showDetail = false; selectedAppointment = null; editMode = false; }}
          class="w-full py-3 rounded-xl bg-surface-800 text-white text-xs font-black uppercase tracking-tight hover:bg-surface-700 transition-all"
        >
          Sluiten
        </button>
      </div>
    </div>
  </div>
{/if}


<!-- New Appointment Modal -->
{#if isCreating}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 200 }}>
    <div class="absolute inset-0 bg-black/90 backdrop-blur-md" onclick={() => isCreating = false}></div>
    
    <div 
      class="relative w-full max-w-md bg-surface-900 border border-white/10 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col z-10"
      transition:scale={{ start: 0.95, duration: 300 }}
    >
      <div class="p-6 space-y-6">
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-black text-white italic tracking-tighter">Nieuwe Afspraak</h2>
          <button onclick={() => isCreating = false} class="text-gray-500 hover:text-white transition-colors">
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="space-y-4">
          <div class="space-y-1.5">
            <label class="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">Omschrijving</label>
            <input 
              bind:value={newApp.omschrijving}
              type="text" 
              class="w-full bg-surface-950 border border-white/5 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-primary-500/50 transition-colors"
              placeholder="Bijv. Projectoverleg"
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">Begin (HH:MM)</label>
              <input 
                bind:value={newApp.start}
                type="time" 
                class="w-full bg-surface-950 border border-white/5 rounded-xl px-4 py-3 text-sm text-white focus:outline-none"
                style="color-scheme: dark"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">Einde (HH:MM)</label>
              <input 
                bind:value={newApp.einde}
                type="time" 
                class="w-full bg-surface-950 border border-white/5 rounded-xl px-4 py-3 text-sm text-white focus:outline-none"
                style="color-scheme: dark"
              />
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">Locatie</label>
            <input 
              bind:value={newApp.lokatie}
              type="text" 
              class="w-full bg-surface-950 border border-white/5 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-primary-500/50 transition-colors"
              placeholder="Bijv. Kantine"
            />
          </div>

          <div class="space-y-1.5">
            <label class="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">Inhoud</label>
            <textarea 
              bind:value={newApp.inhoud}
              class="w-full h-24 bg-surface-950 border border-white/5 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-primary-500/50 transition-colors resize-none"
              placeholder="Details..."
            ></textarea>
          </div>
        </div>

        {#if createError}
          <p class="text-xs text-red-400 font-bold bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{createError}</p>
        {/if}
        <button 
          onclick={createAppointment}
          class="w-full py-4 rounded-2xl bg-primary-500 text-white font-black uppercase tracking-widest hover:bg-primary-400 transition-all shadow-lg shadow-primary-500/25 active:scale-[0.98]"
        >
          Toevoegen
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .glass {
    background: rgba(30, 41, 59, 0.4);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.05);
    box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.5);
  }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  .custom-scrollbar::-webkit-scrollbar { width: 4px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 10px; }
  input[type="time"]::-webkit-calendar-picker-indicator {
    filter: invert(1);
  }
</style>
