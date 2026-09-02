<script lang="ts">
  import { personId, resumedAt } from '$lib/stores';
  import { getStudiewijzers, getStudiewijzerDetail, getStudiewijzerOnderdeelDetail } from '$lib/api';
  import { getFileIcon } from '$lib/icons';
  import { cacheGet, cacheRefresh } from '$lib/cache';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fade, fly, slide } from 'svelte/transition';
  import Button from '$lib/components/Button.svelte';
  import IconButton from '$lib/components/IconButton.svelte';

  let studiewijzers = $state<any[]>([]);
  let selectedSW = $state<any>(null);
  let selectedOnderdeel = $state<any>(null);
  let loading = $state(true);
  let subLoading = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    await loadInitialData();
  });

  // Foreground resume: force-refresh
  let resumedSeen = false;
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) { resumedSeen = true; return; }
    if (get(personId) !== null) loadInitialData(true);
  });

  async function loadInitialData(force = false) {
    const pid = get(personId);
    if (!pid) return;
    if (studiewijzers.length === 0) loading = true;
    error = null;
    try {
      const fetcher = async () => {
        const raw = await getStudiewijzers(pid);
        raw.sort((a, b) => a.Titel.localeCompare(b.Titel));
        return raw;
      };
      studiewijzers = force
        ? await cacheRefresh(`studiewijzers_${pid}`, fetcher, 5 * 60 * 1000)
        : await cacheGet(`studiewijzers_${pid}`, fetcher, 5 * 60 * 1000);
    } catch (e) {
      console.error('Error loading studiewijzers:', e);
      error = 'Kon studiewijzers niet laden.';
    } finally {
      loading = false;
    }
  }

  async function selectSW(sw: any) {
    loading = true;
    selectedSW = sw;
    selectedOnderdeel = null;
    try {
      const isProject = sw.Links?.some((l: any) => l.Href?.includes('projecten'));
      selectedSW.Detail = await getStudiewijzerDetail(get(personId) as number, sw.Id, isProject);
    } catch (e) {
      console.error('Error loading sw detail:', e);
      error = 'Kon detailinformatie niet laden.';
    } finally {
      loading = false;
    }
  }

  async function selectOnderdeel(onderdeel: any) {
    if (selectedOnderdeel?.Id === onderdeel.Id) return;
    subLoading = true;
    selectedOnderdeel = onderdeel;
    try {
      const isProject = selectedSW.Links?.some((l: any) => l.Href?.includes('projecten'));
      selectedOnderdeel.Detail = await getStudiewijzerOnderdeelDetail(get(personId) as number, selectedSW.Id, onderdeel.Id, isProject);
    } catch (e) {
      console.error('Error loading onderdeel detail:', e);
    } finally {
      subLoading = false;
    }
  }

  function goBack() {
    if (selectedOnderdeel) {
      selectedOnderdeel = null;
    } else {
      selectedSW = null;
      error = null;
    }
  }

  function isProject(sw: any) {
     return sw.Links?.some((l: any) => l.Href?.includes('projecten'));
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-60">
  <!-- Header -->
  <header class="sticky top-0 z-40 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-4">
    <div class="max-w-5xl mx-auto w-full flex items-center justify-between">
      <div class="flex items-center gap-3 min-w-0">
        {#if selectedSW}
          <IconButton
            onclick={goBack}
            class="bg-surface-900! border! border-white/5! shadow-lg"
            aria-label="Terug"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>
          </IconButton>
        {/if}
        <div class="flex flex-col min-w-0">
          <h1 class="text-title-large text-gray-100 truncate">
            {selectedSW ? selectedSW.Titel : 'Studiewijzers'}
          </h1>
          <p class="text-body-medium text-gray-600 mt-0.5">
            {selectedSW ? 'Onderdelen & Materiaal' : 'Selecteer een cursus'}
          </p>
        </div>
      </div>

      {#if !selectedSW}
        <IconButton
          onclick={() => loadInitialData(true)}
          class="bg-surface-900! border! border-white/5! hover:rotate-180 duration-700 shadow-lg"
          aria-label="Vernieuwen"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </IconButton>
      {/if}
    </div>
  </header>

  <main class="flex-1 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.02),transparent_40%)] pb-20 overflow-y-auto">
    {#if loading && !selectedSW && !studiewijzers.length}
      <div class="flex flex-col items-center justify-center py-40 gap-4">
        <div class="w-10 h-10 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
        <p class="text-label-medium text-gray-600 animate-pulse">Catalogus inladen...</p>
      </div>
    {:else if error && !selectedSW}
       <div class="max-w-lg mx-auto mt-20 p-10 glass rounded-m3-md text-center space-y-6 border-red-500/10 bg-red-500/[0.02] shadow-2xl mx-4">
          <div class="w-20 h-20 bg-red-500/10 rounded-m3-md flex items-center justify-center mx-auto text-red-500 border border-red-500/20 shadow-inner">
             <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
          </div>
          <div class="space-y-1">
             <h3 class="text-headline-small text-white">Foutmelding</h3>
             <p class="text-gray-500 text-body-medium leading-relaxed">{error}</p>
          </div>
          <Button variant="tonal" onclick={() => loadInitialData(true)} class="w-full">
             Opnieuw Proberen
          </Button>
       </div>
    {:else if !selectedSW}
      <div class="max-w-6xl mx-auto p-5 md:p-10 space-y-8" in:fade>
        {#if studiewijzers.length === 0 && !loading}
          <div class="glass rounded-m3-md p-24 text-center border-white/5 shadow-2xl flex flex-col items-center">
             <svg class="w-16 h-16 text-gray-800 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v11H6.5A2.5 2.5 0 0 0 4 16v3.5z"/></svg>
             <h3 class="text-headline-small text-gray-500">Geen studiewijzers</h3>
             <p class="text-body-medium text-gray-700">Niets beschikbaar voor dit jaar</p>
          </div>
        {:else}
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {#each studiewijzers as sw, i}
              {@const isProj = isProject(sw)}
              <button 
                in:fly={{ y: 20, delay: i * 30 }}
                onclick={() => selectSW(sw)}
                class="glass p-6 rounded-m3-md border-white/5 hover:border-primary-500/20 hover:bg-surface-800/40 transition-all text-left flex flex-col gap-5 group shadow-xl relative overflow-hidden"
              >
                <div class="absolute -right-4 -top-4 w-24 h-24 bg-primary-500/5 rounded-full blur-2xl group-hover:bg-primary-500/10 transition-colors"></div>
                
                <div class="flex items-start justify-between relative z-10">
                   <div class="w-12 h-12 rounded-m3-md bg-surface-950 border border-white/5 flex items-center justify-center text-primary-400 group-hover:rotate-6 group-hover:scale-110 transition-all shadow-inner">
                      {#if isProj}
                        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                      {:else}
                        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v11H6.5A2.5 2.5 0 0 0 4 16v3.5z"/></svg>
                      {/if}
                   </div>
                   <span class="text-label-small px-3 py-1.5 rounded-m3-sm border backdrop-blur-md {isProj ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 'bg-primary-500/10 text-primary-500 border-primary-500/20'}">
                      {isProj ? 'Project' : 'Wijzer'}
                   </span>
                </div>
                
                <div class="relative z-10">
                  <h3 class="text-title-medium text-gray-100 line-clamp-2 leading-none group-hover:text-white transition-colors">
                    {sw.Titel}
                  </h3>
                   <div class="flex items-center gap-2 text-label-small text-gray-600 mt-4 pt-4 border-t border-white/[0.03]">
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v11H6.5A2.5 2.5 0 0 0 4 16v3.5z"/></svg>
                    <span>{new Date(sw.Van).getFullYear()}</span>
                  </div>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <!-- Detail View -->
      <div class="flex flex-col md:flex-row h-full min-h-0" in:slide={{ axis: 'x', duration: 400 }}>
        <!-- Parts List -->
        <div class="w-full md:w-80 lg:w-96 border-r border-white/5 bg-surface-900/10 flex flex-col shrink-0">
          <div class="p-5 border-b border-white/5 bg-surface-950/20">
             <h2 class="text-label-medium text-gray-500">Cursus Onderdelen</h2>
          </div>
          <div class="flex-1 overflow-y-auto no-scrollbar p-3 space-y-2">
            {#if selectedSW.Detail?.Onderdelen?.Items}
              {#each selectedSW.Detail.Onderdelen.Items as onderdeel}
                <button 
                  onclick={() => selectOnderdeel(onderdeel)}
                  class="w-full p-4 rounded-m3-md text-left transition-all border {selectedOnderdeel?.Id === onderdeel.Id ? 'bg-primary-500/15 border-primary-500/40 shadow-xl' : 'bg-surface-800/20 border-transparent hover:bg-surface-800/60'} flex items-center gap-4 group"
                >
                  <div class="w-3 h-3 rounded-m3-xs shrink-0 shadow-inner group-hover:scale-110 transition-transform" style="background-color: {onderdeel.Kleur ? '#' + onderdeel.Kleur.toString(16).padStart(6, '0') : '#3b82f6'}"></div>
                  <span class="text-label-medium text-gray-200 group-hover:text-white transition-colors">{onderdeel.Titel}</span>
                </button>
              {/each}
            {/if}
          </div>
        </div>

        <!-- Content Area -->
        <div class="flex-1 overflow-y-auto no-scrollbar bg-surface-950/30">
          {#if subLoading}
             <div class="h-full flex flex-col items-center justify-center py-40 gap-4">
                <div class="w-10 h-10 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
             </div>
          {:else if selectedOnderdeel}
            <div class="p-6 md:p-12 max-w-4xl mx-auto space-y-12" in:fade>
              <div class="space-y-6">
                <div class="flex items-center gap-5">
                   <div class="w-1.5 h-12 rounded-full shadow-lg" style="background-color: {selectedOnderdeel.Kleur ? '#' + selectedOnderdeel.Kleur.toString(16).padStart(6, '0') : '#3b82f6'}"></div>
                   <div class="min-w-0">
                      <h2 class="text-headline-medium text-white leading-none truncate">{selectedOnderdeel.Titel}</h2>
                      <p class="text-label-small text-gray-600 mt-1">Geselecteerd Onderdeel</p>
                   </div>
                </div>
                
                {#if selectedOnderdeel.Omschrijving}
                  <div class="glass p-8 md:p-10 rounded-m3-md border-white/5 text-gray-300 text-body-large leading-loose prose-invert prose-p:mb-4 shadow-2xl relative overflow-hidden">
                    <div class="absolute top-0 right-0 p-8 opacity-[0.03] grayscale pointer-events-none">
                       <svg class="w-32 h-32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v11H6.5A2.5 2.5 0 0 0 4 16v3.5z"/></svg>
                    </div>
                    {@html selectedOnderdeel.Omschrijving}
                  </div>
                {/if}
              </div>

              {#if (selectedOnderdeel.Detail?.Bronnen || []).length > 0}
                <div class="space-y-6">
                  <div class="flex items-center gap-4">
                     <span class="text-label-medium text-gray-600">Bijlagen & Bronnen</span>
                     <div class="h-px flex-1 bg-gradient-to-r from-white/5 to-transparent"></div>
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {#each selectedOnderdeel.Detail.Bronnen as bron, i}
                      <div in:fly={{ y: 15, delay: i * 30 }} class="glass p-5 rounded-m3-md border-white/5 flex items-center justify-between group hover:bg-surface-800/40 transition-all shadow-xl">
                         <div class="flex items-center gap-4 min-w-0 pr-4">
                            <div class="w-10 h-10 rounded-m3-sm bg-surface-950 flex items-center justify-center text-primary-400 border border-white/5 shadow-inner">
                               {@html getFileIcon(bron)}
                            </div>
                            <span class="text-label-medium text-gray-200 truncate">{bron.Naam}</span>
                         </div>
                         <a 
                           href={bron.Links?.find((l: any) => l.Rel === 'content')?.Href} 
                           target="_blank"
                           class="w-12 h-12 rounded-full bg-primary-500/10 hover:bg-primary-500 text-primary-400 hover:text-white transition-all active:scale-90 flex items-center justify-center border border-primary-500/20 shadow-lg shadow-primary-500/5 group/btn"
                         >
                           {#if bron.BronSoort === 3}
                             <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                           {:else}
                             <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                           {/if}
                         </a>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {:else}
             <div class="h-full flex flex-col items-center justify-center p-12 text-center opacity-30">
                <div class="w-24 h-24 rounded-m3-lg bg-surface-900 border border-white/5 flex items-center justify-center mb-6 text-gray-700 shadow-inner group-hover:rotate-6 transition-transform">
                  <svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                </div>
                <h3 class="text-headline-small text-gray-500">Geen deel geselecteerd</h3>
                <p class="text-body-medium mt-2">Kies een onderdeel uit de lijst</p>
             </div>
          {/if}
        </div>
      </div>
    {/if}
  </main>
</div>

<style>
  .glass {
    background: oklch(0.12 0.02 290 / 0.5);
    backdrop-filter: blur(25px);
    -webkit-backdrop-filter: blur(25px);
    border: 1px solid oklch(1 0 0 / 0.05);
  }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

  :global(.prose) {
     font-family: 'Outfit', 'Inter', sans-serif;
  }
  :global(.prose b), :global(.prose strong) {
     color: #fff;
     font-weight: 700;
  }
</style>
