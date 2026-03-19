<script lang="ts">
  import { personId } from '$lib/stores';
  import { getAbsences, formatDate } from '$lib/api';
  import { onMount } from 'svelte';

  let absences = $state<any[]>([]);
  let loading = $state(true);
  
  // Default to current school year range or last 3 months
  let van = $state('');
  let tot = $state('');

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    
    const now = new Date();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(now.getMonth() - 3);
    
    van = formatDate(threeMonthsAgo);
    tot = formatDate(now);
    
    await loadAbsences();
  });

  async function loadAbsences() {
    loading = true;
    try {
      absences = await getAbsences($personId as number, van, tot);
      // Sort by date desc
      absences.sort((a, b) => new Date(b.Start).getTime() - new Date(a.Start).getTime());
    } catch (e) {
      console.error('Error loading absences:', e);
    }
    loading = false;
  }

  function getAbsenceType(code: string) {
    if (code === 'L') return { label: 'Te Laat', color: 'text-yellow-400 bg-yellow-400/10' };
    if (code === 'S' || code === 'Z') return { label: 'Ziek', color: 'text-red-400 bg-red-400/10' };
    if (code === 'V') return { label: 'Verwijderd', color: 'text-orange-400 bg-orange-400/10' };
    return { label: 'Afwezig', color: 'text-blue-400 bg-blue-400/10' };
  }
</script>

<div class="p-6 max-w-4xl mx-auto">
  <div class="flex items-center justify-between mb-8">
    <div>
      <h1 class="text-3xl font-bold text-gray-100">Afwezigheid</h1>
      <p class="text-gray-500 mt-1">Overzicht van je absenties en te laat meldingen</p>
    </div>
  </div>

  <div class="glass p-4 mb-6 flex flex-wrap items-center gap-4 rounded-2xl">
    <div class="flex flex-col">
      <span class="text-[10px] font-bold text-gray-500 uppercase ml-1 mb-1">Van</span>
      <input type="date" bind:value={van} onchange={loadAbsences} class="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-primary-500/50" />
    </div>
    <div class="flex flex-col">
      <span class="text-[10px] font-bold text-gray-500 uppercase ml-1 mb-1">Tot</span>
      <input type="date" bind:value={tot} onchange={loadAbsences} class="bg-surface-800 border border-surface-700 rounded-xl px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-primary-500/50" />
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else if absences.length === 0}
    <div class="glass rounded-3xl p-12 text-center">
      <div class="w-16 h-16 bg-surface-800 rounded-2xl flex items-center justify-center mx-auto mb-4 text-3xl">🎉</div>
      <p class="text-gray-300 font-medium">Lekker bezig! Geen absenties gevonden in deze periode.</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each absences as absence}
        {@const type = getAbsenceType(absence.Code)}
        <div class="glass p-4 rounded-2xl border border-surface-700/30 flex items-center gap-4 hover:border-surface-600/50 transition-colors">
          <div class="w-12 h-12 rounded-xl flex flex-col items-center justify-center bg-surface-800/50 shrink-0">
            <span class="text-[10px] font-bold text-gray-500 uppercase leading-none">{new Date(absence.Start).toLocaleString('nl-NL', { month: 'short' })}</span>
            <span class="text-lg font-bold text-gray-200">{new Date(absence.Start).getDate()}</span>
          </div>
          
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider {type.color}">
                {type.label}
              </span>
              {#if !absence.Geoorloofd}
                 <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider text-red-400 bg-red-400/10">
                   Ongeoorloofd
                 </span>
              {/if}
              <span class="text-xs text-gray-500">{new Date(absence.Start).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <h3 class="text-sm font-medium text-gray-200 truncate">{absence.Omschrijving || 'Geen omschrijving'}</h3>
          </div>
          
          {#if absence.Lesuur}
            <div class="text-right shrink-0">
              <span class="text-[10px] font-bold text-gray-500 uppercase block">Lesuur</span>
              <span class="text-sm font-bold text-gray-200">{absence.Lesuur}e</span>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
