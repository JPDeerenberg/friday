<script lang="ts">
  import { getMessageFolders, getMessages, getMessageDetail, markMessagesAsRead, searchContacts, sendMessage } from '$lib/api';
  import { onMount } from 'svelte';

  let folders = $state<any[]>([]);
  let selectedFolder = $state<any>(null);
  let messages = $state<any[]>([]);
  let selectedMessage = $state<any>(null);
  let loading = $state(true);
  let loadingMessages = $state(false);
  let loadingDetail = $state(false);
  let showCompose = $state(false);

  // Mobile: which "panel" is visible (list or detail)
  let mobileView = $state<'list' | 'detail'>('list');

  // Compose state
  let composeSubject = $state('');
  let composeContent = $state('');
  let composeQuery = $state('');
  let composeContacts = $state<any[]>([]);
  let composeRecipients = $state<any[]>([]);
  let composeSending = $state(false);

  onMount(async () => {
    try {
      folders = await getMessageFolders();
      if (folders.length > 0) {
        selectedFolder = folders[0];
        await loadMessages();
      }
    } catch (e) {
      console.error('Error loading folders:', e);
    }
    loading = false;
  });

  async function loadMessages() {
    if (!selectedFolder?.links?.berichten?.href) return;
    loadingMessages = true;
    try {
      messages = await getMessages(selectedFolder.links.berichten.href, 25, 0);
    } catch (e) {
      console.error('Error loading messages:', e);
    }
    loadingMessages = false;
  }

  async function selectFolder(folder: any) {
    selectedFolder = folder;
    selectedMessage = null;
    mobileView = 'list';
    await loadMessages();
  }

  async function selectMessage(msg: any) {
    if (selectedMessage?.id === msg.id) {
      selectedMessage = null;
      mobileView = 'list';
      return;
    }

    loadingDetail = true;
    try {
      const link = msg.links?.self?.href ?? '';
      if (link) {
        const detail = await getMessageDetail(link);
        selectedMessage = detail;
        mobileView = 'detail';
        if (!msg.isGelezen) {
          await markMessagesAsRead([msg.id], true);
          msg.isGelezen = true;
        }
      }
    } catch (e) {
      console.error('Error loading message detail:', e);
      selectedMessage = msg;
      mobileView = 'detail';
    }
    loadingDetail = false;
  }

  async function doSearchContacts() {
    if (composeQuery.length < 2) { composeContacts = []; return; }
    try {
      composeContacts = await searchContacts(composeQuery);
    } catch (_) {}
  }

  function addRecipient(contact: any) {
    if (!composeRecipients.find(r => r.id === contact.id)) {
      composeRecipients = [...composeRecipients, contact];
    }
    composeQuery = '';
    composeContacts = [];
  }

  function removeRecipient(id: number) {
    composeRecipients = composeRecipients.filter(r => r.id !== id);
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

  function formatDate(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  }
</script>

<!-- ======= DESKTOP LAYOUT: 3-column ======= -->
<div class="hidden md:flex h-full">
  <!-- Folder sidebar -->
  <div class="w-48 bg-surface-900/50 border-r border-surface-700/30 p-3 space-y-1 shrink-0">
    <button
      onclick={() => showCompose = true}
      class="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 text-white text-sm font-semibold mb-3 hover:from-primary-400 hover:to-primary-500"
    >
      ✏️ Nieuw bericht
    </button>

    {#if loading}
      <p class="text-gray-600 text-xs text-center py-4">Laden...</p>
    {:else}
      {#each folders as folder}
        <button
          onclick={() => selectFolder(folder)}
          class="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs
                 {selectedFolder?.id === folder.id ? 'bg-primary-500/15 text-primary-400' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-300'}"
        >
          <span class="truncate">{folder.naam}</span>
          {#if folder.aantalOngelezen > 0}
            <span class="bg-primary-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 ml-1">{folder.aantalOngelezen}</span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>

  <!-- Messages list -->
  <div class="w-80 border-r border-surface-700/30 overflow-y-auto shrink-0">
    {#if loadingMessages}
      <div class="flex items-center justify-center py-10">
        <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    {:else if messages.length === 0}
      <p class="text-gray-600 text-sm text-center py-10">Geen berichten</p>
    {:else}
      {#each messages as msg}
        <button
          onclick={() => selectMessage(msg)}
          class="w-full text-left p-4 border-b border-surface-700/30 hover:bg-surface-800/50
                 {selectedMessage?.id === msg.id ? 'bg-primary-500/5' : ''}
                 {!msg.isGelezen ? 'border-l-2 border-l-primary-500' : ''}"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="text-sm font-medium text-gray-200 truncate {!msg.isGelezen ? 'font-semibold' : ''}">{msg.afzender?.naam ?? 'Onbekend'}</p>
            <span class="text-[10px] text-gray-600 shrink-0">{formatDate(msg.verzondenOp ?? msg.laatsteWijzigingDatumTijd ?? '')}</span>
          </div>
          <p class="text-xs text-gray-400 truncate mt-0.5">{msg.onderwerp ?? '(geen onderwerp)'}</p>
          {#if msg.heeftPrioriteit}
            <span class="text-[10px] text-orange-400 font-medium">⚡ Prioriteit</span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>

  <!-- Message detail -->
  <div class="flex-1 overflow-y-auto">
    {#if loadingDetail}
      <div class="flex items-center justify-center py-20">
        <div class="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    {:else if selectedMessage}
      <div class="p-6 space-y-4">
        <h2 class="text-lg font-semibold text-gray-100">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center text-white text-xs font-semibold">
            {selectedMessage.afzender?.naam?.[0] ?? '?'}
          </div>
          <div>
            <p class="text-sm font-medium text-gray-300">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
            {#if selectedMessage.ontvangers?.length}
              <p class="text-xs text-gray-600">Aan: {selectedMessage.ontvangers.map((r: any) => r.weergavenaam).join(', ')}</p>
            {/if}
          </div>
        </div>
        {#if selectedMessage.inhoud}
          <div class="p-4 rounded-xl bg-surface-800/50 prose prose-sm prose-invert max-w-none">{@html selectedMessage.inhoud}</div>
        {/if}
      </div>
    {:else}
      <div class="flex items-center justify-center h-full">
        <p class="text-gray-600 text-sm">Selecteer een bericht om te lezen</p>
      </div>
    {/if}
  </div>
</div>

<!-- ======= MOBILE LAYOUT: single column ======= -->
<div class="flex flex-col md:hidden h-full">
  {#if mobileView === 'list'}
    <!-- Header with folder tabs -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-surface-700/30 bg-surface-900/50 shrink-0">
      <h1 class="text-lg font-bold text-gray-100">Berichten</h1>
      <button
        onclick={() => showCompose = true}
        class="px-3 py-1.5 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 text-white text-xs font-semibold"
      >
        ✏️ Nieuw
      </button>
    </div>

    <!-- Folder tab strip -->
    {#if !loading && folders.length > 0}
      <div class="flex gap-1 overflow-x-auto no-scrollbar px-3 py-2 border-b border-surface-700/30 shrink-0">
        {#each folders as folder}
          <button
            onclick={() => selectFolder(folder)}
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap shrink-0 transition-all
                   {selectedFolder?.id === folder.id ? 'bg-primary-500 text-white font-semibold' : 'bg-surface-800 text-gray-400'}"
          >
            {folder.naam}
            {#if folder.aantalOngelezen > 0}
              <span class="{selectedFolder?.id === folder.id ? 'bg-white/20' : 'bg-primary-500'} text-white text-[10px] font-bold rounded-full px-1.5">
                {folder.aantalOngelezen}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Messages list -->
    <div class="flex-1 overflow-y-auto">
      {#if loadingMessages}
        <div class="flex items-center justify-center py-10">
          <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else if messages.length === 0}
        <p class="text-gray-600 text-sm text-center py-10">Geen berichten</p>
      {:else}
        {#each messages as msg}
          <button
            onclick={() => selectMessage(msg)}
            class="w-full text-left px-4 py-3 border-b border-surface-700/20 active:bg-surface-800/50
                   {!msg.isGelezen ? 'border-l-2 border-l-primary-500' : ''}"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-sm {!msg.isGelezen ? 'font-semibold text-gray-100' : 'font-medium text-gray-300'} truncate">
                  {msg.afzender?.naam ?? 'Onbekend'}
                </p>
                <p class="text-xs text-gray-500 truncate mt-0.5">{msg.onderwerp ?? '(geen onderwerp)'}</p>
              </div>
              <span class="text-[10px] text-gray-600 shrink-0 mt-0.5">{formatDate(msg.verzondenOp ?? msg.laatsteWijzigingDatumTijd ?? '')}</span>
            </div>
          </button>
        {/each}
      {/if}
    </div>

  {:else}
    <!-- Detail view -->
    <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-700/30 bg-surface-900/50 shrink-0">
      <button onclick={() => { mobileView = 'list'; selectedMessage = null; }} class="text-primary-400 flex items-center gap-1 text-sm font-medium">
        ‹ Terug
      </button>
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if loadingDetail}
        <div class="flex items-center justify-center py-20">
          <div class="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else if selectedMessage}
        <div class="p-4 space-y-4">
          <h2 class="text-base font-semibold text-gray-100">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center text-white text-xs font-semibold">
              {selectedMessage.afzender?.naam?.[0] ?? '?'}
            </div>
            <div>
              <p class="text-sm font-medium text-gray-300">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
              {#if selectedMessage.ontvangers?.length}
                <p class="text-xs text-gray-600">Aan: {selectedMessage.ontvangers.map((r: any) => r.weergavenaam).join(', ')}</p>
              {/if}
            </div>
          </div>
          {#if selectedMessage.inhoud}
            <div class="p-3 rounded-xl bg-surface-800/50 prose prose-sm prose-invert max-w-none">{@html selectedMessage.inhoud}</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Compose modal (shared) -->
{#if showCompose}
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
    <div class="glass rounded-t-3xl sm:rounded-2xl w-full sm:max-w-lg p-5 sm:p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold text-gray-100">Nieuw bericht</h3>
        <button onclick={() => showCompose = false} class="text-gray-500 hover:text-gray-300">✕</button>
      </div>

      <!-- Recipients -->
      <div>
        <label for="recipient-search" class="text-xs text-gray-500 uppercase block mb-1">Aan</label>
        <div class="flex flex-wrap gap-1 mb-2">
          {#each composeRecipients as r}
            <span class="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary-500/15 text-primary-400 text-xs">
              {r.roepnaam ?? r.voorletters} {r.achternaam}
              <button onclick={() => removeRecipient(r.id)} class="hover:text-white">✕</button>
            </span>
          {/each}
        </div>
        <input
          id="recipient-search" type="text" bind:value={composeQuery} oninput={doSearchContacts}
          placeholder="Zoek contact..."
          class="w-full px-3 py-2 rounded-lg bg-surface-800 border border-surface-700 text-gray-100 text-sm focus:outline-none focus:border-primary-500"
        />
        {#if composeContacts.length > 0}
          <div class="mt-1 max-h-32 overflow-y-auto rounded-lg bg-surface-800 border border-surface-700">
            {#each composeContacts.slice(0, 10) as contact}
              <button onclick={() => addRecipient(contact)} class="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-surface-700">
                {contact.roepnaam ?? contact.voorletters} {contact.achternaam}
                {#if contact.code}<span class="text-gray-600 ml-1">({contact.code})</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div>
        <label for="compose-subject" class="text-xs text-gray-500 uppercase block mb-1">Onderwerp</label>
        <input id="compose-subject" type="text" bind:value={composeSubject}
          class="w-full px-3 py-2 rounded-lg bg-surface-800 border border-surface-700 text-gray-100 text-sm focus:outline-none focus:border-primary-500" />
      </div>

      <div>
        <label for="compose-content" class="text-xs text-gray-500 uppercase block mb-1">Bericht</label>
        <textarea id="compose-content" bind:value={composeContent} rows="5"
          class="w-full px-3 py-2 rounded-lg bg-surface-800 border border-surface-700 text-gray-100 text-sm resize-none focus:outline-none focus:border-primary-500"
        ></textarea>
      </div>

      <div class="flex justify-end gap-3">
        <button onclick={() => showCompose = false} class="px-4 py-2 rounded-lg bg-surface-800 text-gray-300 text-sm hover:bg-surface-700">Annuleren</button>
        <button onclick={doSend} disabled={composeSending || composeRecipients.length === 0 || !composeSubject.trim()}
          class="px-4 py-2 rounded-lg bg-gradient-to-r from-primary-500 to-primary-600 text-white text-sm font-semibold disabled:opacity-50">
          {composeSending ? 'Verzenden...' : 'Verzenden'}
        </button>
      </div>
    </div>
  </div>
{/if}
