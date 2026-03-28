<script lang="ts">
  import { personId, accountInfo, profilePicture, userSettings } from '$lib/stores';
  import { get } from 'svelte/store';
  import { getCalendarEvents, getGrades, getSchoolyears, getMessageFolders, getAssignments, formatDate, infoTypeShort, getBulkGradeExtraInfo, formatTeacherName } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';

  let todayEvents = $state<any[]>([]);
  let latestGrades = $state<any[]>([]);
  let unreadCount = $state(0);
  let upcomingAssignments = $state<any[]>([]);
  let loading = $state(true);

  onMount(async () => {
    // Load cache
    const cached = localStorage.getItem('dashboard_cache');
    if (cached) {
      const data = JSON.parse(cached);
      todayEvents = data.todayEvents;
      latestGrades = data.latestGrades;
      unreadCount = data.unreadCount;
      upcomingAssignments = data.upcomingAssignments;
    }
    await loadDashboardData();
  });

  async function loadDashboardData() {
    const pid = get(personId);
    if (!pid) return;
    loading = true;

    try {
      const now = new Date();
      const today = formatDate(now);
      
      // Load everything in parallel
      const [events, schoolyears, folders] = await Promise.all([
        getCalendarEvents(pid, today, today),
        getSchoolyears(pid, '2020-01-01', today),
        getMessageFolders()
      ]);

      todayEvents = events
        .filter(e => e.Status !== 4 && e.Status !== 5)
        .sort((a, b) => a.Start.localeCompare(b.Start));

      unreadCount = folders.reduce((sum, f) => sum + (f.aantalOngelezen ?? 0), 0);

      if (schoolyears.length > 0) {
        const currentYear = schoolyears.find(y => {
          if (!y.begin || !y.einde) return false;
          return new Date(y.begin) <= now && new Date(y.einde) >= now;
        }) || schoolyears[schoolyears.length - 1];

        if (currentYear?.id) {
          const fetchedGrades = await getGrades(pid, currentYear.id, currentYear.einde);
          latestGrades = fetchedGrades
            .filter(g => g.CijferStr && g.CijferKolom?.KolomSoort === 1)
            .sort((a, b) => (b.DatumIngevoerd ?? '').localeCompare(a.DatumIngevoerd ?? ''))
            .slice(0, 5);
        }
      }

      const nextWeek = formatDate(new Date(now.getTime() + 7 * 86400000));
      const assignments = await getAssignments(pid, today, nextWeek);
      upcomingAssignments = assignments
        .filter(a => !a.Afgesloten)
        .sort((a, b) => a.InleverenVoor.localeCompare(b.InleverenVoor))
        .slice(0, 3);
        
      // Update cache
      localStorage.setItem('dashboard_cache', JSON.stringify({
        todayEvents,
        latestGrades,
        unreadCount,
        upcomingAssignments
      }));

    } catch (e) {
      console.error('Dashboard load error:', e);
    }
    loading = false;
  }

  function getSubjectIcon(subject: string): string {
    const s = subject.toLowerCase();
    
    // SVG icons instead of emojis
    const iconBase = `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">`;
    
    if (s.includes('wiskunde')) return iconBase + `<path d="m19 5-7 7-7-7"/><path d="m19 19-7-7-7 7"/></svg>`;
    if (s.includes('nederlands') || s.includes('engels') || s.includes('frans') || s.includes('duits')) return iconBase + `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>`;
    if (s.includes('geschiedenis')) return iconBase + `<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>`;
    if (s.includes('aardrijkskunde')) return iconBase + `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
    if (s.includes('natuurkunde') || s.includes('scheikunde') || s.includes('biologie')) return iconBase + `<path d="M10 2v8L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45L14 10V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></svg>`;
    if (s.includes('economie')) return iconBase + `<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
    if (s.includes('gym') || s.includes('lo')) return iconBase + `<circle cx="12" cy="12" r="10"/><path d="M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0"/></svg>`;
    if (s.includes('tekenen') || s.includes('kunst')) return iconBase + `<path d="m14 6-6 6"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/></svg>`;
    if (s.includes('muziek')) return iconBase + `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    
    return iconBase + `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>`; // Default book
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function isVoldoende(grade: any): boolean {
    const val = parseFloat(grade.CijferStr.replace(',', '.'));
    return val >= $userSettings.insufficientThreshold;
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <!-- Sticky Header -->
  <header class="sticky top-0 z-10 bg-surface-950/95 backdrop-blur border-b border-surface-800/50 px-4 py-4 mb-6 md:mb-10">
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 max-w-7xl mx-auto w-full">
      <div class="flex items-center gap-4">
        <div>
          <h1 class="text-2xl md:text-3xl font-black text-white tracking-tighter italic">
            Goeiedag, <span class="text-primary-500">{$accountInfo?.Persoon?.Roepnaam ?? 'Gebruiker'}</span>!
          </h1>
          <p class="text-gray-500 text-[10px] font-black uppercase tracking-[0.2em] mt-1">
            {new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <button 
          onclick={loadDashboardData}
          class="p-2.5 rounded-full bg-surface-800/40 text-gray-500 hover:text-primary-400 border border-white/5 transition-all hover:scale-110 active:scale-95"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>

      <div class="flex items-center gap-3">
        <div class="glass px-4 py-2 rounded-2xl flex items-center gap-2 border-primary-500/20">
          <span class="text-primary-400">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><rect width="20" height="14" x="2" y="5" rx="2"/></svg>
          </span>
          <span class="text-xs font-black text-primary-400 uppercase tracking-widest">{unreadCount} ongelezen</span>
        </div>
      </div>
    </div>
  </header>

  <div class="max-w-7xl mx-auto px-4 md:px-8 w-full pb-10">
    {#if loading}
      <div class="flex items-center justify-center py-40">
        <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    {:else}
      <!-- Main Grid -->
      <div in:fade={{ duration: 400 }} class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        <!-- Left Column: Schedule -->
        <div class="lg:col-span-7 space-y-6">
          <section 
            role="button"
            tabindex="0"
            onclick={() => currentPage.set('calendar')}
            class="glass rounded-3xl md:rounded-[2rem] p-5 md:p-8 border border-white/5 shadow-2xl relative overflow-hidden group cursor-pointer hover:bg-surface-800/40 transition-all"
          >
            <div class="flex items-center justify-between mb-8">
              <h2 class="text-xl font-bold text-gray-100 flex items-center gap-2">
                <svg class="w-5 h-5 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                Vandaag
              </h2>
              <span class="text-[9px] font-black text-primary-500 bg-primary-500/10 px-3 py-1.5 rounded-full uppercase tracking-widest border border-primary-500/20 shadow-sm">
                {todayEvents.length} lessen
              </span>
            </div>

            {#if todayEvents.length === 0}
              <div class="py-12 flex flex-col items-center justify-center text-center opacity-60">
                 <div class="w-20 h-20 rounded-full bg-surface-900 flex items-center justify-center mb-6 text-gray-500 border border-surface-800 shadow-inner">
                    <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>
                 </div>
                <p class="text-gray-400 font-black uppercase tracking-[0.2em] text-[10px]">Geen lessen voor vandaag</p>
                <p class="text-[9px] text-gray-600 mt-2 font-bold uppercase tracking-wider">Lekker ontspannen.</p>
              </div>
            {:else}
              <div class="space-y-4">
                {#each todayEvents as event, i}
                  <div in:fly={{ y: 20, delay: i * 50 }} class="flex items-center gap-4 p-4 rounded-2xl bg-surface-900/40 border border-white/5 group/event transition-all hover:bg-surface-800/60">
                    <div class="flex flex-col items-center justify-center min-w-[60px] py-2 px-3 rounded-xl bg-surface-900 border border-surface-700/50">
                      <span class="text-xs font-black text-primary-400">{formatTime(event.Start)}</span>
                      <span class="text-[10px] font-bold text-gray-600 mt-0.5">{event.LesuurVan ? event.LesuurVan + 'e' : ''}</span>
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-black text-gray-100 truncate group-hover/event:text-primary-400 transition-colors uppercase tracking-tight italic">
                        {event.Vakken?.[0]?.Naam ?? event.Omschrijving ?? 'Afspraak'}
                      </p>
                      <div class="flex items-center gap-2 mt-1">
                        <span class="text-[9px] font-black text-gray-500 uppercase tracking-widest px-2 py-0.5 rounded-lg bg-surface-800 border border-white/5">{event.Lokalen?.[0]?.Naam ?? '??'}</span>
                        <span class="text-[9px] font-black text-gray-600 uppercase tracking-tighter truncate">{formatTeacherName(event.Docenten?.[0]?.Naam) ?? ''}</span>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>

          <!-- Grades Section -->
          <section 
            role="button"
            tabindex="0"
            onclick={() => currentPage.set('grades')}
            class="glass rounded-3xl md:rounded-[2rem] p-5 md:p-8 border border-white/5 shadow-2xl cursor-pointer hover:bg-surface-800/40 transition-all"
          >
            <h2 class="text-xl font-bold text-gray-100 mb-8 flex items-center justify-between">
              <span class="flex items-center gap-2">
                <svg class="w-5 h-5 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.105 13.123l2.895-2.123 2.895 2.123 5.105-4.123"/><path d="M3 21h18"/><path d="M3 3v18h18"/></svg>
                Laatste Cijfers
              </span>
              <span class="text-[9px] font-black text-gray-600 uppercase tracking-widest bg-white/5 px-2 py-1 rounded-lg">Top 5</span>
            </h2>
            
            {#each latestGrades as grade, i}
              <div
                in:fly={{ x: -20, delay: i * 50 }}
                class="flex items-center justify-between p-4 mb-4 last:mb-0 rounded-[1.5rem] bg-surface-900/40 border border-white/5 hover:bg-surface-800/60 transition-all group/grade"
              >
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-surface-900 border border-surface-700/50 flex items-center justify-center text-primary-400 relative group-hover/grade:scale-110 transition-transform duration-500 shadow-inner">
                    {@render (function() { return getSubjectIcon(grade.Vak?.Omschrijving ?? ''); })()}
                  </div>
                  <div class="min-w-0">
                    <p class="text-sm font-black text-gray-100 truncate group-hover/grade:text-primary-400 transition-colors italic tracking-tight">
                      {grade.Vak?.Omschrijving ?? 'Onbekend'}
                    </p>
                    <p class="text-[9px] text-gray-500 font-black uppercase tracking-widest mt-0.5 truncate max-w-[120px]">
                      {grade.CijferKolom?.KolomNaam ?? 'Toets'}
                    </p>
                  </div>
                </div>
                
                <div class="text-right">
                  <div class="text-2xl font-black italic tracking-tighter {$userSettings.highlightFailing && !isVoldoende(grade) ? 'text-red-500' : 'text-accent-500'} drop-shadow-sm">
                    {grade.CijferStr}
                  </div>
                  {#if grade.Weging}
                    <div class="text-[9px] font-black text-gray-600 uppercase tracking-widest mt-0.5 opacity-60">
                      ×{grade.Weging}
                    </div>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="py-12 flex flex-col items-center justify-center text-center opacity-40">
                <div class="w-16 h-16 rounded-full bg-surface-900 flex items-center justify-center mb-4 text-gray-500 border border-surface-800">
                    <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                </div>
                <p class="text-[9px] font-black text-gray-400 uppercase tracking-widest">Geen recente cijfers</p>
              </div>
            {/each}
          </section>
        </div>

        <!-- Right Column: Assignments -->
        <div class="lg:col-span-5">
          <section 
             role="button"
             tabindex="0"
             onclick={() => currentPage.set('assignments')}
             class="glass rounded-3xl md:rounded-[2rem] p-5 md:p-8 border border-white/5 shadow-xl sticky top-28 cursor-pointer hover:bg-surface-800/40 transition-all"
          >
            <h2 class="text-xl font-bold text-gray-100 mb-6 flex items-center gap-2">
              <svg class="w-5 h-5 text-primary-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
              Opdrachten
            </h2>
            
            {#each upcomingAssignments as assignment, i}
              <div in:fly={{ x: 20, delay: i * 100 }} class="p-4 mb-3 last:mb-0 rounded-2xl bg-surface-900/50 border border-white/5 group/assign transition-all hover:bg-surface-800/60">
                <div class="flex justify-between items-start gap-4">
                  <div class="min-w-0">
                    <p class="text-sm font-black text-gray-200 truncate group-hover/assign:text-primary-400 transition-colors">{assignment.Titel}</p>
                    <p class="text-[10px] text-gray-500 font-bold mt-1 uppercase tracking-widest italic">{assignment.Vak ?? 'Algemeen'}</p>
                  </div>
                  <div class="shrink-0 px-2.5 py-1.5 rounded-xl bg-red-400/10 border border-red-400/20 text-[9px] font-black text-red-400 uppercase tracking-tighter shadow-sm">
                    {new Date(assignment.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                  </div>
                </div>
              </div>
            {:else}
              <div class="py-12 flex flex-col items-center justify-center text-center opacity-40">
                <div class="w-16 h-16 rounded-full bg-surface-900 flex items-center justify-center mb-4 text-gray-500 border border-surface-800">
                    <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                </div>
                <p class="text-[9px] font-black text-gray-400 uppercase tracking-widest">Alles ingeleverd!</p>
              </div>
            {/each}
            
            <button 
              onclick={() => currentPage.set('assignments')}
              class="w-full mt-6 py-4 rounded-2xl bg-primary-500 text-on-primary font-black text-[10px] uppercase tracking-[0.2em] shadow-lg shadow-primary-500/20 hover:scale-[1.02] transition-all active:scale-95 ring-1 ring-white/10"
            >
              Bekijk Alle Opdrachten
            </button>
          </section>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .glass {
    background: rgba(15, 23, 42, 0.4);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
</style>
