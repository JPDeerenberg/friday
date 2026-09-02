<script lang="ts">
  import { personId, resumedAt } from '$lib/stores';
  import { getActivities, getActivityElements } from '$lib/api';
  import { cacheGet, cacheRefresh } from '$lib/cache';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import Button from '$lib/components/Button.svelte';
  import IconButton from '$lib/components/IconButton.svelte';

  let activities = $state<any[]>([]);

  // Foreground resume
  let resumedSeen = false;
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) { resumedSeen = true; return; }
    if ($personId !== null) {
      // force reload activities via cacheRefresh path if available, else re-trigger personId effect
      loadActivitiesResume();
    }
  });
  async function loadActivitiesResume() {
    const pid = $personId;
    if (!pid) return;
    try {
      activities = await cacheRefresh(`activiteiten_${pid}`, () => getActivities(pid), 5 * 60 * 1000);
    } catch {}
  }
  let selectedActivity = $state<any>(null);
  let elements = $state<any[]>([]);
  let loading = $state(true);
  let elementsLoading = $state(false);

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    try {
      activities = await cacheGet(`activiteiten_${pid}`, () => getActivities(pid), 5 * 60 * 1000);
    } catch (e) {
      console.error('Error loading activities:', e);
    }
    loading = false;
  });

  async function selectActivity(activity: any) {
    selectedActivity = activity;
    elementsLoading = true;
    try {
      elements = await getActivityElements($personId as number, activity.Id);
    } catch (e) {
      console.error('Error loading activity elements:', e);
    }
    elementsLoading = false;
  }

  function goBack() {
    selectedActivity = null;
    elements = [];
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-60">
  <!-- Header -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-4">
    <div class="max-w-5xl mx-auto w-full flex items-center justify-between">
      <div class="flex items-center gap-3 min-w-0">
        {#if selectedActivity}
          <IconButton
            onclick={goBack}
            class="bg-surface-900! border! border-white/5! shadow-lg"
            aria-label="Terug naar overzicht"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>
          </IconButton>
        {/if}
        <div class="flex flex-col min-w-0">
          <h1 class="text-title-large text-gray-100 truncate">
            {selectedActivity ? 'Details' : 'Activiteiten'}
          </h1>
          <p class="text-body-medium text-gray-600 mt-0.5">
            {selectedActivity ? selectedActivity.Titel : 'Inschrijvingen & Events'}
          </p>
        </div>
      </div>
    </div>
  </header>

  <main class="flex-1 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.02),transparent_40%)] pb-20 overflow-y-auto">
    <div class="max-w-5xl mx-auto p-5 space-y-8">
      {#if loading}
        <div class="flex flex-col items-center justify-center py-40 gap-4">
          <div class="w-10 h-10 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
          <p class="text-label-medium text-gray-600 animate-pulse">Laden...</p>
        </div>
      {:else if !selectedActivity}
        {#if activities.length === 0}
          <div in:fade class="glass rounded-m3-md p-16 text-center space-y-6 border-white/5 shadow-2xl flex flex-col items-center">
            <div class="w-20 h-20 bg-surface-900 rounded-m3-md flex items-center justify-center text-gray-700 border border-white/5 shadow-inner">
               <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 12 10 16 18 8"/><circle cx="12" cy="12" r="10"/></svg>
            </div>
            <h3 class="text-headline-small text-gray-400">Geen Activiteiten</h3>
            <p class="text-gray-700 text-body-medium">Niets om voor in te schrijven</p>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            {#each activities as activity, i}
              <button 
                in:fly={{ y: 20, delay: i * 30 }}
                onclick={() => selectActivity(activity)}
                class="glass p-6 rounded-m3-md border-white/5 hover:border-primary-500/20 hover:bg-surface-800/40 transition-all text-left flex flex-col gap-5 group shadow-xl relative overflow-hidden"
              >
                <div class="flex justify-between items-start relative z-10">
                   <div class="px-3 py-1.5 rounded-m3-sm border-white/10 bg-primary-500/10 text-primary-400 text-label-small border">
                      {activity.Status === 1 ? 'Open' : 'Gesloten'}
                   </div>
                   <span class="text-label-small text-gray-600 tabular-nums font-mono">
                     {new Date(activity.StartInschrijfdatum).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })}
                   </span>
                </div>
                <div class="space-y-2 relative z-10">
                  <h3 class="text-title-medium text-gray-100 group-hover:text-primary-400 transition-colors">
                    {activity.Titel}
                  </h3>
                  <p class="text-body-small text-gray-500 line-clamp-2 leading-relaxed">
                    {activity.Details?.replace(/<[^>]*>/g, '') || 'Geen omschrijving beschikbaar'}
                  </p>
                </div>
                
                <div class="flex items-center justify-between pt-4 mt-2 border-t border-white/[0.03] relative z-10">
                  <div class="flex items-center gap-2 text-label-small text-gray-400">
                    <svg class="w-3.5 h-3.5 text-primary-500/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    <span>{activity.AantalInschrijvingen} ingeschreven</span>
                  </div>
                  <svg class="w-4 h-4 text-gray-800 group-hover:text-primary-500 group-hover:translate-x-1 transition-all" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
                </div>
                
                <div class="absolute -right-6 -bottom-6 w-24 h-24 bg-primary-500/5 rounded-full blur-2xl group-hover:bg-primary-500/10 transition-colors"></div>
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="space-y-8" in:slide={{ duration: 400 }}>
          <div class="glass p-10 rounded-m3-md border-white/5 shadow-2xl relative overflow-hidden">
            <div class="absolute top-0 right-0 p-10 opacity-[0.03] grayscale pointer-events-none">
                <svg class="w-40 h-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            
            <div class="relative z-10 space-y-6">
              <h2 class="text-headline-medium text-white">{selectedActivity.Titel}</h2>
              {#if selectedActivity.Details}
                <div class="text-gray-400 text-body-large leading-loose prose-invert prose-p:mb-4">
                  {@html selectedActivity.Details}
                </div>
              {/if}
              
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-10 border-t border-white/5">
                <div>
                  <span class="text-label-small text-gray-600 block mb-2">Inschrijfperiode</span>
                  <div class="flex items-center gap-3">
                    <div class="px-3 py-1.5 rounded-m3-sm bg-surface-900 border border-white/5 text-label-medium text-gray-200 tabular-nums">
                      {new Date(selectedActivity.StartInschrijfdatum).toLocaleDateString('nl-NL')}
                    </div>
                    <svg class="w-3 h-3 text-gray-800" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
                    <div class="px-3 py-1.5 rounded-m3-sm bg-surface-900 border border-white/5 text-label-medium text-gray-200 tabular-nums">
                      {new Date(selectedActivity.EindeInschrijfdatum).toLocaleDateString('nl-NL')}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div>
             <div class="flex items-center gap-4 px-2 mb-6">
              <span class="text-label-medium text-gray-600">Mogelijkheden</span>
              <div class="h-px flex-1 bg-gradient-to-r from-white/5 to-transparent"></div>
            </div>

            {#if elementsLoading}
              <div class="flex items-center justify-center py-20">
                <div class="w-8 h-8 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
              </div>
            {:else if elements.length === 0}
              <div class="p-12 text-center opacity-30 glass rounded-m3-md border-dashed border-white/10">
                <p class="text-body-medium">Geen onderdelen gevonden</p>
              </div>
            {:else}
              <div class="grid grid-cols-1 gap-4">
                {#each elements as element}
                  <div class="glass p-6 rounded-m3-md border-white/5 flex flex-col sm:flex-row sm:items-center gap-6 group hover:bg-surface-800/40 transition-all shadow-xl">
                    <div class="flex-1 space-y-2">
                      <h4 class="text-title-small text-gray-100">{element.Titel}</h4>
                      {#if element.Details}
                        <p class="text-body-small text-gray-500 leading-relaxed">{@html element.Details}</p>
                      {/if}
                    </div>
                    
                    <div class="flex flex-col sm:items-end gap-3 shrink-0">
                       <div class="flex items-center gap-3">
                         <span class="text-label-small text-gray-600">
                           {element.AantalPlaatsenBeschikbaar} plekken vrij
                         </span>
                         {#if element.IsIngeschreven}
                           <span class="px-3 py-1 rounded-m3-sm text-label-small bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]">Ingeschreven</span>
                         {/if}
                       </div>
                       
                       {#if element.IsOpInTeSchrijven && !element.IsIngeschreven}
                         <Button variant="filled" class="px-8">
                           Inschrijven
                         </Button>
                       {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
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

</style>
