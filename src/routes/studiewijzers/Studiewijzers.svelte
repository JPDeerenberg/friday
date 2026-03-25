<script lang="ts">
  import { personId } from '$lib/stores';
  import { getStudiewijzers, getStudiewijzerDetail, getStudiewijzerOnderdeelDetail } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';

  let studiewijzers = $state<any[]>([]);
  let selectedSW = $state<any>(null);
  let selectedOnderdeel = $state<any>(null);
  let loading = $state(true);
  let subLoading = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    await loadInitialData();
  });

  async function loadInitialData() {
    const pid = $personId;
    if (!pid) return;
    loading = true;
    error = null;
    try {
      studiewijzers = await getStudiewijzers(pid);
      studiewijzers.sort((a, b) => a.Titel.localeCompare(b.Titel));
    } catch (e) {
      console.error('Error loading studiewijzers:', e);
      error = 'Kon studiewijzers niet laden. Probeer het later opnieuw.';
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
      selectedSW.Detail = await getStudiewijzerDetail($personId as number, sw.Id, isProject);
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
      selectedOnderdeel.Detail = await getStudiewijzerOnderdeelDetail($personId as number, selectedSW.Id, onderdeel.Id, isProject);
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

  function getFileIcon(bron: any) {
    if (bron.BronSoort === 3) return '🔗';
    const ext = bron.Naam?.split('.').pop()?.toLowerCase();
    const icons: Record<string, string> = {
      pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
      ppt: '📙', pptx: '📙', zip: '📦', rar: '📦', png: '🖼️',
      jpg: '🖼️', jpeg: '🖼️', svg: '🖼️', mp4: '🎬', mp3: '🎵'
    };
    return icons[ext] ?? '📄';
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-3">
    <div class="flex items-center justify-between w-full">
      <div class="flex items-center gap-3">
        {#if selectedSW}
          <button 
            onclick={goBack} 
            class="text-primary-400 font-bold text-sm"
          >
            ‹ Terug
          </button>
        {/if}
        <h1 class="text-lg font-bold text-gray-100 italic tracking-tight truncate max-w-[200px]">
          {#if selectedSW}
             {selectedSW.Titel}
          {:else}
             Studiewijzers
          {/if}
        </h1>
      </div>

      {#if !selectedSW}
        <button 
          onclick={loadInitialData}
          class="p-2 text-gray-500 hover:text-primary-400 transition-all hover:scale-110 active:scale-95"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      {/if}
    </div>
  </header>

  <div class="flex-1 flex flex-col min-h-0">
    {#if loading && !selectedSW && !studiewijzers.length}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
        <div class="w-12 h-12 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
        <p class="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] animate-pulse">Laden...</p>
      </div>
    {/if}

    {#if error && !selectedSW}
       <div class="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
          <div class="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center text-3xl mb-4 text-red-400 border border-red-500/20">
             ⚠️
          </div>
          <h3 class="text-xl font-black text-white italic mb-2">Oeps!</h3>
          <p class="text-gray-400 text-sm max-w-xs mb-6">{error}</p>
          <button onclick={loadInitialData} class="px-6 py-2 rounded-xl bg-primary-600 hover:bg-primary-500 text-white text-xs font-black uppercase tracking-widest">
             Opnieuw
          </button>
       </div>
    {:else if !selectedSW}
      <div class="h-full overflow-y-auto custom-scrollbar p-6 lg:p-10" in:fade>
        <div class="mb-6 flex items-center gap-4">
           <span class="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em]">Beschikbare wijzers</span>
           <div class="h-px w-full bg-gradient-to-r from-surface-800 to-transparent"></div>
        </div>

        {#if studiewijzers.length === 0 && !loading}
          <div class="flex flex-col items-center justify-center py-20 text-center opacity-20 grayscale">
             <div class="text-6xl mb-4">📚</div>
             <p class="text-gray-500 font-bold uppercase text-[10px] tracking-widest">Leeg</p>
          </div>
        {:else}
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {#each studiewijzers as sw, i}
              {@const isProj = isProject(sw)}
              <button 
                in:fly={{ y: 20, delay: i * 30 }}
                onclick={() => selectSW(sw)}
                class="glass p-6 rounded-[2rem] border-surface-800/50 hover:border-primary-500/30 hover:bg-surface-800/40 transition-all text-left flex flex-col gap-4 group shadow-xl"
              >
                <div class="flex items-start justify-between">
                   <div class="w-12 h-12 rounded-2xl bg-surface-900/80 border border-surface-700/50 flex items-center justify-center text-primary-400 group-hover:scale-110 transition-transform shadow-inner">
                      {#if isProj}
                        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
                      {:else}
                        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>
                      {/if}
                   </div>
                   <span class="text-[9px] font-black uppercase tracking-[0.15em] px-2.5 py-1 rounded-full border {isProj ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-primary-500/10 text-primary-400 border-primary-500/20'}">
                      {isProj ? 'Project' : 'Wijzer'}
                   </span>
                </div>
                <div class="flex-1">
                  <h3 class="text-base font-bold text-gray-100 italic tracking-tight line-clamp-2 leading-tight group-hover:text-primary-400 transition-colors">
                    {sw.Titel}
                  </h3>
                </div>
                <div class="flex items-center gap-2 text-[9px] font-black text-gray-500 uppercase tracking-widest mt-2 pt-4 border-t border-surface-800/50">
                   <span>{new Date(sw.Van).getFullYear()}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex h-full" in:slide={{ axis: 'x', duration: 300 }}>
        <div class="w-1/2 lg:w-1/3 border-r border-surface-800/50 bg-surface-900/20 flex flex-col">
          <div class="p-6 border-b border-surface-800/50 flex items-center justify-between">
             <h2 class="text-xs font-black text-gray-500 uppercase tracking-widest">Onderdelen</h2>
          </div>
          <div class="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
            {#if selectedSW.Detail?.Onderdelen?.Items}
              {#each selectedSW.Detail.Onderdelen.Items as onderdeel}
                <button 
                  onclick={() => selectOnderdeel(onderdeel)}
                  class="w-full p-4 rounded-2xl text-left transition-all border {selectedOnderdeel?.Id === onderdeel.Id ? 'bg-primary-500/10 border-primary-500/30' : 'bg-surface-800/30 border-transparent hover:bg-surface-800/80'} flex items-center gap-3 group"
                >
                  <div class="w-2 h-2 rounded-full shrink-0" style="background-color: {onderdeel.Kleur ? '#' + onderdeel.Kleur.toString(16).padStart(6, '0') : '#3b82f6'}"></div>
                  <span class="text-sm font-bold text-gray-200 group-hover:text-white transition-colors">{onderdeel.Titel}</span>
                </button>
              {/each}
            {/if}
          </div>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar bg-surface-950/20">
          {#if subLoading}
             <div class="h-full flex flex-col items-center justify-center gap-4">
                <div class="w-8 h-8 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
             </div>
          {:else if selectedOnderdeel}
            <div class="p-8 lg:p-12 space-y-10" in:fade>
              <div>
                <div class="flex items-center gap-3 mb-6">
                   <div class="w-3 h-10 rounded-full" style="background-color: {selectedOnderdeel.Kleur ? '#' + selectedOnderdeel.Kleur.toString(16).padStart(6, '0') : '#3b82f6'}"></div>
                   <h2 class="text-3xl font-black text-white italic tracking-tighter">{selectedOnderdeel.Titel}</h2>
                </div>
                {#if selectedOnderdeel.Omschrijving}
                  <div class="glass p-8 rounded-[2.5rem] border-surface-800/30 text-gray-300 text-sm leading-relaxed prose prose-invert max-w-none shadow-2xl">
                    {@html selectedOnderdeel.Omschrijving}
                  </div>
                {/if}
              </div>

              <div class="space-y-6">
                <div class="flex items-center gap-4">
                   <span class="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em]">Bronnen</span>
                   <div class="h-px w-full bg-surface-800"></div>
                </div>

                {#if (selectedOnderdeel.Detail?.Bronnen || []).length === 0}
                  <div class="p-12 text-center opacity-20">
                    <p class="text-gray-500 text-xs font-black uppercase tracking-widest">Geen bronnen</p>
                  </div>
                {:else}
                  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {#each selectedOnderdeel.Detail.Bronnen as bron, i}
                      <div in:fly={{ y: 15, delay: i * 30 }} class="glass p-4 rounded-3xl border-surface-800/50 flex items-center justify-between group">
                         <div class="flex items-center gap-4 min-w-0 pr-4">
                            <span class="text-2xl">{getFileIcon(bron)}</span>
                            <span class="text-sm font-bold text-gray-200 truncate">{bron.Naam}</span>
                         </div>
                         <a 
                           href={bron.Links?.find((l: any) => l.Rel === 'content')?.Href} 
                           target="_blank"
                           class="w-10 h-10 rounded-xl bg-surface-800/50 hover:bg-primary-500 flex items-center justify-center text-gray-400 hover:text-white transition-all active:scale-95"
                         >
                           <span>{bron.BronSoort === 3 ? '↗️' : '⬇️'}</span>
                         </a>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          {:else}
             <div class="h-full flex flex-col items-center justify-center p-8 text-center opacity-20">
                <div class="w-20 h-20 rounded-full bg-surface-900 flex items-center justify-center mb-6 text-gray-500 border border-surface-800 shadow-inner">
                  <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
                </div>
                <h3 class="text-xl font-black text-gray-400 italic">Selecteer een onderdeel</h3>
             </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Redundant CSS removed to fix Tailwind parsing */

  :global(.prose) {
     font-family: 'Inter', sans-serif;
  }
  :global(.prose b), :global(.prose strong) {
     color: #fff;
     font-weight: 800;
  }
  :global(.prose a) {
     color: #3b82f6;
     text-decoration: none;
     border-bottom: 1px solid rgba(59, 130, 246, 0.2);
  }
</style>
