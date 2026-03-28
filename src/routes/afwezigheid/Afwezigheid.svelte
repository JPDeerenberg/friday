<script lang="ts">
  import { personId } from '$lib/stores';
  import { getAbsences, formatDate, getSchoolyears } from '$lib/api';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fade, fly, slide } from 'svelte/transition';

  let absences = $state<any[]>([]);
  let schoolyears = $state<any[]>([]);
  let selectedYearId = $state<number | null>(null);
  let loading = $state(true);
  let initialLoading = $state(true);
  
  let van = $state('');
  let tot = $state('');

  onMount(async () => {
    const pid = get(personId);
    if (!pid) return;
    
    try {
      schoolyears = await getSchoolyears(pid as number);
      // Sort schoolyears desc
      schoolyears.sort((a, b) => new Date(b.begin).getTime() - new Date(a.begin).getTime());
      
      if (schoolyears.length > 0) {
        const currentYear = schoolyears[0];
        selectedYearId = currentYear.id;
        van = currentYear.begin.split('T')[0];
        tot = currentYear.einde.split('T')[0];
      } else {
        const now = new Date();
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        van = formatDate(oneYearAgo);
        tot = formatDate(now);
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
    if (typeId === 2 || code === 'L') return { label: 'Te Laat', color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20', icon: '⏰' };
    if (typeId === 3 || code === 'S' || code === 'Z') return { label: 'Ziek', color: 'text-red-400 bg-red-400/10 border-red-400/20', icon: '🤒' };
    if (typeId === 4 || code === 'V') return { label: 'Verwijderd', color: 'text-orange-400 bg-orange-400/10 border-orange-400/20', icon: '🚪' };
    if (typeId === 7) return { label: 'Boeken', color: 'text-primary-400 bg-primary-400/10 border-primary-400/20', icon: '📚' };
    if (typeId === 8) return { label: 'Huiswerk', color: 'text-purple-400 bg-purple-400/10 border-purple-400/20', icon: '📓' };
    return { label: 'Afwezig', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20', icon: '👤' };
  }

  const stats = $derived(() => {
    const total = absences.length;
    const unexcused = absences.filter(a => !a.Geoorloofd).length;
    const late = absences.filter(a => a.Verantwoordingtype === 2 || a.Code === 'L').length;
    const sick = absences.filter(a => a.Verantwoordingtype === 3).length;
    return { total, unexcused, late, sick };
  });

  function getSubjectName(absence: any): string | null {
    // Try Vakken first (often null in real data), then fall back to Afspraak.Omschrijving
    if (absence.Afspraak?.Vakken?.length > 0) {
      const naam = absence.Afspraak.Vakken[0].Naam || absence.Afspraak.Vakken[0].naam;
      if (naam) return naam;
    }
    // Afspraak.Omschrijving is always populated: e.g. "wi - iah - bv3.wi_a"
    if (absence.Afspraak?.Omschrijving) {
      return absence.Afspraak.Omschrijving;
    }
    return null;
  }
</script>

<div class="flex flex-col bg-surface-950">
  <!-- Sticky Header -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-3">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-100 italic tracking-tighter">Absentietoets</h1>
        <button 
          onclick={loadAbsences} 
          aria-label="Vernieuwen"
          class="p-2 text-gray-500 hover:text-primary-400 transition-all hover:scale-110 active:scale-95"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
      
      <div class="flex items-center gap-2">
      <!-- Schoolyear Selector -->
      {#if schoolyears.length > 0}
        <div class="relative group">
          <select 
            bind:value={selectedYearId} 
            onchange={handleYearChange}
            class="appearance-none bg-surface-800/50 border border-surface-700/50 rounded-xl px-4 py-1.5 pr-8 text-xs font-bold text-gray-300 focus:outline-none focus:ring-2 focus:ring-primary-500/30 cursor-pointer hover:bg-surface-700/50 transition-colors"
          >
            {#each schoolyears as year}
              <option value={year.id}>{year.groep.code} ({year.studie.code})</option>
            {/each}
          </select>
          <div class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500 text-[10px]">▼</div>
        </div>
      {/if}

      <div class="flex items-center gap-2 bg-surface-800/30 rounded-2xl p-1 border border-surface-700/30">
        <div class="flex items-center gap-2 px-3 py-1">
          <span class="text-[9px] font-black text-gray-500 uppercase tracking-widest">Van</span>
          <input type="date" bind:value={van} onchange={loadAbsences} class="bg-transparent border-none text-[11px] font-bold text-gray-300 focus:ring-0 cursor-pointer p-0" />
        </div>
        <div class="w-px h-3 bg-surface-700"></div>
        <div class="flex items-center gap-2 px-3 py-1">
          <span class="text-[9px] font-black text-gray-500 uppercase tracking-widest">Tot</span>
          <input type="date" bind:value={tot} onchange={loadAbsences} class="bg-transparent border-none text-[11px] font-bold text-gray-300 focus:ring-0 cursor-pointer p-0" />
        </div>
      </div>
    </div>
  </div>
</header>

  <main class="bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.03),transparent_40%)] pb-10">
    <div class="max-w-5xl mx-auto p-8 space-y-8">
      
      <!-- Statistics Tiles -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {#each [
          { label: 'Totaal', value: stats().total, icon: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`, color: 'text-gray-400' },
          { label: 'Ongeoorloofd', value: stats().unexcused, icon: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>`, color: stats().unexcused > 0 ? 'text-red-400' : 'text-gray-400' },
          { label: 'Te laat', value: stats().late, icon: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, color: 'text-yellow-400' },
          { label: 'Ziek', value: stats().sick, icon: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`, color: 'text-blue-400' },
        ] as stat}
          <div in:fly={{ y: 20, delay: 100 }} class="glass p-5 rounded-[2rem] border-surface-800/50 flex flex-col items-center text-center group transition-all hover:scale-[1.02] hover:bg-surface-800/40 shadow-xl">
            <span class="text-3xl mb-3 drop-shadow-md">{@html stat.icon}</span>
            <span class="text-3xl font-black text-white group-hover:text-primary-400 transition-colors uppercase tabular-nums tracking-tighter">{stat.value}</span>
            <span class="text-[10px] font-black uppercase tracking-widest mt-1.5 {stat.color} opacity-80">{stat.label}</span>
          </div>
        {/each}
      </div>

      {#if loading && initialLoading}
        <div class="flex flex-col items-center justify-center py-20 gap-4">
          <div class="w-12 h-12 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
          <p class="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] animate-pulse">Laden...</p>
        </div>
      {:else if absences.length === 0}
        <div in:fade class="glass rounded-[2.5rem] p-20 text-center space-y-6 border-emerald-500/10 bg-emerald-500/[0.03] shadow-2xl">
          <div class="w-24 h-24 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto text-5xl shadow-[0_0_50px_rgba(16,185,129,0.15)] ring-1 ring-emerald-500/20">
            ✨
          </div>
          <div class="space-y-2">
            <h3 class="text-2xl font-black text-white italic tracking-tight">Geen absenties!</h3>
            <p class="text-gray-400 font-medium max-w-sm mx-auto leading-relaxed">Je record is vlekkeloos voor de geselecteerde periode. Houd dit vol!</p>
          </div>
        </div>
      {:else}
        <div class="space-y-6">
          <div class="flex items-center gap-4 px-2">
            <span class="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] whitespace-nowrap">Absentieshistorie</span>
            <div class="h-px w-full bg-gradient-to-r from-surface-800 to-transparent"></div>
          </div>

          <div class="grid grid-cols-1 gap-4">
            {#each absences as absence, i}
              {@const type = getAbsenceType(absence.Verantwoordingtype, absence.Code)}
              {@const subject = getSubjectName(absence)}
              <div 
                in:fly={{ y: 15, delay: i * 30 }}
                class="glass p-5 rounded-[2rem] border-surface-800/20 hover:border-primary-500/20 hover:bg-surface-800/40 transition-all flex items-center gap-6 group shadow-lg"
              >
                <!-- Date stamp -->
                <div class="w-16 h-16 rounded-2xl bg-surface-900/80 flex flex-col items-center justify-center border border-surface-700/50 shrink-0 group-hover:scale-105 transition-transform shadow-inner">
                  <span class="text-[10px] font-black text-gray-500 uppercase leading-none mb-1">{absence.Start ? new Date(absence.Start).toLocaleString('nl-NL', { month: 'short' }) : '??'}</span>
                  <span class="text-2xl font-black text-white tracking-tighter tabular-nums">{absence.Start ? new Date(absence.Start).getDate() : '?'}</span>
                </div>
                
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-2 flex-wrap">
                    <span class="px-3 py-1 rounded-xl text-[9px] font-black uppercase tracking-widest border transition-colors {type.color} flex items-center gap-1.5">
                      {@html type.iconSvg}
                      {type.label}
                    </span>
                    {#if !absence.Geoorloofd}
                       <span class="px-3 py-1 rounded-xl text-[9px] font-black uppercase tracking-widest bg-red-500/10 text-red-400 border border-red-500/20 shadow-[0_0_10px_rgba(239,68,68,0.1)]">
                         Ongeoorloofd
                       </span>
                    {/if}
                    <span class="text-[10px] font-bold text-gray-500 ml-1">
                      {absence.Start ? new Date(absence.Start).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <h3 class="text-base font-bold text-gray-100 truncate group-hover:text-white transition-colors">
                      {absence.Omschrijving || 'Afwezig'}
                    </h3>
                    {#if subject}
                      <span class="text-xs text-gray-400 truncate">{subject}</span>
                    {/if}
                  </div>
                </div>
                
                <div class="hidden sm:flex flex-col items-end gap-2 shrink-0">
                   {#if absence.Lesuur}
                    <div class="bg-surface-900/60 px-4 py-2 rounded-2xl border border-surface-700/50 group-hover:border-primary-500/20 group-hover:bg-primary-500/[0.02] transition-all shadow-inner">
                      <span class="text-[9px] font-black text-gray-500 uppercase block tracking-tighter leading-none mb-1 text-right">Lesuur</span>
                      <span class="text-base font-black text-primary-400 uppercase italic tracking-tighter leading-none">{absence.Lesuur}e</span>
                    </div>
                  {/if}
                </div>
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
    background: rgba(30, 41, 59, 0.4);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .custom-scrollbar::-webkit-scrollbar {
    width: 4px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
</style>
