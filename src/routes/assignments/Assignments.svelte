<script lang="ts">
  import { personId } from '$lib/stores';
  import { getAssignments, getAssignmentDetail, formatDate } from '$lib/api';
  import { onMount } from 'svelte';

  let assignments = $state<any[]>([]);
  let selectedAssignment = $state<any>(null);
  let loading = $state(true);
  let loadingDetail = $state(false);
  let filter = $state<'all' | 'open' | 'submitted' | 'graded'>('all');

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;

    try {
      const start = '2013-01-01';
      const end = formatDate(new Date(Date.now() + 365 * 86400000));
      assignments = await getAssignments(pid, start, end);
      assignments.sort((a, b) => b.InleverenVoor.localeCompare(a.InleverenVoor));
    } catch (e) {
      console.error('Error loading assignments:', e);
    }
    loading = false;
  });

  function getStatus(a: any): { label: string; color: string } {
    if (a.Afgesloten) return { label: 'Afgesloten', color: 'text-gray-500 bg-gray-500/10' };
    if (a.BeoordeeldOp) return { label: 'Beoordeeld', color: 'text-accent-400 bg-accent-500/10' };
    if (a.IngeleverdOp) return { label: 'Ingeleverd', color: 'text-blue-400 bg-blue-500/10' };
    if (a.MagInleveren) return { label: 'In te leveren', color: 'text-orange-400 bg-orange-500/10' };
    return { label: 'Openstaand', color: 'text-yellow-400 bg-yellow-500/10' };
  }

  function filteredAssignments(): any[] {
    if (filter === 'all') return assignments;
    return assignments.filter(a => {
      const s = getStatus(a);
      if (filter === 'open') return s.label === 'In te leveren' || s.label === 'Openstaand';
      if (filter === 'submitted') return s.label === 'Ingeleverd';
      if (filter === 'graded') return s.label === 'Beoordeeld';
      return true;
    });
  }

  async function selectAssignment(assignment: any) {
    if (selectedAssignment?.Id === assignment.Id) {
      selectedAssignment = null;
      return;
    }
    loadingDetail = true;
    try {
      const selfLink = assignment.Links?.find((l: any) => l.Rel === 'Self')?.Href;
      if (selfLink) {
        selectedAssignment = await getAssignmentDetail(selfLink);
      } else {
        selectedAssignment = assignment;
      }
    } catch (_) {
      selectedAssignment = assignment;
    }
    loadingDetail = false;
  }

  function formatDateFull(iso: string): string {
    return new Date(iso).toLocaleDateString('nl-NL', {
      weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function formatDateShort(iso: string): string {
    return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  }

  function isOverdue(assignment: any): boolean {
    return !assignment.IngeleverdOp && !assignment.Afgesloten && new Date(assignment.InleverenVoor) < new Date();
  }
</script>

<div class="p-6 max-w-5xl mx-auto">
  <!-- Header -->
  <div class="flex items-center justify-between mb-6">
    <h1 class="text-2xl font-bold text-gray-100">Opdrachten</h1>
    <div class="flex items-center gap-1 bg-surface-800/50 rounded-lg p-1">
      {#each [
        { id: 'all', label: 'Alle' },
        { id: 'open', label: 'Open' },
        { id: 'submitted', label: 'Ingeleverd' },
        { id: 'graded', label: 'Beoordeeld' },
      ] as f}
        <button
          onclick={() => filter = f.id as any}
          class="px-3 py-1.5 rounded-md text-xs font-medium
                 {filter === f.id
                   ? 'bg-primary-500/15 text-primary-400'
                   : 'text-gray-400 hover:text-gray-200'}"
        >
          {f.label}
        </button>
      {/each}
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else}
    {@const filtered = filteredAssignments()}

    {#if filtered.length === 0}
      <div class="glass rounded-2xl p-8 text-center">
        <p class="text-gray-500">Geen opdrachten gevonden</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each filtered as assignment}
          {@const status = getStatus(assignment)}
          <div class="glass rounded-2xl overflow-hidden">
            <button
              onclick={() => selectAssignment(assignment)}
              class="w-full flex items-center justify-between p-4 hover:bg-surface-800/30"
            >
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-xl bg-surface-800 flex items-center justify-center text-lg shrink-0">
                  📝
                </div>
                <div class="text-left min-w-0">
                  <p class="text-sm font-semibold text-gray-200 truncate">{assignment.Titel}</p>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-xs text-gray-500">{assignment.Vak ?? ''}</span>
                    <span class="text-xs text-gray-600">•</span>
                    <span class="text-xs {isOverdue(assignment) ? 'text-red-400' : 'text-gray-500'}">
                      {formatDateShort(assignment.InleverenVoor)}
                    </span>
                  </div>
                </div>
              </div>
              <span class="text-xs font-medium px-2 py-1 rounded-lg {status.color} shrink-0 ml-3">
                {status.label}
              </span>
            </button>

            {#if selectedAssignment?.Id === assignment.Id}
              <div class="border-t border-surface-700/50 p-5 space-y-4">
                {#if loadingDetail}
                  <div class="flex justify-center py-4">
                    <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
                  </div>
                {:else}
                  <!-- Details -->
                  <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <div>
                      <p class="text-xs text-gray-500 uppercase">Inleveren voor</p>
                      <p class="text-sm text-gray-300">{formatDateFull(selectedAssignment.InleverenVoor)}</p>
                    </div>
                    {#if selectedAssignment.IngeleverdOp}
                      <div>
                        <p class="text-xs text-gray-500 uppercase">Ingeleverd op</p>
                        <p class="text-sm text-gray-300">{formatDateFull(selectedAssignment.IngeleverdOp)}</p>
                      </div>
                    {/if}
                    {#if selectedAssignment.BeoordeeldOp}
                      <div>
                        <p class="text-xs text-gray-500 uppercase">Beoordeeld op</p>
                        <p class="text-sm text-gray-300">{formatDateFull(selectedAssignment.BeoordeeldOp)}</p>
                      </div>
                    {/if}
                    {#if selectedAssignment.Beoordeling}
                      <div>
                        <p class="text-xs text-gray-500 uppercase">Beoordeling</p>
                        <p class="text-sm font-semibold text-accent-400">{selectedAssignment.Beoordeling}</p>
                      </div>
                    {/if}
                    {#if selectedAssignment.Docenten?.length}
                      <div>
                        <p class="text-xs text-gray-500 uppercase">Docent</p>
                        <p class="text-sm text-gray-300">{selectedAssignment.Docenten.map((d: any) => d.Naam).join(', ')}</p>
                      </div>
                    {/if}
                  </div>

                  {#if selectedAssignment.Omschrijving}
                    <div class="p-4 rounded-xl bg-surface-800/50">
                      <p class="text-xs text-gray-500 uppercase mb-2">Omschrijving</p>
                      <div class="text-sm text-gray-300 prose prose-sm prose-invert max-w-none">
                        {@html selectedAssignment.Omschrijving}
                      </div>
                    </div>
                  {/if}

                  <!-- Versions -->
                  {#if selectedAssignment.VersieNavigatieItems?.length}
                    <div>
                      <p class="text-xs text-gray-500 uppercase mb-2">Versies</p>
                      <div class="space-y-1">
                        {#each selectedAssignment.VersieNavigatieItems as version}
                          <div class="p-3 rounded-xl bg-surface-800/50 flex items-center justify-between">
                            <span class="text-sm text-gray-300">Versie {version.VersieNummer ?? version.Id}</span>
                            <span class="text-xs text-gray-500">{version.Omschrijving ?? ''}</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
