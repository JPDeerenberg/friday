<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { getCalendarEvents, formatDate, getCalendarEvent, toggleCalendarEventDone } from '$lib/api';
  import HtmlRenderer from '$lib/components/HtmlRenderer.svelte';
  import { onMount } from 'svelte';
  import { fade, fly, slide, scale } from 'svelte/transition';

  let appointments = $state<any[]>([]);
  let selectedDate = $state(new Date());
  let loading = $state(true);
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

  async function loadAppointments() {
    const pid = $personId;
    if (!pid) return;
    loading = true;
    try {
      const start = new Date(selectedDate);
      start.setDate(start.getDate() - 7);
      const end = new Date(selectedDate);
      end.setDate(end.getDate() + 7);
      
      appointments = await getCalendarEvents(pid, formatDate(start), formatDate(end));
    } catch (e) {
      console.error('Error loading appointments:', e);
    } finally {
      loading = false;
    }
  }

  const dayAppointments = $derived(
    appointments.filter(a => {
      const d = new Date(a.Start);
      return d.toDateString() === selectedDate.toDateString();
    })
    .sort((a, b) => a.Start.localeCompare(b.Start))
    .map(a => ({
      ...a,
      Inhoud: localOverrides[a.Id] || a.Inhoud,
      Lesuur: a.LesuurVan || '—'
    }))
  );

  function nextDay() {
    selectedDate = new Date(selectedDate.setDate(selectedDate.getDate() + 1));
    if (!$userSettings.showWeekend && (selectedDate.getDay() === 0 || selectedDate.getDay() === 6)) {
        nextDay();
    } else {
        loadAppointments();
    }
  }

  function prevDay() {
    selectedDate = new Date(selectedDate.setDate(selectedDate.getDate() - 1));
    if (!$userSettings.showWeekend && (selectedDate.getDay() === 0 || selectedDate.getDay() === 6)) {
        prevDay();
    } else {
        loadAppointments();
    }
  }

  function goToToday() {
    selectedDate = new Date();
    loadAppointments();
  }

  async function openDetail(app: any) {
    loadingDetail = true;
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

  async function createAppointment() {
    const pid = $personId;
    if (!pid) return;
    try {
      // Set times relative to selectedDate
      const start = new Date(selectedDate);
      const [sh, sm] = newApp.start.split(':').map(Number);
      start.setHours(sh || 9, sm || 0, 0, 0);

      const end = new Date(selectedDate);
      const [eh, em] = newApp.einde.split(':').map(Number);
      end.setHours(eh || 10, em || 0, 0, 0);

      await createCalendarEvent({
        personId: pid,
        start: start.toISOString(),
        einde: end.toISOString(),
        duurtHeleDag: newApp.duurtHeleDag,
        omschrijving: newApp.omschrijving,
        lokatie: newApp.lokatie,
        inhoud: newApp.inhoud
      });
      isCreating = false;
      await loadAppointments();
    } catch (e) {
      console.error('Error creating appointment:', e);
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

  // Swipe handling
  let touchStartX = 0;
  function handleTouchStart(e: TouchEvent) { touchStartX = e.touches[0].clientX; }
  function handleTouchEnd(e: TouchEvent) {
    const touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 70) {
      if (diff > 0) nextDay(); else prevDay();
    }
  }

</script>

<div class="flex flex-col h-full bg-surface-950" ontouchstart={handleTouchStart} ontouchend={handleTouchEnd}>
  <!-- Header Section -->
  <header class="sticky top-0 z-20 bg-surface-950/95 backdrop-blur-xl border-b border-surface-800/50 px-4 py-3">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-black text-white italic tracking-tighter">Agenda</h1>
        <button
          onclick={() => { appointments = []; loadAppointments(); }}
          class="p-1.5 text-gray-500 hover:text-primary-400 transition-all hover:rotate-180 duration-500"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
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
      <div class="flex flex-col">
        <p class="text-[10px] font-black text-primary-400 uppercase tracking-[0.2em]">
          {selectedDate.toLocaleDateString('nl-NL', { month: 'short', year: 'numeric' })}
        </p>
        <h2 class="text-xl font-black text-white italic tracking-tighter leading-tight">
          {selectedDate.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric' })}
        </h2>
      </div>

      <!-- Compact Navigation Arrows -->
      <div class="flex items-center bg-surface-900 rounded-xl p-0.5 border border-white/5">
        <button onclick={prevDay} class="p-2 text-gray-500 hover:text-white transition-colors">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div class="h-4 w-px bg-surface-700 mx-0.5"></div>
        <button onclick={nextDay} class="p-2 text-gray-500 hover:text-white transition-colors">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
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
  <main class="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
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
      {#each dayAppointments as app}
        <button
          onclick={() => openDetail(app)}
          class="w-full text-left glass rounded-3xl p-4 flex gap-4 transition-all active:scale-[0.98] group relative overflow-hidden
                 {app.InfoType === 1 && !app.Afgerond ? 'border-primary-500/30' : ''}
                 {app.Afgerond ? 'opacity-60' : ''}"
        >
          <!-- Background accent -->
          <div class="absolute inset-0 bg-gradient-to-r from-primary-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
          {#if app.InfoType === 1 && !app.Afgerond}
            <div class="absolute top-0 right-0 w-32 h-32 bg-primary-500/5 blur-3xl -mr-16 -mt-16"></div>
          {/if}
          
          <!-- Time/Period -->
          <div class="flex flex-col items-center justify-center min-w-[42px] gap-0.5 relative z-10">
            <span class="text-[9px] font-black text-gray-600 uppercase tracking-tight">Les</span>
            <span class="text-xl font-black text-white italic leading-none">{app.Lesuur}</span>
            <div class="h-px w-5 bg-surface-700 my-1"></div>
            <span class="text-[9px] font-bold text-gray-500">{formatTime(app.Start)}</span>
          </div>

          <!-- Vertical Divider -->
          <div class="w-px bg-surface-800/80 my-1"></div>

          <!-- Info -->
          <div class="flex-1 min-w-0 flex flex-col justify-center relative z-10">
            <div class="flex items-center justify-between gap-2 mb-1">
              <span class="text-sm font-black text-primary-400 uppercase tracking-tight truncate">
                {app.Vakken?.[0]?.Omschrijving || app.Omschrijving || 'Vrij'}
              </span>
              {#if app.Docenten?.[0]}
                <span class="text-[9px] font-bold text-gray-600 shrink-0 bg-surface-900/50 px-1.5 py-0.5 rounded-md border border-white/5">
                  {app.Docenten[0].Naam}
                </span>
              {/if}
            </div>

            <div class="flex items-center gap-3 text-[10px] font-bold text-gray-500">
              <div class="flex items-center gap-1">
                <svg class="w-3 h-3 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                <span class="truncate">{app.Lokatie || '—'}</span>
              </div>
              <div class="flex items-center gap-1">
                <svg class="w-3 h-3 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                <span>Tot {formatTime(app.Einde)}</span>
              </div>
            </div>

            {#if app.InfoType && app.InfoType !== 0}
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
            {:else if app.Status === 4} <!-- Cancelled -->
              <div class="w-7 h-7 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </div>
            {:else if app.Inhoud} <!-- Content present -->
               <div class="w-7 h-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-500">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
              </div>
            {/if}
          </div>
        </button>
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
      </div>
      
      <!-- Footer Button (Close) -->
      <div class="p-4 pt-0 shrink-0 md:hidden">
        <button 
          onclick={() => { selectedAppointment = null; editMode = false; }}
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

        <button 
          onclick={createAppointment}
          class="w-full py-4 rounded-2xl bg-primary-500 text-white font-black uppercase tracking-widest hover:bg-primary-400 transition-all shadow-lg shadow-primary-500/25 active:scale-[0.98]"
        >
          Toevoegen & Synchroniseren
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
