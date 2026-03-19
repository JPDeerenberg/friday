<script lang="ts">
  import { personId } from '$lib/stores';
  import { getStudiewijzers, getStudiewijzerDetail, getStudiewijzerOnderdeelDetail } from '$lib/api';
  import { onMount } from 'svelte';

  let studiewijzers = $state<any[]>([]);
  let selectedSW = $state<any>(null);
  let selectedOnderdeel = $state<any>(null);
  let loading = $state(true);
  let subLoading = $state(false);

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    try {
      studiewijzers = await getStudiewijzers(pid);
    } catch (e) {
      console.error('Error loading studiewijzers:', e);
    }
    loading = false;
  });

  async function selectSW(sw: any) {
    loading = true;
    selectedSW = sw;
    selectedOnderdeel = null;
    try {
      const isProject = sw.Links.some((l: any) => l.Href.includes('projecten'));
      selectedSW.Detail = await getStudiewijzerDetail($personId as number, sw.Id, isProject);
    } catch (e) {
      console.error('Error loading sw detail:', e);
    }
    loading = false;
  }

  async function selectOnderdeel(onderdeel: any) {
    subLoading = true;
    selectedOnderdeel = onderdeel;
    try {
      const isProject = selectedSW.Links.some((l: any) => l.Href.includes('projecten'));
      selectedOnderdeel.Detail = await getStudiewijzerOnderdeelDetail($personId as number, selectedSW.Id, onderdeel.Id, isProject);
    } catch (e) {
      console.error('Error loading onderdeel detail:', e);
    }
    subLoading = false;
  }

  function goBack() {
    if (selectedOnderdeel) {
      selectedOnderdeel = null;
    } else {
      selectedSW = null;
    }
  }
</script>

<div class="h-full flex flex-col p-6 max-w-6xl mx-auto overflow-hidden">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-3xl font-bold text-gray-100">Studiewijzers</h1>
      <p class="text-gray-500 mt-1">Planners, projecten en studiemateriaal</p>
    </div>
    {#if selectedSW}
      <button onclick={goBack} class="bg-surface-800 hover:bg-surface-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors">
        ⬅️ Terug
      </button>
    {/if}
  </div>

  <div class="flex-1 overflow-y-auto custom-scrollbar">
    {#if loading}
      <div class="flex items-center justify-center h-full py-20">
        <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    {:else if !selectedSW}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each studiewijzers as sw}
          <button 
            type="button"
            onclick={() => selectSW(sw)}
            class="glass p-5 rounded-2xl border border-surface-700/30 hover:border-primary-500/30 hover:bg-surface-800/50 transition-all cursor-pointer group text-left w-full"
          >
            <div class="flex items-center gap-3 mb-3">
              <span class="text-2xl group-hover:scale-110 transition-transform">📚</span>
              <h3 class="font-bold text-gray-100 line-clamp-1">{sw.Titel}</h3>
            </div>
            <div class="flex items-center gap-2 text-[10px] text-gray-500 font-bold uppercase tracking-wider">
               <span>{sw.InLeerlingArchief ? 'Archief' : 'Huidig'}</span>
               <span class="w-1 h-1 bg-surface-700 rounded-full"></span>
               <span>{new Date(sw.Van).getFullYear()}</span>
            </div>
          </button>
        {/each}
      </div>
    {:else if !selectedOnderdeel}
      <div class="space-y-4">
        <h2 class="text-xl font-bold text-gray-200 mb-4">{selectedSW.Titel}</h2>
        <div class="grid grid-cols-1 gap-2">
          {#each selectedSW.Detail.Onderdelen.Items as onderdeel}
             <button 
               type="button"
               onclick={() => selectOnderdeel(onderdeel)}
               class="glass p-4 rounded-xl border border-surface-700/30 hover:bg-surface-800/50 transition-all cursor-pointer flex items-center justify-between text-left w-full"
             >
                <div class="flex items-center gap-3">
                  <div class="w-1.5 h-6 rounded-full" style="background-color: {onderdeel.Kleur || '#3b82f6'}"></div>
                  <span class="text-sm font-medium text-gray-200">{onderdeel.Titel}</span>
                </div>
                <span class="text-[10px] text-gray-500">{onderdeel.Bronnen?.length || 0} bronnen</span>
             </button>
          {/each}
        </div>
      </div>
    {:else}
      <div class="space-y-6">
        <div class="flex items-center gap-3 mb-2">
           <div class="w-2 h-8 rounded-full" style="background-color: {selectedOnderdeel.Kleur || '#3b82f6'}"></div>
           <h2 class="text-2xl font-bold text-gray-100">{selectedOnderdeel.Titel}</h2>
        </div>

        {#if selectedOnderdeel.Omschrijving}
          <div class="glass p-6 rounded-2xl text-gray-300 text-sm leading-relaxed prose prose-invert max-w-none">
            {@html selectedOnderdeel.Omschrijving}
          </div>
        {/if}

        <div class="space-y-3">
          <h3 class="text-lg font-bold text-gray-200 flex items-center gap-2">
             <span>📂</span> Bronnen
          </h3>
          {#if subLoading}
             <div class="p-4 text-center text-gray-500">Laden...</div>
          {:else if (selectedOnderdeel.Detail?.Bronnen || []).length === 0}
             <div class="p-8 glass rounded-2xl text-center text-gray-500 italic">Geen bronnen gevonden</div>
          {:else}
             <div class="grid grid-cols-1 gap-2">
               {#each selectedOnderdeel.Detail.Bronnen as bron}
                 <div class="glass p-3 rounded-xl border border-surface-700/30 flex items-center justify-between group hover:bg-surface-800/30 transition-all">
                    <div class="flex items-center gap-3">
                      <span class="text-xl">{bron.BronSoort === 3 ? '🔗' : '📄'}</span>
                      <span class="text-sm text-gray-200">{bron.Naam}</span>
                    </div>
                    <a 
                      href={bron.Links.find((l: any) => l.Rel === 'content')?.Href} 
                      target="_blank"
                      class="text-xs bg-surface-800 hover:bg-primary-500 px-3 py-1.5 rounded-lg text-gray-300 hover:text-white transition-all"
                    >
                      {bron.BronSoort === 3 ? 'Bezoek' : 'Download'}
                    </a>
                 </div>
               {/each}
             </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
