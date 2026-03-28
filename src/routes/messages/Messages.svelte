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

  // Panel state: 'list' or 'detail' (only matters on narrow screens)
  let panel = $state<'list' | 'detail'>('list');

  // Compose
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
    panel = 'list';
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
</script>

<div class="flex flex-col h-full bg-surface-950">

  <!-- ====== LIST PANEL (always visible on desktop, hides on mobile when detail open) ====== -->
  <div class="flex flex-col h-full {panel === 'detail' ? 'hidden md:flex' : 'flex'} md:flex-row">

    <!-- ---- Folder sidebar (desktop only, hidden on mobile) ---- -->
    <div class="hidden md:flex flex-col w-48 bg-surface-900/50 border-r border-surface-700/30 shrink-0 relative">
      <div class="p-3 border-b border-surface-700/30">
        <button onclick={() => showCompose = true}
          class="w-full py-2.5 px-3 rounded-2xl bg-primary-500 text-on-primary text-sm font-black uppercase tracking-widest hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-primary-500/20 transition-all flex items-center justify-center gap-2">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          Nieuw
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-2 space-y-1">
        {#if loading}
          <p class="text-gray-600 text-xs text-center py-4">Laden...</p>
        {:else}
          {#each folders as folder}
            <button onclick={() => selectFolder(folder)}
              class="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors
                     {selectedFolder?.id === folder.id ? 'bg-primary-500/15 text-primary-400' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-300'}">
              <span class="truncate">{folder.naam}</span>
              {#if folder.aantalOngelezen > 0}
                <span class="bg-primary-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 ml-1">{folder.aantalOngelezen}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- ---- Messages column ---- -->
    <div class="flex flex-col flex-1 min-w-0 md:max-w-sm md:border-r md:border-surface-700/30 relative">
      <!-- Mobile header -->
      <div class="md:hidden flex items-center justify-between px-4 py-4 border-b border-surface-700/30 bg-surface-950 sticky top-0 z-10">
        <h1 class="text-2xl font-bold text-gray-100 italic tracking-tighter">Berichten</h1>
      </div>

      <!-- Folder tabs (mobile) -->
      {#if !loading && folders.length > 0}
        <div class="md:hidden flex gap-1.5 overflow-x-auto no-scrollbar px-4 py-2 border-b border-surface-700/30 bg-surface-900/50 shrink-0">
          {#each folders as folder}
            <button onclick={() => selectFolder(folder)}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap shrink-0 font-medium transition-all
                     {selectedFolder?.id === folder.id ? 'bg-primary-500 text-on-primary shadow-lg shadow-primary-500/20' : 'bg-surface-800 text-gray-400'}">
              {folder.naam}
              {#if folder.aantalOngelezen > 0}
                <span class="{selectedFolder?.id === folder.id ? 'bg-white/30' : 'bg-primary-500 text-white'} text-[10px] font-bold rounded-full px-1.5">
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
          <div class="flex items-center justify-center py-12">
            <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if messages.length === 0}
          <p class="text-gray-600 text-sm text-center py-12">Geen berichten</p>
        {:else}
          {#each messages as msg}
            <button onclick={() => openMessage(msg)}
              class="w-full text-left px-4 py-3.5 border-b border-surface-800/60 transition-colors active:bg-surface-800/50
                     {selectedMessage?.id === msg.id ? 'bg-primary-500/10' : ''}
                     {!msg.isGelezen ? 'border-l-4 border-l-primary-500 shadow-[inset_4px_0_10px_-4px_rgba(var(--color-primary-500),0.2)]' : ''}">
              <div class="flex items-start justify-between gap-2">
                <p class="text-sm {!msg.isGelezen ? 'font-semibold text-gray-100' : 'font-medium text-gray-300'} truncate flex-1">{msg.afzender?.naam ?? 'Onbekend'}</p>
                <span class="text-[11px] text-gray-600 shrink-0">{formatDate(msg.verzondenOp ?? msg.laatsteWijzigingDatumTijd ?? '')}</span>
              </div>
              <p class="text-xs text-gray-500 truncate mt-0.5">{msg.onderwerp ?? '(geen onderwerp)'}</p>
              {#if msg.heeftPrioriteit}
                <span class="text-[10px] text-accent-500 font-bold uppercase tracking-widest bg-accent-500/10 px-1.5 py-0.5 rounded-md border border-accent-500/20">⚡ Prioriteit</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      <!-- Floating Action Button for Mobile -->
      {#if panel === 'list'}
        <button onclick={() => showCompose = true}
          aria-label="Nieuw bericht"
          class="md:hidden absolute bottom-6 right-6 w-14 h-14 bg-primary-500 text-white rounded-2xl flex items-center justify-center shadow-xl shadow-primary-500/30 active:scale-90 transition-all z-20">
          <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      {/if}
    </div>

    <!-- ---- Desktop detail pane ---- -->
    <div class="hidden md:flex flex-col flex-1 overflow-y-auto">
      {#if loadingDetail}
        <div class="flex items-center justify-center py-20">
          <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else if selectedMessage}
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold text-gray-100">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full bg-primary-500 flex items-center justify-center text-on-primary text-sm font-bold shrink-0">
              {selectedMessage.afzender?.naam?.[0] ?? '?'}
            </div>
            <div>
              <p class="text-sm font-medium text-gray-300">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
              {#if selectedMessage.ontvangers?.length}
                <p class="text-xs text-gray-600">Aan: {selectedMessage.ontvangers.map((r:any) => r.weergavenaam).join(', ')}</p>
              {/if}
            </div>
          </div>
          {#if selectedMessage.inhoud}
            <div class="p-4 rounded-xl bg-surface-800/50 prose prose-sm prose-invert max-w-none">{@html selectedMessage.inhoud}</div>
          {/if}
          
          <div class="pt-6 border-t border-surface-800/50 mt-4 overflow-x-auto pb-4">
            <div class="flex items-center gap-3">
              <button onclick={replyToMessage}
                class="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-primary-500 text-on-primary text-xs font-black uppercase tracking-widest shadow-lg shadow-primary-500/20 active:scale-95 transition-all whitespace-nowrap">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 17-5-5 5-5m10 5H5"/></svg>
                Beantwoord
              </button>
              <button class="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-surface-800 text-gray-300 text-xs font-black uppercase tracking-widest border border-white/5 active:scale-95 transition-all whitespace-nowrap">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Verplaats
              </button>
              <button class="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-surface-800 text-gray-300 text-xs font-black uppercase tracking-widest border border-white/5 active:scale-95 transition-all whitespace-nowrap">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3"/></svg>
                Archief
              </button>
              <button class="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-red-500/10 text-red-500 text-xs font-black uppercase tracking-widest border border-red-500/20 active:scale-95 transition-all whitespace-nowrap">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                Wis
              </button>
            </div>
          </div>
        </div>
      {:else}
        <div class="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
          <span class="text-4xl">✉️</span>
          <p class="text-gray-500 text-sm">Selecteer een bericht om te lezen</p>
        </div>
      {/if}
    </div>
  </div>

  <!-- ====== MOBILE DETAIL PANEL ====== -->
  {#if panel === 'detail'}
    <div class="flex flex-col h-full md:hidden">
      <!-- Back header -->
      <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-700/30 bg-surface-900/80 sticky top-0 z-10 shrink-0">
        <button onclick={goBack}
          class="flex items-center gap-1 text-primary-400 text-sm font-semibold active:opacity-70">
          ‹ Terug
        </button>
      </div>
      <!-- Detail content -->
      <div class="flex-1 overflow-y-auto">
        {#if loadingDetail}
          <div class="flex items-center justify-center py-20">
            <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if selectedMessage}
          <div class="p-4 space-y-4">
            <h2 class="text-base font-semibold text-gray-100 leading-snug">{selectedMessage.onderwerp ?? '(geen onderwerp)'}</h2>
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full bg-primary-500 flex items-center justify-center text-on-primary text-xs font-bold shrink-0">
                {selectedMessage.afzender?.naam?.[0] ?? '?'}
              </div>
              <div>
                <p class="text-sm font-medium text-gray-300">{selectedMessage.afzender?.naam ?? 'Onbekend'}</p>
                {#if selectedMessage.ontvangers?.length}
                  <p class="text-xs text-gray-600">Aan: {selectedMessage.ontvangers.map((r:any) => r.weergavenaam).join(', ')}</p>
                {/if}
              </div>
            </div>
            {#if selectedMessage.inhoud}
              <div class="p-3 rounded-xl bg-surface-800/50 prose prose-sm prose-invert max-w-none overflow-x-hidden">{@html selectedMessage.inhoud}</div>
            {:else}
              <p class="text-sm text-gray-600 italic">Geen berichtinhoud</p>
            {/if}
            <div class="pt-4 pb-10">
              <button onclick={replyToMessage}
                class="w-full py-3 rounded-2xl bg-primary-500 text-on-primary text-sm font-black uppercase tracking-widest shadow-xl shadow-primary-500/20 active:scale-95 transition-all">
                ↩️ Reageren
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- ====== COMPOSE MODAL ====== -->
{#if showCompose}
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4">
    <div class="bg-surface-900 border border-surface-700/50 rounded-t-3xl md:rounded-2xl w-full md:max-w-lg shadow-2xl overflow-hidden">
      <div class="flex items-center justify-between px-5 py-4 border-b border-surface-800">
        <h3 class="text-base font-semibold text-gray-100">Nieuw bericht</h3>
        <button onclick={() => showCompose = false} class="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
      </div>
      <div class="p-5 space-y-4">
        <div>
          <label for="composeQuery" class="text-xs text-gray-500 uppercase block mb-1">Aan</label>
          <div class="flex flex-wrap gap-1 mb-2">
            {#each composeRecipients as r}
              <span class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-primary-500 border border-primary-400 text-white shadow-lg shadow-primary-500/20 text-xs font-bold font-sans">
                {r.naam ?? (r.roepnaam ? `${r.roepnaam} ${r.achternaam}` : `${r.voorletters} ${r.achternaam}`)}
                <button onclick={() => composeRecipients = composeRecipients.filter(x => x.id !== r.id)} 
                  aria-label="Verwijder ontvanger"
                  class="text-white hover:opacity-80 transition-opacity ml-1">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </span>
            {/each}
          </div>
          <input id="composeQuery" type="text" bind:value={composeQuery} oninput={doSearchContacts}
            placeholder="Zoek contact..."
            class="w-full px-3 py-2.5 rounded-lg bg-surface-800 border border-surface-700 text-gray-100 text-sm focus:outline-none focus:border-primary-500" />
          {#if composeContacts.length > 0}
            <div class="mt-1 max-h-36 overflow-y-auto rounded-lg bg-surface-800 border border-surface-700">
              {#each composeContacts.slice(0, 10) as c}
                <button onclick={() => addRecipient(c)} class="w-full text-left px-3 py-2.5 text-sm text-gray-300 hover:bg-surface-700 border-b border-surface-700/50 last:border-0">
                  {c.roepnaam ?? c.voorletters} {c.achternaam}
                  {#if c.code}<span class="text-gray-500 ml-1">({c.code})</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <div>
          <label for="composeSubject" class="text-xs text-gray-500 uppercase block mb-1">Onderwerp</label>
          <input id="composeSubject" type="text" bind:value={composeSubject}
            class="w-full px-3 py-2.5 rounded-lg bg-surface-800 border border-surface-700 text-gray-100 text-sm focus:outline-none focus:border-primary-500" />
        </div>
        <div>
          <label for="composeContent" class="text-xs text-gray-500 uppercase block mb-1">Bericht</label>
          <textarea id="composeContent" bind:value={composeContent} rows="5"
            class="w-full px-3 py-2.5 rounded-lg bg-surface-800 border border-surface-700 text-gray-100 text-sm resize-none focus:outline-none focus:border-primary-500"
          ></textarea>
        </div>
        <div class="flex gap-3">
          <button onclick={() => showCompose = false}
            class="flex-1 py-2.5 rounded-xl bg-surface-800 text-gray-300 text-sm hover:bg-surface-700">Annuleren</button>
          <button onclick={doSend} disabled={composeSending || composeRecipients.length === 0 || !composeSubject.trim()}
            class="flex-1 py-2.5 rounded-xl bg-primary-500 text-on-primary font-semibold text-sm disabled:opacity-50 hover:bg-primary-400 shadow-lg shadow-primary-500/20 transition-all active:scale-95">
            {composeSending ? 'Verzenden...' : 'Verzenden'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
