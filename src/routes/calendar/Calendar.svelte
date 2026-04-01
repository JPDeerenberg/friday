<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { getCalendarEvents, updateCalendarEvent, createCalendarEvent, deleteCalendarEvent, formatDate, getWeekRange, infoTypeShort, infoTypeName, formatTeacherName } from '$lib/api';
  import { onMount, getContext } from 'svelte';
  import { get } from 'svelte/store';
  import { fly, fade } from 'svelte/transition';

  let events = $state<any[]>([]);
  let loading = $state(true);
  let currentDate = $state(new Date());
  let hideCanceled = $state(false);
  let selectedEvent = $state<any | null>(null);
  let touchStartX = 0;
  let touchStartY = 0;

  let loadedRangeStart = $state<number>(0);
  let loadedRangeEnd = $state<number>(0);

  // Derived state for the current day's events
  let dayEvents = $derived(getEventsForDay(currentDate));

  // Edit states
  let isEditing = $state(false);
  let draftInhoud = $state('');

  // Add event states
  let showAddModal = $state(false);
  let isSubmitting = $state(false);
  let newEventForm = $state({
    omschrijving: '',
    start: '',
    einde: '',
    lokatie: '',
    inhoud: ''
  });

  // View mode: always 'day' on narrow, 'week' on wide
  // We track this with a simple reactive store derived from a MQ
  let isWeekView = $state(false);

  onMount(() => {
    const cached = localStorage.getItem('calendar_cache');
    if (cached) {
      try {
        events = JSON.parse(cached);
        const cw = localStorage.getItem('calendar_cache_window');
        if (cw) {
           const parsed = JSON.parse(cw);
           loadedRangeStart = parsed.start;
           loadedRangeEnd = parsed.end;
        }
        loading = false;
      } catch (e) {}
    }

    const mq = window.matchMedia('(min-width: 768px)');
    isWeekView = mq.matches;
    const handler = (e: MediaQueryListEvent) => {
      isWeekView = e.matches;
      loadEvents();
    };
    mq.addEventListener('change', handler);
    if (!events.length) {
      loadEvents();
    } else {
      loadEvents(true); // background silent refresh
    }
    return () => mq.removeEventListener('change', handler);
  });

  const weekDays = ['Ma', 'Di', 'Wo', 'Do', 'Vr'];

  async function loadEvents(silent = false) {
    const pid = $personId;
    if (!pid) return;
    if (!silent) loading = true;
    try {
      if (isWeekView) {
        const { start, end } = getWeekRange(currentDate);
        events = await getCalendarEvents(pid, start, end);
        loadedRangeStart = new Date(start).getTime();
        loadedRangeEnd = new Date(end).getTime();
      } else {
        // Load ±14 days so prev/next navigation is instant for 2 full weeks
        const from = new Date(currentDate.getTime() - 14 * 86400000);
        const to   = new Date(currentDate.getTime() + 14 * 86400000);
        loadedRangeStart = from.getTime();
        loadedRangeEnd = to.getTime();
        events = await getCalendarEvents(pid, formatDate(from), formatDate(to));
      }
      events.sort((a, b) => a.Start.localeCompare(b.Start));
      localStorage.setItem('calendar_cache', JSON.stringify(events));
      localStorage.setItem('calendar_cache_window', JSON.stringify({ start: loadedRangeStart, end: loadedRangeEnd }));
    } catch (e) {
      console.error('Failed to load events:', e);
    }
    if (!silent) loading = false;
  }

  function nextWeek() {
    currentDate = new Date(currentDate.getTime() + 7 * 86400000);
    loadEvents();
  }
  function prevWeek() {
    currentDate = new Date(currentDate.getTime() - 7 * 86400000);
    loadEvents();
  }
  function checkBoundaryReload() {
    const margin = 3 * 86400000;
    const cTime = currentDate.getTime();
    if (cTime - loadedRangeStart < margin || loadedRangeEnd - cTime < margin) {
      loadEvents(true);
    }
  }

  function nextDay() {
    currentDate = new Date(currentDate.getTime() + 86400000);
    checkBoundaryReload();
  }
  function prevDay() {
    currentDate = new Date(currentDate.getTime() - 86400000);
    checkBoundaryReload();
  }
  function handleMainTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
  function handleMainTouchEnd(e: TouchEvent) {
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const diffX = touchEndX - touchStartX;
    const diffY = touchEndY - touchStartY;
    
    if (Math.abs(diffX) > 60 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
      if (diffX > 0) prevDay();
      else nextDay();
    }
  }
  function goToday() {
    currentDate = new Date();
    loadEvents();
  }

  function getWeekDates(): Date[] {
    const { start } = getWeekRange(currentDate);
    const length = $userSettings.showWeekend ? 7 : 5;
    return Array.from({ length }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }

  const weekDates = $derived(getWeekDates());

  function getEventsForDay(date: Date): any[] {
    const dayStr = formatDate(date);
    let dayEvents = events.filter(e => e.Start?.startsWith(dayStr));
    if (hideCanceled) dayEvents = dayEvents.filter(e => !isCanceled(e));
    return dayEvents;
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function eventTimeLabel(event: any): string {
    if (event.DuurtHeleDag) return 'Hele dag';
    return `${formatTime(event.Start)} – ${formatTime(event.Einde)}`;
  }

  function eventTimeLabelShort(event: any): string {
    if (event.DuurtHeleDag) return 'Hele dag';
    if (event.LesuurVan) {
      const suffix = event.LesuurTotMet && event.LesuurTotMet !== event.LesuurVan ? `-${event.LesuurTotMet}` : '';
      return `${event.LesuurVan}${suffix}e`;
    }
    return formatTime(event.Start);
  }

  function getEventColor(event: any): string {
    if (isCanceled(event)) return 'bg-red-500/15 border-red-500/30 text-red-200/80 backdrop-blur-sm';
    // Tests (Proefwerk, Tentamen, SO, MO)
    if (event.InfoType >= 2 && event.InfoType <= 5) return 'bg-amber-500/20 border-amber-500/40 text-amber-100 shadow-xl shadow-amber-500/10 backdrop-blur-md';
    // Homework
    if (event.InfoType === 1) return 'bg-primary-500/20 border-primary-500/30 text-primary-100 shadow-xl shadow-primary-500/10 backdrop-blur-md font-bold';
    // Normal / Other
    return 'bg-surface-800/60 border-white/10 text-white shadow-xl shadow-black/20 backdrop-blur-md';
  }

  function getStatusColor(event: any): string {
    if (isCanceled(event)) return 'bg-red-500';
    if (event.InfoType === 1) return 'bg-primary-400';
    if (event.InfoType >= 2 && event.InfoType <= 5) return 'bg-amber-500';
    return 'bg-primary-500/60';
  }

  function hasTestOnDay(date: Date): boolean {
    const dayStr = formatDate(date);
    return events.some(e => e.Start?.startsWith(dayStr) && e.InfoType >= 2 && e.InfoType <= 5 && !isCanceled(e));
  }

  function isCanceled(event: any): boolean {
    return event.Status === 4 || event.Status === 5;
  }

  function getBreakDuration(prev: any, curr: any): number {
    if (!prev?.Einde || !curr?.Start) return 0;
    const diff = new Date(curr.Start).getTime() - new Date(prev.Einde).getTime();
    return Math.max(0, Math.floor(diff / 60000));
  }

  function selectEvent(event: any) {
    selectedEvent = selectedEvent?.Id === event.Id ? null : event;
    isEditing = false;
  }

  function startEditing() {
    if (!selectedEvent) return;
    draftInhoud = selectedEvent.Inhoud ?? '';
    isEditing = true;
  }

  async function saveInhoud() {
    if (!selectedEvent || !selectedEvent.self_url) return;
    try {
      // Magister often requires a full object or specific fields.
      // We'll mimic a 'sync' by re-fetching or ensuring all fields are present.
      const updated = { ...selectedEvent, Inhoud: draftInhoud };
      await updateCalendarEvent(selectedEvent.self_url, JSON.stringify(updated));
      
      // Update local state
      events = events.map(e => e.Id === updated.Id ? { ...updated } : e);
      selectedEvent = { ...updated };
      isEditing = false;
      
      // Briefly show a success indicator or just close
    } catch (e) {
      console.error('Save failed:', e);
      alert('Fout bij opslaan. Probeer het later opnieuw.');
    }
  }

  async function toggleHomeworkDone() {
    if (!selectedEvent || !selectedEvent.self_url) return;
    try {
      const updated = { ...selectedEvent, Afgerond: !selectedEvent.Afgerond };
      await updateCalendarEvent(selectedEvent.self_url, JSON.stringify(updated));
      events = events.map(e => e.Id === updated.Id ? updated : e);
      selectedEvent = updated;
    } catch (e) {
      alert('Kon de huiswerkstatus niet bijwerken.');
    }
  }

  function openAddModal() {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const offset = now.getTimezoneOffset() * 60000;
    const startIso = new Date(now.getTime() - offset).toISOString().slice(0, 16);
    const endIso   = new Date(now.getTime() - offset + 3600000).toISOString().slice(0, 16);
    newEventForm = { omschrijving: '', start: startIso, einde: endIso, lokatie: '', inhoud: '' };
    showAddModal = true;
  }

  async function deleteEvent(event: any) {
    if (!event.self_url) return;
    if (!confirm('Weet je zeker dat je deze afspraak wilt verwijderen?')) return;
    try {
      await deleteCalendarEvent(event.self_url);
      events = events.filter(e => e.Id !== event.Id);
      selectedEvent = null;
    } catch (e) {
      alert('Kon de afspraak niet verwijderen.');
    }
  }

  function editEvent(event: any) {
    selectEvent(event);
    startEditing();
  }

  async function submitNewEvent() {
    if (!$personId || !newEventForm.omschrijving || !newEventForm.start || !newEventForm.einde) return;
    isSubmitting = true;
    try {
      await createCalendarEvent({
        ['personId']: get(personId) as number,
        start: new Date(newEventForm.start).toISOString(),
        einde: new Date(newEventForm.einde).toISOString(),
        duurtHeleDag: false,
        omschrijving: newEventForm.omschrijving,
        lokatie: newEventForm.lokatie || undefined,
        inhoud: newEventForm.inhoud || undefined,
        eventType: 1
      });
      showAddModal = false;
      await loadEvents();
    } catch (e) {
      alert('Kon de afspraak niet maken.');
    }
    isSubmitting = false;
  }

  function mobileDayLabel(date: Date): string {
    const todayStr     = formatDate(new Date());
    const tomorrowStr  = formatDate(new Date(Date.now() + 86400000));
    const yesterdayStr = formatDate(new Date(Date.now() - 86400000));
    const d = formatDate(date);
    if (d === todayStr)     return 'Vandaag';
    if (d === tomorrowStr)  return 'Morgen';
    if (d === yesterdayStr) return 'Gisteren';
    return date.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const isToday = (date: Date) => formatDate(date) === formatDate(new Date());

  function downloadAttachment(attachment: any) {
    if (attachment.Url) {
       // @ts-ignore
       window.open(attachment.Url, '_blank');
    } else {
       alert('Deze bijlage heeft geen download-link.');
    }
  }
</script>

<!-- ===== PAGE WRAPPER ===== -->
<div class="flex flex-col h-full bg-surface-950">

  <!-- ===== STICKY MOBILE HEADER ===== -->
  <div class="md:hidden sticky top-0 z-20 bg-surface-950/95 backdrop-blur border-b border-surface-800/50 px-4 py-3 space-y-4">
    <!-- Top row: title + global actions -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 max-w-7xl mx-auto w-full">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 overflow-hidden">
          <img src="/logo.png" alt="Friday Logo" class="w-full h-full object-cover" />
        </div>
        <div class="flex flex-col">
          <h1 class="text-2xl font-black text-white italic tracking-tighter">Friday</h1>
          <p class="text-[10px] font-bold text-primary-400 uppercase tracking-[0.2em]">{new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button 
          onclick={() => loadEvents()} 
          class="p-2 text-gray-500 hover:text-primary-400 transition-all hover:scale-110 active:scale-95"
          aria-label="Vernieuwen"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
        <button 
          onclick={() => hideCanceled = !hideCanceled} 
          class="flex items-center justify-center w-8 h-8 rounded-lg {hideCanceled ? 'bg-primary-500 text-on-primary shadow-lg shadow-primary-500/20' : 'bg-primary-500/10 text-primary-500 border border-primary-500/20'} active:scale-95 transition-all"
          aria-label={hideCanceled ? 'Toon uitval' : 'Verberg uitval'}
        >
          {#if hideCanceled}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
          {:else}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          {/if}
        </button>
        <button onclick={goToday} class="px-2.5 py-1.5 rounded-xl bg-primary-500/10 text-primary-500 text-[9px] font-black uppercase tracking-tight border border-primary-500/20 active:scale-95 transition-all">
          Today
        </button>
        <button onclick={openAddModal} class="w-8 h-8 rounded-lg bg-primary-500 text-on-primary flex items-center justify-center shadow-lg shadow-primary-500/20 active:scale-90 transition-all">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
    </div>

    <!-- Day Navigation & Chips -->
    <div class="flex items-center gap-3">
      <button onclick={prevWeek} class="w-12 h-12 rounded-2xl bg-surface-800/60 text-gray-400 flex items-center justify-center active:scale-90 transition-all border border-white/5 hover:text-primary-400" aria-label="Vorige week">
        <svg class="w-5 h-5 translate-x-[-1px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>

      <div class="flex-1 py-1">
        <div class="grid grid-flow-col auto-cols-fr gap-1.5 px-1">
          {#each weekDates as date}
            {@const isSelected = formatDate(date) === formatDate(currentDate)}
            {@const isTod = formatDate(date) === formatDate(new Date())}
            {@const hasTest = hasTestOnDay(date)}
            <button
              onclick={() => currentDate = date}
              class="flex flex-col items-center py-2 rounded-2xl transition-all border relative
                     {isSelected 
                       ? 'bg-primary-500 text-on-primary border-primary-500 shadow-xl shadow-primary-500/30 -translate-y-0.5' 
                       : isTod 
                         ? 'bg-primary-container text-on-primary-container border-primary-500/10' 
                         : 'bg-surface-800/60 text-gray-500 border-white/5'}"
            >
              {#if hasTest}
                <div class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]"></div>
              {/if}
              <span class="text-[9px] font-black uppercase tracking-tight opacity-70">{['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'][date.getDay()]}</span>
              <span class="text-xs font-black mt-0.5">{date.getDate()}</span>
            </button>
          {/each}
        </div>
      </div>

      <button onclick={nextWeek} class="w-12 h-12 rounded-2xl bg-surface-800/60 text-gray-400 flex items-center justify-center active:scale-90 transition-all border border-white/5 hover:text-primary-400" aria-label="Volgende week">
        <svg class="w-5 h-5 translate-x-[1px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    </div>
  </div>

  <!-- ===== DESKTOP HEADER ===== -->
  <div class="hidden md:flex items-center justify-between px-6 py-4 border-b border-surface-800/50 shrink-0">
    <h1 class="text-2xl font-bold text-gray-100">Agenda</h1>
    <div class="flex items-center gap-3">
      <label class="flex items-center gap-2 cursor-pointer">
        <div class="relative inline-flex items-center">
          <input type="checkbox" bind:checked={hideCanceled} class="sr-only peer" />
          <div class="w-9 h-5 bg-surface-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-500"></div>
        </div>
        <span class="text-sm text-gray-400">Verberg uitval</span>
      </label>
      <button onclick={prevWeek} class="px-3 py-2 rounded-lg bg-surface-800 text-gray-300 hover:bg-surface-700 text-sm">‹ Week</button>
      <button onclick={goToday} class="px-3 py-2 rounded-lg bg-primary-500/15 text-primary-400 hover:bg-primary-500/25 text-sm font-medium">Vandaag</button>
      <button onclick={nextWeek} class="px-3 py-2 rounded-lg bg-surface-800 text-gray-300 hover:bg-surface-700 text-sm">Week ›</button>
      <button onclick={openAddModal} class="px-4 py-2 rounded-xl bg-primary-500 text-on-primary text-xs font-black uppercase tracking-widest shadow-lg shadow-primary-500/20 active:scale-95 transition-all">
        Toevoegen
      </button>
    </div>
  </div>

  <!-- ===== MAIN SCROLLABLE AREA ===== -->
  <div 
    class="flex-1 relative overflow-hidden grid grid-cols-1 grid-rows-1 bg-surface-950"
    ontouchstart={handleMainTouchStart}
    ontouchend={handleMainTouchEnd}
  >
    {#key currentDate}
      <div in:fly={{ x: 30, duration: 400, opacity: 0 }} out:fade={{ duration: 100 }} class="row-start-1 col-start-1 w-full h-full overflow-y-auto pt-4 pb-20 bg-surface-950 z-10">

    {#if loading}
      <div class="flex items-center justify-center py-20 bg-surface-950/80 backdrop-blur-sm relative z-50">
        <div class="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>

    {:else}
      <!-- ======= MOBILE: Single-Day View ======= -->
      <div class="md:hidden px-4 py-3 space-y-2">
        {#if dayEvents.length === 0}
          <div class="flex flex-col items-center justify-center py-24 text-center rounded-[3rem] bg-gradient-to-b from-surface-900/40 to-transparent border border-white/5 relative overflow-hidden group">
            <div class="absolute inset-0 bg-primary-500/5 opacity-0 group-hover:opacity-100 transition-opacity blur-3xl"></div>
            <div class="w-20 h-20 rounded-full bg-surface-800/80 flex items-center justify-center mb-6 text-3xl text-gray-500 border border-white/5 shadow-xl relative z-10">
               <svg class="w-10 h-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>
            </div>
            <p class="text-gray-400 font-black uppercase tracking-[0.3em] text-[11px] relative z-10">Geen lessen</p>
            <p class="text-gray-600 text-[10px] mt-2 font-medium tracking-tight relative z-10 px-8">Je hebt een heerlijk rustige dag voor de boeg.</p>
          </div>
        {:else}
          {#each dayEvents as event, j}
            {#if j > 0}
              {@const breakMins = getBreakDuration(dayEvents[j - 1], event)}
              {#if breakMins > 0}
                <div class="flex items-center gap-2 px-1 py-0.5">
                  <div class="h-px flex-1 bg-surface-700/50"></div>
                  <span class="text-[10px] text-gray-600 font-medium">{breakMins} min pauze</span>
                  <div class="h-px flex-1 bg-surface-700/50"></div>
                </div>
              {/if}
            {/if}
            <div
              role="button"
              tabindex="0"
              onclick={() => selectEvent(event)}
              onkeydown={(e) => e.key === 'Enter' && selectEvent(event)}
              class="w-full text-left rounded-3xl border transition-all active:scale-[0.97] cursor-pointer overflow-hidden flex {getEventColor(event)} {selectedEvent?.Id === event.Id ? 'ring-2 ring-primary-400/50 shadow-2xl shadow-primary-500/10' : ''}"
            >
              <!-- Status bar -->
              <div class="w-1.5 shrink-0 {getStatusColor(event)}"></div>
              
              <div class="flex-1 p-4">
                <!-- Title row -->
                <div class="flex items-start justify-between gap-2">
                  <p class="font-bold text-[15px] leading-tight {isCanceled(event) ? 'line-through opacity-50' : ''} flex-1 tracking-tight">
                    {event.Vakken?.[0]?.Naam ?? event.Omschrijving?.split(' - ')[0] ?? 'Afspraak'}
                  </p>
                  {#if infoTypeShort(event.InfoType)}
                    <span class="shrink-0 text-[9px] font-black uppercase tracking-widest bg-black/30 px-2 py-1 rounded-lg border border-white/5 shadow-inner">{infoTypeShort(event.InfoType)}</span>
                  {/if}
                </div>
                <!-- Meta row -->
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] font-medium opacity-85">
                  {#if !event.DuurtHeleDag && event.LesuurVan}
                    <span class="px-1.5 py-0.5 bg-white/5 rounded-md text-primary-300 font-bold">{event.LesuurVan}{event.LesuurTotMet && event.LesuurTotMet !== event.LesuurVan ? `–${event.LesuurTotMet}` : ''}e</span>
                  {/if}
                  <span class="flex items-center gap-1">
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                    {eventTimeLabel(event)}
                  </span>
                  {#if event.Lokalen?.[0]?.Naam}
                    <span class="flex items-center gap-1">
                      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m2 22 1-1h3l9-9"/><path d="M22 17v5h-5"/><path d="M4.46 7.16 2 9v11l2 2h11l2-2.46"/><path d="M17 13.5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10"/><path d="M15 2H9a2 2 0 0 0-2 2v6"/><path d="M12 2v3"/><path d="M12 21v-3"/></svg>
                      {event.Lokalen[0].Naam}
                    </span>
                  {/if}
                </div>

                <!-- Homework preview snippet -->
                {#if event.Inhoud && selectedEvent?.Id !== event.Id}
                  <p class="text-[10px] text-gray-400 mt-2 line-clamp-1 opacity-60">
                    {event.Inhoud.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')}
                  </p>
                {/if}

                <!-- Expanded content -->
                {#if selectedEvent?.Id === event.Id}
                  <div class="mt-4 pt-4 border-t border-white/10 space-y-3">
                    {#if event.Inhoud}
                      <div class="text-xs leading-relaxed opacity-90 prose prose-invert prose-xs max-w-none">{@html event.Inhoud}</div>
                    {:else}
                      <p class="text-[11px] opacity-40 italic">Geen aanvullende informatie</p>
                    {/if}

                    {#if event.Bijlagen && event.Bijlagen.length > 0}
                      <div class="space-y-2 mt-4">
                        <p class="text-[10px] font-black text-gray-500 uppercase tracking-widest">Bijlagen ({event.Bijlagen.length})</p>
                        <div class="grid grid-cols-1 gap-2">
                          {#each event.Bijlagen as bijlage}
                            <button 
                              onclick={(e) => { e.stopPropagation(); downloadAttachment(bijlage); }}
                              class="flex items-center justify-between p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group/file text-left"
                            >
                              <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-xl bg-surface-900 flex items-center justify-center text-primary-400 group-hover/file:scale-110 transition-transform">
                                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                                </div>
                                <span class="text-xs font-bold text-gray-300 truncate max-w-[200px]">{bijlage.Naam ?? 'Bijlage'}</span>
                              </div>
                              <svg class="w-4 h-4 text-gray-600 group-hover/file:text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                            </button>
                          {/each}
                        </div>
                      </div>
                    {/if}
                    
                    <div class="flex items-center justify-between pt-1">
                      {#if event.Docenten?.[0]?.Naam}
                        <div class="flex items-center gap-2">
                          <div class="w-6 h-6 rounded-full bg-surface-700 flex items-center justify-center text-[10px] font-bold text-primary-400 border border-white/5">
                            {formatTeacherName(event.Docenten[0].Naam)?.[0] ?? '?'}
                          </div>
                          <span class="text-[11px] font-semibold text-gray-400">{formatTeacherName(event.Docenten[0].Naam)}</span>
                        </div>
                      {/if}

                      <div class="flex items-center gap-2">
                        {#if event.self_url}
                          <button
                            onclick={(e) => { e.stopPropagation(); deleteEvent(event); }}
                            class="p-2 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-all"
                            aria-label="Verwijderen"
                          >
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                          </button>
                          <button
                            onclick={(e) => { e.stopPropagation(); editEvent(event); }}
                            class="p-2 rounded-xl bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 border border-primary-500/20 transition-all"
                            aria-label="Bewerken"
                          >
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                          </button>
                        {/if}

                        {#if event.Afgerond !== undefined && event.InfoType !== 0}
                          <button 
                            onclick={(e) => { e.stopPropagation(); toggleHomeworkDone(); }}
                            class="flex items-center justify-center gap-2.5 px-5 py-2.5 rounded-2xl transition-all shadow-lg hover:scale-[1.02] active:scale-95 border
                                   {selectedEvent.Afgerond 
                                     ? 'bg-green-500 text-white border-green-400 shadow-green-500/20' 
                                     : 'bg-primary-500 text-white border-primary-400 shadow-primary-500/20'}"
                          >
                            <div class="w-5 h-5 rounded-full border-2 flex items-center justify-center
                                        {selectedEvent.Afgerond ? 'border-separator text-white' : 'border-white/50 bg-primary-600'}">
                              {#if selectedEvent.Afgerond}
                                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>
                              {/if}
                            </div>
                            <span class="text-[11px] font-black uppercase tracking-widest">{selectedEvent.Afgerond ? 'Afgerond' : 'Afronden'}</span>
                          </button>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        {/if}

      </div>

      <!-- ======= DESKTOP: Week View ======= -->
      <div class="hidden md:block p-6">
        <div class="rounded-2xl overflow-hidden border border-surface-800/50">
          <!-- Day headers -->
          <div class="grid grid-cols-5 border-b border-surface-800 bg-surface-900/40">
            {#each getWeekDates() as date, i}
              {@const today = isToday(date)}
              <div class="text-center py-4 border-r border-surface-800 last:border-r-0 {today ? 'bg-primary-500/10 relative overflow-hidden' : ''}">
                {#if today}
                  <div class="absolute top-0 left-0 right-0 h-1 bg-primary-500 shadow-[0_0_10px_rgba(var(--m3-primary-rgb),0.5)]"></div>
                {/if}
                <p class="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">{weekDays[i]}</p>
                <p class="text-2xl font-black {today ? 'text-primary-400' : 'text-gray-200'} tracking-tighter">{date.getDate()}</p>
                <p class="text-[10px] font-bold text-gray-600 uppercase tracking-tight">{date.toLocaleDateString('nl-NL', { month: 'short' })}</p>
              </div>
            {/each}
          </div>
          <!-- Events grid -->
          <div class="grid grid-cols-5 min-h-[500px] bg-surface-900/20">
            {#each getWeekDates() as date, i}
              {@const dayEvents = getEventsForDay(date)}
              {@const today = isToday(date)}
              <div class="border-r border-surface-700/20 last:border-r-0 p-2 space-y-1.5 {today ? 'bg-primary-500/5' : ''}">
                {#each dayEvents as event, j}
                  {#if j > 0}
                    {@const brk = getBreakDuration(dayEvents[j-1], event)}
                    {#if brk > 0}
                      <div class="text-[9px] text-gray-600 text-center py-0.5">{brk}m</div>
                    {/if}
                  {/if}
                  <button onclick={() => selectEvent(event)}
                    class="w-full text-left rounded-xl border transition-all hover:scale-[1.02] hover:shadow-xl flex overflow-hidden
                           {getEventColor(event)}
                           {selectedEvent?.Id === event.Id ? 'ring-2 ring-primary-500' : ''}">
                    <div class="w-1 shrink-0 {getStatusColor(event)} opacity-60"></div>
                    <div class="p-2 min-w-0">
                      <p class="font-bold text-[11px] truncate tracking-tight {isCanceled(event) ? 'line-through opacity-50' : ''}">
                        {event.Vakken?.[0]?.Naam ?? event.Omschrijving?.split(' - ')[0] ?? '—'}
                      </p>
                      <p class="text-[9px] font-medium opacity-80 mt-0.5 truncate flex items-center gap-1">
                        <span class="text-primary-300 font-bold">{eventTimeLabelShort(event)}</span>
                        {#if event.Lokalen?.[0]?.Naam}<span>· {event.Lokalen[0].Naam}</span>{/if}
                      </p>
                    </div>
                  </button>
                {/each}
                {#if dayEvents.length === 0}
                  <p class="text-gray-700 text-xs text-center pt-6">—</p>
                {/if}
              </div>
            {/each}
          </div>
        </div>
        
        <!-- Desktop event detail -->
        {#if selectedEvent}
          <div class="mt-4 rounded-2xl bg-surface-900/60 border border-surface-800/50 p-5">
            <div class="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-100">{selectedEvent.Vakken?.[0]?.Naam ?? selectedEvent.Omschrijving ?? 'Afspraak'}</h3>
                {#if selectedEvent.Omschrijving}<p class="text-sm text-gray-500 mt-0.5">{selectedEvent.Omschrijving}</p>{/if}
              </div>
              <button onclick={() => selectedEvent = null} class="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><p class="text-xs text-gray-500 uppercase mb-1">Tijd</p><p class="text-gray-300">{eventTimeLabel(selectedEvent)}</p></div>
              {#if !selectedEvent.DuurtHeleDag && selectedEvent.LesuurVan}
                <div><p class="text-xs text-gray-500 uppercase mb-1">Lesuur</p><p class="text-gray-300">{selectedEvent.LesuurVan}{selectedEvent.LesuurTotMet ? `–${selectedEvent.LesuurTotMet}` : ''}</p></div>
              {/if}
              {#if selectedEvent.Lokalen?.[0]?.Naam}
                <div><p class="text-xs text-gray-500 uppercase mb-1">Lokaal</p><p class="text-gray-300">{selectedEvent.Lokalen.map((l:any) => l.Naam).join(', ')}</p></div>
              {/if}
              {#if selectedEvent.Docenten?.[0]?.Naam}
                <div><p class="text-xs text-gray-500 uppercase mb-1">Docent</p><p class="text-gray-300">{selectedEvent.Docenten.map((d:any) => formatTeacherName(d.Naam)).join(', ')}</p></div>
              {/if}
            </div>

            {#if isEditing}
              <div class="mt-4 space-y-2">
                <textarea bind:value={draftInhoud} class="w-full h-28 bg-surface-800 border border-surface-700 rounded-lg p-3 text-sm text-gray-200 focus:outline-none focus:border-primary-500 resize-none"></textarea>
                <div class="flex gap-2">
                  <button onclick={() => isEditing = false} class="px-3 py-1.5 rounded-lg bg-surface-700 text-gray-300 text-sm">Annuleren</button>
                  <button onclick={saveInhoud} class="px-3 py-1.5 rounded-lg bg-primary-500 text-on-primary font-bold text-xs uppercase tracking-widest shadow-lg shadow-primary-500/10 active:scale-95 transition-all">Opslaan</button>
                </div>
              </div>
            {:else}
              <div class="mt-4 group">
                <div class="flex items-center justify-between mb-1">
                  <p class="text-xs text-gray-500 uppercase">Inhoud</p>
                  <button onclick={startEditing} class="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded bg-surface-700">Bewerk</button>
                </div>
                {#if selectedEvent.Inhoud}
                  <div class="text-sm text-gray-300 prose prose-sm prose-invert max-w-none">{@html selectedEvent.Inhoud}</div>
                {:else}
                  <p class="text-sm text-gray-600 italic">Geen inhoud.</p>
                {/if}
              </div>
              {#if selectedEvent.Afgerond !== undefined && selectedEvent.InfoType !== 0}
                <button 
                  onclick={(e) => { e.stopPropagation(); toggleHomeworkDone(); }}
                  class="flex items-center gap-3 mt-6 px-6 py-3 w-max rounded-2xl transition-all shadow-xl hover:scale-105 active:scale-95 border
                         {selectedEvent.Afgerond 
                           ? 'bg-green-500 text-white border-green-400 shadow-green-500/20' 
                           : 'bg-primary-500 text-white border-primary-400 shadow-primary-500/20'}"
                >
                  <div class="w-5 h-5 rounded-full border-2 flex items-center justify-center
                              {selectedEvent.Afgerond ? 'border-white text-white' : 'border-white/50 bg-primary-600'}">
                    {#if selectedEvent.Afgerond}
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>
                    {/if}
                  </div>
                  <span class="text-sm font-black uppercase tracking-widest">{selectedEvent.Afgerond ? 'Afgerond' : 'Huiswerk Afronden'}</span>
                </button>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
  {/key}
</div>

<!-- ===== ADD EVENT MODAL ===== -->
{#if showAddModal}
  <div class="fixed inset-0 bg-black/80 backdrop-blur-xl z-50 flex items-end md:items-center justify-center p-0 md:p-4">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0" onclick={() => showAddModal = false}></div>
    <div class="bg-surface-900 border border-white/5 rounded-t-[2.5rem] md:rounded-[2rem] w-full md:max-w-md shadow-2xl overflow-hidden relative z-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div class="px-8 py-6 border-b border-white/5 flex justify-between items-center bg-surface-900/50">
        <div>
          <h2 class="text-lg font-black text-white italic tracking-tighter">Nieuwe afspraak</h2>
          <div class="flex items-center gap-2 mt-0.5">
            <p class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Handmatig toevoegen</p>
            {#if newEventForm.start}
              <span class="text-[10px] px-2 py-0.5 rounded-full bg-primary-500/10 text-primary-400 border border-primary-500/20 font-black uppercase tracking-tighter">
                {new Date(newEventForm.start).toLocaleDateString('nl-NL', { weekday: 'long' })}
              </span>
            {/if}
          </div>
        </div>
        <button onclick={() => showAddModal = false} class="w-10 h-10 rounded-full bg-surface-800 text-gray-400 hover:text-white flex items-center justify-center transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <form onsubmit={(e) => { e.preventDefault(); submitNewEvent(); }} class="p-8 space-y-6">
        <div class="space-y-1.5">
          <label for="event-title" class="px-1 text-[10px] font-black text-gray-500 uppercase tracking-widest">Wat gaan we doen?</label>
          <input id="event-title" required type="text" bind:value={newEventForm.omschrijving}
            class="w-full bg-surface-800/50 border border-white/5 rounded-2xl px-4 py-3.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500/50 focus:ring-4 focus:ring-primary-500/10 transition-all"
            placeholder="Bijv. Tandartsbezoek" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label for="event-start" class="px-1 text-[10px] font-black text-gray-500 uppercase tracking-widest">Begin</label>
            <input id="event-start" required type="datetime-local" bind:value={newEventForm.start}
              class="w-full bg-surface-800/50 border border-white/5 rounded-2xl px-4 py-3.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500/50 focus:ring-4 focus:ring-primary-500/10 [&::-webkit-calendar-picker-indicator]:invert-[0.8]" />
          </div>
          <div class="space-y-1.5">
            <label for="event-einde" class="px-1 text-[10px] font-black text-gray-500 uppercase tracking-widest">Einde</label>
            <input id="event-einde" required type="datetime-local" bind:value={newEventForm.einde}
              class="w-full bg-surface-800/50 border border-white/5 rounded-2xl px-4 py-3.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500/50 focus:ring-4 focus:ring-primary-500/10 [&::-webkit-calendar-picker-indicator]:invert-[0.8]" />
          </div>
        </div>
        <div class="space-y-1.5">
          <label for="event-lokatie" class="px-1 text-[10px] font-black text-gray-500 uppercase tracking-widest">Waar is het?</label>
          <input id="event-lokatie" type="text" bind:value={newEventForm.lokatie}
            class="w-full bg-surface-800/50 border border-white/5 rounded-2xl px-4 py-3.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500/50 focus:ring-4 focus:ring-primary-500/10 transition-all"
            placeholder="Locatie (optioneel)" />
        </div>
        <div class="flex gap-4 pt-4">
            <button 
              type="submit"
              disabled={isSubmitting}
              class="flex-1 py-4 rounded-2xl bg-primary-500 text-on-primary font-black text-xs uppercase tracking-[0.2em] shadow-xl shadow-primary-500/20 disabled:opacity-50 active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              {#if isSubmitting}
                <div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
              {:else}
                Opslaan
              {/if}
            </button>
        </div>
      </form>
    </div>
  </div>
{/if}
</div>
