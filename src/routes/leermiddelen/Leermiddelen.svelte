<script lang="ts">
  import { personId } from '$lib/stores';
  import { getLeermiddelen } from '$lib/api';
  import { onMount } from 'svelte';

  let leermiddelen = $state<any[]>([]);
  let loading = $state(true);
  let searchQuery = $state('');

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    try {
      leermiddelen = await getLeermiddelen(pid);
    } catch (e) {
      console.error('Error loading leermiddelen:', e);
    }
    loading = false;
  });

  const filteredMaterials = $derived(
    leermiddelen.filter(m => 
      m.Titel.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (m.Vak?.Omschrijving || '').toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  function getStatusColor(status: number) {
    // Basic status mapping based on Discipulus
    if (status === 1) return 'text-accent-400 bg-accent-400/10';
    return 'text-gray-400 bg-gray-400/10';
  }
</script>

<div class="p-6 max-w-6xl mx-auto">
  <div class="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
    <div>
      <h1 class="text-3xl font-bold text-gray-100">Leermiddelen</h1>
      <p class="text-gray-500 mt-1">Je boeken en digitaal lesmateriaal</p>
    </div>
    <div class="relative max-w-xs w-full">
      <input
        type="text"
        placeholder="Zoeken op titel of vak..."
        bind:value={searchQuery}
        class="w-full bg-surface-800/50 border border-surface-700/50 rounded-xl px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-primary-500/50 transition-all pl-10"
      />
      <span class="absolute left-3.5 top-3 text-gray-500">🔍</span>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else if filteredMaterials.length === 0}
    <div class="glass rounded-3xl p-12 text-center">
      <div class="w-16 h-16 bg-surface-800 rounded-2xl flex items-center justify-center mx-auto mb-4 text-3xl">📚</div>
      <p class="text-gray-400 font-medium">Geen leermiddelen gevonden</p>
      {#if searchQuery}
        <button onclick={() => searchQuery = ''} class="mt-4 text-primary-400 text-sm hover:underline">Wis zoekopdracht</button>
      {/if}
    </div>
  {:else}
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {#each filteredMaterials as material}
        <div class="glass flex flex-col rounded-2xl overflow-hidden hover:translate-y-[-4px] transition-all duration-300 border border-surface-700/30 group">
          <div class="aspect-[3/4] bg-surface-900 relative overflow-hidden">
            {#if material.PreviewImageUrl}
              <img src={material.PreviewImageUrl} alt={material.Titel} class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
            {:else}
              <div class="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-800 to-surface-900 text-5xl">📖</div>
            {/if}
            <div class="absolute top-2 right-2">
               <span class="px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider {getStatusColor(material.Status)}">
                 {material.Status === 1 ? 'Actief' : 'Onbekend'}
               </span>
            </div>
          </div>
          
          <div class="p-4 flex flex-col flex-1">
            <div class="mb-2">
              <span class="text-[10px] font-bold text-primary-400 uppercase tracking-widest leading-none">
                {material.Vak?.Omschrijving || 'Algemeen'}
              </span>
              <h3 class="text-sm font-bold text-gray-100 line-clamp-2 mt-1 leading-snug h-10" title={material.Titel}>
                {material.Titel}
              </h3>
            </div>
            
            <div class="mt-auto pt-4 flex flex-wrap gap-2">
              {#each material.Links as link}
                {#if link.Rel === 'content'}
                  <a
                    href={link.Href}
                    target="_blank"
                    class="flex-1 bg-primary-500 hover:bg-primary-600 text-white text-xs font-bold py-2 rounded-lg text-center transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span>Openen</span>
                    <span class="text-[10px]">↗</span>
                  </a>
                {/if}
              {/each}
              <div class="w-full flex items-center justify-between mt-2 text-[10px] text-gray-500">
                <span>{material.Uitgeverij || ''}</span>
                <span>{material.EAN || ''}</span>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
