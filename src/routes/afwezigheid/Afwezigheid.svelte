<script lang="ts">
  import { personId } from '$lib/stores';
  import { getAbsences, formatDate, getSchoolyears } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';

  let absences = $state<any[]>([]);
  let schoolyears = $state<any[]>([]);
  let selectedYearId = $state<number | null>(null);
  let loading = $state(true);
  let initialLoading = $state(true);
  
  let van = $state('');
  let tot = $state('');

  onMount(async () => {
    if (!$personId) return;
    
    try {
      schoolyears = await getSchoolyears($personId as number);
      schoolyears.sort((a, b) => new Date(b.begin).getTime() - new Date(a.begin).getTime());
      
      if (schoolyears.length > 0) {
        const currentYear = schoolyears[0];
        selectedYearId = currentYear.id;
        van = currentYear.begin.split('T')[0];
        tot = currentYear.einde.split('T')[0];
      } else {
        const now = new Date();
        const oneYearAgo = new Date(now);
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        van = oneYearAgo.toISOString().split('T')[0];
        tot = now.toISOString().split('T')[0];
      }
      
      await loadAbsences();
    } catch (e) {
      console.error('Error in onMount:', e);
    } finally {
      initialLoading = false;
    }
  });

  async function loadAbsences() {
    if (!$personId) return;
    loading = true;
    try {
      const raw = await getAbsences($personId as number, van, tot);
      absences = raw.sort((a, b) => {
        const dateA = a.Start ? new Date(a.Start).getTime() : 0;
        const dateB = b.Start ? new Date(b.Start).getTime() : 0;
        return dateB - dateA;
      });
    } catch (e) {
      console.error('Error loading absences:', e);
    } finally {
      loading = false;
    }
  }

  function handleYearChange(e: Event) {
    const id = parseInt((e.target as HTMLSelectElement).value);
    const year = schoolyears.find(y => y.id === id);
    if (year) {
      selectedYearId = id;
      van = year.begin.split('T')[0];
      tot = year.einde.split('T')[0];
      loadAbsences();
    }
  }

  function getAbsenceType(typeId: number, code: string) {
    const iconBase = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">`;
    if (typeId === 2 || code === 'L') return { label: 'Te Laat', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20', icon: iconBase + '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' };
    if (typeId === 3 || code === 'S' || code === 'Z') return { label: 'Ziek', color: 'text-red-400 bg-red-400/10 border-red-400/20', icon: iconBase + '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>' };
    if (typeId === 4 || code === 'V') return { label: 'Verwijderd', color: 'text-orange-400 bg-orange-400/10 border-orange-400/20', icon: iconBase + '<path d="M18 6L6 18M6 6l12 12"/></svg>' };
    if (typeId === 7) return { label: 'Boeken', color: 'text-primary-400 bg-primary-400/10 border-primary-400/20', icon: iconBase + '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v11H6.5A2.5 2.5 0 0 0 4 16v3.5z"/></svg>' };
    if (typeId === 8) return { label: 'Huiswerk', color: 'text-purple-400 bg-purple-400/10 border-purple-400/20', icon: iconBase + '<path d="M15.5 2H8.6c-.4 0-.8.2-1.1.5-.3.3-.5.7-.5 1.1v12.8c0 .4.2.8.5 1.1.3.3.7.5 1.1.5h9.8c.4 0 .8-.2 1.1-.5.3-.3.5-.7.5-1.1V6.5L15.5 2z"/><path d="M15 2v4.5a1 1 0 0 0 1 1h4.5"/></svg>' };
    return { label: 'Afwezig', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20', icon: iconBase + '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' };
  }

  const stats = $derived(() => {
    const total = absences.length;
    const unexcused = absences.filter(a => !a.Geoorloofd).length;
    const late = absences.filter(a => a.Verantwoordingtype === 2 || a.Code === 'L').length;
    const sick = absences.filter(a => a.Verantwoordingtype === 3).length;
    return { total, unexcused, late, sick };
  });

  function getSubjectName(absence: any): string | null {
    if (absence.Afspraak?.Vakken?.length > 0) {
      const naam = absence.Afspraak.Vakken[0].Naam || absence.Afspraak.Vakken[0].naam;
      if (naam) return naam;
    }
    if (absence.Afspraak?.Omschrijving) {
      return absence.Afspraak.Omschrijving;
    }
    return null;
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-60">
  <!-- Header -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-4">
    <div class="flex flex-col gap-4 max-w-5xl mx-auto w-full">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-black text-gray-100 italic tracking-tighter uppercase shrink-0">Absenties</h1>
        <div class="flex items-center gap-3">
          <button 
            onclick={loadAbsences} 
            class="p-2 text-gray-500 hover:text-primary-400 hover:rotate-180 transition-all duration-700 active:scale-95"
            aria-label="Vernieuwen"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>
          
          {#if schoolyears.length > 0}
            <div class="relative group">
              <select 
                bind:value={selectedYearId} 
                onchange={handleYearChange}
                class="appearance-none bg-surface-900 border border-white/5 rounded-2xl px-4 py-2 pr-9 text-[10px] font-black uppercase tracking-widest text-gray-300 focus:outline-none focus:border-primary-500 transition-all cursor-pointer shadow-lg"
              >
                {#each schoolyears as year}
                  <option value={year.id}>{year.groep.code} — {year.studie.code}</option>
                {/each}
              </select>
              <div class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-600 text-[10px]">▼</div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2 overflow-x-auto no-scrollbar pb-1">
        <div class="flex items-center gap-2 bg-surface-900/40 rounded-2xl p-1 border border-white/5 shadow-inner">
          <div class="flex items-center gap-2 px-3 py-1.5 shrink-0">
            <span class="text-[9px] font-black text-gray-600 uppercase tracking-widest">Van</span>
            <input type="date" bind:value={van} onchange={loadAbsences} class="bg-transparent border-none text-[10px] font-black italic text-gray-200 focus:ring-0 cursor-pointer p-0 w-24" />
          </div>
          <div class="w-0.5 h-3 bg-surface-800 rounded-full opacity-50"></div>
          <div class="flex items-center gap-2 px-3 py-1.5 shrink-0">
            <span class="text-[9px] font-black text-gray-600 uppercase tracking-widest">Tot</span>
            <input type="date" bind:value={tot} onchange={loadAbsences} class="bg-transparent border-none text-[10px] font-black italic text-gray-200 focus:ring-0 cursor-pointer p-0 w-24" />
          </div>
        </div>
      </div>
    </div>
  </header>

  <main class="flex-1 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.02),transparent_40%)] pb-20 overflow-y-auto">
    <div class="max-w-5xl mx-auto p-5 space-y-8">
      
      <!-- Stats -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        {#each [
          { label: 'Totaal', value: stats().total, icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`, color: 'from-blue-500/10 to-blue-600/5', text: 'text-blue-400' },
          { label: 'Ongeoorloofd', value: stats().unexcused, icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>`, color: stats().unexcused > 0 ? 'from-red-500/15 to-red-600/5' : 'from-surface-800 to-surface-900', text: stats().unexcused > 0 ? 'text-red-400' : 'text-gray-500' },
          { label: 'Te laat', value: stats().late, icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, color: 'from-amber-500/10 to-amber-600/5', text: 'text-amber-400' },
          { label: 'Ziek', value: stats().sick, icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`, color: 'from-emerald-500/10 to-emerald-600/5', text: 'text-emerald-400' },
        ] as stat}
          <div in:fly={{ y: 20, delay: 100 }} class="glass p-5 rounded-[2.5rem] border-white/5 flex flex-col items-center bg-gradient-to-br {stat.color} group transition-all hover:scale-[1.02] shadow-xl">
            <span class="p-2.5 rounded-2xl bg-surface-950/40 mb-3 shadow-inner group-hover:rotate-12 transition-transform {stat.text}">{@html stat.icon}</span>
            <span class="text-3xl font-black text-white tracking-tighter tabular-nums leading-none">{stat.value}</span>
            <span class="text-[9px] font-black uppercase tracking-[0.2em] mt-2.5 {stat.text} opacity-80">{stat.label}</span>
          </div>
        {/each}
      </div>

      {#if loading && initialLoading}
        <div class="flex flex-col items-center justify-center py-32 gap-4">
          <div class="w-10 h-10 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
          <p class="text-[9px] font-black text-gray-600 uppercase tracking-[0.3em] animate-pulse">Historie ophalen...</p>
        </div>
      {:else if absences.length === 0}
        <div in:fade class="glass rounded-[3rem] p-16 text-center space-y-6 border-emerald-500/10 bg-emerald-500/[0.02] shadow-2xl">
          <div class="w-24 h-24 bg-emerald-500/10 rounded-[2.5rem] flex items-center justify-center mx-auto text-emerald-500 shadow-[0_0_50px_rgba(var(--color-emerald-500),0.1)] border border-emerald-500/20 group hover:rotate-12 transition-transform">
            <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </div>
          <div class="space-y-2">
            <h3 class="text-2xl font-black text-white italic tracking-tight uppercase">Alles op orde</h3>
            <p class="text-gray-500 text-[10px] font-black uppercase tracking-widest max-w-[200px] mx-auto leading-relaxed">Geen absenties gevonden voor deze periode.</p>
          </div>
        </div>
      {:else}
        <div class="space-y-6">
          <div class="flex items-center gap-4 px-2">
            <span class="text-[10px] font-black text-gray-600 uppercase tracking-[0.3em] italic">Logboek</span>
            <div class="h-px flex-1 bg-gradient-to-r from-surface-800 to-transparent"></div>
          </div>

          <div class="grid grid-cols-1 gap-3">
            {#each absences as absence, i}
              {@const type = getAbsenceType(absence.Verantwoordingtype, absence.Code)}
              {@const subject = getSubjectName(absence)}
              <div 
                in:fly={{ y: 15, delay: i * 30 }}
                class="glass p-4 rounded-[2rem] border-white/5 hover:bg-surface-800/40 hover:border-primary-500/20 transition-all flex items-center gap-5 group shadow-lg"
              >
                <!-- Date -->
                <div class="w-14 h-14 rounded-2xl bg-surface-950 flex flex-col items-center justify-center border border-white/5 shrink-0 group-hover:scale-105 transition-transform shadow-inner text-center">
                  <span class="text-[8px] font-black text-gray-600 uppercase leading-none mb-1">{absence.Start ? new Date(absence.Start).toLocaleString('nl-NL', { month: 'short' }) : '?'}</span>
                  <span class="text-xl font-black text-white italic leading-none">{absence.Start ? new Date(absence.Start).getDate() : '?'}</span>
                </div>
                
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-2 overflow-hidden">
                    <span class="px-2.5 py-1 rounded-xl text-[8px] font-black uppercase tracking-widest border transition-colors {type.color} flex items-center gap-1.5 shadow-sm shrink-0">
                      {@html type.icon}
                      {type.label}
                    </span>
                    {#if !absence.Geoorloofd}
                       <span class="px-2.5 py-1 rounded-xl text-[8px] font-black uppercase tracking-widest bg-red-500/20 text-red-100 border border-red-500/30 shadow-lg shadow-red-500/10 shrink-0">
                         Ongeoorloofd
                       </span>
                    {/if}
                    <span class="text-[9px] font-black text-gray-600 uppercase tracking-widest ml-auto tabular-nums">
                      {absence.Start ? new Date(absence.Start).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                  <div class="flex flex-col">
                    <h3 class="text-sm font-black text-gray-100 truncate group-hover:text-white transition-colors italic uppercase tracking-tight">
                      {absence.Omschrijving || 'Registratie'}
                    </h3>
                    {#if subject}
                      <span class="text-[10px] text-gray-500 font-bold uppercase tracking-tight truncate">{subject}</span>
                    {/if}
                  </div>
                </div>
                
                {#if absence.Lesuur}
                  <div class="bg-surface-950 px-3 py-2 rounded-2xl border border-white/5 group-hover:border-primary-500/40 shadow-inner shrink-0">
                    <span class="text-[8px] font-black text-gray-700 uppercase block tracking-tighter leading-none mb-0.5 text-right">Uur</span>
                    <span class="text-sm font-black text-primary-400 italic tracking-tighter leading-none">{absence.Lesuur}e</span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </main>
</div>

<style>
  .glass {
    background: oklch(0.12 0.02 290 / 0.5);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid oklch(1 0 0 / 0.05);
  }

  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
