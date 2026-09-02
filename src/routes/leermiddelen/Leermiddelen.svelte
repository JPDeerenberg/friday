<script lang="ts">
  import { personId, resumedAt } from '$lib/stores';
  import { get } from 'svelte/store';
  import { getLeermiddelen, getLeermiddelLaunchUrl } from '$lib/api';
  import { cacheGet, cacheRefresh } from '$lib/cache';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import Button from '$lib/components/Button.svelte';
  import IconButton from '$lib/components/IconButton.svelte';

  let leermiddelen = $state<any[]>([]);
  let loading = $state(true);
  let searchQuery = $state('');
  let error = $state<string | null>(null);

  onMount(async () => {
    await loadData();
  });

  // Foreground resume: force-refresh leermiddelen on resume
  let resumedSeen = $state(false);
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) { resumedSeen = true; return; }
    if (get(personId) !== null) loadData(true);
  });

  async function loadData(force = false) {
    const pid = get(personId);
    if (!pid) return;
    if (leermiddelen.length === 0) loading = true;
    error = null;
    try {
      leermiddelen = force
        ? await cacheRefresh(`leermiddelen_${pid}`, () => getLeermiddelen(pid), 5 * 60 * 1000)
        : await cacheGet(`leermiddelen_${pid}`, () => getLeermiddelen(pid), 5 * 60 * 1000);
    } catch (e) {
      console.error('Error loading leermiddelen:', e);
      error = 'Kon leermiddelen niet laden.';
    } finally {
      loading = false;
    }
  }

  const filteredMaterials = $derived(() => {
    return leermiddelen.filter(m => 
      m.Titel.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (m.Vak?.Omschrijving || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  function getStatusColor(status: number) {
    if (status === 1) return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
    return 'text-gray-500 bg-gray-400/5 border-white/5';
  }

  async function handleOpen(href: string) {
    try {
      const launchUrl = await getLeermiddelLaunchUrl(href);
      await openUrl(launchUrl);
    } catch (e) {
      console.error('Failed to open leermiddel:', e);
      alert('Kon leermiddel niet openen.');
    }
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-60">
  <!-- Header -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-4">
    <div class="max-w-5xl mx-auto w-full space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h1 class="text-title-large text-gray-100 shrink-0">Leermiddelen</h1>
          <IconButton
            onclick={() => loadData(true)}
            class="hover:rotate-180 duration-700"
            aria-label="Vernieuwen"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          </IconButton>
        </div>
      </div>
      
      <div class="relative group">
        <input
          type="text"
          placeholder="Zoeken in boeken..."
          bind:value={searchQuery}
          class="w-full bg-surface-900 border border-white/5 rounded-m3-full px-5 py-3 pl-11 text-body-large text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500/50 transition-all shadow-lg"
        />
        <svg class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 group-focus-within:text-emerald-500 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </div>
    </div>
  </header>

  <main class="flex-1 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.02),transparent_40%)] pb-20 overflow-y-auto">
    <div class="max-w-7xl mx-auto p-5 lg:p-10">
      
      {#if loading && !leermiddelen.length}
        <div class="flex flex-col items-center justify-center py-40 gap-4">
          <div class="w-10 h-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin"></div>
          <p class="text-label-medium text-gray-600 animate-pulse">Catalogus ophalen...</p>
        </div>
      {:else if error && !leermiddelen.length}
        <div class="glass rounded-m3-md p-16 text-center space-y-6 border-red-500/10 bg-red-500/[0.02] shadow-2xl mx-auto max-w-lg">
           <div class="w-20 h-20 bg-red-500/10 rounded-m3-md flex items-center justify-center mx-auto text-red-500 border border-red-500/20 shadow-inner">
              <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
           </div>
           <div class="space-y-1">
              <h3 class="text-headline-small text-white">Inladen mislukt</h3>
              <p class="text-gray-500 text-body-medium leading-relaxed">{error}</p>
           </div>
           <Button variant="tonal" onclick={() => loadData(true)} class="w-full">
              Herhalen
           </Button>
        </div>
      {:else if filteredMaterials().length === 0}
        <div in:fade class="glass rounded-m3-md p-24 text-center space-y-4 border-white/5 shadow-2xl flex flex-col items-center">
            <svg class="w-16 h-16 text-gray-800 mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v11H6.5A2.5 2.5 0 0 0 4 16v3.5z"/></svg>
            <h3 class="text-headline-small text-gray-400">Geen resultaten</h3>
            <p class="text-gray-700 text-body-medium">Pas je filter aan</p>
        </div>
      {:else}
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 md:gap-10">
          {#each filteredMaterials() as material, i}
             <div in:fly={{ y: 20, delay: i * 40 }} class="flex flex-col group h-full">
              <!-- Book Cover Container -->
              <div class="mb-5 relative aspect-[3/4.2] rounded-m3-lg overflow-hidden shadow-2xl transition-all duration-700 group-hover:-translate-y-4 group-hover:scale-[1.04] group-hover:shadow-[0_40px_70px_-20px_rgba(0,0,0,0.8)] border border-white/5">
                 {#if material.PreviewImageUrl}
                   <img src={material.PreviewImageUrl} alt={material.Titel} class="w-full h-full object-cover group-hover:brightness-110 transition-all duration-700" />
                 {:else}
                    <div class="w-full h-full bg-gradient-to-br from-surface-800 to-surface-950 flex flex-col items-center justify-center p-6 text-center shadow-inner">
                      <div class="text-gray-600 group-hover:text-emerald-400 transition-colors duration-500 drop-shadow-2xl mb-4">
                         <svg class="w-16 h-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v11H6.5A2.5 2.5 0 0 0 4 16v3.5z"/></svg>
                      </div>
                      <div class="px-3 py-1 rounded-m3-sm bg-emerald-500/5 border border-emerald-500/10 shadow-sm transition-all group-hover:bg-emerald-500/15">
                        <span class="text-label-small text-emerald-500">
                           {material.Vak?.Afkorting || 'MAGIS'}
                        </span>
                     </div>
                   </div>
                 {/if}

                 <!-- Overlay Hover -->
                 <div class="absolute inset-0 bg-gradient-to-t from-surface-950/90 via-surface-950/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                 
                 <!-- Status Badge -->
                 <div class="absolute top-4 right-4">
                    <span class="px-3.5 py-1.5 rounded-m3-sm text-label-small border backdrop-blur-3xl shadow-2xl {getStatusColor(material.Status)}">
                      {material.Status === 1 ? 'Beschikbaar' : 'Gearchiveerd'}
                    </span>
                 </div>

                 <!-- Action Button -->
                 <div class="absolute inset-x-5 bottom-5 translate-y-10 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-700 cubic-bezier(0.16, 1, 0.3, 1)">
                    {#each material.Links as link}
                      {#if link.Rel === 'content'}
                        <Button
                          variant="filled"
                          onclick={() => handleOpen(link.Href)}
                          class="w-full bg-emerald-500! text-white! hover:bg-emerald-400! shadow-xl shadow-emerald-500/20 border border-emerald-400/30! ring-1 ring-white/10"
                        >
                          Lezen
                          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        </Button>
                      {/if}
                    {/each}
                 </div>
              </div>

              <!-- Meta -->
              <div class="px-2 space-y-1.5 flex flex-col items-center text-center">
                <span class="text-label-small text-emerald-500 leading-none block opacity-70">
                  {material.Vak?.Omschrijving || 'Algemeen Lesmateriaal'}
                </span>
                <h3 class="text-title-small text-gray-100 group-hover:text-emerald-400 transition-colors line-clamp-2 leading-none min-h-[1.5rem]">
                  {material.Titel}
                </h3>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
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
</style>
