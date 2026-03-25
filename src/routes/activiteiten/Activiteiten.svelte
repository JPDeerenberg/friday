<script lang="ts">
  import { personId } from '$lib/stores';
  import { getActivities, getActivityElements } from '$lib/api';
  import { onMount } from 'svelte';

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

<div class="p-4 md:p-6 max-w-5xl mx-auto h-full flex flex-col">
  <div class="flex items-center justify-between mb-8">
    <div>
      <h1 class="text-3xl font-bold text-gray-100">Activiteiten</h1>
      <p class="text-gray-500 mt-1">Inschrijven voor schoolactiviteiten en evenementen</p>
    </div>
    {#if selectedActivity}
      <button onclick={goBack} class="bg-surface-800 hover:bg-surface-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors">
        ⬅️ Alle activiteiten
      </button>
    {/if}
  </div>

  <div class="flex-1 overflow-y-auto no-scrollbar">
    {#if loading}
      <div class="flex items-center justify-center py-20">
        <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    {:else if !selectedActivity}
      {#if activities.length === 0}
        <div class="glass p-12 text-center rounded-3xl border border-surface-700/30">
          <span class="text-5xl mb-4 block">🎟️</span>
          <p class="text-gray-400">Er zijn momenteel geen activiteiten beschikbaar.</p>
        </div>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          {#each activities as activity}
            <button 
              type="button"
              onclick={() => selectActivity(activity)}
              class="glass p-6 rounded-2xl border border-surface-700/30 hover:border-primary-500/30 hover:bg-surface-800/50 transition-all cursor-pointer group text-left w-full"
            >
              <div class="flex justify-between items-start mb-4">
                <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-primary-500/10 text-primary-400 border border-primary-500/20">
                  {activity.Status === 1 ? 'Open' : 'Gesloten'}
                </span>
                <span class="text-xs text-gray-500">{new Date(activity.StartInschrijfdatum).toLocaleDateString()}</span>
              </div>
              <h3 class="text-lg font-bold text-gray-100 mb-2 group-hover:text-primary-400 transition-colors">{activity.Titel}</h3>
              <p class="text-xs text-gray-500 line-clamp-2 mb-4 leading-relaxed">{activity.Details || 'Geen omschrijving beschikbaar'}</p>
              
              <div class="flex items-center gap-4 text-[10px] font-bold text-gray-600 uppercase tracking-widest">
                <span class="flex items-center gap-1.5">👥 {activity.AantalInschrijvingen} ingeschreven</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="space-y-6">
        <div class="glass p-8 rounded-3xl border border-surface-700/30">
          <h2 class="text-2xl font-bold text-gray-100 mb-4">{selectedActivity.Titel}</h2>
          {#if selectedActivity.Details}
            <div class="text-gray-400 text-sm leading-relaxed mb-6">{@html selectedActivity.Details}</div>
          {/if}
          
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 pt-6 border-t border-surface-700/30">
            <div>
              <span class="text-[10px] font-bold text-gray-600 uppercase block mb-1">Inschrijfperiode</span>
              <p class="text-xs text-gray-300">
                {new Date(selectedActivity.StartInschrijfdatum).toLocaleDateString()} - 
                {new Date(selectedActivity.EindeInschrijfdatum).toLocaleDateString()}
              </p>
            </div>
          </div>
        </div>

        <h3 class="text-xl font-bold text-gray-200 mt-8 mb-4">Mogelijkheden</h3>
        {#if elementsLoading}
          <div class="flex items-center justify-center py-10">
            <div class="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if elements.length === 0}
          <p class="text-gray-500 italic">Geen onderdelen gevonden voor deze activiteit.</p>
        {:else}
          <div class="space-y-4">
            {#each elements as element}
              <div class="glass p-5 rounded-2xl border border-surface-700/30 flex flex-col sm:flex-row sm:items-center gap-4">
                <div class="flex-1">
                  <h4 class="font-bold text-gray-100">{element.Titel}</h4>
                  {#if element.Details}
                    <p class="text-xs text-gray-500 mt-1">{@html element.Details}</p>
                  {/if}
                </div>
                
                <div class="flex flex-col sm:items-end gap-2">
                   <div class="flex items-center gap-3">
                     <span class="text-[10px] text-gray-500 uppercase font-bold">
                       {element.AantalPlaatsenBeschikbaar} plekken over
                     </span>
                     {#if element.IsIngeschreven}
                       <span class="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-green-500/10 text-green-400 border border-green-500/20">Ingeschreven</span>
                     {/if}
                   </div>
                   
                   {#if element.IsOpInTeSchrijven && !element.IsIngeschreven}
                     <button class="bg-primary-500 hover:bg-primary-600 text-white text-xs font-bold px-4 py-2 rounded-xl transition-all shadow-lg shadow-primary-500/20">
                       Inschrijven
                     </button>
                   {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
