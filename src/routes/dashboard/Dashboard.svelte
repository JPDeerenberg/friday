<script lang="ts">
  import { personId, accountInfo, profilePicture, userSettings } from '$lib/stores';
  import { getCalendarEvents, getGrades, getSchoolyears, getMessageFolders, getAssignments, formatDate, infoTypeShort, getBulkGradeExtraInfo } from '$lib/api';
  import { onMount } from 'svelte';

  let todayEvents = $state<any[]>([]);
  let latestGrades = $state<any[]>([]);
  let unreadCount = $state(0);
  let upcomingAssignments = $state<any[]>([]);
  let loading = $state(true);

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;

    try {
      // Today's events only
      const now = new Date();
      const today = formatDate(now);
      const tomorrow = formatDate(new Date(now.getTime() + 86400000));
      // Note: getCalendarEvents usually takes van/tot as YYYY-MM-DD
      // To get ONLY today, we fetch today and filter if needed, but Magister usually returns the whole day
      const events = await getCalendarEvents(pid, today, today);
      todayEvents = events
        .filter(e => e.Status !== 4 && e.Status !== 5)
        .sort((a, b) => a.Start.localeCompare(b.Start));

      // Grades from current schoolyear
      const schoolyears = await getSchoolyears(pid, '2013-01-01', today);
      if (schoolyears.length > 0) {
        const latest = schoolyears[schoolyears.length - 1];
        if (latest.id) {
          const fetchedGrades = await getGrades(pid, latest.id, latest.einde);
          const top4 = fetchedGrades
            .filter(g => g.CijferStr && g.CijferKolom.KolomSoort === 1)
            .sort((a, b) => (b.DatumIngevoerd ?? '').localeCompare(a.DatumIngevoerd ?? ''))
            .slice(0, 4);
          
          const columnIds = [...new Set(top4.map(g => g.CijferKolom.Id))];
          if (columnIds.length > 0) {
              const weightsMap = await getBulkGradeExtraInfo(pid, latest.id, columnIds);
              latestGrades = top4.map(g => {
                  const extra = weightsMap[g.CijferKolom.Id];
                  return extra ? { ...g, Weging: extra.Weging } : g;
              });
          } else {
              latestGrades = top4;
          }
        }
      }

      // Unread messages
      const folders = await getMessageFolders();
      unreadCount = folders.reduce((sum, f) => sum + (f.aantalOngelezen ?? 0), 0);

      // Upcoming assignments (next 7 days)
      const nextWeek = formatDate(new Date(now.getTime() + 7 * 86400000));
      const assignments = await getAssignments(pid, today, nextWeek);
      upcomingAssignments = assignments
        .filter(a => !a.Afgesloten)
        .sort((a, b) => a.InleverenVoor.localeCompare(b.InleverenVoor))
        .slice(0, 3);
    } catch (e) {
      console.error('Dashboard load error:', e);
    }
    loading = false;
  });

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function getSubjectIcon(name: string): string {
    const n = name.toLowerCase();
    if (n.includes('wiskunde')) return '➗';
    if (n.includes('nederlands')) return '🇳🇱';
    if (n.includes('engels')) return '🇬🇧';
    if (n.includes('geschiedenis')) return '⏳';
    if (n.includes('aardrijkskunde')) return '🌍';
    if (n.includes('biologie')) return '🧬';
    if (n.includes('natuurkunde')) return '⚛️';
    if (n.includes('scheikunde')) return '🧪';
    if (n.includes('gym') || n.includes('lo')) return '🏀';
    if (n.includes('economie')) return '📈';
    return '📚';
  }

  function isVoldoende(grade: any): boolean {
    const val = parseFloat(grade.CijferStr.replace(',', '.'));
    return val >= $userSettings.insufficientThreshold;
  }
</script>

<div class="p-6 max-w-6xl mx-auto">
  {#if loading}
    <div class="flex items-center justify-center py-40">
      <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else}
    <!-- Hero Section -->
    <div class="mb-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
      <div>
        <h1 class="text-4xl font-bold text-gray-100 tracking-tight">
          Hoi, {$accountInfo?.Persoon?.Roepnaam ?? 'Gebruiker'}! 👋
        </h1>
        <p class="text-gray-400 mt-2 text-lg font-medium">
          {new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>
      
      <div class="flex gap-4">
        <div class="glass px-6 py-4 rounded-3xl flex items-center gap-4 border border-surface-700/30">
          <div class="w-10 h-10 rounded-2xl bg-primary-500/10 flex items-center justify-center text-xl">✉️</div>
          <div>
            <p class="text-xl font-black text-gray-100 leading-none">{unreadCount}</p>
            <p class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-1">Berichten</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      
      <!-- Left Column: Schedule (Focus) -->
      <div class="lg:col-span-7 space-y-6">
        <section class="glass rounded-[2rem] p-8 border border-white/5 shadow-2xl relative overflow-hidden group">
          <div class="flex items-center justify-between mb-8">
            <h2 class="text-xl font-bold text-gray-100">Vandaag</h2>
            <span class="text-xs font-bold text-primary-400 bg-primary-400/10 px-3 py-1 rounded-full uppercase tracking-widest">
              {todayEvents.length} lessen
            </span>
          </div>

          {#if todayEvents.length === 0}
            <div class="py-12 flex flex-col items-center justify-center text-center opacity-60">
              <span class="text-5xl mb-4">🏖️</span>
              <p class="text-gray-400 font-medium">Geen lessen voor vandaag!</p>
              <p class="text-sm text-gray-600 mt-1">Lekker ontspannen.</p>
            </div>
          {:else}
            <div class="relative pl-4 space-y-6 before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:bg-surface-700/50">
              {#each todayEvents as event}
                <div class="relative flex items-start gap-6 group/item">
                  <!-- Timeline Dot -->
                  <div class="absolute -left-[1.35rem] top-1.5 w-2 h-2 rounded-full border-2 border-surface-950
                              {event.Status === 4 || event.Status === 5 ? 'bg-red-500' : 'bg-primary-500 shadow-[0_0_10px_rgba(var(--primary-500-rgb),0.5)]'}"></div>
                  
                  <div class="shrink-0 w-16 pt-0.5">
                    <p class="text-sm font-black text-gray-100">{event.LesuurVan ? event.LesuurVan + 'e' : formatTime(event.Start)}</p>
                    <p class="text-[10px] text-gray-500 font-bold uppercase tracking-wider">{event.LesuurVan ? formatTime(event.Start) : ''}</p>
                  </div>

                  <div class="flex-1 glass p-4 rounded-2xl border border-white/5 group-hover/item:bg-surface-800/80 transition-all
                              {event.Status === 4 || event.Status === 5 ? 'opacity-40 line-through' : ''}">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <p class="text-base font-bold text-gray-100 leading-tight">
                          {event.Vakken?.[0]?.Naam ?? event.Omschrijving ?? 'Afspraak'}
                        </p>
                        <div class="flex items-center gap-3 mt-2">
                          {#if event.Lokalen?.[0]?.Naam}
                            <div class="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-900 border border-white/5 text-[11px] font-bold text-gray-400">
                              <span class="opacity-50">📍</span> {event.Lokalen[0].Naam}
                            </div>
                          {/if}
                          {#if event.Docenten?.[0]?.Naam}
                            <span class="text-[11px] font-medium text-gray-500">
                              👤 {event.Docenten[0].Naam}
                            </span>
                          {/if}
                        </div>
                      </div>
                      
                      {#if infoTypeShort(event.InfoType)}
                        <span class="shrink-0 text-[10px] font-black uppercase px-2 py-1 rounded-lg 
                                   {event.InfoType === 1 ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'} border border-white/5">
                          {infoTypeShort(event.InfoType)}
                        </span>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <!-- Right Column -->
      <div class="lg:col-span-5 space-y-6">
        
        <!-- Latest Grades Widget -->
        <section class="glass rounded-[2rem] p-8 border border-white/5 shadow-xl">
          <h2 class="text-xl font-bold text-gray-100 mb-6 flex items-center gap-2">
            Laatste Cijfers 📈
          </h2>
          
          {#if latestGrades.length === 0}
            <p class="text-gray-500 text-center py-10">Geen recente cijfers</p>
          {:else}
            <div class="space-y-4">
              {#each latestGrades as grade}
                <div class="flex items-center justify-between p-4 rounded-2xl bg-surface-900/50 border border-white/5 hover:bg-surface-800/50 transition-all group">
                  <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-xl bg-surface-800 flex items-center justify-center text-lg group-hover:scale-110 transition-transform">
                      {getSubjectIcon(grade.Vak?.Omschrijving ?? '')}
                    </div>
                    <div>
                      <p class="text-sm font-bold text-gray-200">{grade.Vak?.Omschrijving ?? 'Onbekend'}</p>
                      <p class="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-0.5">{grade.CijferKolom?.KolomNaam ?? ''}</p>
                    </div>
                  </div>
                  <div class="text-right">
                    <span class="text-xl font-black {$userSettings.highlightFailing && !isVoldoende(grade) ? 'text-red-400' : 'text-accent-400'}">
                      {grade.CijferStr}
                    </span>
                    {#if grade.Weging && grade.CijferKolom?.KolomSoort === 1}
                      <p class="text-[9px] text-gray-600 font-bold mt-1 uppercase">×{grade.Weging}</p>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
            <button class="w-full mt-6 py-3 text-xs font-bold text-gray-500 hover:text-primary-400 transition-colors uppercase tracking-widest">
              Alle cijfers bekijken →
            </button>
          {/if}
        </section>

        <!-- Assignments Widget -->
        <section class="glass rounded-[2rem] p-8 border border-white/5 shadow-xl">
          <h2 class="text-xl font-bold text-gray-100 mb-6 flex items-center gap-2">
            Opdrachten 🗓️
          </h2>
          
          {#each upcomingAssignments as assignment}
            <div class="p-4 mb-3 last:mb-0 rounded-2xl bg-surface-900/50 border border-white/5">
              <div class="flex justify-between items-start gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-bold text-gray-200 truncate">{assignment.Titel}</p>
                  <p class="text-[11px] text-gray-500 font-medium mt-1 uppercase tracking-tight">{assignment.Vak ?? 'Algemeen'}</p>
                </div>
                <div class="shrink-0 px-2 py-1 rounded bg-red-400/10 border border-red-400/20 text-[10px] font-black text-red-400 uppercase tracking-tighter">
                  {new Date(assignment.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                </div>
              </div>
            </div>
          {:else}
            <p class="text-gray-500 text-center py-6">Niets op de planning!</p>
          {/each}
        </section>
      </div>

    </div>
  {/if}
</div>

<style>
  .glass {
    background: rgba(23, 23, 23, 0.4);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }
</style>
