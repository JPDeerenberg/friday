<script lang="ts">
  import { personId } from '$lib/stores';
  import { 
    getAssignments, 
    getAssignmentDetail, 
    formatDate, 
    handInAssignment, 
    uploadAssignmentAttachment 
  } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { open } from '@tauri-apps/plugin-dialog';

  let assignments = $state<any[]>([]);
  let selectedAssignment = $state<any>(null);
  let loadingList = $state(true);
  let loadingDetail = $state(false);
  let filter = $state<'all' | 'open' | 'submitted' | 'graded'>('all');

  // Submission state
  let submissionText = $state("");
  let attachments = $state<{id: number, storageId: string, name: string, path: string}[]>([]);
  let isSubmitting = $state(false);
  let uploadLoading = $state(false);

  onMount(async () => {
    await loadAssignments();
  });

  async function loadAssignments() {
    const pid = $personId;
    if (!pid) return;

    loadingList = true;
    try {
      const start = '2013-01-01'; // Load many for now
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
    if (a.Afgesloten) return { label: 'Afgesloten', color: 'bg-gray-500/10 text-gray-400 border-gray-500/20' };
    if (a.BeoordeeldOp) return { label: 'Beoordeeld', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
    if (a.IngeleverdOp) return { label: 'Ingeleverd', color: 'bg-blue-500/10 text-blue-400 border-blue-500/20' };
    if (a.MagInleveren) return { label: 'In te leveren', color: 'bg-orange-500/10 text-orange-400 border-orange-500/20' };
    return { label: 'Openstaand', color: 'bg-surface-700 text-gray-300 border-surface-600' };
  }

  const filteredAssignments = $derived(
    filter === 'all' 
      ? assignments 
      : assignments.filter(a => {
          const s = getStatus(a).label;
          if (filter === 'open') return s === 'In te leveren' || s === 'Openstaand';
          if (filter === 'submitted') return s === 'Ingeleverd';
          if (filter === 'graded') return s === 'Beoordeeld';
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
        filters: [{
          name: 'Documenten',
          extensions: ['pdf', 'doc', 'docx', 'jpg', 'png', 'txt', 'zip']
        }]
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
    } catch (e) {
      console.error(e);
    }
  }

  function removeAttachment(idx: number) {
    attachments = attachments.filter((_, i) => i !== idx);
  }

  async function handleSubmit() {
    if (!selectedAssignment || isSubmitting) return;
    
    const lastVersion = selectedAssignment.VersieNavigatieItems?.[0];
    const selfUrl = lastVersion?.Links?.find((l: any) => l.Rel === 'Self')?.Href;
    
    if (!selfUrl) {
      alert("Geen inlever-link gevonden voor deze opdracht.");
      return;
    }

    isSubmitting = true;
    try {
      const submissionBody = {
        Id: lastVersion.Id,
        Vak: lastVersion.Vak,
        Status: 1, // Ingeleverd
        OpdrachtId: lastVersion.OpdrachtId,
        LeerlingOpmerking: submissionText,
        DocentOpmerking: null,
        InleverenVoor: lastVersion.InleverenVoor,
        IngeleverdOp: new Date().toISOString(),
        GestartOp: null,
        Beoordeling: null,
        BeoordeeldOp: null,
        VersieNummer: lastVersion.VersieNummer,
        IsTeLaat: false,
        Omschrijving: lastVersion.Omschrijving,
        LeerlingBijlagen: attachments.map(a => ({
          Id: 0,
          Naam: a.name,
          ContentType: "", // Backend handles it but we can provide if needed
          Datum: null,
          Grootte: 0,
          Url: "",
          UniqueId: a.storageId,
          BronSoort: 1,
          Links: null
        }))
      };

      await hand_in_assignment(selfUrl, selectedAssignment.Id, JSON.stringify(submissionBody));
      
      // Refresh
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
      weekday: 'short', day: 'numeric', month: 'long', 
      hour: '2-digit', minute: '2-digit'
    });
  }

  function isOverdue(a: any) {
    return !a.IngeleverdOp && !a.Afgesloten && new Date(a.InleverenVoor) < new Date();
  }
</script>

<div class="h-screen flex flex-col overflow-hidden bg-surface-950">
  <!-- Top Header -->
  <header class="h-16 shrink-0 border-b border-surface-800/50 flex items-center justify-between px-6 bg-surface-900/50 backdrop-blur-xl z-10">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-lg bg-primary-500/20 flex items-center justify-center text-primary-400">
        📝
      </div>
      <h1 class="text-lg font-bold text-gray-100">Opdrachten</h1>
    </div>

    <div class="flex items-center gap-1 bg-surface-800/50 rounded-xl p-1">
      {#each [
        { id: 'all', label: 'Alle' },
        { id: 'open', label: 'Open' },
        { id: 'submitted', label: 'Ingeleverd' },
        { id: 'graded', label: 'Beoordeeld' },
      ] as f}
        <button
          onclick={() => filter = f.id as any}
          class="px-4 py-1.5 rounded-lg text-xs font-medium transition-all
                 {filter === f.id
                   ? 'bg-primary-500/15 text-primary-400 shadow-sm'
                   : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700/50'}"
        >
          {f.label}
        </button>
      {/each}
    </div>
  </header>

  <main class="flex-1 flex min-h-0">
    <!-- List Pane -->
    <aside class="w-80 border-r border-surface-800/50 flex flex-col bg-surface-900/30">
      {#if loadingList}
        <div class="flex-1 flex items-center justify-center">
          <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else}
        <div class="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
          {#each filteredAssignments as assignment}
            {@const status = getStatus(assignment)}
            <button
              onclick={() => selectAssignment(assignment)}
              class="w-full text-left p-3 rounded-xl transition-all border
                     {selectedAssignment?.Id === assignment.Id 
                       ? 'bg-primary-500/10 border-primary-500/30 ring-1 ring-primary-500/20' 
                       : 'bg-surface-800/20 border-transparent hover:bg-surface-800/40 hover:border-surface-700'}"
            >
              <div class="flex justify-between items-start mb-1 gap-2">
                <p class="text-sm font-semibold text-gray-200 truncate flex-1">{assignment.Titel}</p>
                <div class="w-2 h-2 rounded-full mt-1.5 shrink-0
                            {status.label === 'In te leveren' ? 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.4)]' : 
                             status.label === 'Ingeleverd' ? 'bg-blue-500' : 
                             status.label === 'Beoordeeld' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-gray-600'}">
                </div>
              </div>
              <div class="flex items-center justify-between text-[10px] text-gray-500 uppercase tracking-wider font-medium">
                <span>{assignment.Vak ?? 'Algemeen'}</span>
                <span class={isOverdue(assignment) ? 'text-red-400 font-bold' : ''}>
                  {new Date(assignment.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                </span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <!-- Content Pane -->
    <section class="flex-1 overflow-y-auto bg-surface-950 p-8 custom-scrollbar relative">
      {#if loadingDetail}
        <div class="absolute inset-0 flex items-center justify-center bg-surface-950/50 backdrop-blur-sm z-20">
          <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {/if}

      {#if selectedAssignment}
        <div in:fly={{ y: 20, duration: 400 }} class="max-w-4xl mx-auto space-y-8 pb-20">
          <!-- Main Details -->
          <div class="space-y-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="flex items-center gap-3 mb-2">
                  <span class="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest border {getStatus(selectedAssignment).color}">
                    {getStatus(selectedAssignment).label}
                  </span>
                  {#if isOverdue(selectedAssignment)}
                    <span class="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest bg-red-500/10 text-red-400 border border-red-500/20 animate-pulse">
                      Te laat
                    </span>
                  {/if}
                </div>
                <h2 class="text-3xl font-black text-white leading-tight">{selectedAssignment.Titel}</h2>
                <p class="text-gray-400 mt-1 font-medium italic">{selectedAssignment.Vak ?? 'Geen vak opgegeven'}</p>
              </div>
              
              {#if selectedAssignment.Beoordeling}
                <div class="glass p-4 rounded-2xl flex flex-col items-center justify-center min-w-[100px] border-emerald-500/30">
                  <span class="text-[10px] text-emerald-400 font-bold uppercase tracking-widest mb-1">Cijfer</span>
                  <span class="text-3xl font-black text-emerald-400">{selectedAssignment.Beoordeling}</span>
                </div>
              {/if}
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4">
              <div class="glass p-3 rounded-xl">
                <p class="text-[10px] text-gray-500 font-bold uppercase tracking-tighter mb-1">Deadline</p>
                <p class="text-xs text-gray-200">{formatDateFull(selectedAssignment.InleverenVoor)}</p>
              </div>
              {#if selectedAssignment.IngeleverdOp}
                <div class="glass p-3 rounded-xl border-blue-500/20">
                  <p class="text-[10px] text-blue-400/70 font-bold uppercase tracking-tighter mb-1">Ingeleverd op</p>
                  <p class="text-xs text-gray-200">{formatDateFull(selectedAssignment.IngeleverdOp)}</p>
                </div>
              {/if}
              {#if selectedAssignment.BeoordeeldOp}
                <div class="glass p-3 rounded-xl border-emerald-500/20">
                  <p class="text-[10px] text-emerald-400/70 font-bold uppercase tracking-tighter mb-1">Beoordeeld op</p>
                  <p class="text-xs text-gray-200">{formatDateFull(selectedAssignment.BeoordeeldOp)}</p>
                </div>
              {/if}
              <div class="glass p-3 rounded-xl">
                <p class="text-[10px] text-gray-500 font-bold uppercase tracking-tighter mb-1">Docent</p>
                <p class="text-xs text-gray-200 truncate">{selectedAssignment.Docenten?.map((d: any) => d.Naam).join(', ') || 'N.v.t.'}</p>
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
              <div class="prose prose-invert prose-sm max-w-none text-gray-300 leading-relaxed font-normal">
                {@html selectedAssignment.Omschrijving}
              </div>
            </div>
          {/if}

          <!-- Attachments (from teacher) -->
          {#if selectedAssignment.Bijlagen?.length}
             <div class="space-y-3">
               <h3 class="text-sm font-bold text-gray-100 flex items-center gap-2">
                 <span class="w-1.5 h-4 bg-blue-500 rounded-full"></span>
                 Bijlagen van docent
               </h3>
               <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                 {#each selectedAssignment.Bijlagen as file}
                   <div class="glass p-3 rounded-xl flex items-center justify-between hover:bg-surface-800/40 transition-colors group cursor-pointer">
                     <div class="flex items-center gap-3 overflow-hidden">
                       <div class="w-8 h-8 rounded-lg bg-surface-800 flex items-center justify-center text-sm shrink-0">
                         📎
                       </div>
                       <span class="text-sm text-gray-300 truncate font-medium">{file.Naam}</span>
                     </div>
                     <span class="text-[10px] text-gray-500 font-bold opacity-0 group-hover:opacity-100 transition-opacity">DOWNLOAD</span>
                   </div>
                 {/each}
               </div>
             </div>
          {/if}

          <!-- Submission Area -->
          {#if selectedAssignment.MagInleveren || selectedAssignment.OpnieuwInleveren}
            <div class="space-y-6 pt-4 border-t border-surface-800/50">
              <div class="flex items-center justify-between">
                <h3 class="text-xl font-black text-white tracking-tight">Inleveren</h3>
                {#if isSubmitting}
                  <div class="flex items-center gap-2 text-xs text-primary-400 font-bold uppercase animate-pulse">
                    <div class="w-2 h-2 rounded-full bg-primary-500"></div>
                    Bezig met inleveren...
                  </div>
                {/if}
              </div>

              <div class="glass rounded-3xl overflow-hidden border-primary-500/20 focus-within:border-primary-500 custom-transition">
                <textarea
                  bind:value={submissionText}
                  placeholder="Typ hier je opmerking voor de docent..."
                  class="w-full bg-transparent p-6 text-sm text-gray-200 outline-none resize-none min-h-[140px] font-medium placeholder:text-gray-600"
                ></textarea>
                
                <!-- Attachment List -->
                {#if attachments.length > 0 || uploadLoading}
                  <div class="px-6 py-4 bg-surface-900/50 border-t border-surface-800/50 space-y-3">
                    <div class="flex items-center justify-between mb-2">
                       <span class="text-[10px] text-gray-500 font-bold uppercase">Jouw bijlagen ({attachments.length})</span>
                       {#if uploadLoading}
                         <div class="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
                       {/if}
                    </div>
                    <div class="flex flex-wrap gap-2">
                      {#each attachments as att, i}
                        <div transition:slide={{ axis: 'x' }} class="pl-3 pr-2 py-1.5 rounded-xl bg-surface-800 border border-surface-700 flex items-center gap-2 group shadow-lg">
                          <span class="text-xs text-gray-300 font-medium">{att.name}</span>
                          <button 
                            onclick={() => removeAttachment(i)}
                            class="w-5 h-5 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center hover:bg-red-500 hover:text-white transition-all"
                          >
                            ×
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
                    class="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-gray-300 hover:bg-surface-700 transition-colors disabled:opacity-50"
                  >
                    <span class="text-lg">📎</span>
                    BIJLAGE TOEVOEGEN
                  </button>

                  <button
                    onclick={handleSubmit}
                    disabled={isSubmitting || uploadLoading || (!submissionText.trim() && attachments.length === 0)}
                    class="px-8 py-2.5 rounded-xl bg-primary-600 text-white text-xs font-black tracking-widest uppercase
                           hover:bg-primary-500 hover:shadow-[0_0_20px_rgba(59,130,246,0.3)] 
                           active:scale-95 transition-all disabled:opacity-50 disabled:hover:shadow-none"
                  >
                    INLEVEREN
                  </button>
                </div>
              </div>
            </div>
          {/if}

          <!-- Previous Versions -->
          {#if selectedAssignment.VersieNavigatieItems?.length > 1}
            <div class="space-y-3">
               <h3 class="text-sm font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                 Geschiedenis
               </h3>
               <div class="space-y-2">
                 {#each selectedAssignment.VersieNavigatieItems.slice(1) as version}
                   <div class="glass p-4 rounded-2xl flex items-center justify-between opacity-60 hover:opacity-100 transition-opacity">
                      <div class="flex items-center gap-4">
                        <div class="w-10 h-10 rounded-full bg-surface-800 flex items-center justify-center text-xs font-black text-gray-500">
                          V{version.VersieNummer}
                        </div>
                        <div>
                          <p class="text-sm font-bold text-gray-200">{version.Omschrijving || 'Ingeleverde versie'}</p>
                          <p class="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">Ingeleverd</p>
                        </div>
                      </div>
                      <button class="text-xs font-bold text-primary-400 hover:underline">BEKIJKEN</button>
                   </div>
                 {/each}
               </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="h-full flex flex-col items-center justify-center text-center p-8">
           <div class="w-24 h-24 rounded-full bg-surface-900 flex items-center justify-center text-4xl mb-6 border border-surface-800 shadow-2xl">
             🏜️
           </div>
           <h3 class="text-2xl font-black text-white mb-2">Selecteer een opdracht</h3>
           <p class="text-gray-500 max-w-xs leading-relaxed font-medium">Kies een opdracht uit de lijst aan de linkerkant om details te bekijken of werk in te leveren.</p>
        </div>
      {/if}
    </section>
  </main>
</div>

<style>
  .glass {
    background: rgba(30, 41, 59, 0.4);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.05);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
  }

  .custom-scrollbar::-webkit-scrollbar {
    width: 5px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  :global(.prose h1, .prose h2, .prose h3) {
    color: white !important;
    font-weight: 800 !important;
  }
  :global(.prose a) {
    color: #3b82f6 !important;
    text-decoration: underline;
  }
  :global(.prose strong) {
    color: #cbd5e1 !important;
    font-weight: 700;
  }
</style>
