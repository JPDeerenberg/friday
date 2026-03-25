<script lang="ts">
  import { personId, accountInfo, profilePicture, userSettings } from '$lib/stores';
  import { getCalendarEvents, getGrades, getSchoolyears, getMessageFolders, getAssignments, formatDate, infoTypeShort, getBulkGradeExtraInfo } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';

  let todayEvents = $state<any[]>([]);
  let latestGrades = $state<any[]>([]);
  let unreadCount = $state(0);
  let upcomingAssignments = $state<any[]>([]);
  let loading = $state(true);

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;

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

    } catch (e) {
      console.error('Dashboard load error:', e);
    }
    loading = false;
  });

  function getSubjectIcon(subject: string): string {
    const s = subject.toLowerCase();
    if (s.includes('wiskunde')) return '📐';
    if (s.includes('nederlands')) return '📚';
    if (s.includes('engels')) return '🇬🇧';
    if (s.includes('frans')) return '🇫🇷';
    if (s.includes('duits')) return '🇩🇪';
    if (s.includes('geschiedenis')) return '📜';
    if (s.includes('aardrijkskunde')) return '🌍';
    if (s.includes('natuurkunde')) return '⚛️';
    if (s.includes('scheikunde')) return '🧪';
    if (s.includes('biologie')) return '🌿';
    if (s.includes('economie')) return '💰';
    if (s.includes('gym') || s.includes('lo')) return '🏀';
    if (s.includes('tekenen') || s.includes('kunst')) return '🎨';
    if (s.includes('muziek')) return '🎵';
    return '📖';
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
      <div>
        <h1 class="text-2xl md:text-4xl font-black text-white tracking-tighter italic">
          Goeiedag, <span class="text-primary-500">{$accountInfo?.Persoon?.Roepnaam ?? 'Gebruiker'}</span>! 👋
        </h1>
        <p class="text-gray-500 text-xs md:text-sm font-bold uppercase tracking-[0.2em] mt-1">
          {new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      <div class="flex items-center gap-3">
        <div class="glass px-4 py-2 rounded-2xl flex items-center gap-2 border-primary-500/20">
          <span class="text-sm">✉️</span>
          <span class="text-xs font-black text-primary-400">{unreadCount} ongelezen</span>
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
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        <!-- Left Column: Schedule -->
        <div class="lg:col-span-7 space-y-6">
          <section class="glass rounded-3xl md:rounded-[2rem] p-5 md:p-8 border border-white/5 shadow-2xl relative overflow-hidden group">
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
              <div class="space-y-4">
                {#each todayEvents as event}
                  <div class="flex items-center gap-4 p-4 rounded-2xl bg-surface-900/40 border border-white/5 group/event transition-all hover:bg-surface-800/60">
                    <div class="flex flex-col items-center justify-center min-w-[60px] py-2 px-3 rounded-xl bg-surface-900 border border-surface-700/50">
                      <span class="text-xs font-black text-primary-400">{formatTime(event.Start)}</span>
                      <span class="text-[10px] font-bold text-gray-600 mt-0.5">{event.LesuurVan ? event.LesuurVan + 'e' : ''}</span>
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-black text-gray-100 truncate group-hover/event:text-primary-400 transition-colors uppercase tracking-tight">
                        {event.Vakken?.[0]?.Naam ?? event.Omschrijving ?? 'Afspraak'}
                      </p>
                      <div class="flex items-center gap-2 mt-1">
                        <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1.5 py-0.5 rounded bg-surface-800">{event.Lokalen?.[0]?.Naam ?? '??'}</span>
                        <span class="text-[10px] font-medium text-gray-600 truncate">{event.Docenten?.[0]?.Naam ?? ''}</span>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>

          <!-- Grades Section -->
          <section class="glass rounded-3xl md:rounded-[2rem] p-5 md:p-8 border border-white/5 shadow-2xl">
            <h2 class="text-xl font-bold text-gray-100 mb-8 flex items-center justify-between">
              Laatste Cijfers 📊
              <span class="text-[10px] font-black text-gray-600 uppercase tracking-widest">Top 5</span>
            </h2>
            
            {#each latestGrades as grade, i}
              <div
                class="flex items-center justify-between p-4 mb-4 last:mb-0 rounded-[1.5rem] bg-surface-900/40 border border-white/5 hover:bg-surface-800/60 transition-all group/grade"
              >
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-surface-900 border border-surface-700/50 flex items-center justify-center text-xl relative group-hover/grade:scale-110 transition-transform duration-500">
                    <span class="relative z-10">{getSubjectIcon(grade.Vak?.Omschrijving ?? '')}</span>
                  </div>
                  <div class="min-w-0">
                    <p class="text-sm font-black text-gray-100 truncate group-hover/grade:text-primary-400 transition-colors">
                      {grade.Vak?.Omschrijving ?? 'Onbekend'}
                    </p>
                    <p class="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-0.5 truncate max-w-[120px]">
                      {grade.CijferKolom?.KolomNaam ?? 'Toets'}
                    </p>
                  </div>
                </div>
                
                <div class="text-right">
                  <div class="text-2xl font-black italic tracking-tighter {$userSettings.highlightFailing && !isVoldoende(grade) ? 'text-red-500' : 'text-accent-400'} drop-shadow-sm">
                    {grade.CijferStr}
                  </div>
                  {#if grade.Weging}
                    <div class="text-[9px] font-black text-gray-600 uppercase tracking-widest mt-0.5">
                      ×{grade.Weging}
                    </div>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="py-12 flex flex-col items-center justify-center text-center opacity-40">
                <span class="text-4xl mb-3">📈</span>
                <p class="text-sm font-bold text-gray-400 uppercase tracking-widest">Geen recente cijfers</p>
              </div>
            {/each}
          </section>
        </div>

        <!-- Right Column: Assignments -->
        <div class="lg:col-span-5">
          <section class="glass rounded-3xl md:rounded-[2rem] p-5 md:p-8 border border-white/5 shadow-xl sticky top-28">
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
              <div class="py-12 flex flex-col items-center justify-center text-center opacity-40">
                <span class="text-4xl mb-3">✅</span>
                <p class="text-sm font-bold text-gray-400 uppercase tracking-widest">Alles ingeleverd!</p>
              </div>
            {/each}
            
            <button class="w-full mt-6 py-4 rounded-2xl bg-primary-600 text-white font-black text-xs uppercase tracking-[0.2em] shadow-lg shadow-primary-500/20 hover:bg-primary-500 transition-all active:scale-95">
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
    background: rgba(30, 41, 59, 0.4);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
</style>
