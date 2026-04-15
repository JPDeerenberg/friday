<script lang="ts">
  import { personId, accountInfo, userSettings, currentPage } from '$lib/stores';
  import { getCalendarEvents, getGrades, getSchoolyears, getMessageFolders, getAssignments, formatDate, formatTeacherName } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, scale } from 'svelte/transition';

  // Svelte 5 State
  let todayEvents = $state<any[]>([]);
  let latestGrades = $state<any[]>([]);
  let unreadCount = $state(0);
  let upcomingAssignments = $state<any[]>([]);
  
  // Section-specific loading states
  let loadingEvents = $state(true);
  let loadingGrades = $state(true);
  let loadingMessages = $state(true);
  let loadingAssignments = $state(true);
  
  let refreshTrigger = $state(0);

  // Derived greeting
  const greeting = $derived(() => {
    const hour = new Date().getHours();
    if (hour < 6) return 'Goedenacht';
    if (hour < 12) return 'Goedemorgen';
    if (hour < 18) return 'Goedemiddag';
    return 'Goedenavond';
  });

  // Watch for personId availability and local storage hydration
  $effect(() => {
    if ($personId !== null && refreshTrigger >= 0) {
      loadDashboardData();
    }
  });

  onMount(() => {
    const cached = localStorage.getItem('dashboard_cache');
    if (cached) {
      try {
        const data = JSON.parse(cached);
        todayEvents = data.todayEvents || [];
        latestGrades = data.latestGrades || [];
        unreadCount = data.unreadCount || 0;
        upcomingAssignments = data.upcomingAssignments || [];
        
        // If we have cached data, we can stop initial global loading
        loadingEvents = todayEvents.length === 0;
        loadingGrades = latestGrades.length === 0;
        loadingMessages = false;
        loadingAssignments = upcomingAssignments.length === 0;
      } catch (e) {
        console.error('Failed to parse dashboard cache:', e);
      }
    }
  });

  async function loadDashboardData() {
    const pid = $personId;
    if (pid === null) return;
    
    // Set all to loading if we are manually refreshing
    if (refreshTrigger > 0) {
        loadingEvents = true;
        loadingGrades = true;
        loadingMessages = true;
        loadingAssignments = true;
    }

    const now = new Date();
    const today = formatDate(now);
    const nextWeek = formatDate(new Date(now.getTime() + 7 * 86400000));

    // Parallel requests with individual error handling and loading completion
    await Promise.allSettled([
      // 1. Calendar
      (async () => {
        try {
          const events = await getCalendarEvents(pid, today, today);
          todayEvents = events
            .filter(e => e.Status !== 4 && e.Status !== 5)
            .sort((a, b) => a.Start.localeCompare(b.Start));
        } catch (e) {
          console.error('Dashboard: Calendar fetch failed', e);
        } finally {
          loadingEvents = false;
        }
      })(),

      // 2. Messages
      (async () => {
        try {
          const folders = await getMessageFolders();
          unreadCount = folders.reduce((sum, f) => sum + (f.aantalOngelezen ?? 0), 0);
        } catch (e) {
          console.error('Dashboard: Messages fetch failed', e);
        } finally {
          loadingMessages = false;
        }
      })(),

      // 3. Grades (requires schoolyears first)
      (async () => {
        try {
          const schoolyears = await getSchoolyears(pid, '2020-01-01', today);
          if (schoolyears.length > 0) {
            const currentYear = schoolyears.find(y => {
              if (!y.begin || !y.einde) return false;
              const b = new Date(y.begin);
              const e = new Date(y.einde);
              return b <= now && e >= now;
            }) || schoolyears[schoolyears.length - 1];

            if (currentYear?.id) {
              const fetchedGrades = await getGrades(pid, currentYear.id, currentYear.einde);
              latestGrades = fetchedGrades
                .filter(g => g.CijferStr && g.CijferKolom?.KolomSoort === 1)
                .sort((a, b) => (b.DatumIngevoerd ?? '').localeCompare(a.DatumIngevoerd ?? ''))
                .slice(0, 5);
            }
          }
        } catch (e) {
          console.error('Dashboard: Grades fetch failed', e);
        } finally {
          loadingGrades = false;
        }
      })(),

      // 4. Assignments
      (async () => {
        try {
          const assignments = await getAssignments(pid, today, nextWeek);
          upcomingAssignments = assignments
            .filter(a => !a.Afgesloten)
            .sort((a, b) => a.InleverenVoor.localeCompare(b.InleverenVoor))
            .slice(0, 3);
        } catch (e) {
          console.error('Dashboard: Assignments fetch failed', e);
        } finally {
          loadingAssignments = false;
        }
      })()
    ]);

    localStorage.setItem('dashboard_cache', JSON.stringify({
      todayEvents,
      latestGrades,
      unreadCount,
      upcomingAssignments
    }));
  }

  function handleRefresh() {
    refreshTrigger++;
  }

  function getSubjectIcon(subject: string): string {
    const s = subject.toLowerCase();
    const iconBase = `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`;
    
    if (s.includes('wiskunde') || s.includes('rekenen')) return iconBase + `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="m10 10 4 4"/><path d="m14 10-4 4"/></svg>`;
    if (s.includes('taal') || s.includes('nederlands') || s.includes('engels') || s.includes('frans') || s.includes('duits') || s.includes('spaans')) return iconBase + `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>`;
    if (s.includes('geschiedenis') || s.includes('maatschappij')) return iconBase + `<circle cx="12" cy="10" r="3"/><path d="M7 21l3-10h4l3 10"/><path d="M8 21h8"/></svg>`;
    if (s.includes('aardrijkskunde')) return iconBase + `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
    if (s.includes('natuur') || s.includes('scheikunde') || s.includes('biologie') || s.includes('science')) return iconBase + `<path d="M10 2v8L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45L14 10V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></svg>`;
    if (s.includes('economie')) return iconBase + `<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
    if (s.includes('gym') || s.includes('lo')) return iconBase + `<path d="M6 18h8"/><path d="M3 22h18"/><path d="M9 10a5 5 0 1 0 5 5"/><path d="M19 10a5 5 0 1 0-5 5"/></svg>`;
    if (s.includes('kunst') || s.includes('tekenen') || s.includes('handvaardigheid')) return iconBase + `<path d="m12 19 7-7 3 3-7 7-3-3Z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5Z"/><path d="m2 2 5 2"/><path d="m2 2 2 5"/><path d="m11 8 1 1"/><path d="m16 12 1 1"/></svg>`;
    if (s.includes('muziek')) return iconBase + `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    if (s.includes('informatica') || s.includes('it')) return iconBase + `<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`;
    
    return iconBase + `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>`;
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function isVoldoende(grade: any): boolean {
    const val = parseFloat(grade.CijferStr.replace(',', '.'));
    return val >= ($userSettings.insufficientThreshold ?? 5.5);
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-screen selection:bg-primary-500/30">
  <!-- Sticky Header -->
  <header class="sticky top-0 z-40 bg-surface-950/80 backdrop-blur-2xl border-b border-white/5 px-6 py-6 md:py-8 transition-all duration-500 overflow-hidden">
    <!-- Animated background pulse for header -->
    <div class="absolute inset-x-0 -top-24 h-48 bg-primary-500/5 blur-[100px] rounded-full animate-header-pulse"></div>
    
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 max-w-7xl mx-auto w-full relative z-10">
      <div class="flex items-center gap-6" in:fly={{ x: -20, duration: 800 }}>
        <div class="relative group">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white text-3xl font-black shadow-2xl shadow-primary-500/30 group-hover:rotate-6 group-hover:scale-105 transition-all duration-500 cursor-help">
            {$accountInfo?.Persoon?.Roepnaam?.[0] ?? 'U'}
          </div>
          <div class="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-emerald-500 border-4 border-surface-950 shadow-lg animate-pulse"></div>
        </div>
        <div>
          <h1 class="text-3xl md:text-5xl font-black text-white tracking-tighter italic leading-none flex flex-wrap items-baseline gap-x-3">
             <span class="opacity-60 font-medium not-italic text-2xl md:text-3xl">{greeting()}</span>
             <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 via-primary-200 to-primary-500 animate-gradient-x italic">
                {$accountInfo?.Persoon?.Roepnaam ?? 'Gebruiker'}
             </span>
          </h1>
          <p class="text-gray-500 text-[11px] font-black uppercase tracking-[0.3em] mt-3 flex items-center gap-3">
            <span class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_10px_#10b981]"></span>
            {new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3 md:gap-5">
        <button
           onclick={() => currentPage.set('messages')}
           aria-label={`${unreadCount} ongelezen berichten`}
           class="glass px-5 py-3 rounded-2xl flex items-center gap-3 border-primary-500/10 group transition-all hover:bg-primary-500/20 hover:border-primary-500/40 active:scale-95 shadow-xl shadow-black/40 relative overflow-hidden"
        >
          <div class="absolute inset-0 bg-gradient-to-r from-primary-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
          <div class="relative">
            <svg class="w-5 h-5 text-primary-400 group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><rect width="20" height="14" x="2" y="5" rx="2"/></svg>
            {#if unreadCount > 0}
              <span class="absolute -top-1.5 -right-1.5 flex h-3 w-3">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
              </span>
            {/if}
          </div>
          <span class="text-xs font-black text-primary-400 uppercase tracking-widest relative z-10">{unreadCount} berichten</span>
        </button>
        <button 
          onclick={handleRefresh}
          class="p-4 rounded-2xl bg-surface-800/40 text-gray-400 hover:text-white border border-white/5 transition-all hover:bg-surface-700/60 active:scale-90 shadow-2xl group overflow-hidden relative"
          aria-label="Vernieuwen"
        >
          <div class="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
          <svg class="w-5 h-5 group-hover:rotate-180 transition-transform duration-1000 ease-in-out relative z-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-6 md:px-12 w-full py-12 pb-32">
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-12 md:gap-16">
      
      <!-- Left Column: Schedule -->
      <div class="lg:col-span-7 space-y-16">
        <section in:fly={{ y: 30, duration: 800 }} class="space-y-8">
          <div class="flex items-center justify-between px-2">
            <h2 class="text-3xl font-black text-white italic tracking-tighter flex items-center gap-4">
              <div class="w-2.5 h-10 bg-primary-500 rounded-full shadow-[0_0_25px_rgba(200,100,255,0.7)] animate-pulse"></div>
              Jouw Rooster
            </h2>
            <button 
              onclick={() => currentPage.set('calendar')}
              class="text-[11px] font-black text-primary-400 hover:text-primary-300 uppercase tracking-[0.3em] transition-all hover:gap-4 flex items-center gap-3 group/all bg-primary-500/5 px-5 py-2.5 rounded-full border border-primary-500/10 hover:border-primary-500/30"
            >
              Bekijk alles <svg class="w-4 h-4 group-hover/all:translate-x-1 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>

          <div class="glass rounded-[4rem] p-4 md:p-8 shadow-3xl relative overflow-hidden group border-white/5 min-h-[400px] flex flex-col">
             <div class="absolute inset-0 bg-gradient-to-br from-primary-500/10 via-transparent to-transparent opacity-50 group-hover:opacity-80 transition-opacity duration-700"></div>
             
             {#if loadingEvents}
               <div class="space-y-6 relative z-10 w-full p-4">
                  {#each Array(4) as _}
                    <div class="flex items-center gap-7 p-6 rounded-[3rem] bg-surface-900/30 animate-pulse border border-white/10">
                       <div class="w-20 h-20 rounded-3xl bg-surface-800"></div>
                       <div class="flex-1 space-y-3">
                          <div class="h-6 bg-surface-800 rounded-full w-2/3"></div>
                          <div class="h-4 bg-surface-800/50 rounded-full w-1/3"></div>
                       </div>
                    </div>
                  {/each}
               </div>
             {:else if todayEvents.length === 0}
              <div class="flex-1 flex flex-col items-center justify-center text-center opacity-70 py-24" in:fade>
                 <div class="w-40 h-40 rounded-[3.5rem] bg-surface-900/60 border border-white/10 flex items-center justify-center mb-10 text-gray-600 shadow-2xl group-hover:scale-110 group-hover:rotate-6 transition-all duration-700 relative">
                    <div class="absolute inset-0 bg-primary-500/5 blur-3xl rounded-full"></div>
                    <svg class="w-20 h-20 opacity-20 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/></svg>
                 </div>
                <p class="text-white font-black uppercase tracking-[0.4em] text-lg italic">Vrije dag!</p>
                <p class="text-[11px] text-gray-500 mt-5 font-bold uppercase tracking-widest italic max-w-xs leading-relaxed">Je hebt vandaag geen geplande lessen. Geniet van je vrije tijd of bereid je voor op morgen.</p>
              </div>
            {:else}
              <div class="space-y-4 md:space-y-5 relative z-10 w-full px-1 md:px-2">
                {#each todayEvents as event, i (event.Id || i)}
                  <button 
                    onclick={() => currentPage.set('calendar')}
                    in:fly={{ x: -30, delay: i * 100, duration: 600 }}
                    class="w-full flex flex-row items-center gap-4 md:gap-7 p-4 sm:p-6 md:p-7 rounded-[2rem] sm:rounded-[3rem] bg-surface-900/40 border border-white/5 group/event transition-all hover:bg-surface-800/90 hover:border-primary-500/40 hover:scale-[1.02] active:scale-95 shadow-lg"
                  >
                    <div class="flex flex-col items-center justify-center min-w-[70px] md:min-w-[85px] py-3 md:py-5 rounded-[1.5rem] sm:rounded-[2.5rem] bg-surface-950 border border-surface-700/50 group-hover/event:border-primary-500/60 transition-all duration-500 shadow-2xl relative overflow-hidden shrink-0">
                      <div class="absolute inset-0 bg-primary-500/5 opacity-0 group-hover/event:opacity-100 transition-opacity"></div>
                      <span class="text-2xl md:text-3xl font-black text-primary-400 italic leading-none relative z-10">{event.LesuurVan || '—'}</span>
                      <span class="text-[9px] md:text-[10px] font-black text-gray-600 mt-1.5 md:mt-2.5 uppercase tracking-tighter relative z-10">{formatTime(event.Start)}</span>
                    </div>
                    <div class="flex-1 min-w-0 text-left">
                      <p class="text-lg md:text-xl font-black text-gray-100 truncate group-hover/event:text-primary-400 transition-colors uppercase tracking-tight italic">
                        {event.Vakken?.[0]?.Naam ?? event.Omschrijving ?? 'Afspraak'}
                      </p>
                      <div class="flex flex-wrap md:flex-nowrap items-center gap-2 md:gap-5 mt-2 md:mt-4">
                        <span class="flexitems-center gap-1.5 md:gap-2.5 text-[9px] md:text-[10px] font-black text-gray-400 uppercase tracking-widest px-3 md:px-4 py-1.5 md:py-2 rounded-xl sm:rounded-2xl bg-surface-800/80 border border-white/5 shadow-inner">
                          <svg class="w-3 md:w-3.5 h-3 md:h-3.5 text-primary-500 inline-block mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                          {event.Lokalen?.[0]?.Naam ?? '??'}
                        </span>
                        <span class="text-[9px] md:text-[11px] font-bold text-gray-500 uppercase tracking-tight truncate opacity-80 group-hover/event:opacity-100 transition-opacity bg-white/5 px-2.5 md:px-3 py-1 md:py-1.5 rounded-lg sm:rounded-xl">{formatTeacherName(event.Docenten?.[0]?.Naam) ?? 'Geen docent'}</span>
                      </div>
                    </div>
                    {#if event.Inhoud}
                      <div class="w-10 h-10 md:w-14 md:h-14 rounded-full flex items-center justify-center bg-primary-500/10 text-primary-400 shrink-0 opacity-40 group-hover/event:opacity-100 transition-all border border-primary-500/20 group-hover/event:rotate-90 group-hover/event:scale-110 shadow-lg">
                        <svg class="w-5 h-5 md:w-7 md:h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M12 5v14M5 12h14"/></svg>
                      </div>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </section>

        <!-- Middle Section: Recent Grades -->
        <section in:fly={{ y: 30, delay: 200, duration: 800 }} class="space-y-6 md:space-y-10">
          <div class="flex items-center justify-between px-2">
            <h2 class="text-2xl md:text-3xl font-black text-white italic tracking-tighter flex items-center gap-3 md:gap-4">
              <div class="w-2 md:w-2.5 h-8 md:h-10 bg-accent-500 rounded-full shadow-[0_0_25px_rgba(200,100,255,0.7)]"></div>
              Resultaten
            </h2>
            <button 
              onclick={() => currentPage.set('grades')}
              class="text-[9px] md:text-[11px] font-black text-accent-400 hover:text-accent-300 uppercase tracking-widest md:tracking-[0.3em] transition-all hover:gap-3 md:hover:gap-4 flex items-center gap-2 md:gap-3 group/grades bg-accent-500/5 px-4 md:px-5 py-2 md:py-2.5 rounded-full border border-accent-500/10 hover:border-accent-500/30"
            >
              Alle cijfers <svg class="w-3.5 h-3.5 md:w-4 md:h-4 group-hover/grades:translate-x-1 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>
          
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-8">
            {#if loadingGrades}
               {#each Array(4) as _}
                 <div class="p-5 md:p-8 rounded-[2rem] sm:rounded-[3.5rem] glass animate-pulse border border-white/5 h-24 md:h-32 flex items-center gap-4 md:gap-6">
                    <div class="w-12 h-12 md:w-16 md:h-16 rounded-2xl md:rounded-3xl bg-surface-800"></div>
                    <div class="flex-1 space-y-2 md:space-y-3">
                       <div class="h-4 md:h-5 bg-surface-800 rounded-full w-2/3"></div>
                       <div class="h-3 md:h-4 bg-surface-800/50 rounded-full w-1/3"></div>
                    </div>
                 </div>
               {/each}
            {:else}
              {#each latestGrades as grade, i (grade.Id || i)}
                <button
                  onclick={() => currentPage.set('grades')}
                  in:scale={{ delay: i * 120, duration: 600, start: 0.9 }}
                  class="flex items-center justify-between p-5 md:p-8 rounded-[2rem] sm:rounded-[3.5rem] glass border border-white/5 hover:scale-[1.05] hover:border-accent-500/40 transition-all group/grade active:scale-95 shadow-2xl md:shadow-3xl relative overflow-hidden"
                >
                  <div class="absolute -right-6 -bottom-6 w-24 h-24 md:w-32 md:h-32 bg-accent-500/5 blur-3xl rounded-full group-hover:bg-accent-500/15 transition-all duration-700"></div>
                  <div class="flex items-center gap-4 md:gap-7 min-w-0 relative z-10 w-full pr-4">
                    <div class="w-12 h-12 md:w-16 md:h-16 rounded-xl md:rounded-[2rem] bg-surface-900 border border-surface-700/40 flex items-center justify-center text-primary-400 shrink-0 shadow-lg md:shadow-2xl group-hover/grade:border-accent-500/60 transition-all duration-700 group-hover/grade:bg-surface-800 group-hover/grade:rotate-12 group-hover/grade:scale-110">
                      {@html getSubjectIcon(grade.Vak?.Omschrijving ?? '')}
                    </div>
                    <div class="min-w-0 text-left flex-1">
                      <p class="text-lg md:text-xl font-black text-gray-100 truncate italic tracking-tighter uppercase leading-tight group-hover/grade:text-accent-400 transition-colors">{grade.Vak?.Omschrijving ?? 'Onbekend'}</p>
                      <p class="text-[9px] md:text-[10px] text-gray-500 font-black uppercase tracking-widest mt-1.5 md:mt-3 truncate group-hover/grade:text-gray-300 transition-colors bg-white/5 px-2 py-1 rounded inline-block">{formatDate(grade.DatumIngevoerd || '')}</p>
                    </div>
                  </div>
                  <div class="text-right shrink-0 relative z-10 pl-2">
                    <span class="text-4xl md:text-6xl font-extrabold italic tracking-tighter drop-shadow-2xl md:drop-shadow-3xl transition-transform group-hover/grade:scale-110 block {$userSettings.highlightFailing && !isVoldoende(grade) ? 'text-red-500' : 'text-transparent bg-clip-text bg-gradient-to-br from-accent-400 via-accent-300 to-accent-600 animate-gradient-y'}">
                      {grade.CijferStr}
                    </span>
                  </div>
                </button>
              {:else}
                <div class="sm:col-span-2 py-16 md:py-24 glass rounded-[3rem] md:rounded-[4rem] flex flex-col items-center justify-center text-center opacity-50 border-dashed border-2 border-white/10 shadow-inner" in:fade>
                   <p class="text-[11px] md:text-[13px] font-black text-gray-400 uppercase tracking-widest md:tracking-[0.4em] italic mb-2">Radiostilte...</p>
                </div>
              {/each}
            {/if}
          </div>
        </section>
      </div>

      <!-- Right Column: Assignments & Motivation -->
      <div class="lg:col-span-5 space-y-10 md:space-y-16">
        <section in:fly={{ x: 30, delay: 400, duration: 800 }} class="space-y-6 md:space-y-10">
          <h2 class="text-2xl md:text-3xl font-black text-white italic tracking-tighter flex items-center gap-3 md:gap-4 px-2">
            <div class="w-2 md:w-2.5 h-8 md:h-10 bg-red-500 rounded-full shadow-[0_0_25px_rgba(239,68,68,0.7)] animate-pulse"></div>
            Deadlines
          </h2>
          
          <div class="glass rounded-[2.5rem] md:rounded-[4rem] p-4 md:p-8 shadow-2xl md:shadow-3xl relative overflow-hidden group border-white/5 flex flex-col min-h-[350px] md:min-h-[450px]">
            <div class="absolute inset-0 bg-gradient-to-br from-red-500/10 via-transparent to-transparent opacity-40 group-hover:opacity-60 transition-opacity duration-700"></div>
            
            {#if loadingAssignments}
               <div class="space-y-4 md:space-y-6 relative z-10 w-full p-2 md:p-4">
                  {#each Array(3) as _}
                    <div class="p-6 md:p-8 rounded-[2rem] sm:rounded-[3rem] bg-surface-900/30 animate-pulse border border-white/10 h-24 md:h-32"></div>
                  {/each}
               </div>
            {:else if upcomingAssignments.length === 0}
              <div class="flex-1 flex flex-col items-center justify-center text-center opacity-70 py-16 md:py-24 px-4 md:px-8" in:fade>
                  <div class="w-24 h-24 md:w-36 md:h-36 rounded-[2.5rem] sm:rounded-[3.5rem] bg-surface-900/80 flex items-center justify-center mb-6 md:mb-10 text-gray-500 border border-white/10 shadow-2xl md:shadow-3xl group-hover:scale-110 transition-all duration-700 relative">
                      <div class="absolute inset-0 bg-emerald-500/5 blur-3xl rounded-full animate-pulse"></div>
                      <svg class="w-10 h-10 md:w-16 md:h-16 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  </div>
                  <p class="text-base md:text-lg font-black text-emerald-400/80 uppercase tracking-widest md:tracking-[0.4em] mb-4 italic">Helemaal Bij!</p>
              </div>
            {:else}
              <div class="space-y-4 md:space-y-6 mb-8 md:mb-12 relative z-10 p-1 md:p-2">
                {#each upcomingAssignments as assignment, i (assignment.Id || i)}
                  <button 
                    onclick={() => currentPage.set('assignments')}
                    in:fly={{ x: 30, delay: i * 150, duration: 600 }}
                    class="w-full p-5 md:p-8 rounded-[2rem] sm:rounded-[3rem] bg-surface-900/50 border border-white/5 group/assign transition-all hover:bg-surface-800/90 hover:border-red-500/40 text-left shadow-xl md:shadow-2xl overflow-hidden relative active:scale-95 hover:scale-[1.02] flex flex-col sm:flex-row justify-between sm:items-center gap-4 sm:gap-8"
                  >
                    <div class="absolute -right-3 -top-3 w-16 h-16 md:w-20 md:h-20 bg-red-500/10 blur-2xl rounded-full group-hover/assign:bg-red-500/20 transition-all duration-700"></div>
                    <div class="min-w-0 relative z-10">
                      <p class="text-lg md:text-xl font-black text-gray-100 truncate group-hover/assign:text-red-400 transition-colors uppercase tracking-tight italic leading-tight">{assignment.Titel}</p>
                      <p class="text-[9px] md:text-[11px] text-gray-500 font-black mt-2 md:mt-3.5 uppercase tracking-widest md:tracking-[0.25em] bg-red-500/5 px-2 py-1 rounded inline-block">{assignment.Vak ?? 'Algemeen'}</p>
                    </div>
                    <div class="align-self-start sm:align-self-auto shrink-0 px-3 md:px-5 py-2 md:py-3 rounded-xl sm:rounded-[1.5rem] bg-red-500/15 border border-red-500/30 text-[10px] md:text-[12px] font-black text-red-500 uppercase tracking-tighter shadow-xl group-hover/assign:scale-110 group-hover/assign:-rotate-2 transition-all relative z-10">
                      {new Date(assignment.InleverenVoor).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
            
            <button 
              onclick={() => currentPage.set('assignments')}
              class="w-full py-5 md:py-7 rounded-[2rem] sm:rounded-[3rem] bg-gradient-to-r from-primary-600 to-primary-400 text-white font-black text-[12px] md:text-[14px] uppercase tracking-widest md:tracking-[0.4em] shadow-2xl md:shadow-3xl shadow-primary-500/40 hover:scale-[1.03] hover:brightness-110 transition-all active:scale-95 border border-white/20 ring-[6px] md:ring-8 ring-primary-500/10 italic relative overflow-hidden group/btn mt-auto"
            >
              <div class="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover/btn:translate-x-[100%] transition-transform duration-1000 skew-x-12"></div>
              <span class="relative z-10 flex items-center justify-center gap-4">
                 Open Portaal <svg class="w-6 h-6 animate-bounce-horizontal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </span>
            </button>
          </div>
        </section>

        <!-- Motivation card -->
        <section in:fly={{ x: 30, delay: 600, duration: 800 }} class="glass rounded-[4rem] p-12 relative overflow-hidden bg-gradient-to-br from-primary-950/60 via-surface-950 to-accent-950/60 border-l-[6px] border-primary-500/50 shadow-3xl group">
           <div class="relative z-20 flex flex-col items-center justify-center text-center py-6">
              <div class="w-24 h-24 rounded-[2.5rem] bg-primary-500/20 flex items-center justify-center mb-10 group-hover:rotate-12 group-hover:scale-110 transition-all duration-700 shadow-3xl border border-primary-500/30 relative">
                  <div class="absolute inset-0 bg-primary-400/20 blur-2xl animate-pulse"></div>
                  <svg class="w-12 h-12 text-primary-400 relative z-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
              </div>
              <h3 class="text-4xl font-black text-white italic tracking-tighter uppercase mb-6 leading-none animate-float">Investeer in jezelf!</h3>
              <p class="text-[13px] text-primary-200/80 font-bold uppercase tracking-[0.35em] max-w-[320px] leading-loose italic opacity-90">
                Jouw inzet bepaalt de uitkomst. Maak er een legendarische dag van!
              </p>
           </div>
           <!-- Decorative layers for absolute premium feel -->
           <div class="absolute -top-32 -right-32 w-80 h-80 bg-primary-500/20 blur-[120px] rounded-full animate-pulse-slow"></div>
           <div class="absolute -bottom-32 -left-32 w-80 h-80 bg-accent-500/20 blur-[120px] rounded-full animate-pulse-slow-reverse"></div>
           <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-grid-white/[0.02] mask-radial-gradient"></div>
        </section>
      </div>
    </div>
  </main>
</div>

<style>
  /* Custom Animations & UI Extensions */
  
  @keyframes gradient-x {
    0%, 100% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
  }
  .animate-gradient-x {
    background-size: 200% 100%;
    animation: gradient-x 12s ease infinite;
  }

  @keyframes gradient-y {
    0%, 100% { background-position: 50% 0%; }
    50% { background-position: 50% 100%; }
  }
  .animate-gradient-y {
    background-size: 100% 200%;
    animation: gradient-y 8s ease infinite;
  }

  @keyframes header-pulse {
    0%, 100% { transform: scale(1); opacity: 0.05; }
    50% { transform: scale(1.1); opacity: 0.1; }
  }
  .animate-header-pulse {
    animation: header-pulse 10s ease-in-out infinite;
  }

  @keyframes pulse-slow {
    0%, 100% { transform: scale(1); opacity: 0.3; }
    50% { transform: scale(1.2); opacity: 0.5; }
  }
  .animate-pulse-slow {
    animation: pulse-slow 15s ease-in-out infinite;
  }

  @keyframes pulse-slow-reverse {
    0%, 100% { transform: scale(1.2); opacity: 0.5; }
    50% { transform: scale(1); opacity: 0.3; }
  }
  .animate-pulse-slow-reverse {
    animation: pulse-slow-reverse 15s ease-in-out infinite;
  }

  @keyframes bounce-horizontal {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(6px); }
  }
  .animate-bounce-horizontal {
    animation: bounce-horizontal 1.5s infinite;
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
  }
  .animate-float {
    animation: float 6s ease-in-out infinite;
  }

  .glass {
    background: color-mix(in oklch, var(--color-surface-900), transparent 40%);
    backdrop-filter: blur(40px) saturate(180%);
    -webkit-backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid color-mix(in oklch, white, transparent 94%);
    box-shadow: 
        0 30px 60px -12px rgba(0, 0, 0, 0.6),
        inset 0 1px 1px rgba(255, 255, 255, 0.05);
  }
  
  :global(body) {
    background-color: var(--color-surface-950);
    overflow-x: hidden;
  }

  .shadow-3xl {
    box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.7);
  }

  .bg-grid-white {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32' fill='none' stroke='white' stroke-opacity='1' %3E%3Cpath d='M0 .5H31.5V32' /%3E%3C/svg%3E");
  }

  .mask-radial-gradient {
    mask-image: radial-gradient(circle at center, black, transparent 80%);
  }
</style>
