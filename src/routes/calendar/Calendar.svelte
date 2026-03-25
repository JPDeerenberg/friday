<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { getCalendarEvents, updateCalendarEvent, createCalendarEvent, formatDate, getWeekRange, infoTypeShort, infoTypeName } from '$lib/api';
  import { onMount } from 'svelte';

  let events = $state<any[]>([]);
  let loading = $state(true);
  let currentDate = $state(new Date());
  let hideCanceled = $state(false);
  let selectedEvent = $state<any | null>(null);

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
    const mq = window.matchMedia('(min-width: 768px)');
    isWeekView = mq.matches;
    const handler = (e: MediaQueryListEvent) => {
      isWeekView = e.matches;
      loadEvents();
    };
    mq.addEventListener('change', handler);
    loadEvents();
    return () => mq.removeEventListener('change', handler);
  });

  const weekDays = ['Ma', 'Di', 'Wo', 'Do', 'Vr'];

  async function loadEvents() {
    const pid = $personId;
    if (!pid) return;
    loading = true;
    try {
      if (isWeekView) {
        const { start, end } = getWeekRange(currentDate);
        events = await getCalendarEvents(pid, start, end);
      } else {
        // Load ±3 days so prev/next navigation is instant
        const from = new Date(currentDate.getTime() - 3 * 86400000);
        const to   = new Date(currentDate.getTime() + 3 * 86400000);
        events = await getCalendarEvents(pid, formatDate(from), formatDate(to));
      }
      events.sort((a, b) => a.Start.localeCompare(b.Start));
    } catch (e) {
      console.error('Failed to load events:', e);
    }
    loading = false;
  }

  function nextWeek() {
    currentDate = new Date(currentDate.getTime() + 7 * 86400000);
    loadEvents();
  }
  function prevWeek() {
    currentDate = new Date(currentDate.getTime() - 7 * 86400000);
    loadEvents();
  }
  function nextDay() {
    currentDate = new Date(currentDate.getTime() + 86400000);
    // Only reload if we're near the edge of our cached window
    const dayStr = formatDate(currentDate);
    const hasEvents = events.some(e => e.Start?.startsWith(dayStr));
    if (!hasEvents) loadEvents();
  }
  function prevDay() {
    currentDate = new Date(currentDate.getTime() - 86400000);
    const dayStr = formatDate(currentDate);
    const hasEvents = events.some(e => e.Start?.startsWith(dayStr));
    if (!hasEvents) loadEvents();
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
    if (isCanceled(event)) return 'bg-gray-700/30 border-gray-600/30 text-gray-500';
    if (event.InfoType >= 2 && event.InfoType <= 5) return 'bg-orange-500/10 border-orange-500/30 text-orange-300';
    if (event.InfoType === 1) return 'bg-accent-500/10 border-accent-500/30 text-accent-300';
    return 'bg-primary-500/10 border-primary-500/30 text-primary-300';
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
      const updated = { ...selectedEvent, Inhoud: draftInhoud };
      await updateCalendarEvent(selectedEvent.self_url, JSON.stringify(updated));
      selectedEvent.Inhoud = draftInhoud;
      events = events.map(e => e.Id === updated.Id ? updated : e);
      isEditing = false;
    } catch (e) {
      alert('Kon de inhoud niet opslaan.');
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

  async function submitNewEvent() {
    if (!$personId || !newEventForm.omschrijving || !newEventForm.start || !newEventForm.einde) return;
    isSubmitting = true;
    try {
      await createCalendarEvent({
        personId: $personId,
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
</script>

<!-- ===== PAGE WRAPPER ===== -->
<div class="flex flex-col h-full bg-surface-950">

  <!-- ===== STICKY MOBILE HEADER ===== -->
  <div class="md:hidden sticky top-0 z-10 bg-surface-950/95 backdrop-blur border-b border-surface-800/50 px-4 py-3 space-y-3">
    <!-- Top row: title + add button -->
    <div class="flex items-center justify-between">
      <h1 class="text-lg font-bold text-gray-100">Agenda</h1>
      <div class="flex items-center gap-2">
        <button onclick={goToday} class="px-3 py-1.5 rounded-lg bg-surface-800 text-gray-300 text-xs font-medium active:bg-surface-700">
          Vandaag
        </button>
        <button onclick={openAddModal} class="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-xs font-semibold active:bg-primary-500">
          + Afspraak
        </button>
      </div>
    </div>

    <!-- Day navigation -->
    <div class="flex items-center gap-2">
      <button onclick={nextDay}
        class="w-10 h-10 rounded-xl bg-surface-800 text-gray-300 active:bg-surface-700 flex items-center justify-center text-lg font-bold flex-shrink-0">
        ›
      </button>
    </div>

    <!-- Current day label -->
    <p class="text-sm font-semibold text-gray-100 capitalize text-center -mt-1">
      {mobileDayLabel(currentDate)}
    </p>
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
      <button onclick={openAddModal} class="px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-sm font-semibold">
        + Afspraak
      </button>
    </div>
  </div>

  <!-- ===== MAIN SCROLLABLE AREA ===== -->
  <div class="flex-1 overflow-y-auto">

    {#if loading}
      <div class="flex items-center justify-center py-20">
        <div class="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>

    {:else}
      <!-- ======= MOBILE: Single-Day View ======= -->
      <div class="md:hidden px-4 py-3 space-y-2">
        {#if dayEvents.length === 0}
          <div class="flex flex-col items-center justify-center py-20 text-center rounded-[2.5rem] bg-surface-900/40 border border-white/5 opacity-60">
            <div class="w-16 h-16 rounded-full bg-surface-800 flex items-center justify-center mb-4 text-2xl text-gray-500">
               <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>
            </div>
            <p class="text-gray-400 font-black uppercase tracking-[0.2em] text-[10px]">Geen lessen vandaag</p>
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
            <button
              onclick={() => selectEvent(event)}
              class="w-full text-left rounded-2xl border p-4 transition-all active:scale-[0.98]
                     {getEventColor(event)}
                     {selectedEvent?.Id === event.Id ? 'ring-2 ring-primary-400/70' : ''}"
            >
              <!-- Title row -->
              <div class="flex items-start justify-between gap-2">
                <p class="font-semibold text-sm leading-snug {isCanceled(event) ? 'line-through opacity-50' : ''} flex-1">
                  {event.Vakken?.[0]?.Naam ?? event.Omschrijving?.split(' - ')[0] ?? 'Afspraak'}
                </p>
                {#if infoTypeShort(event.InfoType)}
                  <span class="shrink-0 text-[10px] font-bold bg-black/20 px-1.5 py-0.5 rounded-md">{infoTypeShort(event.InfoType)}</span>
                {/if}
              </div>
              <!-- Meta row -->
              <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs opacity-70">
                {#if !event.DuurtHeleDag && event.LesuurVan}
                  <span class="font-bold">{event.LesuurVan}{event.LesuurTotMet && event.LesuurTotMet !== event.LesuurVan ? `–${event.LesuurTotMet}` : ''}e</span>
                {/if}
                <span>{eventTimeLabel(event)}</span>
                {#if event.Lokalen?.[0]?.Naam}<span>· {event.Lokalen[0].Naam}</span>{/if}
                {#if event.Docenten?.[0]?.Naam}<span>· {event.Docenten[0].Naam}</span>{/if}
              </div>

              <!-- Expanded content -->
              {#if selectedEvent?.Id === event.Id}
                <div class="mt-3 pt-3 border-t border-current/20 space-y-2">
                  {#if event.Inhoud}
                    <div class="text-xs opacity-80 prose prose-xs prose-invert max-w-none">{@html event.Inhoud}</div>
                  {:else}
                    <p class="text-xs opacity-50 italic">Geen huiswerkinhoud</p>
                  {/if}
                  {#if event.Afgerond !== undefined && event.InfoType !== 0}
                    <button
                      onclick={(e) => { e.stopPropagation(); toggleHomeworkDone(); }}
                      class="flex items-center gap-2 text-xs font-semibold mt-2 opacity-90"
                    >
                      <span class="w-5 h-5 rounded border-2 border-current/60 flex items-center justify-center text-[10px]">
                        {event.Afgerond ? '✓' : ''}
                      </span>
                      {event.Afgerond ? 'Afgerond — tik om ongedaan te maken' : 'Markeer als afgerond'}
                    </button>
                  {/if}
                </div>
              {/if}
            </button>
          {/each}
        {/if}

        <!-- Hide canceled toggle -->
        <label class="flex items-center gap-2 cursor-pointer mt-3 px-1">
          <div class="relative inline-flex items-center">
            <input type="checkbox" bind:checked={hideCanceled} class="sr-only peer" />
            <div class="w-9 h-5 bg-surface-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-500"></div>
          </div>
          <span class="text-sm text-gray-400">Verberg uitval</span>
        </label>
      </div>

      <!-- ======= DESKTOP: Week View ======= -->
      <div class="hidden md:block p-6">
        <div class="rounded-2xl overflow-hidden border border-surface-800/50">
          <!-- Day headers -->
          <div class="grid grid-cols-5 border-b border-surface-800">
            {#each getWeekDates() as date, i}
              {@const today = isToday(date)}
              <div class="text-center py-3 border-r border-surface-700/30 last:border-r-0 {today ? 'bg-primary-500/10' : ''}">
                <p class="text-xs text-gray-500 uppercase">{weekDays[i]}</p>
                <p class="text-lg font-bold {today ? 'text-primary-400' : 'text-gray-300'}">{date.getDate()}</p>
                <p class="text-xs text-gray-600">{date.toLocaleDateString('nl-NL', { month: 'short' })}</p>
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
                    class="w-full text-left text-xs rounded-lg border p-2 transition-all hover:brightness-110
                           {getEventColor(event)}
                           {selectedEvent?.Id === event.Id ? 'ring-1 ring-primary-400' : ''}">
                    <p class="font-semibold truncate {isCanceled(event) ? 'line-through opacity-50' : ''}">
                      {event.Vakken?.[0]?.Naam ?? event.Omschrijving?.split(' - ')[0] ?? '—'}
                    </p>
                    <p class="opacity-70 mt-0.5 truncate">{eventTimeLabelShort(event)}{event.Lokalen?.[0]?.Naam ? ` · ${event.Lokalen[0].Naam}` : ''}</p>
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
                <div><p class="text-xs text-gray-500 uppercase mb-1">Docent</p><p class="text-gray-300">{selectedEvent.Docenten.map((d:any) => d.Naam).join(', ')}</p></div>
              {/if}
            </div>

            {#if isEditing}
              <div class="mt-4 space-y-2">
                <textarea bind:value={draftInhoud} class="w-full h-28 bg-surface-800 border border-surface-700 rounded-lg p-3 text-sm text-gray-200 focus:outline-none focus:border-primary-500 resize-none"></textarea>
                <div class="flex gap-2">
                  <button onclick={() => isEditing = false} class="px-3 py-1.5 rounded-lg bg-surface-700 text-gray-300 text-sm">Annuleren</button>
                  <button onclick={saveInhoud} class="px-3 py-1.5 rounded-lg bg-primary-600 text-white font-medium text-sm">Opslaan</button>
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
                <label class="flex items-center gap-3 cursor-pointer mt-4 w-fit">
                  <input type="checkbox" checked={selectedEvent.Afgerond} onchange={toggleHomeworkDone}
                    class="h-5 w-5 cursor-pointer rounded border border-surface-600 bg-surface-800 checked:border-accent-500 checked:bg-accent-500 transition-all appearance-none" />
                  <span class="text-sm {selectedEvent.Afgerond ? 'line-through text-gray-500' : 'text-gray-300'}">
                    {selectedEvent.Afgerond ? 'Afgerond' : 'Markeer als afgerond'}
                  </span>
                </label>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- ===== ADD EVENT MODAL ===== -->
{#if showAddModal}
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4">
    <div class="bg-surface-900 border border-surface-700/50 rounded-t-3xl md:rounded-2xl w-full md:max-w-md shadow-2xl overflow-hidden">
      <div class="px-6 py-4 border-b border-surface-800 flex justify-between items-center">
        <h2 class="text-base font-semibold text-gray-100">Nieuwe afspraak</h2>
        <button onclick={() => showAddModal = false} class="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
      </div>
      <form onsubmit={(e) => { e.preventDefault(); submitNewEvent(); }} class="p-5 space-y-4">
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider">Titel</label>
          <input required type="text" bind:value={newEventForm.omschrijving}
            class="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500"
            placeholder="Bijv. Tandarts" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider">Start</label>
            <input required type="datetime-local" bind:value={newEventForm.start}
              class="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500 [&::-webkit-calendar-picker-indicator]:invert-[0.8]" />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider">Einde</label>
            <input required type="datetime-local" bind:value={newEventForm.einde}
              class="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500 [&::-webkit-calendar-picker-indicator]:invert-[0.8]" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider">Locatie (optioneel)</label>
          <input type="text" bind:value={newEventForm.lokatie}
            class="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500" />
        </div>
        <div class="flex gap-3 pt-1">
          <button type="button" onclick={() => showAddModal = false}
            class="flex-1 py-2.5 rounded-xl bg-surface-800 hover:bg-surface-700 text-gray-300 font-medium text-sm">Annuleren</button>
          <button type="submit" disabled={isSubmitting}
            class="flex-1 py-2.5 rounded-xl bg-primary-600 hover:bg-primary-500 text-white font-semibold text-sm disabled:opacity-50">
            {isSubmitting ? 'Opslaan...' : 'Toevoegen'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
