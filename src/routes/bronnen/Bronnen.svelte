<script lang="ts">
  import { personId } from '$lib/stores';
  import { getBronnen, getExternalBronSources } from '$lib/api';
  import { onMount } from 'svelte';

  let sources = $state<any[]>([]);
  let currentItems = $state<any[]>([]);
  let loading = $state(true);
  let pathHistory = $state<any[]>([]); // To support back navigation

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    try {
      sources = await getExternalBronSources(pid);
      // Automatically enter the first source (usually Magister Bronnen)
      if (sources.length > 0) {
        enterSource(sources[0]);
      } else {
        loading = false;
      }
    } catch (e) {
      console.error('Error loading sources:', e);
      loading = false;
    }
  });

  async function enterSource(source: any) {
    loading = true;
    const path = source.Links.find((l: any) => l.Rel === 'items')?.Href;
    if (path) {
      try {
        currentItems = await getBronnen(path);
        pathHistory = [{ Naam: source.Naam, Href: path }];
      } catch (e) {
        console.error('Error entering source:', e);
      }
    }
    loading = false;
  }

  async function enterFolder(folder: any) {
    loading = true;
    const path = folder.Links.find((l: any) => l.Rel === 'items')?.Href;
    if (path) {
      try {
        currentItems = await getBronnen(path);
        pathHistory = [...pathHistory, { Naam: folder.Naam, Href: path }];
      } catch (e) {
        console.error('Error entering folder:', e);
      }
    }
    loading = false;
  }

  async function goBack() {
    if (pathHistory.length <= 1) return;
    loading = true;
    const newHistory = pathHistory.slice(0, -1);
    const last = newHistory[newHistory.length - 1];
    try {
      currentItems = await getBronnen(last.Href);
      pathHistory = newHistory;
    } catch (e) {
      console.error('Error going back:', e);
    }
    loading = false;
  }

  function formatSize(bytes: number) {
    if (bytes === 0) return '';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i)) + ' ' + sizes[i];
  }

  function getFileIcon(item: any) {
    if (item.BronSoort === 0) return '📁';
    if (item.BronSoort === 3) return '🔗';
    const type = item.ContentType?.toLowerCase() || '';
    if (type.includes('pdf')) return '📕';
    if (type.includes('image')) return '🖼️';
    if (type.includes('word') || type.includes('text')) return '📄';
    if (type.includes('presentation') || type.includes('powerpoint')) return '📊';
    if (type.includes('spreadsheet') || type.includes('excel')) return '📉';
    return '📄';
  }
</script>

<div class="h-full flex flex-col p-6 max-w-6xl mx-auto overflow-hidden">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-3xl font-bold text-gray-100">Bronnen</h1>
      <p class="text-gray-500 mt-1">Schooldocumenten en extern lesmateriaal</p>
    </div>
  </div>

  <div class="flex-1 flex flex-col glass rounded-3xl overflow-hidden border border-surface-700/30">
    <div class="bg-surface-800/50 p-3 flex items-center gap-2 border-b border-surface-700/30">
      <button 
        onclick={goBack} 
        disabled={pathHistory.length <= 1}
        class="p-2 rounded-xl hover:bg-surface-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-gray-300"
      >
        ⬅️
      </button>
      
      <div class="flex items-center overflow-x-auto no-scrollbar gap-1 text-xs">
        {#each pathHistory as part, i}
          {#if i > 0}<span class="text-gray-600 mx-0.5">/</span>{/if}
          <span class="px-2 py-1 rounded-lg bg-surface-700/50 text-gray-200 whitespace-nowrap">{part.Naam}</span>
        {/each}
      </div>
    </div>

    <div class="flex-1 overflow-y-auto custom-scrollbar p-2">
      {#if loading}
        <div class="flex items-center justify-center h-full">
          <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else if currentItems.length === 0}
        <div class="flex flex-col items-center justify-center h-full py-20 opacity-50">
          <span class="text-5xl mb-4">📭</span>
          <p class="text-gray-400">Deze map is leeg</p>
        </div>
      {:else}
        <div class="grid grid-cols-1 divide-y divide-surface-800">
          {#each currentItems as item}
            <div class="group flex items-center gap-4 p-3 hover:bg-surface-800/50 rounded-xl transition-all cursor-pointer">
              <div class="w-10 h-10 rounded-xl bg-surface-800 flex items-center justify-center text-xl group-hover:scale-110 transition-transform">
                {getFileIcon(item)}
              </div>
              
              <button 
                type="button"
                class="flex-1 min-w-0 text-left" 
                onclick={() => item.BronSoort === 0 ? enterFolder(item) : null}
              >
                <h3 class="text-sm font-medium text-gray-200 truncate">{item.Naam}</h3>
                <div class="flex items-center gap-3 mt-0.5">
                   <span class="text-[10px] text-gray-500">{item.BronSoort === 0 ? 'Map' : item.BronSoort === 3 ? 'Link' : 'Bestand'}</span>
                   {#if item.Grootte > 0}
                     <span class="text-[10px] text-gray-600">•</span>
                     <span class="text-[10px] text-gray-500">{formatSize(item.Grootte)}</span>
                   {/if}
                </div>
              </button>

              <div class="flex items-center gap-2">
                {#if item.BronSoort === 3}
                  <a href={item.Links.find((l: any) => l.Rel === 'content')?.Href} target="_blank" class="p-2 hover:bg-surface-700 rounded-lg text-primary-400 transition-colors">
                    🌐
                  </a>
                {:else if item.BronSoort === 1}
                  <a href={item.Links.find((l: any) => l.Rel === 'content')?.Href} target="_blank" class="p-2 hover:bg-surface-700 rounded-lg text-primary-400 transition-colors">
                    📥
                  </a>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
