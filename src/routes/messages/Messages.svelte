<script lang="ts">
  import { getMessageFolders, getMessages, getMessageDetail, markMessagesAsRead, searchContacts, sendMessage } from '$lib/api';
  import { cacheGet, cacheRefresh } from '$lib/cache';
  import { onMount } from 'svelte';
  import { slide, fade } from 'svelte/transition';
  import Button from '$lib/components/Button.svelte';
  import Chip from '$lib/components/Chip.svelte';
  import IconButton from '$lib/components/IconButton.svelte';
  import type { Contact, Message, MessagesFolder } from '$lib/types';

  type Recipient = {
    id: number;
    naam?: string;
    roepnaam?: string | null;
    voorletters?: string | null;
    achternaam?: string;
  };

  let folders = $state<MessagesFolder[]>([]);
  let selectedFolder = $state<MessagesFolder | null>(null);
  let messages = $state<Message[]>([]);
  let selectedMessage = $state<Message | null>(null);
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
  let composeContacts = $state<Contact[]>([]);
  let composeRecipients = $state<Recipient[]>([]);
  let composeSending = $state(false);

  onMount(async () => {
    try {
      folders = await cacheGet('messages_folders', () => getMessageFolders(), 5 * 60 * 1000);
      const current = selectedFolder;
      if (folders.length > 0) {
        if (!current || !folders.find(f => f.id === current.id)) {
          selectedFolder = folders[0];
        }
        await loadMessages();
      }
    } catch (e) {
      console.error('Error loading folders:', e);
    }
    loading = false;
  });

  async function loadMessages(force = false) {
    const href = selectedFolder?.links?.berichten?.href;
    if (!href) return;
    if (messages.length === 0) loadingMessages = true;
    try {
      const fetcher = () => getMessages(href, 50, 0);
      messages = force
        ? await cacheRefresh(`messages_${selectedFolder?.id ?? ''}`, fetcher, 5 * 60 * 1000)
        : await cacheGet(`messages_${selectedFolder?.id ?? ''}`, fetcher, 5 * 60 * 1000);
    } catch (e) {
      console.error('Error loading messages:', e);
    }
    loadingMessages = false;
  }

  async function selectFolder(folder: MessagesFolder) {
    selectedFolder = folder;
    selectedMessage = null;
    panel = 'list';
    msgFilter = 'all';
    searchQuery = '';
    await loadMessages();
  }

  async function openMessage(msg: Message) {
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

  function addRecipient(c: Contact) {
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
      await loadMessages(true);
    } catch (e) {
      console.error('Send failed:', e);
    }
    composeSending = false;
  }

  function replyToMessage() {
    if (!selectedMessage) return;
    if (selectedMessage.afzender) composeRecipients = [selectedMessage.afzender];
    composeSubject = `Re: ${selectedMessage.onderwerp ?? ''}`;
    composeContent = `\n\n--- Oorspronkelijk bericht ---\nVan: ${selectedMessage.afzender?.naam}\nVerzonden: ${new Date(selectedMessage.verzondenOp ?? '').toLocaleString()}\n\n${selectedMessage.inhoud?.replace(/<[^>]*>/g, '')}`;
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
        <Button
          onclick={() => showCompose = true}
          class="w-full"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          Nieuw
        </Button>
      </div>
      <div class="flex-1 overflow-y-auto p-2 space-y-0.5">
        {#if loading}
          <p class="text-gray-600 text-label-medium text-center py-4">Laden...</p>
        {:else}
          {#each folders as folder}
            <button
              onclick={() => selectFolder(folder)}
              class="w-full flex items-center justify-between px-3 py-2.5 rounded-m3-md text-label-medium transition-all {selectedFolder?.id === folder.id ? 'bg-primary-500/15 text-primary-300' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}"
            >
              <span class="truncate">{folder.naam}</span>
              {#if folder.aantalOngelezen > 0}
                <span class="bg-primary-500 text-white text-label-small rounded-full px-1.5 py-0.5 ml-1 shadow-lg shadow-primary-500/30">
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
            <!-- svelte-ignore a11y_autofocus -->
            <input
              type="text"
              bind:value={searchQuery}
              placeholder="Zoek berichten..."
              autofocus
              class="flex-1 bg-transparent text-gray-100 text-body-large outline-none placeholder:text-gray-600"
            />
            <IconButton onclick={toggleSearch} aria-label="Zoeken sluiten">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </IconButton>
          </div>
        {:else}
          <h1 class="text-title-large text-gray-100">Berichten</h1>
          <div class="flex items-center gap-1">
            <IconButton onclick={toggleSearch} aria-label="Zoeken">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            </IconButton>
            <IconButton onclick={() => showCompose = true} aria-label="Nieuw bericht">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </IconButton>
          </div>
        {/if}
      </div>

      <!-- Folder tabs (mobile) -->
      {#if !loading && folders.length > 0}
        <div class="md:hidden flex gap-1.5 overflow-x-auto no-scrollbar px-4 py-2 border-b border-surface-700/20 bg-surface-900/40 shrink-0">
          {#each folders as folder}
            <button
              onclick={() => selectFolder(folder)}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-m3-sm text-label-medium whitespace-nowrap shrink-0 transition-all {selectedFolder?.id === folder.id ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25' : 'bg-surface-800 text-gray-400 hover:text-gray-200'}"
            >
              {folder.naam}
              {#if folder.aantalOngelezen > 0}
                <span class="{selectedFolder?.id === folder.id ? 'bg-white/25' : 'bg-primary-500 text-white'} text-label-small rounded-full px-1.5">
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
          class="flex-1 bg-transparent text-gray-300 text-body-medium outline-none placeholder:text-gray-600"
        />
        {#if searchQuery}
            <IconButton onclick={() => searchQuery = ''} class="w-8! h-8! text-gray-600 hover:text-gray-400" aria-label="Zoekopdracht wissen">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </IconButton>
        {/if}
      </div>

      <!-- Filter chips -->
      <div class="flex gap-1.5 px-3 py-2 border-b border-surface-700/20 bg-surface-900/20 shrink-0 overflow-x-auto no-scrollbar">
        {#each [
          { id: 'all', label: 'Alles' },
          { id: 'unread', label: 'Ongelezen' },
          { id: 'priority', label: 'Prioriteit' },
        ] as f}
          <Chip
            variant="filter"
            selected={msgFilter === f.id}
            onclick={() => msgFilter = f.id as any}
          >
            {#if f.id === 'unread'}
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>
            {:else if f.id === 'priority'}
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            {/if}
            {f.label}
          </Chip>
        {/each}
        {#if filteredMessages().length !== messages.length}
          <span class="ml-auto text-label-small text-gray-600 self-center shrink-0">
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
            <p class="text-gray-600 text-body-medium">Geen berichten</p>
          </div>
        {:else}
          {#each filteredMessages() as msg}
            <button
              onclick={() => openMessage(msg)}
              class="w-full text-left px-4 py-3.5 border-b border-surface-800/40 transition-all active:bg-surface-800/50 group {selectedMessage?.id === msg.id ? 'bg-primary-500/8 border-l-2 border-l-primary-500' : ''} {!msg.isGelezen ? 'border-l-2 border-l-primary-400' : ''}"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2.5 min-w-0">
                  {#if !msg.isGelezen}
                    <div class="w-2 h-2 rounded-full bg-primary-400 shrink-0 shadow-[0_0_8px_rgba(var(--color-primary-500),0.6)]"></div>
                  {:else}
                    <div class="w-2 h-2 shrink-0"></div>
                  {/if}
                  <p class="text-title-small {!msg.isGelezen ? 'text-gray-100' : 'text-gray-300'} truncate">
                    {msg.afzender?.naam ?? 'Onbekend'}
                  </p>
                </div>
                <span class="text-label-small text-gray-600 shrink-0">{formatDate(msg.verzondenOp ?? '')}</span>
              </div>
              <p class="text-body-small text-gray-500 truncate mt-0.5 pl-4.5">{msg.onderwerp ?? '(geen onderwerp)'}</p>
              {#if msg.heeftPrioriteit}
                <div class="mt-1.5 pl-4.5 flex">
                  <span class="flex items-center gap-1 text-label-small text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-m3-sm border border-amber-500/20">
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
            <h2 class="text-title-large text-gray-100 leading-snug">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
            {#if selectedMessage.heeftPrioriteit}
              <span class="flex items-center gap-1 text-label-small text-amber-400 bg-amber-500/10 border border-amber-500/25 px-2.5 py-1 rounded-m3-sm shrink-0">
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
              <p class="text-title-small text-gray-200">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
              {#if selectedMessage.ontvangers?.length}
                <p class="text-body-small text-gray-600">Aan: {selectedMessage.ontvangers.map((r: any) => r.weergavenaam).join(', ')}</p>
              {/if}
            </div>
          </div>

          {#if selectedMessage.inhoud}
            <div class="p-5 rounded-m3-md bg-surface-800/40 border border-white/5 prose prose-sm prose-invert max-w-none">
              {@html selectedMessage.inhoud}
            </div>
          {/if}

          <div class="pt-4 border-t border-surface-800/50 flex flex-wrap gap-2">
            <Button
              variant="filled"
              onclick={replyToMessage}
              class="px-5"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 17-5-5 5-5m10 5H5"/></svg>
              Beantwoord
            </Button>
          </div>
        </div>
      {:else}
        <div class="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
          <div class="w-20 h-20 rounded-full bg-surface-900 border border-surface-800 flex items-center justify-center">
            <svg class="w-9 h-9 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          </div>
          <p class="text-gray-600 text-body-medium">Selecteer een bericht om te lezen</p>
        </div>
      {/if}
    </div>
  </div>

  <!-- ====== MOBILE DETAIL PANEL ====== -->
  {#if panel === 'detail'}
    <div class="flex flex-col h-full md:hidden">
      <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-700/20 bg-surface-900/80 sticky top-0 z-10 shrink-0">
        <Button variant="text" onclick={goBack} class="px-3">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          Terug
        </Button>
      </div>
      <div class="flex-1 overflow-y-auto">
        {#if loadingDetail}
          <div class="flex items-center justify-center py-20">
            <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if selectedMessage}
          <div class="p-4 space-y-4 pb-6">
            <h2 class="text-title-large text-gray-100 leading-snug">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center text-white text-xs font-black shrink-0">
                {selectedMessage.afzender?.naam?.[0]?.toUpperCase() ?? '?'}
              </div>
              <div>
                <p class="text-title-small text-gray-200">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
                {#if selectedMessage.ontvangers?.length}
                  <p class="text-body-small text-gray-600">Aan: {selectedMessage.ontvangers.map((r: any) => r.weergavenaam).join(', ')}</p>
                {/if}
              </div>
            </div>
            {#if selectedMessage.inhoud}
              <div class="p-4 rounded-m3-md bg-surface-800/50 border border-white/5 prose prose-sm prose-invert max-w-none overflow-x-hidden">
                {@html selectedMessage.inhoud}
              </div>
            {:else}
              <p class="text-body-medium text-gray-600">Geen berichtinhoud</p>
            {/if}

            <Button
              variant="filled"
              onclick={replyToMessage}
              class="w-full"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 17-5-5 5-5m10 5H5"/></svg>
              Beantwoorden
            </Button>
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

    <div class="elevation-3 border border-surface-700/40 rounded-t-m3-xl md:rounded-m3-xl w-full md:max-w-lg shadow-2xl relative flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-surface-800 shrink-0">
        <h3 class="text-title-large text-gray-100 flex items-center gap-2">
          <svg class="w-4 h-4 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          Nieuw bericht
        </h3>
        <IconButton onclick={() => showCompose = false} class="bg-surface-800! hover:bg-surface-700! text-gray-400 hover:text-white!" aria-label="Sluiten">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </IconButton>
      </div>

      <!-- Scrollable body -->
      <div class="flex-1 overflow-y-auto p-5 space-y-4">
        <!-- To field -->
        <div>
          <label for="composeQuery" class="text-label-medium text-gray-500 block mb-1.5">Aan</label>
          <div class="flex flex-wrap gap-1.5 mb-2">
            {#each composeRecipients as r}
              <span class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-m3-sm bg-primary-500/20 border border-primary-500/30 text-primary-300 text-label-medium">
                {r.naam ?? (r.roepnaam ? `${r.roepnaam} ${r.achternaam}` : `${r.voorletters} ${r.achternaam}`)}
                <IconButton size="sm" onclick={() => composeRecipients = composeRecipients.filter(x => x.id !== r.id)} class="w-6! h-6! hover:text-white!" aria-label="Verwijder ontvanger">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </IconButton>
              </span>
            {/each}
          </div>
          <input
            id="composeQuery" type="text" bind:value={composeQuery} oninput={doSearchContacts}
            placeholder="Zoek contact..."
            class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-gray-100 text-body-large focus:outline-none focus:border-primary-500"
          />
          {#if composeContacts.length > 0}
            <div class="mt-1 max-h-36 overflow-y-auto rounded-m3-xs bg-surface-800 border border-surface-700 shadow-xl">
              {#each composeContacts.slice(0, 10) as c}
                <button
                  onclick={() => addRecipient(c)}
                  class="w-full text-left px-3 py-2.5 text-body-medium text-gray-300 hover:bg-surface-700 border-b border-surface-700/50 last:border-0 transition-colors"
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
          <label for="composeSubject" class="text-label-medium text-gray-500 block mb-1.5">Onderwerp</label>
          <input
            id="composeSubject" type="text" bind:value={composeSubject}
            class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-gray-100 text-body-large focus:outline-none focus:border-primary-500"
          />
        </div>

        <!-- Body -->
        <div>
          <label for="composeContent" class="text-label-medium text-gray-500 block mb-1.5">Bericht</label>
          <textarea
            id="composeContent" bind:value={composeContent} rows="6"
            class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-gray-100 text-body-large resize-none focus:outline-none focus:border-primary-500"
          ></textarea>
        </div>
      </div>

      <!-- Sticky action footer — always visible above keyboard -->
      <div class="shrink-0 border-t border-surface-800 px-5 py-4 bg-surface-900 flex gap-3">
        <Button
          variant="tonal"
          onclick={() => showCompose = false}
          class="flex-1"
        >
          Annuleren
        </Button>
        <Button
          variant="filled"
          onclick={doSend}
          disabled={composeSending || composeRecipients.length === 0 || !composeSubject.trim()}
          class="flex-1"
        >
          {#if composeSending}
            <div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
            Verzenden...
          {:else}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            Verzenden
          {/if}
        </Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
