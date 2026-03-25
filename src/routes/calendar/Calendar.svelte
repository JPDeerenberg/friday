<script lang="ts">
  import { personId } from '$lib/stores';
  import { getCalendarEvents, updateCalendarEvent, createCalendarEvent, formatDate, getWeekRange, infoTypeShort, infoTypeName } from '$lib/api';
  import { onMount } from 'svelte';

  let events = $state<any[]>([]);
  let loading = $state(true);
  let currentDate = $state(new Date());
  let datePickerValue = $state(formatDate(new Date()));
  let hideCanceled = $state(false);
  let selectedEvent = $state<any | null>(null);

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

  // Mobile: detect if narrow viewport
  let isMobile = $state(false);

  onMount(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    isMobile = mq.matches;
    const handler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  const weekDays = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

  $effect(() => {
    const d = new Date(datePickerValue);
    if (!isNaN(d.getTime()) && formatDate(d) !== formatDate(currentDate)) {
      currentDate = d;
    }
  });

  $effect(() => {
    datePickerValue = formatDate(currentDate);
  });

  $effect(() => {
    loadEvents();
  });

  async function loadEvents() {
    const pid = $personId;
    if (!pid) return;
    loading = true;

    if (isMobile) {
      // On mobile, load just the current day
      const dayStr = formatDate(currentDate);
      try {
        events = await getCalendarEvents(pid, dayStr, dayStr);
        events.sort((a, b) => a.Start.localeCompare(b.Start));
      } catch (e) {
        console.error('Failed to load events:', e);
      }
    } else {
      // On desktop, load the full week
      const { start, end } = getWeekRange(currentDate);
      try {
        events = await getCalendarEvents(pid, start, end);
        events.sort((a, b) => a.Start.localeCompare(b.Start));
      } catch (e) {
        console.error('Failed to load events:', e);
      }
    }
    loading = false;
  }

  // Reload when isMobile changes (e.g. resize)
  $effect(() => {
    // isMobile is a dependency
    void isMobile;
    loadEvents();
  });

  function nextWeek() {
    currentDate = new Date(currentDate.getTime() + 7 * 86400000);
  }

  function prevWeek() {
    currentDate = new Date(currentDate.getTime() - 7 * 86400000);
  }

  function nextDay() {
    currentDate = new Date(currentDate.getTime() + 86400000);
  }

  function prevDay() {
    currentDate = new Date(currentDate.getTime() - 86400000);
  }

  function goToday() {
    currentDate = new Date();
  }

  function getWeekDates(): Date[] {
    const { start } = getWeekRange(currentDate);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }

  function getEventsForDay(date: Date): any[] {
    const dayStr = formatDate(date);
    let dayEvents = events.filter(e => e.Start?.startsWith(dayStr));
    if (hideCanceled) {
      dayEvents = dayEvents.filter(e => !isCanceled(e));
    }
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
    if (event.Status === 4 || event.Status === 5) return 'bg-gray-700/30 border-gray-600/30 text-gray-500';
    if (event.InfoType >= 2 && event.InfoType <= 5) return 'bg-orange-500/10 border-orange-500/30 text-orange-300';
    if (event.InfoType === 1) return 'bg-accent-500/10 border-accent-500/30 text-accent-300';
    return 'bg-primary-500/10 border-primary-500/30 text-primary-300';
  }

  function isCanceled(event: any): boolean {
    return event.Status === 4 || event.Status === 5;
  }

  function getBreakDuration(prev: any, curr: any): number {
    if (!prev?.Einde || !curr?.Start) return 0;
    const d1 = new Date(prev.Einde).getTime();
    const d2 = new Date(curr.Start).getTime();
    const diff = Math.max(0, d2 - d1);
    return Math.floor(diff / 60000);
  }

  function startEditing() {
    if (!selectedEvent) return;
    draftInhoud = selectedEvent.Inhoud ?? '';
    isEditing = true;
  }

  function selectEvent(event: any) {
    if (selectedEvent?.Id === event.Id) {
      selectedEvent = null;
    } else {
      selectedEvent = event;
    }
    isEditing = false;
  }

  async function saveInhoud() {
    if (!selectedEvent || !selectedEvent.self_url) return;
    try {
      const updated = { ...selectedEvent, Inhoud: draftInhoud };
      await updateCalendarEvent(selectedEvent.self_url, JSON.stringify(updated));
      selectedEvent.Inhoud = draftInhoud;
      updateEventInList(updated);
      isEditing = false;
    } catch (e) {
      console.error('Failed to save contents:', e);
      alert('Kon de inhoud niet opslaan.');
    }
  }

  async function toggleHomeworkDone() {
    if (!selectedEvent || !selectedEvent.self_url) return;
    const newStatus = !selectedEvent.Afgerond;
    try {
      const updated = { ...selectedEvent, Afgerond: newStatus };
      await updateCalendarEvent(selectedEvent.self_url, JSON.stringify(updated));
      selectedEvent.Afgerond = newStatus;
      updateEventInList(updated);
    } catch (e) {
      console.error('Failed to update homework state:', e);
      alert('Kon de huiswerkstatus niet bijwerken.');
    }
  }

  function updateEventInList(updated: any) {
    const idx = events.findIndex(e => e.Id === updated.Id);
    if (idx !== -1) {
      events[idx] = updated;
    }
  }

  function openAddModal() {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const startIso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
    const end = new Date(now.getTime() + 60 * 60000);
    const endIso = new Date(end.getTime() - (end.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);

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
      console.error('Failed to create event:', e);
      alert('Kon de afspraak niet maken.');
    }
    isSubmitting = false;
  }

  // Friendly day label for mobile header
  function mobileDayLabel(date: Date): string {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86400000);
    const yesterday = new Date(today.getTime() - 86400000);
    if (formatDate(date) === formatDate(today)) return 'Vandaag';
    if (formatDate(date) === formatDate(tomorrow)) return 'Morgen';
    if (formatDate(date) === formatDate(yesterday)) return 'Gisteren';
    return date.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  }
</script>

<div class="p-4 md:p-6 max-w-7xl mx-auto">
  <!-- Header -->
  <div class="flex items-center justify-between mb-4 md:mb-6">
    <div class="flex items-center gap-3">
      <h1 class="text-xl md:text-2xl font-bold text-gray-100">Agenda</h1>
      <button onclick={openAddModal} class="px-3 py-1.5 rounded-lg bg-accent-500/20 text-accent-400 hover:bg-accent-500/30 text-sm font-medium flex items-center gap-1.5 transition-colors">
        <span class="text-lg leading-none">+</span><span class="hidden sm:inline">Afspraak</span>
      </button>
    </div>

    <!-- Desktop controls -->
    <div class="hidden md:flex items-center gap-4">
      <label class="flex items-center gap-2 cursor-pointer">
        <div class="relative inline-flex items-center">
          <input type="checkbox" bind:checked={hideCanceled} class="sr-only peer" />
          <div class="w-9 h-5 bg-surface-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-500"></div>
        </div>
        <span class="text-sm text-gray-400">Verberg uitval</span>
      </label>
      <div class="flex items-center gap-2">
        <button onclick={prevWeek} class="px-3 py-2 rounded-lg bg-surface-800 text-gray-300 hover:bg-surface-700 text-sm">‹</button>
        <button onclick={goToday} class="px-3 py-2 rounded-lg bg-primary-500/15 text-primary-400 hover:bg-primary-500/25 text-sm font-medium">Vandaag</button>
        <input type="date" bind:value={datePickerValue} class="bg-surface-800 text-gray-300 border border-surface-700 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-primary-500" />
        <button onclick={nextWeek} class="px-3 py-2 rounded-lg bg-surface-800 text-gray-300 hover:bg-surface-700 text-sm">›</button>
      </div>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else if isMobile}
    <!-- ============ MOBILE: Day View ============ -->
    <!-- Day navigation strip -->
    <div class="flex items-center justify-between mb-3">
      <button onclick={prevDay} class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-800 text-gray-300 active:bg-surface-700 text-sm">
        ‹ <span class="hidden xs:inline">Gisteren</span>
      </button>
      <div class="text-center">
        <p class="text-sm font-semibold text-gray-100 capitalize">{mobileDayLabel(currentDate)}</p>
        <p class="text-xs text-gray-500">{currentDate.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}</p>
      </div>
      <button onclick={nextDay} class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-800 text-gray-300 active:bg-surface-700 text-sm">
        <span class="hidden xs:inline">Morgen</span> ›
      </button>
    </div>

    <!-- Scrollable day strip (tap to jump to that day) -->
    <div class="flex gap-2 overflow-x-auto no-scrollbar mb-4 pb-1">
      {#each getWeekDates().slice(0, 5) as date, i}
        {@const isSelected = formatDate(date) === formatDate(currentDate)}
        {@const isToday = formatDate(date) === formatDate(new Date())}
        <button
          onclick={() => { currentDate = date; }}
          class="flex flex-col items-center px-3 py-2 rounded-2xl shrink-0 transition-all
                 {isSelected ? 'bg-primary-500 text-white shadow-lg' : isToday ? 'bg-primary-500/15 text-primary-400' : 'bg-surface-800 text-gray-400'}"
        >
          <span class="text-[10px] font-bold uppercase">{weekDays[i]}</span>
          <span class="text-lg font-bold leading-tight">{date.getDate()}</span>
        </button>
      {/each}
    </div>

    <!-- Day events list -->
    {@const dayEvents = getEventsForDay(currentDate).filter(e => !hideCanceled || !isCanceled(e))}
    {#if dayEvents.length === 0}
      <div class="glass rounded-2xl flex flex-col items-center justify-center py-16 text-center">
        <span class="text-4xl mb-3">🏖️</span>
        <p class="text-gray-400 font-medium">Geen lessen</p>
        <p class="text-xs text-gray-600 mt-1">Geniet van je vrije tijd!</p>
      </div>
    {:else}
      <div class="space-y-2">
        {#each dayEvents as event, j}
          {#if j > 0}
            {@const breakMins = getBreakDuration(dayEvents[j-1], event)}
            {#if breakMins > 0}
              <div class="flex items-center gap-2 px-2">
                <div class="h-px bg-surface-700/50 flex-1"></div>
                <span class="text-[10px] text-gray-600">{breakMins}m pauze</span>
                <div class="h-px bg-surface-700/50 flex-1"></div>
              </div>
            {/if}
          {/if}
          <button
            onclick={() => selectEvent(event)}
            class="w-full text-left p-4 rounded-2xl border transition-all active:scale-[0.98]
                   {getEventColor(event)}
                   {selectedEvent?.Id === event.Id ? 'ring-1 ring-primary-400' : ''}"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <p class="font-semibold text-sm {isCanceled(event) ? 'line-through' : ''} truncate">
                  {event.Vakken?.[0]?.Naam ?? event.Omschrijving?.split(' - ')[0] ?? '—'}
                </p>
                <div class="flex items-center gap-2 mt-1 text-xs opacity-75">
                  {#if !event.DuurtHeleDag && event.LesuurVan}
                    <span class="font-bold">{event.LesuurVan}{event.LesuurTotMet && event.LesuurTotMet !== event.LesuurVan ? `-${event.LesuurTotMet}` : ''}e</span>
                  {/if}
                  <span>{eventTimeLabel(event)}</span>
                  {#if event.Lokalen?.[0]?.Naam}
                    <span>• {event.Lokalen[0].Naam}</span>
                  {/if}
                </div>
                {#if event.Docenten?.[0]?.Naam}
                  <p class="text-[11px] opacity-60 mt-0.5">{event.Docenten[0].Naam}</p>
                {/if}
              </div>
              {#if infoTypeShort(event.InfoType)}
                <span class="shrink-0 text-[10px] font-bold opacity-75 mt-0.5">{infoTypeShort(event.InfoType)}</span>
              {/if}
            </div>

            <!-- Expanded detail (shown when selected) -->
            {#if selectedEvent?.Id === event.Id}
              <div class="mt-3 pt-3 border-t border-current/20 space-y-2">
                {#if event.Inhoud}
                  <div class="text-xs opacity-80 prose prose-xs prose-invert max-w-none">{@html event.Inhoud}</div>
                {/if}
                {#if event.Afgerond !== undefined}
                  <button
                    onclick={(e) => { e.stopPropagation(); toggleHomeworkDone(); }}
                    class="flex items-center gap-2 text-xs font-medium opacity-80"
                  >
                    <span class="w-4 h-4 rounded border border-current/50 flex items-center justify-center">
                      {#if event.Afgerond}✓{/if}
                    </span>
                    {event.Afgerond ? 'Afgerond' : 'Markeer als afgerond'}
                  </button>
                {/if}
              </div>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Hide canceled toggle (mobile, below list) -->
      <label class="flex items-center gap-2 cursor-pointer mt-4 px-1">
        <div class="relative inline-flex items-center">
          <input type="checkbox" bind:checked={hideCanceled} class="sr-only peer" />
          <div class="w-9 h-5 bg-surface-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-500"></div>
        </div>
        <span class="text-sm text-gray-400">Verberg uitval</span>
      </label>
    {/if}

  {:else}
    <!-- ============ DESKTOP: Week View ============ -->
    <div class="glass rounded-2xl overflow-hidden">
      <!-- Day headers -->
      <div class="grid grid-cols-5 border-b border-surface-700/50">
        {#each getWeekDates().slice(0, 5) as date, i}
          {@const isToday = formatDate(date) === formatDate(new Date())}
          <div class="text-center py-3 border-r border-surface-700/30 last:border-r-0 {isToday ? 'bg-primary-500/10' : ''}">
            <p class="text-xs text-gray-500 uppercase">{weekDays[i]}</p>
            <p class="text-lg font-semibold {isToday ? 'text-primary-400' : 'text-gray-300'}">{date.getDate()}</p>
            <p class="text-xs text-gray-600">{date.toLocaleDateString('nl-NL', { month: 'short' })}</p>
          </div>
        {/each}
      </div>

      <!-- Events grid -->
      <div class="grid grid-cols-5 min-h-[500px]">
        {#each getWeekDates().slice(0, 5) as date, i}
          {@const dayEvents = getEventsForDay(date)}
          {@const isToday = formatDate(date) === formatDate(new Date())}
          <div class="border-r border-surface-700/30 last:border-r-0 p-2 space-y-1.5 {isToday ? 'bg-primary-500/5' : ''}">
            {#each dayEvents as event, j}
              {#if j > 0}
                {@const breakMins = getBreakDuration(dayEvents[j-1], event)}
                {#if breakMins > 0}
                  <div class="flex items-center justify-center py-0.5">
                    <div class="h-px bg-surface-700/50 flex-1"></div>
                    <span class="text-[10px] text-gray-500 px-1.5">{breakMins}m pauze</span>
                    <div class="h-px bg-surface-700/50 flex-1"></div>
                  </div>
                {/if}
              {/if}
              <button
                onclick={() => selectEvent(event)}
                class="w-full text-left p-2 rounded-lg border text-xs transition-all hover:scale-[1.02]
                       {getEventColor(event)}
                       {selectedEvent?.Id === event.Id ? 'ring-1 ring-primary-400' : ''}"
              >
                <div class="flex items-center justify-between gap-1">
                  <span class="font-semibold truncate {isCanceled(event) ? 'line-through' : ''}">
                    {event.Vakken?.[0]?.Naam ?? event.Omschrijving?.split(' - ')[0] ?? '—'}
                  </span>
                  {#if infoTypeShort(event.InfoType)}
                    <span class="shrink-0 text-[10px] font-bold opacity-75">{infoTypeShort(event.InfoType)}</span>
                  {/if}
                </div>
                <div class="flex items-center gap-1.5 mt-0.5 opacity-70">
                  <span>{eventTimeLabelShort(event)}</span>
                  {#if event.Lokalen?.[0]?.Naam}
                    <span>• {event.Lokalen[0].Naam}</span>
                  {/if}
                </div>
              </button>
            {/each}
            {#if dayEvents.length === 0}
              <p class="text-gray-700 text-xs text-center py-8">—</p>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- Event detail panel (desktop) -->
    {#if selectedEvent}
      <div class="glass rounded-2xl p-5 mt-4">
        <div class="flex items-start justify-between">
          <div>
            <h3 class="text-lg font-semibold text-gray-100">
              {selectedEvent.Vakken?.[0]?.Naam ?? selectedEvent.Omschrijving ?? 'Afspraak'}
            </h3>
            <p class="text-sm text-gray-500 mt-1">{selectedEvent.Omschrijving}</p>
          </div>
          <button onclick={() => selectedEvent = null} class="text-gray-500 hover:text-gray-300 text-lg">✕</button>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
          <div>
            <p class="text-xs text-gray-500 uppercase">Tijd</p>
            <p class="text-sm text-gray-300">{eventTimeLabel(selectedEvent)}</p>
          </div>
          {#if !selectedEvent.DuurtHeleDag && selectedEvent.LesuurVan}
            <div>
              <p class="text-xs text-gray-500 uppercase">Lesuur</p>
              <p class="text-sm text-gray-300">{selectedEvent.LesuurVan}{selectedEvent.LesuurTotMet ? ` - ${selectedEvent.LesuurTotMet}` : ''}</p>
            </div>
          {/if}
          {#if selectedEvent.Lokalen?.[0]?.Naam}
            <div>
              <p class="text-xs text-gray-500 uppercase">Lokaal</p>
              <p class="text-sm text-gray-300">{selectedEvent.Lokalen.map((l: any) => l.Naam).join(', ')}</p>
            </div>
          {/if}
          {#if selectedEvent.Docenten?.[0]?.Naam}
            <div>
              <p class="text-xs text-gray-500 uppercase">Docent</p>
              <p class="text-sm text-gray-300">{selectedEvent.Docenten.map((d: any) => d.Naam).join(', ')}</p>
            </div>
          {/if}
          {#if selectedEvent.InfoType > 0}
            <div>
              <p class="text-xs text-gray-500 uppercase">Type</p>
              <p class="text-sm text-gray-300">{infoTypeName(selectedEvent.InfoType)}</p>
            </div>
          {/if}
        </div>

        {#if isEditing}
          <div class="mt-4 p-3 rounded-xl bg-surface-800/50">
            <div class="flex items-center justify-between mb-2">
               <p class="text-xs text-gray-400 uppercase">Inhoud bewerken</p>
               <div class="flex gap-2">
                 <button onclick={() => isEditing = false} class="text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600 text-gray-300">Annuleren</button>
                 <button onclick={saveInhoud} class="text-xs px-2 py-1 rounded bg-primary-600 hover:bg-primary-500 text-white font-medium">Opslaan</button>
               </div>
            </div>
            <textarea
              bind:value={draftInhoud}
              class="w-full h-32 bg-surface-900 border border-surface-700 rounded-lg p-2 text-sm text-gray-200 focus:outline-none focus:border-primary-500"
              placeholder="Notities of huiswerk..."
            ></textarea>
          </div>
        {:else if selectedEvent.Inhoud !== undefined}
          <div class="mt-4 p-3 rounded-xl bg-surface-800/50 group relative">
            <div class="flex items-center justify-between mb-2">
              <p class="text-xs text-gray-500 uppercase">Inhoud</p>
              <button onclick={startEditing} class="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-surface-700 hover:bg-surface-600 text-gray-300 px-2 py-1 rounded">Bewerk</button>
            </div>
            <div class="text-sm text-gray-300 prose prose-sm prose-invert max-w-none">
              {@html selectedEvent.Inhoud || '<span class="italic text-gray-500">Geen inhoud. Klik op Bewerk om toe te voegen.</span>'}
            </div>
          </div>
        {/if}

        {#if selectedEvent.Afgerond !== undefined || selectedEvent.InfoType !== 0}
          <div class="mt-4 pt-3 border-t border-surface-700/50">
            <label class="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-surface-800/50 transition-colors inline-flex">
              <div class="relative flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={selectedEvent.Afgerond}
                  onchange={toggleHomeworkDone}
                  class="peer h-5 w-5 cursor-pointer appearance-none rounded border border-surface-600 bg-surface-800 checked:border-accent-500 checked:bg-accent-500 transition-all"
                />
                <svg class="absolute w-3.5 h-3.5 pointer-events-none opacity-0 peer-checked:opacity-100 text-white" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              </div>
              <span class="text-sm font-medium {selectedEvent.Afgerond ? 'text-gray-400 line-through' : 'text-gray-200'}">
                {selectedEvent.Afgerond ? 'Afgerond' : 'Markeer als afgerond'}
              </span>
            </label>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<!-- Add Appointment Modal -->
{#if showAddModal}
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
    <div class="bg-surface-900 border border-surface-700/50 rounded-t-3xl sm:rounded-2xl w-full sm:max-w-md shadow-2xl overflow-hidden shadow-black/50">
      <div class="px-6 py-4 border-b border-surface-800 flex justify-between items-center bg-surface-800/20">
        <h2 class="text-lg font-semibold text-gray-100">Nieuwe afspraak</h2>
        <button onclick={() => showAddModal = false} class="text-gray-500 hover:text-gray-300">✕</button>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); submitNewEvent(); }} class="p-6 space-y-4">
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider" for="title">Titel / Omschrijving</label>
          <input id="title" required type="text" bind:value={newEventForm.omschrijving}
            class="w-full bg-surface-950 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors"
            placeholder="Bijv. Tandarts" />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider" for="start">Start</label>
            <input id="start" required type="datetime-local" bind:value={newEventForm.start}
              class="w-full bg-surface-950 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors [&::-webkit-calendar-picker-indicator]:invert-[0.8]" />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider" for="end">Einde</label>
            <input id="end" required type="datetime-local" bind:value={newEventForm.einde}
              class="w-full bg-surface-950 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors [&::-webkit-calendar-picker-indicator]:invert-[0.8]" />
          </div>
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider" for="location">Locatie (Optioneel)</label>
          <input id="location" type="text" bind:value={newEventForm.lokatie}
            class="w-full bg-surface-950 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors" />
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider" for="content">Notities (Optioneel)</label>
          <textarea id="content" bind:value={newEventForm.inhoud}
            class="w-full h-24 bg-surface-950 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors resize-none"
          ></textarea>
        </div>

        <div class="flex gap-3 pt-2">
          <button type="button" onclick={() => showAddModal = false}
            class="flex-1 py-2.5 rounded-lg bg-surface-800 hover:bg-surface-700 text-gray-300 font-medium text-sm transition-colors">
            Annuleren
          </button>
          <button type="submit" disabled={isSubmitting}
            class="flex-1 py-2.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {isSubmitting ? 'Opslaan...' : 'Afspraak toevoegen'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
