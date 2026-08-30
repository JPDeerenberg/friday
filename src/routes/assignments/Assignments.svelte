<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { get } from 'svelte/store';
  import {
    getAssignments,
    getAssignmentDetail,
    formatDate,
    handInAssignment,
    uploadAssignmentAttachment,
    formatTeacherName,
    downloadFile
  } from '$lib/api';
  import { formatDateFull } from '$lib/format';
  import { cacheGet, cacheRefresh } from '$lib/cache';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { open } from '@tauri-apps/plugin-dialog';
  import RichTextEditor from '$lib/components/RichTextEditor.svelte';
  import Button from '$lib/components/Button.svelte';
  import Chip from '$lib/components/Chip.svelte';
  import IconButton from '$lib/components/IconButton.svelte';
  import type { Assignment, AssignmentAttachment, AssignmentLink, AssignmentVersion, Docent } from '$lib/types';

  let assignments = $state<Assignment[]>([]);
  let selectedAssignment = $state<Assignment | null>(null);
  let loadingList = $state(true);
  let loadingDetail = $state(false);
  let filter = $state<'all' | 'open' | 'submitted' | 'graded' | 'overdue'>('all');

  let submissionText = $state("");
  let attachments = $state<{id: number, storageId: string, name: string, path: string}[]>([]);
  let isSubmitting = $state(false);
  let uploadLoading = $state(false);
  let downloadingFile = $state<string | null>(null);
  let isMobile = $state(false);

  onMount(async () => {
    const mq = window.matchMedia('(max-width: 767px)');
    isMobile = mq.matches;
    mq.addEventListener('change', (e) => isMobile = e.matches);
    await loadAssignments();
  });

  async function loadAssignments(force = false) {
    const pid = get(personId);
    if (!pid) return;
    if (assignments.length === 0) loadingList = true;
    try {
      const fetcher = async () => {
        const start = '2013-01-01';
        const end = formatDate(new Date(Date.now() + 365 * 86400000));
        const raw = await getAssignments(pid, start, end);
        return raw.sort((a, b) => b.InleverenVoor.localeCompare(a.InleverenVoor));
      };
      assignments = force
        ? await cacheRefresh(`assignments_${pid}`, fetcher, 5 * 60 * 1000)
        : await cacheGet(`assignments_${pid}`, fetcher, 5 * 60 * 1000);
    } catch (e) {
      console.error('Error loading assignments:', e);
    } finally {
      loadingList = false;
    }
  }

  function getStatus(a: Assignment) {
    if (a.Afgesloten) return { label: 'Afgesloten', key: 'closed' };
    if (a.BeoordeeldOp) return { label: 'Beoordeeld', key: 'graded' };
    if (a.IngeleverdOp) return { label: 'Ingeleverd', key: 'submitted' };
    if (isOverdue(a)) return { label: 'Te laat', key: 'overdue' };
    if (a.MagInleveren) return { label: 'In te leveren', key: 'open' };
    return { label: 'Openstaand', key: 'open' };
  }

  function getStatusStyle(key: string) {
    if (key === 'open') return 'bg-amber-500/15 text-amber-400 border-amber-500/25';
    if (key === 'submitted') return 'bg-blue-500/15 text-blue-400 border-blue-500/25';
    if (key === 'graded') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25';
    if (key === 'overdue') return 'bg-red-500/15 text-red-400 border-red-500/25';
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
          if (filter === 'overdue') return s === 'overdue';
          return true;
        })
  );

  async function selectAssignment(assignment: Assignment) {
    if (selectedAssignment?.Id === assignment.Id) return;
    loadingDetail = true;
    submissionText = "";
    attachments = [];
    try {
      const selfLink = assignment.Links?.find((l: AssignmentLink) => l.Rel === 'Self')?.Href;
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

  async function handleDownload(bijlage: AssignmentAttachment) {
    if (downloadingFile) return;
    try {
      const url = bijlage.Links?.find((l: AssignmentLink) => l.Rel === 'Self')?.Href ?? bijlage.Url;
      if (!url) return;
      downloadingFile = bijlage.Naam;
      const downloadDir = get(userSettings).downloadDir || '';
      const path = await downloadFile(url, bijlage.Naam, downloadDir);
      alert(`Bestand gedownload naar: ${path}`);
    } catch (e) {
      console.error('Download mislukt:', e);
    } finally {
      downloadingFile = null;
    }
  }

  async function handleSubmit() {
    if (!selectedAssignment || isSubmitting) return;
    const lastVersion = selectedAssignment.VersieNavigatieItems?.[0];
    const selfUrl = lastVersion?.Links?.find((l: AssignmentLink) => l.Rel === 'Self')?.Href;
    if (!selfUrl || !lastVersion) { alert("Geen inlever-link gevonden voor deze opdracht."); return; }
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
      await loadAssignments(true);
      await selectAssignment(assignments.find(a => a.Id === selectedAssignment!.Id)!);
      submissionText = "";
      attachments = [];
    } catch (e) {
      console.error(e);
      alert("Inleveren mislukt: " + e);
    } finally {
      isSubmitting = false;
    }
  }

  function isOverdue(a: Assignment) {
    if (a.IsTeLaat === true) return true;
    if (a.IsTeLaat !== undefined && a.IsTeLaat !== null) return false;
    return !a.IngeleverdOp && !a.Afgesloten && new Date(a.InleverenVoor) < new Date();
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <!-- Header row: title + refresh only -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur">
    <div class="flex items-center justify-between px-4 py-3 gap-3">
      <div class="flex items-center gap-3 min-w-0">
        {#if selectedAssignment && isMobile}
          <IconButton
            onclick={() => selectedAssignment = null}
            aria-label="Terug naar opdrachtenlijst"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </IconButton>
        {/if}
        <h1 class="text-title-large text-gray-100 truncate">Opdrachten</h1>
      </div>
      <IconButton
        onclick={() => loadAssignments(true)}
        aria-label="Vernieuwen"
        title="Vernieuwen"
        class="hover:rotate-180 duration-700"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
      </IconButton>
    </div>

    <!-- Filter sub-row -->
    <div class="flex items-center gap-1.5 px-4 pb-3 overflow-x-auto no-scrollbar">
      {#each [
        { id: 'all', label: 'Alle', count: assignments.length },
        { id: 'open', label: 'Open', count: assignments.filter(a => getStatus(a).key === 'open').length },
        { id: 'overdue', label: 'Te laat', count: assignments.filter(a => getStatus(a).key === 'overdue').length },
        { id: 'submitted', label: 'Ingeleverd', count: assignments.filter(a => getStatus(a).key === 'submitted').length },
        { id: 'graded', label: 'Beoordeeld', count: assignments.filter(a => getStatus(a).key === 'graded').length },
      ] as f}
        <Chip
          variant="filter"
          selected={filter === f.id}
          onclick={() => filter = f.id as any}
        >
          {f.label}
          {#if f.count > 0}
            <span class="text-label-small px-1.5 py-0.5 rounded-full bg-surface-700">{f.count}</span>
          {/if}
        </Chip>
      {/each}
    </div>
  </header>

  <div class="flex flex-1 min-h-0">
    <!-- List Pane -->
    <aside class="{selectedAssignment ? 'hidden md:flex' : 'flex'} w-full md:w-80 border-r border-surface-800/50 flex-col bg-surface-900/30">
      {#if loadingList}
        <div class="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
          {#each Array(5) as _}
            <div class="p-4 rounded-m3-md bg-surface-800/40 border border-white/5">
              <div class="flex justify-between items-start mb-3 gap-3">
                <div class="h-4 skeleton-shimmer rounded-full w-2/3"></div>
                <div class="h-5 skeleton-shimmer rounded-m3-sm w-16"></div>
              </div>
              <div class="flex items-center justify-between">
                <div class="h-3 skeleton-shimmer rounded-full w-1/4"></div>
                <div class="h-3 skeleton-shimmer rounded-full w-12"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if filteredAssignments.length === 0}
        <div class="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <svg class="w-10 h-10 text-gray-700 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p class="text-gray-600 text-body-medium">Geen opdrachten</p>
        </div>
      {:else}
        <div class="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
          {#each filteredAssignments as assignment, i}
            {@const status = getStatus(assignment)}
            <button
              onclick={() => selectAssignment(assignment)}
              style="--i: {i}"
              class="stagger-item w-full text-left p-4 rounded-m3-md transition-all border {selectedAssignment?.Id === assignment.Id ? 'bg-primary-500/10 border-primary-500/30 shadow-xl shadow-primary-500/5' : 'bg-surface-800/40 border-white/5 hover:bg-surface-800/60 hover:border-white/10'}"
            >
              <div class="flex justify-between items-start mb-2 gap-3">
                <p class="text-title-small text-gray-100 truncate flex-1 leading-tight">{assignment.Titel}</p>
                <span class="px-2 py-0.5 rounded-m3-sm text-label-small border shrink-0 {getStatusStyle(status.key)}">
                  {status.label}
                </span>
              </div>
              <div class="flex items-center justify-between text-label-small text-gray-500">
                <span class="truncate opacity-70">{assignment.Vak ?? 'Algemeen'}</span>
                <span class="{isOverdue(assignment) ? 'text-red-400' : ''}">
                  {new Date(assignment.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                </span>
              </div>
              {#if isOverdue(assignment)}
                <div class="mt-1.5 flex items-center gap-1 text-red-400">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <span class="text-label-small">Te laat</span>
                </div>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <!-- Content Pane -->
    <section class="{!selectedAssignment ? 'hidden md:block' : 'block'} flex-1 overflow-y-auto bg-surface-950 p-4 md:p-8 custom-scrollbar relative">
      {#if loadingDetail}
        <div class="absolute inset-0 z-20 overflow-hidden custom-scrollbar">
          <div class="p-4 md:p-8 max-w-4xl mx-auto space-y-8">
            <!-- Title skeleton -->
            <div class="space-y-4">
              <div class="flex items-center gap-2">
                <div class="h-5 skeleton-shimmer rounded-m3-sm w-20"></div>
                <div class="h-5 skeleton-shimmer rounded-m3-sm w-24"></div>
              </div>
              <div class="h-8 skeleton-shimmer rounded-full w-3/4"></div>
              <div class="h-4 skeleton-shimmer rounded-full w-1/3"></div>
              <!-- Info cards skeleton -->
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {#each Array(4) as _}
                  <div class="glass p-3 rounded-m3-sm">
                    <div class="h-3 skeleton-shimmer rounded-full w-1/2 mb-2"></div>
                    <div class="h-4 skeleton-shimmer rounded-full w-3/4"></div>
                  </div>
                {/each}
              </div>
            </div>
            <!-- Description skeleton -->
            <div class="glass rounded-m3-md p-6">
              <div class="h-4 skeleton-shimmer rounded-full w-1/4 mb-4"></div>
              <div class="space-y-3">
                <div class="h-3 skeleton-shimmer rounded-full w-full"></div>
                <div class="h-3 skeleton-shimmer rounded-full w-5/6"></div>
                <div class="h-3 skeleton-shimmer rounded-full w-4/6"></div>
              </div>
            </div>
          </div>
        </div>
      {/if}

      {#if selectedAssignment}
        <div in:fly={{ y: 20, duration: 350 }} class="max-w-4xl mx-auto space-y-8 pb-20">
          <!-- Title block -->
          <div class="space-y-4">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-2 flex-wrap">
                  <span class="px-2.5 py-1 rounded-m3-sm text-label-small border {getStatusStyle(getStatus(selectedAssignment).key)}">
                    {getStatus(selectedAssignment).label}
                  </span>
                  {#if isOverdue(selectedAssignment)}
                    <span class="flex items-center gap-1 px-2.5 py-1 rounded-m3-sm text-label-small bg-red-500/15 text-red-400 border border-red-500/25 animate-pulse">
                      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      Te laat
                    </span>
                  {/if}
                </div>
                <h2 class="text-headline-medium text-white leading-tight">{selectedAssignment.Titel}</h2>
                <p class="text-gray-400 mt-1 text-body-medium">{selectedAssignment.Vak ?? 'Geen vak opgegeven'}</p>
              </div>

              {#if selectedAssignment.Beoordeling}
                <div class="glass p-4 rounded-m3-md flex flex-col items-center justify-center min-w-[90px] border-emerald-500/30">
                  <span class="text-label-small text-emerald-400 mb-1">Cijfer</span>
                  <span class="text-headline-large text-emerald-400">{selectedAssignment.Beoordeling}</span>
                </div>
              {/if}
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="glass p-3 rounded-m3-sm">
                <div class="flex items-center gap-1.5 mb-1">
                  <svg class="w-3 h-3 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                  <p class="text-label-small text-gray-500">Deadline</p>
                </div>
                <p class="text-body-small text-gray-200">{formatDateFull(selectedAssignment.InleverenVoor)}</p>
              </div>
              {#if selectedAssignment.IngeleverdOp}
                <div class="glass p-3 rounded-m3-sm border-blue-500/20">
                  <p class="text-label-small text-blue-400/80 mb-1">Ingeleverd op</p>
                  <p class="text-body-small text-gray-200">{formatDateFull(selectedAssignment.IngeleverdOp)}</p>
                </div>
              {/if}
              {#if selectedAssignment.BeoordeeldOp}
                <div class="glass p-3 rounded-m3-sm border-emerald-500/20">
                  <p class="text-label-small text-emerald-400/80 mb-1">Beoordeeld op</p>
                  <p class="text-body-small text-gray-200">{formatDateFull(selectedAssignment.BeoordeeldOp)}</p>
                </div>
              {/if}
              <div class="glass p-3 rounded-m3-sm">
                <div class="flex items-center gap-1.5 mb-1">
                  <svg class="w-3 h-3 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  <p class="text-label-small text-gray-500">Docent</p>
                </div>
                <p class="text-body-small text-gray-200 truncate">{selectedAssignment.Docenten?.map((d: Docent) => formatTeacherName(d.Naam)).join(', ') || 'N.v.t.'}</p>
              </div>
            </div>
          </div>

          <!-- Description -->
          {#if selectedAssignment.Omschrijving}
            <div class="glass rounded-m3-md p-6 bg-surface-900/40">
              <h3 class="text-title-small text-gray-100 mb-4 flex items-center gap-2">
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
              <h3 class="text-title-small text-gray-300 flex items-center gap-2">
                <svg class="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                Bijlagen van docent
              </h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {#each selectedAssignment.Bijlagen as file}
                  <button
                    onclick={() => handleDownload(file)}
                    disabled={downloadingFile != null}
                    class="glass p-3 rounded-m3-md flex items-center justify-between hover:bg-surface-800/40 transition-colors group cursor-pointer w-full text-left disabled:opacity-50"
                  >
                    <div class="flex items-center gap-3 overflow-hidden">
                      <div class="w-8 h-8 rounded-m3-sm bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                        {#if downloadingFile === file.Naam}
                          <div class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                        {:else}
                          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                        {/if}
                      </div>
                      <span class="text-body-medium text-gray-300 truncate">{file.Naam}</span>
                    </div>
                    <svg class="w-4 h-4 text-gray-600 group-hover:text-primary-400 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Submission -->
          {#if selectedAssignment.MagInleveren || selectedAssignment.OpnieuwInleveren}
            <div class="space-y-4 pt-4 border-t border-surface-800/50">
              <div class="flex items-center justify-between">
                <h3 class="text-title-large text-white">Inleveren</h3>
                {#if isSubmitting}
                  <div class="flex items-center gap-2 text-label-medium text-primary-400 animate-pulse">
                    <div class="w-2 h-2 rounded-full bg-primary-500 animate-pulse"></div>
                    Bezig...
                  </div>
                {/if}
              </div>

              <div class="space-y-3">
                <RichTextEditor
                  content={submissionText}
                  placeholder="Typ hier je opmerking voor de docent (met opmaak)..."
                  onUpdate={(html) => submissionText = html}
                />

                {#if attachments.length > 0 || uploadLoading}
                  <div class="px-5 py-3 bg-surface-900/50 border-t border-surface-800/50 space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-label-medium text-gray-500">Bijlagen ({attachments.length})</span>
                      {#if uploadLoading}
                        <div class="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
                      {/if}
                    </div>
                    <div class="flex flex-wrap gap-2">
                      {#each attachments as att, i}
                        <div transition:slide={{ axis: 'x' }} class="pl-3 pr-2 py-1.5 rounded-m3-sm bg-surface-800 border border-surface-700 flex items-center gap-2">
                          <svg class="w-3 h-3 text-gray-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                          <span class="text-label-medium text-gray-300">{att.name}</span>
                          <IconButton
                            onclick={() => removeAttachment(i)}
                            class="w-6! h-6! bg-red-500/10! text-red-500! hover:bg-red-500! hover:text-white!"
                            aria-label="Verwijder bijlage"
                          >
                            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </IconButton>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                <div class="flex items-center justify-between">
                  <Button
                    variant="text"
                    onclick={handlePickFile}
                    disabled={uploadLoading || isSubmitting}
                    class="px-4"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    Bijlage toevoegen
                  </Button>

                  <Button
                    variant="filled"
                    onclick={handleSubmit}
                    disabled={isSubmitting || uploadLoading || (!submissionText.trim() && attachments.length === 0)}
                    class="px-6"
                  >
                    {#if isSubmitting}
                      <div class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                    {:else}
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
                    {/if}
                    Inleveren
                  </Button>
                </div>
              </div>
            </div>
          {/if}

          <!-- History -->
          {#if (selectedAssignment.VersieNavigatieItems?.length ?? 0) > 1}
            {@const versies = selectedAssignment.VersieNavigatieItems ?? []}
            <div class="space-y-3">
              <h3 class="text-title-small text-gray-500 flex items-center gap-2">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                Geschiedenis
              </h3>
              <div class="space-y-2">
                {#each versies.slice(1) as version}
                  <div class="glass p-4 rounded-m3-md flex items-center justify-between opacity-60 hover:opacity-100 transition-opacity">
                    <div class="flex items-center gap-4">
                      <div class="w-9 h-9 rounded-full bg-surface-800 flex items-center justify-center text-xs font-black text-gray-500 border border-surface-700">
                        V{version.VersieNummer}
                      </div>
                      <div>
                        <p class="text-title-small text-gray-200">{version.Omschrijving || 'Ingeleverde versie'}</p>
                        <p class="text-label-small text-gray-500">Ingeleverd</p>
                      </div>
                    </div>
                    <Button variant="text" class="px-4">Bekijken</Button>
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
          <h3 class="text-headline-small text-white mb-2">Selecteer een opdracht</h3>
          <p class="text-gray-600 max-w-xs text-body-medium leading-relaxed">Kies een opdracht uit de lijst</p>
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
