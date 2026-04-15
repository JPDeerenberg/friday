<script lang="ts">
  import { personId } from '$lib/stores';
  import { getBronnen, getExternalBronSources } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';

  /** Find the href from a Links array using multiple possible Rel values. */
  function findLink(links: any[], ...rels: string[]): string | undefined {
    for (const rel of rels) {
      const found = links?.find((l: any) => l.Rel?.toLowerCase() === rel.toLowerCase());
      if (found?.Href) return found.Href;
    }
    return undefined;
  }

  let sources = $state<any[]>([]);
  let currentItems = $state<any[]>([]);
  let loading = $state(true);
  let pathHistory = $state<any[]>([]); // To support back navigation

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    try {
      sources = await getExternalBronSources(pid);
      console.log('[Bronnen] External sources:', JSON.stringify(sources));
      if (sources.length > 0) {
        // Try each source until we find one with items
        let loaded = false;
        for (const src of sources) {
          await enterSource(src);
          if (currentItems.length > 0) { loaded = true; break; }
        }
        if (!loaded) loading = false;
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
    // Try multiple rel names — Magister uses different ones per API version
    const path = findLink(source.Links, 'items', 'self', 'content', 'children');
    console.log('[Bronnen] enterSource', source.Naam, 'path =', path, 'links =', JSON.stringify(source.Links));
    if (path) {
      try {
        currentItems = await getBronnen(path);
        console.log('[Bronnen] items loaded:', currentItems.length);
        pathHistory = [{ Naam: source.Naam, Href: path }];
      } catch (e) {
        console.error('Error entering source:', e);
        currentItems = [];
        pathHistory = [{ Naam: source.Naam, Href: path }];
      }
    } else {
      console.warn('[Bronnen] No usable link found in source links:', JSON.stringify(source.Links));
      currentItems = [];
      pathHistory = [{ Naam: source.Naam, Href: '' }];
    }
    loading = false;
  }

  async function enterFolder(folder: any) {
    loading = true;
    const path = findLink(folder.Links, 'items', 'self', 'content', 'children');
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
    if (!bytes || bytes === 0) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i)) + ' ' + sizes[i];
  }

  function getFileIcon(item: any) {
    const iconBase = `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">`;
    if (item.BronSoort === 0) return iconBase + '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    if (item.BronSoort === 3) return iconBase + '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    
    const type = item.ContentType?.toLowerCase() || '';
    if (type.includes('pdf')) return iconBase + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>';
    if (type.includes('image')) return iconBase + '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    if (type.includes('presentation') || type.includes('powerpoint')) return iconBase + '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>';
    if (type.includes('spreadsheet') || type.includes('excel')) return iconBase + '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>';
    
    return iconBase + '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-60">
  <!-- Header -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-4">
    <div class="flex flex-col gap-4 max-w-5xl mx-auto w-full">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-black text-gray-100 italic tracking-tighter uppercase">Bronnen</h1>
          <p class="text-[10px] font-black text-gray-600 uppercase tracking-widest mt-0.5">Lesmateriaal & Documenten</p>
        </div>
        
        <button 
          onclick={goBack} 
          disabled={pathHistory.length <= 1}
          class="p-2.5 rounded-2xl bg-surface-900 border border-white/5 text-gray-400 hover:text-primary-400 disabled:opacity-20 transition-all active:scale-95 shadow-lg shadow-black/20"
          aria-label="Terug"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
      </div>

      <!-- Path breadcrumbs -->
      <div class="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
        {#each pathHistory as part, i}
          {#if i > 0}
            <svg class="w-3 h-3 text-gray-800 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
          {/if}
          <span class="px-3 py-1.5 rounded-xl bg-surface-900/50 border border-white/5 text-[9px] font-black uppercase tracking-widest text-gray-400 whitespace-nowrap shadow-sm">
            {part.Naam}
          </span>
        {/each}
      </div>
    </div>
  </header>

  <main class="flex-1 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.02),transparent_40%)] pb-20 overflow-y-auto">
    <div class="max-w-5xl mx-auto p-4 lg:p-8 space-y-6">
      
      {#if loading}
        <div class="flex flex-col items-center justify-center py-40 gap-4">
          <div class="w-10 h-10 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
          <p class="text-[9px] font-black text-gray-600 uppercase tracking-widest animate-pulse">Bestanden zoeken...</p>
        </div>
      {:else if currentItems.length === 0}
        <div in:fade class="glass rounded-[3rem] p-16 text-center space-y-6 border-surface-800/50 bg-surface-900/[0.02] shadow-2xl">
          <div class="w-20 h-20 bg-surface-900 rounded-[2rem] flex items-center justify-center mx-auto text-gray-700 border border-white/5 shadow-inner">
            <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="space-y-1">
            <h3 class="text-xl font-black text-white italic tracking-tight uppercase">Lege Map</h3>
            <p class="text-gray-600 text-[10px] font-black uppercase tracking-widest leading-relaxed">Geen bestanden gevonden in deze map.</p>
          </div>
        </div>
      {:else}
        <div class="grid grid-cols-1 divide-y divide-white/[0.03] glass rounded-[2.5rem] overflow-hidden shadow-2xl border-white/5">
          {#each currentItems as item, i}
            <div 
              in:fly={{ y: 10, delay: i * 20 }} 
              class="group flex items-center gap-5 p-5 hover:bg-surface-800/40 transition-all cursor-pointer relative"
              role="button"
              tabindex="0"
              onclick={() => item.BronSoort === 0 ? enterFolder(item) : null}
              onkeydown={(e) => { 
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (item.BronSoort === 0) enterFolder(item);
                }
              }}
            >
              <div class="w-12 h-12 rounded-2xl bg-surface-950 flex items-center justify-center text-primary-400 group-hover:bg-primary-500/10 group-hover:scale-105 transition-all shadow-inner border border-white/5">
                {@html getFileIcon(item)}
              </div>
              
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-black text-gray-200 truncate group-hover:text-white transition-colors italic uppercase tracking-tighter">
                  {item.Naam}
                </h3>
                <div class="flex items-center gap-3 mt-1 underline-offset-4">
                   <span class="text-[9px] font-black text-gray-600 uppercase tracking-widest">{item.BronSoort === 0 ? 'Folder' : item.BronSoort === 3 ? 'URL' : 'Data'}</span>
                   {#if item.Grootte > 0}
                     <span class="w-1 h-1 bg-surface-800 rounded-full"></span>
                     <span class="text-[9px] font-black text-gray-500 uppercase tabular-nums">{formatSize(item.Grootte)}</span>
                   {/if}
                </div>
              </button>

              <div class="flex items-center gap-3">
                {#if item.BronSoort === 3}
                  <a href={item.Links.find((l: any) => l.Rel === 'content')?.Href} target="_blank" class="p-3 bg-surface-950/50 hover:bg-primary-500/10 rounded-2xl text-primary-400 transition-all border border-white/5 shadow-inner active:scale-90">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                {:else if item.BronSoort === 1}
                  <a href={item.Links.find((l: any) => l.Rel === 'content')?.Href} target="_blank" class="p-3 bg-surface-950/50 hover:bg-primary-500/10 rounded-2xl text-primary-400 transition-all border border-white/5 shadow-inner active:scale-90">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </a>
                {/if}
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
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid oklch(1 0 0 / 0.05);
  }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
