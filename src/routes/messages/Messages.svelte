<script lang="ts">
  import { getMessageFolders, getMessages, getMessageDetail, markMessagesAsRead, searchContacts, sendMessage } from '$lib/api';
  import { onMount } from 'svelte';
  import { slide, fade } from 'svelte/transition';

  let folders = $state<any[]>([]);
  let selectedFolder = $state<any>(null);
  let messages = $state<any[]>([]);
  let selectedMessage = $state<any>(null);
  let loading = $state(true);
  let loadingMessages = $state(false);
  let loadingDetail = $state(false);
  let showCompose = $state(false);

  let panel = $state<'list' | 'detail'>('list');

  // Filters & Search
  let msgFilter = $state<'all' | 'unread' | 'priority'>('all');
  let searchQuery = $state('');
  let searchOpen = $state(false);

  const filteredMessages = $derived(() => {
    let list = messages;
    if (msgFilter === 'unread') list = list.filter(m => !m.isGelezen);
    if (msgFilter === 'priority') list = list.filter(m => m.heeftPrioriteit);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(m =>
        (m.afzender?.naam ?? '').toLowerCase().includes(q) ||
        (m.onderwerp ?? '').toLowerCase().includes(q)
      );
    }
    return list;
  });

  // Compose
  let composeSubject = $state('');
  let composeContent = $state('');
  let composeQuery = $state('');
  let composeContacts = $state<any[]>([]);
  let composeRecipients = $state<any[]>([]);
  let composeSending = $state(false);

  onMount(async () => {
    const cachedFolders = localStorage.getItem('messages_folders');
    if (cachedFolders) {
      try {
        folders = JSON.parse(cachedFolders);
        if (folders.length > 0) {
          selectedFolder = folders[0];
          const cachedMessages = localStorage.getItem(`messages_cache_${selectedFolder.id}`);
          if (cachedMessages) {
            messages = JSON.parse(cachedMessages);
            loadingMessages = false;
          }
        }
        loading = false;
      } catch (e) { console.error(e); }
    }

    try {
      folders = await getMessageFolders();
      localStorage.setItem('messages_folders', JSON.stringify(folders));
      if (folders.length > 0) {
        // If selectedFolder was not set by cache or doesn't match new folders, set to first
        if (!selectedFolder || !folders.find(f => f.id === selectedFolder.id)) {
          selectedFolder = folders[0];
        }
        await loadMessages();
      }
    } catch (e) {
      console.error('Error loading folders:', e);
    }
    loading = false;
  });

  async function loadMessages() {
    if (!selectedFolder?.links?.berichten?.href) return;
    if (messages.length === 0) loadingMessages = true;
    try {
      messages = await getMessages(selectedFolder.links.berichten.href, 50, 0);
      localStorage.setItem(`messages_cache_${selectedFolder.id}`, JSON.stringify(messages));
    } catch (e) {
      console.error('Error loading messages:', e);
    }
    loadingMessages = false;
  }

  async function selectFolder(folder: any) {
    selectedFolder = folder;
    selectedMessage = null;
    panel = 'list';
    msgFilter = 'all';
    searchQuery = '';
    await loadMessages();
  }

  async function openMessage(msg: any) {
    loadingDetail = true;
    panel = 'detail';
    try {
      const link = msg.links?.self?.href ?? '';
      if (link) {
        selectedMessage = await getMessageDetail(link);
        if (!msg.isGelezen) {
          await markMessagesAsRead([msg.id], true);
          msg.isGelezen = true;
        }
      } else {
        selectedMessage = msg;
      }
    } catch (e) {
      selectedMessage = msg;
    }
    loadingDetail = false;
  }

  function goBack() {
    panel = 'list';
    selectedMessage = null;
  }

  async function doSearchContacts() {
    if (composeQuery.length < 2) { composeContacts = []; return; }
    try { composeContacts = await searchContacts(composeQuery); } catch (_) {}
  }

  function addRecipient(c: any) {
    if (!composeRecipients.find(r => r.id === c.id)) composeRecipients = [...composeRecipients, c];
    composeQuery = '';
    composeContacts = [];
  }

  async function doSend() {
    if (composeRecipients.length === 0 || !composeSubject.trim()) return;
    composeSending = true;
    try {
      await sendMessage({
        recipients: composeRecipients.map(r => r.id),
        copyRecipients: [],
        blindCopyRecipients: [],
        subject: composeSubject,
        htmlContent: composeContent,
        hasPriority: false,
        isConcept: false,
        attachmentIds: [],
      });
      showCompose = false;
      composeSubject = '';
      composeContent = '';
      composeRecipients = [];
      await loadMessages();
    } catch (e) {
      console.error('Send failed:', e);
    }
    composeSending = false;
  }

  function replyToMessage() {
    if (!selectedMessage) return;
    composeRecipients = [selectedMessage.afzender];
    composeSubject = `Re: ${selectedMessage.onderwerp ?? ''}`;
    composeContent = `\n\n--- Oorspronkelijk bericht ---\nVan: ${selectedMessage.afzender?.naam}\nVerzonden: ${new Date(selectedMessage.verzondenOp).toLocaleString()}\n\n${selectedMessage.inhoud?.replace(/<[^>]*>/g, '')}`;
    showCompose = true;
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  }

  function toggleSearch() {
    searchOpen = !searchOpen;
    if (!searchOpen) searchQuery = '';
  }
</script>

<div class="flex flex-col h-full bg-surface-950">

  <!-- ====== LIST PANEL ====== -->
  <div class="flex flex-col h-full {panel === 'detail' ? 'hidden md:flex' : 'flex'} md:flex-row">

    <!-- Folder sidebar (desktop) -->
    <div class="hidden md:flex flex-col w-52 bg-surface-900/50 border-r border-surface-700/20 shrink-0">
      <div class="p-3 border-b border-surface-700/20">
        <button
          onclick={() => showCompose = true}
          class="w-full py-2.5 px-3 rounded-2xl bg-primary-500 text-white text-sm font-black uppercase tracking-widest hover:bg-primary-400 active:scale-[0.98] shadow-lg shadow-primary-500/30 transition-all flex items-center justify-center gap-2"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          Nieuw
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-2 space-y-0.5">
        {#if loading}
          <p class="text-gray-600 text-xs text-center py-4">Laden...</p>
        {:else}
          {#each folders as folder}
            <button
              onclick={() => selectFolder(folder)}
              class="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs transition-all
                     {selectedFolder?.id === folder.id
                       ? 'bg-primary-500/15 text-primary-300 font-bold'
                       : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}"
            >
              <span class="truncate">{folder.naam}</span>
              {#if folder.aantalOngelezen > 0}
                <span class="bg-primary-500 text-white text-[10px] font-black rounded-full px-1.5 py-0.5 ml-1 shadow-lg shadow-primary-500/30">
                  {folder.aantalOngelezen}
                </span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Messages column -->
    <div class="flex flex-col flex-1 min-w-0 md:max-w-sm md:border-r md:border-surface-700/20 relative">

      <!-- Mobile header -->
      <div class="md:hidden flex items-center justify-between px-4 py-3.5 border-b border-surface-700/20 bg-surface-950 sticky top-0 z-10">
        {#if searchOpen}
          <div class="flex items-center gap-2 flex-1" transition:slide={{ axis: 'x', duration: 200 }}>
            <svg class="w-4 h-4 text-gray-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input
              type="text"
              bind:value={searchQuery}
              placeholder="Zoek berichten..."
              autofocus
              class="flex-1 bg-transparent text-gray-100 text-sm outline-none placeholder:text-gray-600"
            />
            <button onclick={toggleSearch} class="p-1 text-gray-500 hover:text-gray-300">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        {:else}
          <h1 class="text-xl font-bold text-gray-100 italic tracking-tighter">Berichten</h1>
          <div class="flex items-center gap-1">
            <button onclick={toggleSearch} class="p-2 text-gray-500 hover:text-primary-400 transition-colors">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            </button>
            <button onclick={() => showCompose = true} class="p-2 text-gray-500 hover:text-primary-400 transition-colors">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
          </div>
        {/if}
      </div>

      <!-- Folder tabs (mobile) -->
      {#if !loading && folders.length > 0}
        <div class="md:hidden flex gap-1.5 overflow-x-auto no-scrollbar px-4 py-2 border-b border-surface-700/20 bg-surface-900/40 shrink-0">
          {#each folders as folder}
            <button
              onclick={() => selectFolder(folder)}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap shrink-0 font-bold transition-all
                     {selectedFolder?.id === folder.id
                       ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25'
                       : 'bg-surface-800 text-gray-400 hover:text-gray-200'}"
            >
              {folder.naam}
              {#if folder.aantalOngelezen > 0}
                <span class="{selectedFolder?.id === folder.id ? 'bg-white/25' : 'bg-primary-500 text-white'} text-[10px] font-black rounded-full px-1.5">
                  {folder.aantalOngelezen}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Desktop search -->
      <div class="hidden md:flex items-center gap-2 px-3 py-2 border-b border-surface-700/20 bg-surface-900/30">
        <svg class="w-3.5 h-3.5 text-gray-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Zoek..."
          class="flex-1 bg-transparent text-gray-300 text-xs outline-none placeholder:text-gray-600"
        />
        {#if searchQuery}
          <button onclick={() => searchQuery = ''} class="text-gray-600 hover:text-gray-400">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        {/if}
      </div>

      <!-- Filter chips -->
      <div class="flex gap-1.5 px-3 py-2 border-b border-surface-700/20 bg-surface-900/20 shrink-0 overflow-x-auto no-scrollbar">
        {#each [
          { id: 'all', label: 'Alles' },
          { id: 'unread', label: 'Ongelezen' },
          { id: 'priority', label: 'Prioriteit' },
        ] as f}
          <button
            onclick={() => msgFilter = f.id as any}
            class="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide whitespace-nowrap shrink-0 transition-all
                   {msgFilter === f.id
                     ? 'bg-primary-500/20 text-primary-300 border border-primary-500/30'
                     : 'text-gray-500 hover:text-gray-300 border border-surface-700/50'}"
          >
            {#if f.id === 'unread'}
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>
            {:else if f.id === 'priority'}
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            {/if}
            {f.label}
          </button>
        {/each}
        {#if filteredMessages().length !== messages.length}
          <span class="ml-auto text-[10px] text-gray-600 font-bold self-center shrink-0">
            {filteredMessages().length} / {messages.length}
          </span>
        {/if}
      </div>

      <!-- Messages list -->
      <div class="flex-1 overflow-y-auto">
        {#if loadingMessages}
          <div class="flex items-center justify-center py-12">
            <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if filteredMessages().length === 0}
          <div class="flex flex-col items-center justify-center py-20 text-center px-6">
            <svg class="w-10 h-10 text-gray-700 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
            <p class="text-gray-600 text-xs font-bold uppercase tracking-widest">Geen berichten</p>
          </div>
        {:else}
          {#each filteredMessages() as msg}
            <button
              onclick={() => openMessage(msg)}
              class="w-full text-left px-4 py-3.5 border-b border-surface-800/40 transition-all active:bg-surface-800/50 group
                     {selectedMessage?.id === msg.id ? 'bg-primary-500/8 border-l-2 border-l-primary-500' : ''}
                     {!msg.isGelezen ? 'border-l-2 border-l-primary-400' : ''}"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2.5 min-w-0">
                  {#if !msg.isGelezen}
                    <div class="w-2 h-2 rounded-full bg-primary-400 shrink-0 shadow-[0_0_8px_rgba(var(--color-primary-500),0.6)]"></div>
                  {:else}
                    <div class="w-2 h-2 shrink-0"></div>
                  {/if}
                  <p class="text-sm {!msg.isGelezen ? 'font-bold text-gray-100' : 'font-medium text-gray-300'} truncate">
                    {msg.afzender?.naam ?? 'Onbekend'}
                  </p>
                </div>
                <span class="text-[11px] text-gray-600 shrink-0">{formatDate(msg.verzondenOp ?? msg.laatsteWijzigingDatumTijd ?? '')}</span>
              </div>
              <p class="text-xs text-gray-500 truncate mt-0.5 pl-4.5">{msg.onderwerp ?? '(geen onderwerp)'}</p>
              {#if msg.heeftPrioriteit}
                <div class="mt-1.5 pl-4.5 flex">
                  <span class="flex items-center gap-1 text-[10px] text-amber-400 font-bold uppercase tracking-widest bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    Prioriteit
                  </span>
                </div>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Desktop detail pane -->
    <div class="hidden md:flex flex-col flex-1 overflow-y-auto">
      {#if loadingDetail}
        <div class="flex items-center justify-center py-20">
          <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else if selectedMessage}
        <div class="p-6 space-y-5">
          <div class="flex items-start justify-between gap-4">
            <h2 class="text-lg font-bold text-gray-100 leading-snug">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
            {#if selectedMessage.heeftPrioriteit}
              <span class="flex items-center gap-1 text-[10px] text-amber-400 font-black uppercase tracking-widest bg-amber-500/10 border border-amber-500/25 px-2.5 py-1 rounded-xl shrink-0">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Prioriteit
              </span>
            {/if}
          </div>

          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center text-white text-sm font-black shrink-0 shadow-lg shadow-primary-500/25">
              {selectedMessage.afzender?.naam?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div>
              <p class="text-sm font-semibold text-gray-200">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
              {#if selectedMessage.ontvangers?.length}
                <p class="text-xs text-gray-600">Aan: {selectedMessage.ontvangers.map((r: any) => r.weergavenaam).join(', ')}</p>
              {/if}
            </div>
          </div>

          {#if selectedMessage.inhoud}
            <div class="p-5 rounded-2xl bg-surface-800/40 border border-white/5 prose prose-sm prose-invert max-w-none">
              {@html selectedMessage.inhoud}
            </div>
          {/if}

          <div class="pt-4 border-t border-surface-800/50 flex flex-wrap gap-2">
            <button
              onclick={replyToMessage}
              class="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-primary-500 text-white text-xs font-black uppercase tracking-widest shadow-lg shadow-primary-500/25 active:scale-95 transition-all"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 17-5-5 5-5m10 5H5"/></svg>
              Beantwoord
            </button>
          </div>
        </div>
      {:else}
        <div class="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
          <div class="w-20 h-20 rounded-full bg-surface-900 border border-surface-800 flex items-center justify-center">
            <svg class="w-9 h-9 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          </div>
          <p class="text-gray-600 text-sm font-medium">Selecteer een bericht om te lezen</p>
        </div>
      {/if}
    </div>
  </div>

  <!-- ====== MOBILE DETAIL PANEL ====== -->
  {#if panel === 'detail'}
    <div class="flex flex-col h-full md:hidden">
      <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-700/20 bg-surface-900/80 sticky top-0 z-10 shrink-0">
        <button onclick={goBack} class="flex items-center gap-1 text-primary-400 text-sm font-semibold">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          Terug
        </button>
      </div>
      <div class="flex-1 overflow-y-auto">
        {#if loadingDetail}
          <div class="flex items-center justify-center py-20">
            <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if selectedMessage}
          <div class="p-4 space-y-4 pb-6">
            <h2 class="text-base font-bold text-gray-100 leading-snug">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center text-white text-xs font-black shrink-0">
                {selectedMessage.afzender?.naam?.[0]?.toUpperCase() ?? '?'}
              </div>
              <div>
                <p class="text-sm font-semibold text-gray-200">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
                {#if selectedMessage.ontvangers?.length}
                  <p class="text-xs text-gray-600">Aan: {selectedMessage.ontvangers.map((r: any) => r.weergavenaam).join(', ')}</p>
                {/if}
              </div>
            </div>
            {#if selectedMessage.inhoud}
              <div class="p-4 rounded-2xl bg-surface-800/50 border border-white/5 prose prose-sm prose-invert max-w-none overflow-x-hidden">
                {@html selectedMessage.inhoud}
              </div>
            {:else}
              <p class="text-sm text-gray-600 italic">Geen berichtinhoud</p>
            {/if}
            <button
              onclick={replyToMessage}
              class="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-primary-500 text-white text-sm font-black uppercase tracking-widest shadow-xl shadow-primary-500/25 active:scale-95 transition-all"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 17-5-5 5-5m10 5H5"/></svg>
              Beantwoorden
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- ====== COMPOSE MODAL ====== -->
{#if showCompose}
  <div class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4">
    <!-- Backdrop -->
    <button class="absolute inset-0 w-full h-full cursor-default" onclick={() => showCompose = false} aria-label="Sluiten"></button>

    <div class="bg-surface-900 border border-surface-700/40 rounded-t-3xl md:rounded-2xl w-full md:max-w-lg shadow-2xl relative flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-surface-800 shrink-0">
        <h3 class="text-base font-bold text-gray-100 flex items-center gap-2">
          <svg class="w-4 h-4 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          Nieuw bericht
        </h3>
        <button onclick={() => showCompose = false} class="w-8 h-8 rounded-full bg-surface-800 hover:bg-surface-700 flex items-center justify-center text-gray-400 hover:text-white transition-all">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- Scrollable body -->
      <div class="flex-1 overflow-y-auto p-5 space-y-4">
        <!-- To field -->
        <div>
          <label for="composeQuery" class="text-[10px] text-gray-500 font-black uppercase tracking-widest block mb-1.5">Aan</label>
          <div class="flex flex-wrap gap-1.5 mb-2">
            {#each composeRecipients as r}
              <span class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-primary-500/20 border border-primary-500/30 text-primary-300 text-xs font-bold">
                {r.naam ?? (r.roepnaam ? `${r.roepnaam} ${r.achternaam}` : `${r.voorletters} ${r.achternaam}`)}
                <button onclick={() => composeRecipients = composeRecipients.filter(x => x.id !== r.id)} class="hover:text-white transition-colors">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </span>
            {/each}
          </div>
          <input
            id="composeQuery" type="text" bind:value={composeQuery} oninput={doSearchContacts}
            placeholder="Zoek contact..."
            class="w-full px-3 py-2.5 rounded-xl bg-surface-800 border border-surface-700 text-gray-100 text-sm focus:outline-none focus:border-primary-500"
          />
          {#if composeContacts.length > 0}
            <div class="mt-1 max-h-36 overflow-y-auto rounded-xl bg-surface-800 border border-surface-700 shadow-xl">
              {#each composeContacts.slice(0, 10) as c}
                <button
                  onclick={() => addRecipient(c)}
                  class="w-full text-left px-3 py-2.5 text-sm text-gray-300 hover:bg-surface-700 border-b border-surface-700/50 last:border-0 transition-colors"
                >
                  {c.roepnaam ?? c.voorletters} {c.achternaam}
                  {#if c.code}<span class="text-gray-500 ml-1">({c.code})</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Subject -->
        <div>
          <label for="composeSubject" class="text-[10px] text-gray-500 font-black uppercase tracking-widest block mb-1.5">Onderwerp</label>
          <input
            id="composeSubject" type="text" bind:value={composeSubject}
            class="w-full px-3 py-2.5 rounded-xl bg-surface-800 border border-surface-700 text-gray-100 text-sm focus:outline-none focus:border-primary-500"
          />
        </div>

        <!-- Body -->
        <div>
          <label for="composeContent" class="text-[10px] text-gray-500 font-black uppercase tracking-widest block mb-1.5">Bericht</label>
          <textarea
            id="composeContent" bind:value={composeContent} rows="6"
            class="w-full px-3 py-2.5 rounded-xl bg-surface-800 border border-surface-700 text-gray-100 text-sm resize-none focus:outline-none focus:border-primary-500"
          ></textarea>
        </div>
      </div>

      <!-- Sticky action footer — always visible above keyboard -->
      <div class="shrink-0 border-t border-surface-800 px-5 py-4 bg-surface-900 flex gap-3">
        <button
          onclick={() => showCompose = false}
          class="flex-1 py-3 rounded-xl bg-surface-800 text-gray-300 text-sm font-bold hover:bg-surface-700 transition-all"
        >
          Annuleren
        </button>
        <button
          onclick={doSend}
          disabled={composeSending || composeRecipients.length === 0 || !composeSubject.trim()}
          class="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-primary-500 text-white font-black text-sm disabled:opacity-40 hover:bg-primary-400 shadow-lg shadow-primary-500/30 transition-all active:scale-95"
        >
          {#if composeSending}
            <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            Verzenden...
          {:else}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            Verzenden
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
