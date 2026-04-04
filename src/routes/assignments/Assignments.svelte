<script lang="ts">
  import { personId } from '$lib/stores';
  import { get } from 'svelte/store';
  import { 
    getAssignments, 
    getAssignmentDetail, 
    formatDate, 
    handInAssignment, 
    uploadAssignmentAttachment,
    formatTeacherName
  } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { open } from '@tauri-apps/plugin-dialog';

  let assignments = $state<any[]>([]);
  let selectedAssignment = $state<any>(null);
  let loadingList = $state(true);
  let loadingDetail = $state(false);
  let filter = $state<'all' | 'open' | 'submitted' | 'graded'>('all');

  let submissionText = $state("");
  let attachments = $state<{id: number, storageId: string, name: string, path: string}[]>([]);
  let isSubmitting = $state(false);
  let uploadLoading = $state(false);
  let isMobile = $state(false);

  onMount(async () => {
    const mq = window.matchMedia('(max-width: 767px)');
    isMobile = mq.matches;
    mq.addEventListener('change', (e) => isMobile = e.matches);
    await loadAssignments();
  });

  async function loadAssignments() {
    const pid = get(personId);
    if (!pid) return;
    loadingList = true;
    try {
      const start = '2013-01-01';
      const end = formatDate(new Date(Date.now() + 365 * 86400000));
      const raw = await getAssignments(pid, start, end);
      assignments = raw.sort((a, b) => b.InleverenVoor.localeCompare(a.InleverenVoor));
    } catch (e) {
      console.error('Error loading assignments:', e);
    } finally {
      loadingList = false;
    }
  }

  function getStatus(a: any) {
    if (a.Afgesloten) return { label: 'Afgesloten', key: 'closed' };
    if (a.BeoordeeldOp) return { label: 'Beoordeeld', key: 'graded' };
    if (a.IngeleverdOp) return { label: 'Ingeleverd', key: 'submitted' };
    if (a.MagInleveren) return { label: 'In te leveren', key: 'open' };
    return { label: 'Openstaand', key: 'open' };
  }

  function getStatusStyle(key: string) {
    if (key === 'open') return 'bg-amber-500/15 text-amber-400 border-amber-500/25';
    if (key === 'submitted') return 'bg-blue-500/15 text-blue-400 border-blue-500/25';
    if (key === 'graded') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25';
    return 'bg-surface-700/60 text-gray-500 border-surface-600/30';
  }

  const filteredAssignments = $derived(
    filter === 'all'
      ? assignments
      : assignments.filter(a => {
          const s = getStatus(a).key;
          if (filter === 'open') return s === 'open';
          if (filter === 'submitted') return s === 'submitted';
          if (filter === 'graded') return s === 'graded';
          return true;
        })
  );

  async function selectAssignment(assignment: any) {
    if (selectedAssignment?.Id === assignment.Id) return;
    loadingDetail = true;
    submissionText = "";
    attachments = [];
    try {
      const selfLink = assignment.Links?.find((l: any) => l.Rel === 'Self')?.Href;
      if (selfLink) {
        selectedAssignment = await getAssignmentDetail(selfLink);
      } else {
        selectedAssignment = assignment;
      }
    } catch (e) {
      console.error(e);
      selectedAssignment = assignment;
    } finally {
      loadingDetail = false;
    }
  }

  async function handlePickFile() {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: 'Documenten', extensions: ['pdf', 'doc', 'docx', 'jpg', 'png', 'txt', 'zip'] }]
      });
      if (Array.isArray(selected)) {
        uploadLoading = true;
        for (const path of selected) {
          const fileName = path.split(/[/\\]/).pop() || 'Onbekend';
          try {
            const [id, storageId] = await uploadAssignmentAttachment(path);
            attachments = [...attachments, { id, storageId, name: fileName, path }];
          } catch (e) {
            console.error(`Upload failed for ${fileName}:`, e);
          }
        }
        uploadLoading = false;
      }
    } catch (e) { console.error(e); }
  }

  function removeAttachment(idx: number) {
    attachments = attachments.filter((_, i) => i !== idx);
  }

  async function handleSubmit() {
    if (!selectedAssignment || isSubmitting) return;
    const lastVersion = selectedAssignment.VersieNavigatieItems?.[0];
    const selfUrl = lastVersion?.Links?.find((l: any) => l.Rel === 'Self')?.Href;
    if (!selfUrl) { alert("Geen inlever-link gevonden voor deze opdracht."); return; }
    isSubmitting = true;
    try {
      const submissionBody = {
        Id: lastVersion.Id, Vak: lastVersion.Vak, Status: 1,
        OpdrachtId: lastVersion.OpdrachtId, LeerlingOpmerking: submissionText,
        DocentOpmerking: null, InleverenVoor: lastVersion.InleverenVoor,
        IngeleverdOp: new Date().toISOString(), GestartOp: null, Beoordeling: null,
        BeoordeeldOp: null, VersieNummer: lastVersion.VersieNummer, IsTeLaat: false,
        Omschrijving: lastVersion.Omschrijving,
        LeerlingBijlagen: attachments.map(a => ({
          Id: 0, Naam: a.name, ContentType: "", Datum: null, Grootte: 0, Url: "",
          UniqueId: a.storageId, BronSoort: 1, Links: null
        }))
      };
      await handInAssignment(selfUrl, selectedAssignment.Id, JSON.stringify(submissionBody));
      await loadAssignments();
      await selectAssignment(assignments.find(a => a.Id === selectedAssignment.Id));
      submissionText = "";
      attachments = [];
    } catch (e) {
      console.error(e);
      alert("Inleveren mislukt: " + e);
    } finally {
      isSubmitting = false;
    }
  }

  function formatDateFull(iso: string) {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('nl-NL', {
      weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
  }

  function isOverdue(a: any) {
    return !a.IngeleverdOp && !a.Afgesloten && new Date(a.InleverenVoor) < new Date();
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <!-- Header row: title + refresh only -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur">
    <div class="flex items-center justify-between px-4 py-3 gap-3">
      <div class="flex items-center gap-3 min-w-0">
        {#if selectedAssignment && isMobile}
          <button
            onclick={() => selectedAssignment = null}
            class="flex items-center gap-1 text-primary-400 font-semibold text-sm shrink-0"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        {/if}
        <h1 class="text-lg font-bold text-gray-100 italic tracking-tighter truncate">Opdrachten</h1>
      </div>
      <button
        onclick={loadAssignments}
        aria-label="Vernieuwen"
        class="p-2 text-gray-500 hover:text-primary-400 transition-all hover:scale-110 active:scale-90 shrink-0"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
      </button>
    </div>

    <!-- Filter sub-row -->
    <div class="flex items-center gap-1.5 px-4 pb-3 overflow-x-auto no-scrollbar">
      {#each [
        { id: 'all', label: 'Alle', count: assignments.length },
        { id: 'open', label: 'Open', count: assignments.filter(a => getStatus(a).key === 'open').length },
        { id: 'submitted', label: 'Ingeleverd', count: assignments.filter(a => getStatus(a).key === 'submitted').length },
        { id: 'graded', label: 'Beoordeeld', count: assignments.filter(a => getStatus(a).key === 'graded').length },
      ] as f}
        <button
          onclick={() => filter = f.id as any}
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-tight transition-all whitespace-nowrap shrink-0
                 {filter === f.id
                   ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/30'
                   : 'bg-surface-800/70 text-gray-400 hover:text-gray-200 border border-white/5'}"
        >
          {f.label}
          {#if f.count > 0}
            <span class="text-[9px] font-black {filter === f.id ? 'bg-white/20' : 'bg-surface-700'} px-1.5 py-0.5 rounded-full">
              {f.count}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </header>

  <div class="flex flex-1 min-h-0">
    <!-- List Pane -->
    <aside class="{selectedAssignment ? 'hidden md:flex' : 'flex'} w-full md:w-80 border-r border-surface-800/50 flex-col bg-surface-900/30">
      {#if loadingList}
        <div class="flex-1 flex items-center justify-center">
          <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else if filteredAssignments.length === 0}
        <div class="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <svg class="w-10 h-10 text-gray-700 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p class="text-gray-600 text-xs font-bold uppercase tracking-widest">Geen opdrachten</p>
        </div>
      {:else}
        <div class="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
          {#each filteredAssignments as assignment}
            {@const status = getStatus(assignment)}
            <button
              onclick={() => selectAssignment(assignment)}
              class="w-full text-left p-4 rounded-2xl transition-all border
                     {selectedAssignment?.Id === assignment.Id
                       ? 'bg-primary-500/10 border-primary-500/30 shadow-xl shadow-primary-500/5'
                       : 'bg-surface-800/40 border-white/5 hover:bg-surface-800/60 hover:border-white/10'}"
            >
              <div class="flex justify-between items-start mb-2 gap-3">
                <p class="text-sm font-bold text-gray-100 truncate flex-1 leading-tight">{assignment.Titel}</p>
                <span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide border shrink-0 {getStatusStyle(status.key)}">
                  {status.label}
                </span>
              </div>
              <div class="flex items-center justify-between text-[10px] text-gray-500 uppercase tracking-tighter font-bold">
                <span class="truncate opacity-70">{assignment.Vak ?? 'Algemeen'}</span>
                <span class="{isOverdue(assignment) ? 'text-red-400 font-black' : ''}">
                  {new Date(assignment.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                </span>
              </div>
              {#if isOverdue(assignment)}
                <div class="mt-1.5 flex items-center gap-1 text-red-400">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <span class="text-[9px] font-black uppercase tracking-widest">Te laat</span>
                </div>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <!-- Content Pane -->
    <section class="flex-1 overflow-y-auto bg-surface-950 p-4 md:p-8 custom-scrollbar relative">
      {#if loadingDetail}
        <div class="absolute inset-0 flex items-center justify-center bg-surface-950/60 backdrop-blur-sm z-20">
          <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {/if}

      {#if selectedAssignment}
        <div in:fly={{ y: 20, duration: 350 }} class="max-w-4xl mx-auto space-y-8 pb-20">
          <!-- Title block -->
          <div class="space-y-4">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-2 flex-wrap">
                  <span class="px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border {getStatusStyle(getStatus(selectedAssignment).key)}">
                    {getStatus(selectedAssignment).label}
                  </span>
                  {#if isOverdue(selectedAssignment)}
                    <span class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest bg-red-500/15 text-red-400 border border-red-500/25 animate-pulse">
                      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      Te laat
                    </span>
                  {/if}
                </div>
                <h2 class="text-2xl font-black text-white leading-tight tracking-tight">{selectedAssignment.Titel}</h2>
                <p class="text-gray-400 mt-1 font-medium italic text-sm">{selectedAssignment.Vak ?? 'Geen vak opgegeven'}</p>
              </div>

              {#if selectedAssignment.Beoordeling}
                <div class="glass p-4 rounded-2xl flex flex-col items-center justify-center min-w-[90px] border-emerald-500/30">
                  <span class="text-[10px] text-emerald-400 font-bold uppercase tracking-widest mb-1">Cijfer</span>
                  <span class="text-3xl font-black text-emerald-400">{selectedAssignment.Beoordeling}</span>
                </div>
              {/if}
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="glass p-3 rounded-xl">
                <div class="flex items-center gap-1.5 mb-1">
                  <svg class="w-3 h-3 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                  <p class="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">Deadline</p>
                </div>
                <p class="text-xs text-gray-200">{formatDateFull(selectedAssignment.InleverenVoor)}</p>
              </div>
              {#if selectedAssignment.IngeleverdOp}
                <div class="glass p-3 rounded-xl border-blue-500/20">
                  <p class="text-[10px] text-blue-400/80 font-bold uppercase tracking-tighter mb-1">Ingeleverd op</p>
                  <p class="text-xs text-gray-200">{formatDateFull(selectedAssignment.IngeleverdOp)}</p>
                </div>
              {/if}
              {#if selectedAssignment.BeoordeeldOp}
                <div class="glass p-3 rounded-xl border-emerald-500/20">
                  <p class="text-[10px] text-emerald-400/80 font-bold uppercase tracking-tighter mb-1">Beoordeeld op</p>
                  <p class="text-xs text-gray-200">{formatDateFull(selectedAssignment.BeoordeeldOp)}</p>
                </div>
              {/if}
              <div class="glass p-3 rounded-xl">
                <div class="flex items-center gap-1.5 mb-1">
                  <svg class="w-3 h-3 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  <p class="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">Docent</p>
                </div>
                <p class="text-xs text-gray-200 truncate">{selectedAssignment.Docenten?.map((d: any) => formatTeacherName(d.Naam)).join(', ') || 'N.v.t.'}</p>
              </div>
            </div>
          </div>

          <!-- Description -->
          {#if selectedAssignment.Omschrijving}
            <div class="glass rounded-3xl p-6 bg-surface-900/40">
              <h3 class="text-sm font-bold text-gray-100 mb-4 flex items-center gap-2">
                <span class="w-1.5 h-4 bg-primary-500 rounded-full"></span>
                Omschrijving
              </h3>
              <div class="prose prose-invert prose-sm max-w-none text-gray-300 leading-relaxed">
                {@html selectedAssignment.Omschrijving}
              </div>
            </div>
          {/if}

          <!-- Teacher attachments -->
          {#if selectedAssignment.Bijlagen?.length}
            <div class="space-y-3">
              <h3 class="text-sm font-bold text-gray-300 flex items-center gap-2">
                <svg class="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                Bijlagen van docent
              </h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {#each selectedAssignment.Bijlagen as file}
                  <div class="glass p-3 rounded-xl flex items-center justify-between hover:bg-surface-800/40 transition-colors group cursor-pointer">
                    <div class="flex items-center gap-3 overflow-hidden">
                      <div class="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                      </div>
                      <span class="text-sm text-gray-300 truncate font-medium">{file.Naam}</span>
                    </div>
                    <svg class="w-4 h-4 text-gray-600 group-hover:text-primary-400 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Submission -->
          {#if selectedAssignment.MagInleveren || selectedAssignment.OpnieuwInleveren}
            <div class="space-y-4 pt-4 border-t border-surface-800/50">
              <div class="flex items-center justify-between">
                <h3 class="text-lg font-black text-white tracking-tight">Inleveren</h3>
                {#if isSubmitting}
                  <div class="flex items-center gap-2 text-xs text-primary-400 font-bold uppercase animate-pulse">
                    <div class="w-2 h-2 rounded-full bg-primary-500 animate-pulse"></div>
                    Bezig...
                  </div>
                {/if}
              </div>

              <div class="glass rounded-3xl overflow-hidden border-primary-500/20 focus-within:border-primary-500/40 transition-colors">
                <textarea
                  bind:value={submissionText}
                  placeholder="Typ hier je opmerking voor de docent..."
                  class="w-full bg-transparent p-5 text-sm text-gray-200 outline-none resize-none min-h-[120px] font-medium placeholder:text-gray-600"
                ></textarea>

                {#if attachments.length > 0 || uploadLoading}
                  <div class="px-5 py-3 bg-surface-900/50 border-t border-surface-800/50 space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Bijlagen ({attachments.length})</span>
                      {#if uploadLoading}
                        <div class="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
                      {/if}
                    </div>
                    <div class="flex flex-wrap gap-2">
                      {#each attachments as att, i}
                        <div transition:slide={{ axis: 'x' }} class="pl-3 pr-2 py-1.5 rounded-xl bg-surface-800 border border-surface-700 flex items-center gap-2">
                          <svg class="w-3 h-3 text-gray-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                          <span class="text-xs text-gray-300 font-medium">{att.name}</span>
                          <button
                            onclick={() => removeAttachment(i)}
                            class="w-5 h-5 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center hover:bg-red-500 hover:text-white transition-all"
                          >
                            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                <div class="p-4 bg-surface-900/50 border-t border-surface-800/50 flex items-center justify-between">
                  <button
                    onclick={handlePickFile}
                    disabled={uploadLoading || isSubmitting}
                    class="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-gray-400 hover:text-gray-200 hover:bg-surface-700 transition-all disabled:opacity-50"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    Bijlage toevoegen
                  </button>

                  <button
                    onclick={handleSubmit}
                    disabled={isSubmitting || uploadLoading || (!submissionText.trim() && attachments.length === 0)}
                    class="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-primary-500 text-white text-xs font-black tracking-widest uppercase
                           hover:bg-primary-400 shadow-lg shadow-primary-500/30
                           active:scale-95 transition-all disabled:opacity-40 disabled:shadow-none"
                  >
                    {#if isSubmitting}
                      <div class="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    {:else}
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
                    {/if}
                    Inleveren
                  </button>
                </div>
              </div>
            </div>
          {/if}

          <!-- History -->
          {#if selectedAssignment.VersieNavigatieItems?.length > 1}
            <div class="space-y-3">
              <h3 class="text-sm font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                Geschiedenis
              </h3>
              <div class="space-y-2">
                {#each selectedAssignment.VersieNavigatieItems.slice(1) as version}
                  <div class="glass p-4 rounded-2xl flex items-center justify-between opacity-60 hover:opacity-100 transition-opacity">
                    <div class="flex items-center gap-4">
                      <div class="w-9 h-9 rounded-full bg-surface-800 flex items-center justify-center text-xs font-black text-gray-500 border border-surface-700">
                        V{version.VersieNummer}
                      </div>
                      <div>
                        <p class="text-sm font-bold text-gray-200">{version.Omschrijving || 'Ingeleverde versie'}</p>
                        <p class="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">Ingeleverd</p>
                      </div>
                    </div>
                    <button class="text-xs font-bold text-primary-400 hover:text-primary-300 transition-colors">Bekijken</button>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>

      {:else}
        <div class="h-full flex flex-col items-center justify-center text-center p-8 opacity-50">
          <div class="w-20 h-20 rounded-full bg-surface-900 flex items-center justify-center mb-6 border border-surface-800 shadow-xl">
            <svg class="w-10 h-10 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
          </div>
          <h3 class="text-lg font-black text-white italic mb-2 tracking-tight">Selecteer een opdracht</h3>
          <p class="text-gray-600 max-w-xs text-xs font-bold uppercase tracking-widest leading-relaxed">Kies een opdracht uit de lijst</p>
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .glass {
    background: rgba(30, 41, 59, 0.5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.06);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
  }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  .custom-scrollbar::-webkit-scrollbar { width: 4px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 10px; }
  :global(.prose h1, .prose h2, .prose h3) { color: white !important; font-weight: 800 !important; }
  :global(.prose a) { color: #60a5fa !important; text-decoration: underline; }
  :global(.prose strong) { color: #cbd5e1 !important; font-weight: 700; }
</style>
