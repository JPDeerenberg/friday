<script lang="ts">
  import { personId } from '$lib/stores';
  import { getActivities, getActivityElements } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';

  let activities = $state<any[]>([]);
  let selectedActivity = $state<any>(null);
  let elements = $state<any[]>([]);
  let loading = $state(true);
  let elementsLoading = $state(false);

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    try {
      activities = await getActivities(pid);
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
          <button 
            onclick={goBack} 
            class="p-2.5 rounded-2xl bg-surface-900 border border-white/5 text-gray-400 hover:text-primary-400 transition-all active:scale-95 shadow-lg"
            aria-label="Terug naar overzicht"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        {/if}
        <div class="flex flex-col min-w-0">
          <h1 class="text-xl font-black text-gray-100 italic tracking-tighter uppercase truncate">
            {selectedActivity ? 'Details' : 'Activiteiten'}
          </h1>
          <p class="text-[9px] font-black text-gray-600 uppercase tracking-widest mt-0.5">
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
          <p class="text-[9px] font-black text-gray-600 uppercase tracking-widest animate-pulse">Laden...</p>
        </div>
      {:else if !selectedActivity}
        {#if activities.length === 0}
          <div in:fade class="glass rounded-[3rem] p-16 text-center space-y-6 border-white/5 shadow-2xl flex flex-col items-center">
            <div class="w-20 h-20 bg-surface-900 rounded-[2.5rem] flex items-center justify-center text-gray-700 border border-white/5 shadow-inner">
               <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 12 10 16 18 8"/><circle cx="12" cy="12" r="10"/></svg>
            </div>
            <h3 class="text-xl font-black text-gray-400 italic uppercase">Geen Activiteiten</h3>
            <p class="text-gray-700 text-[10px] font-black uppercase tracking-[0.4em]">Niets om voor in te schrijven</p>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            {#each activities as activity, i}
              <button 
                in:fly={{ y: 20, delay: i * 30 }}
                onclick={() => selectActivity(activity)}
                class="glass p-6 rounded-[2.5rem] border-white/5 hover:border-primary-500/20 hover:bg-surface-800/40 transition-all text-left flex flex-col gap-5 group shadow-xl relative overflow-hidden"
              >
                <div class="flex justify-between items-start relative z-10">
                   <div class="px-3 py-1.5 rounded-xl border-white/10 bg-primary-500/10 text-primary-400 text-[8px] font-black uppercase tracking-widest border">
                      {activity.Status === 1 ? 'Open' : 'Gesloten'}
                   </div>
                   <span class="text-[9px] font-black text-gray-600 uppercase tracking-tighter tabular-nums font-mono">
                     {new Date(activity.StartInschrijfdatum).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })}
                   </span>
                </div>
                <div class="space-y-2 relative z-10">
                  <h3 class="text-lg font-black text-gray-100 group-hover:text-primary-400 transition-colors italic uppercase tracking-tighter">
                    {activity.Titel}
                  </h3>
                  <p class="text-[11px] text-gray-500 font-bold tracking-tight line-clamp-2 leading-relaxed italic">
                    {activity.Details?.replace(/<[^>]*>/g, '') || 'Geen omschrijving beschikbaar'}
                  </p>
                </div>
                
                <div class="flex items-center justify-between pt-4 mt-2 border-t border-white/[0.03] relative z-10">
                  <div class="flex items-center gap-2 text-[9px] font-black text-gray-400 uppercase tracking-widest">
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
          <div class="glass p-10 rounded-[3rem] border-white/5 shadow-2xl relative overflow-hidden">
            <div class="absolute top-0 right-0 p-10 opacity-[0.03] grayscale pointer-events-none">
                <svg class="w-40 h-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            
            <div class="relative z-10 space-y-6">
              <h2 class="text-3xl font-black text-white italic tracking-tighter uppercase">{selectedActivity.Titel}</h2>
              {#if selectedActivity.Details}
                <div class="text-gray-400 text-sm leading-loose prose-invert prose-p:mb-4 italic">
                  {@html selectedActivity.Details}
                </div>
              {/if}
              
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-10 border-t border-white/5">
                <div>
                  <span class="text-[9px] font-black text-gray-600 uppercase tracking-[0.2em] block mb-2">Inschrijfperiode</span>
                  <div class="flex items-center gap-3">
                    <div class="px-3 py-1.5 rounded-xl bg-surface-900 border border-white/5 text-[10px] font-black text-gray-200 tabular-nums">
                      {new Date(selectedActivity.StartInschrijfdatum).toLocaleDateString('nl-NL')}
                    </div>
                    <svg class="w-3 h-3 text-gray-800" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
                    <div class="px-3 py-1.5 rounded-xl bg-surface-900 border border-white/5 text-[10px] font-black text-gray-200 tabular-nums">
                      {new Date(selectedActivity.EindeInschrijfdatum).toLocaleDateString('nl-NL')}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div>
             <div class="flex items-center gap-4 px-2 mb-6">
              <span class="text-[10px] font-black text-gray-600 uppercase tracking-[0.3em] italic">Mogelijkheden</span>
              <div class="h-px flex-1 bg-gradient-to-r from-white/5 to-transparent"></div>
            </div>

            {#if elementsLoading}
              <div class="flex items-center justify-center py-20">
                <div class="w-8 h-8 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
              </div>
            {:else if elements.length === 0}
              <div class="p-12 text-center opacity-30 glass rounded-3xl border-dashed border-white/10">
                <p class="text-[10px] font-black uppercase tracking-widest">Geen onderdelen gevonden</p>
              </div>
            {:else}
              <div class="grid grid-cols-1 gap-4">
                {#each elements as element}
                  <div class="glass p-6 rounded-[2.5rem] border-white/5 flex flex-col sm:flex-row sm:items-center gap-6 group hover:bg-surface-800/40 transition-all shadow-xl">
                    <div class="flex-1 space-y-2">
                      <h4 class="text-sm font-black text-gray-100 uppercase italic tracking-tight">{element.Titel}</h4>
                      {#if element.Details}
                        <p class="text-[11px] text-gray-500 font-bold leading-relaxed italic">{@html element.Details}</p>
                      {/if}
                    </div>
                    
                    <div class="flex flex-col sm:items-end gap-3 shrink-0">
                       <div class="flex items-center gap-3">
                         <span class="text-[9px] font-black text-gray-600 uppercase tracking-widest">
                           {element.AantalPlaatsenBeschikbaar} PLEKKEN VRIJ
                         </span>
                         {#if element.IsIngeschreven}
                           <span class="px-3 py-1 rounded-xl text-[8px] font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]">Ingeschreven</span>
                         {/if}
                       </div>
                       
                       {#if element.IsOpInTeSchrijven && !element.IsIngeschreven}
                         <button class="bg-primary-500 hover:bg-primary-600 text-white text-[10px] font-black uppercase tracking-widest px-8 py-3.5 rounded-2xl transition-all shadow-xl shadow-primary-500/20 active:scale-95 border border-primary-400/30">
                           Inschrijven
                         </button>
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
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
