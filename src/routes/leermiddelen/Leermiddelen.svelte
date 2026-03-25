<script lang="ts">
  import { personId } from '$lib/stores';
  import { getLeermiddelen, formatDate } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';

  let leermiddelen = $state<any[]>([]);
  let loading = $state(true);
  let searchQuery = $state('');
  let error = $state<string | null>(null);

  onMount(async () => {
    await loadData();
  });

  async function loadData() {
    const pid = $personId;
    if (!pid) return;
    loading = true;
    error = null;
    try {
      leermiddelen = await getLeermiddelen(pid);
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
    return 'text-gray-400 bg-gray-400/10 border-surface-700/30';
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <header class="sticky top-0 z-10 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-3 pb-4">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-100 italic tracking-tighter">Leermiddelen</h1>
        <button 
          onclick={loadData} 
          class="p-2 text-gray-500 hover:text-emerald-400 transition-all hover:scale-110 active:scale-95"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
    </div>
    
    <div class="relative">
      <input
        type="text"
        placeholder="Zoeken..."
        bind:value={searchQuery}
        class="w-full bg-surface-800/50 border border-surface-700/50 rounded-xl px-4 py-2 pl-9 text-xs font-bold text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all shadow-inner"
      />
      <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-[10px]">🔍</span>
    </div>
  </header>

  <main class="bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.03),transparent_40%)] pb-10">
    <div class="max-w-7xl mx-auto p-10 lg:p-14">
      
      {#if loading && !leermiddelen.length}
        <div class="flex flex-col items-center justify-center py-40 gap-6">
          <div class="w-14 h-14 border-4 border-emerald-500/10 border-t-emerald-500 rounded-full animate-spin shadow-[0_0_30px_rgba(16,185,129,0.15)]"></div>
          <p class="text-[10px] font-black text-gray-500 uppercase tracking-[0.4em] animate-pulse">Materialen laden...</p>
        </div>
      {:else if error && !leermiddelen.length}
        <div class="glass rounded-[3rem] p-24 text-center space-y-8 border-red-500/10 bg-red-500/[0.03] shadow-2xl">
           <div class="w-24 h-24 bg-red-500/10 rounded-full flex items-center justify-center mx-auto text-5xl shadow-lg border border-red-500/20 animate-bounce">
              ⚠️
           </div>
           <div class="space-y-3">
              <h3 class="text-2xl font-black text-white italic tracking-tight">Fout bij laden</h3>
              <p class="text-gray-400 text-sm max-w-sm mx-auto leading-relaxed">{error}</p>
           </div>
           <button onclick={loadData} class="px-8 py-3 rounded-2xl bg-surface-800 hover:bg-surface-700 text-white text-[10px] font-black uppercase tracking-[0.25em] transition-all hover:scale-105 active:scale-95 shadow-xl">
              Probeer opnieuw
           </button>
        </div>
      {:else if filteredMaterials().length === 0}
        <div in:fade class="glass rounded-[3rem] p-24 text-center space-y-8 border-surface-800/50 shadow-2xl">
          <div class="w-24 h-24 bg-surface-900/80 rounded-full flex items-center justify-center mx-auto text-6xl shadow-inner border border-surface-800 grayscale opacity-10">
            📖
          </div>
          <div class="space-y-2">
            <h3 class="text-2xl font-black text-gray-400 italic">Niets gevonden</h3>
            <p class="text-gray-600 text-[10px] font-black uppercase tracking-[0.3em]">Pas je zoekopdracht aan</p>
          </div>
        </div>
      {:else}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-10">
          {#each filteredMaterials() as material, i}
            <div 
              in:fly={{ y: 30, delay: i * 40 }}
              class="flex flex-col group h-full perspective-1000"
            >
              <div class="relative aspect-[3/4.2] rounded-[2.5rem] overflow-hidden mb-6 shadow-2xl transition-all duration-700 group-hover:scale-[1.03] group-hover:-translate-y-3 group-hover:shadow-[0_30px_60px_rgba(0,0,0,0.6)] ring-1 ring-white/5 group-hover:ring-emerald-500/30">
                 {#if material.PreviewImageUrl}
                   <img src={material.PreviewImageUrl} alt={material.Titel} class="w-full h-full object-cover group-hover:brightness-110 transition-all duration-700" />
                 {:else}
                    <div class="w-full h-full bg-gradient-to-br from-surface-800 to-surface-950 flex flex-col items-center justify-center p-8 text-center border border-surface-700/50 shadow-inner">
                      <div class="text-gray-500 group-hover:scale-110 transition-transform duration-500 drop-shadow-2xl mb-5">
                         <svg class="w-20 h-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>
                      </div>
                      <div class="px-4 py-1.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)] transition-all group-hover:bg-emerald-500/20">
                        <span class="text-[10px] font-black text-emerald-400 uppercase tracking-[0.2em]">
                           {material.Vak?.Afkorting || 'ALGEM'}
                        </span>
                     </div>
                   </div>
                 {/if}

                 <div class="absolute inset-0 bg-gradient-to-t from-surface-950 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                 
                 <div class="absolute top-5 right-5">
                    <span class="px-4 py-1.5 rounded-2xl text-[9px] font-black uppercase tracking-[0.2em] border backdrop-blur-xl shadow-lg {getStatusColor(material.Status)}">
                      {material.Status === 1 ? 'Actief' : 'Gearchiv.'}
                    </span>
                 </div>

                 <div class="absolute inset-x-6 bottom-6 translate-y-8 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-500 delay-75">
                    {#each material.Links as link}
                      {#if link.Rel === 'content'}
                        <a
                          href={link.Href}
                          target="_blank"
                          class="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-black py-4 rounded-[1.25rem] text-center transition-all flex items-center justify-center gap-3 uppercase tracking-[0.2em] shadow-[0_10px_30px_rgba(16,185,129,0.3)] ring-1 ring-emerald-400/50 hover:scale-[1.02] active:scale-98"
                        >
                          Openen ↗
                        </a>
                      {/if}
                    {/each}
                 </div>
              </div>

              <div class="px-3 space-y-2 flex-1">
                <span class="text-[9px] font-black text-emerald-500/90 uppercase tracking-[0.25em] leading-none block italic">
                  {material.Vak?.Omschrijving || 'Algemeen'}
                </span>
                <h3 class="text-base font-bold text-gray-100 group-hover:text-emerald-400 transition-colors line-clamp-2 leading-tight italic tracking-tight min-h-[2.5rem]">
                  {material.Titel}
                </h3>
                
                <div class="flex items-center justify-between pt-4 mt-2 border-t border-surface-800/50 text-[10px] font-black text-gray-500 uppercase tracking-widest opacity-80">
                   <span class="truncate pr-4">{material.Uitgeverij || 'Uitgeverij'}</span>
                   <span class="shrink-0 tracking-tighter text-[9px] opacity-50">{material.EAN || ''}</span>
                </div>
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
    background: rgba(30, 41, 59, 0.4);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 10px;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .perspective-1000 {
    perspective: 1000px;
  }
</style>
