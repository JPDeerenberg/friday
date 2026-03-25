<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { getSchoolyears, getGrades, formatDate, getBulkGradeExtraInfo } from '$lib/api';
  import { onMount } from 'svelte';

  let schoolyears = $state<any[]>([]);
  let selectedYear = $state<any>(null);
  let grades = $state<any[]>([]);
  let loading = $state(true);
  let selectedSubject = $state<string | null>(null);
  let currentTab = $state<'vakken' | 'recent' | 'totaal'>('vakken');

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;

    try {
      schoolyears = await getSchoolyears(pid, '2013-01-01', formatDate(new Date()));
      if (schoolyears.length > 0) {
        // Auto-select current year based on date
        const now = new Date();
        const currentYear = schoolyears.find(y => {
          if (!y.begin || !y.einde) return false;
          return new Date(y.begin) <= now && new Date(y.einde) >= now;
        });
        
        selectedYear = currentYear || schoolyears[schoolyears.length - 1];
        await loadGrades();
      }
    } catch (e) {
      console.error('Error loading schoolyears:', e);
    }
    loading = false;
  });

  async function loadGrades() {
    if (!selectedYear?.id || !$personId) return;
    loading = true;
    try {
      const fetchedGrades = await getGrades($personId, selectedYear.id, selectedYear.einde);
      
      // Fetch weights in bulk for all relevant columns
      const relevantColumns = [...new Set(fetchedGrades
        .filter(g => g.CijferKolom?.KolomSoort === 1)
        .map(g => g.CijferKolom.Id))];

      if (relevantColumns.length > 0) {
        try {
          const weightsMap = await getBulkGradeExtraInfo($personId, selectedYear.id, relevantColumns);
          // Apply weights to grades
          grades = fetchedGrades.map(g => {
            const extra = weightsMap[g.CijferKolom.Id];
            if (extra) {
                return { ...g, Weging: extra.Weging, description: extra.WerkInformatieOmschrijving || extra.KolomOmschrijving };
            }
            return g;
          });
        } catch (e) {
          console.error('Error loading weights:', e);
          grades = fetchedGrades;
        }
      } else {
        grades = fetchedGrades;
      }
    } catch (e) {
      console.error('Error loading grades:', e);
    }
    loading = false;
  }

  function getSubjects(): { name: string; abbr: string; grades: any[]; avg: number }[] {
    const subjectMap = new Map<string, any[]>();
    for (const grade of grades) {
      if (!grade.Vak || grade.CijferKolom.KolomSoort !== 1) continue;
      const key = grade.Vak.Omschrijving;
      if (!subjectMap.has(key)) subjectMap.set(key, []);
      subjectMap.get(key)!.push(grade);
    }

    return Array.from(subjectMap.entries())
      .map(([name, subGrades]) => {
        let totalPoints = 0;
        let totalWeight = 0;
        const validGrades: { value: number; weight: number }[] = [];

        subGrades
          .filter(g => g.CijferStr && g.TeltMee)
          .forEach(g => {
            const val = parseFloat(g.CijferStr.replace(',', '.'));
            const w = typeof g.Weging === 'number' ? g.Weging : 1;
            if (!isNaN(val)) {
              totalPoints += val * w;
              totalWeight += w;
              validGrades.push({ value: val, weight: w });
            }
          });

        const avg = totalWeight > 0 ? totalPoints / totalWeight : 0;

        return {
          name,
          abbr: subGrades[0]?.Vak?.Afkorting ?? '',
          grades: subGrades.sort((a: any, b: any) =>
            (b.DatumIngevoerd ?? '').localeCompare(a.DatumIngevoerd ?? '')
          ),
          validGrades,
          totalPoints,
          totalWeight,
          avg,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function formatDateShort(iso: string): string {
    return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async function selectYear(year: any) {
    selectedYear = year;
    selectedSubject = null;
    await loadGrades();
  }

  function getRecentGrades() {
    return [...grades]
      .filter(g => g.CijferStr && g.DatumIngevoerd && g.CijferKolom?.KolomSoort === 1)
      .sort((a, b) => b.DatumIngevoerd.localeCompare(a.DatumIngevoerd));
  }

  function getNumericValue(str: string): number {
    return parseFloat(str.replace(',', '.'));
  }

  function isVoldoende(grade: any): boolean {
    const val = typeof grade === 'number' ? grade : getNumericValue(grade.CijferStr);
    return val >= $userSettings.insufficientThreshold;
  }

  function getTrendPath(subject: any): string {
    const chronoGrades = [...subject.grades]
      .filter(g => g.CijferStr && g.TeltMee && !isNaN(getNumericValue(g.CijferStr)))
      .sort((a, b) => (a.DatumIngevoerd ?? '').localeCompare(b.DatumIngevoerd ?? ''))
      .map(g => getNumericValue(g.CijferStr));

    if (chronoGrades.length < 2) return '';

    const w = 100;
    const h = 40;
    
    // Zoom logic
    let minY = 1;
    let maxY = 10;
    if ($userSettings.zoomGraph) {
      minY = Math.max(1, Math.min(...chronoGrades) - 0.5);
      maxY = Math.min(10, Math.max(...chronoGrades) + 0.5);
    }
    
    const points = chronoGrades.map((g, i) => {
      const x = (i / (chronoGrades.length - 1)) * w;
      const y = h - ((g - minY) / (maxY - minY)) * h;
      return { x, y };
    });

    if ($userSettings.roundedGraphs) {
      // Create a smooth cubic bezier path
      let d = `M ${points[0].x},${points[0].y}`;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i];
        const p1 = points[i + 1];
        const cp1x = p0.x + (p1.x - p0.x) / 2;
        d += ` C ${cp1x},${p0.y} ${cp1x},${p1.y} ${p1.x},${p1.y}`;
      }
      return d;
    } else {
      return `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`;
    }
  }

  function getGlobalGrades() {
    return [...grades]
      .filter(g => g.CijferStr && g.DatumIngevoerd && g.CijferKolom?.KolomSoort === 1 && !isNaN(getNumericValue(g.CijferStr)))
      .sort((a, b) => a.DatumIngevoerd.localeCompare(b.DatumIngevoerd));
  }

  function getGlobalTrendPath() {
    const sorted = getGlobalGrades().map(g => getNumericValue(g.CijferStr));
    if (sorted.length < 2) return '';

    const w = 1000;
    const h = 300;
    
    let minY = 1;
    let maxY = 10;
    if ($userSettings.zoomGraph) {
      minY = Math.max(1, Math.min(...sorted) - 0.5);
      maxY = Math.min(10, Math.max(...sorted) + 0.5);
    }

    const points = sorted.map((g, i) => {
      const x = (i / (sorted.length - 1)) * w;
      const y = h - ((g - minY) / (maxY - minY)) * h;
      return { x, y };
    });

    let d = `M ${points[0].x},${points[0].y}`;
    if ($userSettings.roundedGraphs) {
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i];
        const p1 = points[i + 1];
        const cp1x = p0.x + (p1.x - p0.x) / 0.5; // less aggressive smoothing for many points
        const cp1x_correct = p0.x + (p1.x - p0.x) / 2;
        d += ` C ${cp1x_correct},${p0.y} ${cp1x_correct},${p1.y} ${p1.x},${p1.y}`;
      }
    } else {
      d = `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`;
    }
    return d;
  }

  let calcTargetAvg = $state(5.5);
  let calcWeight = $state(1);

  function getRequiredGrade(subject: any): string {
    if (subject.totalWeight === 0) return '?';
    const required = (calcTargetAvg * (subject.totalWeight + calcWeight) - subject.totalPoints) / calcWeight;
    if (required > 10) return 'Onmogelijk (>10)';
    if (required < 1) return '1.0';
    return required.toFixed($userSettings.decimalPoints);
  }
</script>

<div class="flex flex-col bg-surface-950">
  <!-- Sticky Header -->
  <div class="sticky top-0 z-10 bg-surface-950/95 backdrop-blur border-b border-surface-800/50 px-4 py-3 pb-4">
    <div class="flex items-center justify-between mb-3">
      <h1 class="text-xl font-bold text-gray-100">Cijfers</h1>
      <div class="flex items-center gap-2 overflow-x-auto no-scrollbar max-w-[200px] justify-end">
        {#each schoolyears as year}
          <button
            onclick={() => selectYear(year)}
            class="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider shrink-0
                   {selectedYear?.id === year.id
                     ? 'bg-primary-500 text-white'
                     : 'bg-surface-800 text-gray-400 hover:bg-surface-700'}"
          >
            {year.groep?.code ?? year.studie?.code ?? '?'}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <div class="p-4 md:p-6 max-w-5xl mx-auto w-full">

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else}
    <!-- Tabs -->
    <div class="flex gap-4 border-b border-surface-700/50 mb-6 px-2">
      <button 
        onclick={() => currentTab = 'vakken'}
        class="pb-2 text-sm font-medium transition-all {currentTab === 'vakken' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-gray-500 hover:text-gray-300'}"
      >
        Per Vak
      </button>
      <button 
        onclick={() => currentTab = 'totaal'}
        class="pb-2 text-sm font-medium transition-all {currentTab === 'totaal' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-gray-500 hover:text-gray-300'}"
      >
        Totaal
      </button>
      <button 
        onclick={() => currentTab = 'recent'}
        class="pb-2 text-sm font-medium transition-all {currentTab === 'recent' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-gray-500 hover:text-gray-300'}"
      >
        Recent
      </button>
    </div>

    {@const subjects = getSubjects()}

    {#if grades.length === 0}
      <div class="glass rounded-2xl p-5 md:p-8 text-center">
        <p class="text-gray-500">Geen cijfers gevonden</p>
      </div>
    {:else if currentTab === 'vakken'}
      <!-- Subject cards -->
      <div class="space-y-3">
        {#each subjects as subject}
          <div class="glass rounded-2xl overflow-hidden">
            <button
              onclick={() => selectedSubject = selectedSubject === subject.name ? null : subject.name}
              class="w-full flex items-center justify-between p-4 hover:bg-surface-800/30"
            >
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-primary-500/15 flex items-center justify-center text-primary-400 font-bold text-xs shrink-0">
                  {subject.abbr.toUpperCase().slice(0, 3)}
                </div>
                <div class="text-left">
                  <p class="text-sm font-semibold text-gray-200">{subject.name}</p>
                  <p class="text-xs text-gray-500">{subject.grades.length} cijfer{subject.grades.length !== 1 ? 's' : ''}</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                {#if getTrendPath(subject)}
                  <div class="w-16 h-8 text-surface-600 hidden sm:block">
                    <svg viewBox="0 0 100 40" class="w-full h-full overflow-visible" preserveAspectRatio="none">
                      <path d={getTrendPath(subject)} fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </div>
                {/if}
                {#if subject.avg > 0}
                  <span class="text-xl font-bold {isVoldoende(subject.avg) ? 'text-accent-400' : 'text-red-400'}">
                    {subject.avg.toFixed($userSettings.decimalPoints)}
                  </span>
                {/if}
                <span class="text-gray-600 text-sm">{selectedSubject === subject.name ? '▲' : '▼'}</span>
              </div>
            </button>

            {#if selectedSubject === subject.name}
              <div class="border-t border-surface-700/50 p-4 space-y-2 relative">
                {#each subject.grades as grade}
                  <div class="flex items-center justify-between p-3 rounded-xl bg-surface-800/50">
                    <div class="min-w-0">
                      <p class="text-sm text-gray-300">
                        {grade.CijferKolom?.KolomOmschrijving ?? grade.CijferKolom?.KolomNaam ?? 'Cijfer'}
                      </p>
                      <div class="flex items-center gap-2 mt-0.5">
                        {#if grade.DatumIngevoerd}
                          <span class="text-xs text-gray-600">{formatDateShort(grade.DatumIngevoerd)}</span>
                        {/if}
                        {#if grade.Docent}
                          <span class="text-xs text-gray-600">• {grade.Docent}</span>
                        {/if}
                        {#if grade.Weging}
                          <span class="text-xs text-gray-500">× {grade.Weging}</span>
                        {/if}
                      </div>
                    </div>
                    <span class="text-lg font-bold ml-3 {isVoldoende(grade) ? 'text-accent-400' : 'text-red-400'}">
                      {grade.CijferStr}
                    </span>
                  </div>
                {/each}

                <!-- Grade Calculator -->
                <div class="mt-4 pt-4 border-t border-surface-700/50 bg-surface-900/30 -mx-4 -mb-4 p-4">
                  <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Doelcijfer Berekenen</h3>
                  <div class="flex flex-col sm:flex-row sm:items-end gap-4">
                    <div class="flex-1">
                      <label class="block text-xs text-gray-500 mb-1" for="calc_target_{subject.name}">Gewenst Gemiddelde</label>
                      <input id="calc_target_{subject.name}" type="number" step="0.1" min="1" max="10" bind:value={calcTargetAvg} class="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors" />
                    </div>
                    <div class="flex-1">
                      <label class="block text-xs text-gray-500 mb-1" for="calc_weight_{subject.name}">Weging nieuwe toets</label>
                      <input id="calc_weight_{subject.name}" type="number" step="1" min="1" bind:value={calcWeight} class="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500 transition-colors" />
                    </div>
                    <div class="flex-1 bg-surface-800/80 border border-surface-700 rounded-lg p-2.5 flex items-center justify-between">
                      <span class="text-xs text-gray-400">Te halen:</span>
                      <span class="text-base font-bold text-gray-100">{getRequiredGrade(subject)}</span>
                    </div>
                  </div>
                </div>

              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if currentTab === 'totaal'}
        <div class="glass rounded-3xl md:rounded-[2rem] p-5 md:p-8 space-y-8">
            <div class="flex items-center justify-between">
                <div>
                    <h2 class="text-xl font-bold text-gray-100">Algemene Voortgang</h2>
                    <p class="text-xs text-gray-500 mt-1 uppercase tracking-widest font-bold">Chronologische trendlijn van al je cijfers</p>
                </div>
                <div class="text-right">
                    <p class="text-3xl font-black text-primary-400">
                        { (subjects.reduce((a, b) => a + b.avg, 0) / (subjects.filter(s => s.avg > 0).length || 1)).toFixed($userSettings.decimalPoints) }
                    </p>
                    <p class="text-[10px] text-gray-500 font-bold uppercase tracking-tighter mt-1">Gemiddelde overal</p>
                </div>
            </div>

            <div class="relative h-[300px] w-full bg-surface-900/30 rounded-3xl border border-white/5 overflow-hidden p-4">
                <!-- Grid Lines -->
                <div class="absolute inset-0 flex flex-col justify-between p-4 opacity-5">
                    {#each Array(5) as _}
                        <div class="w-full h-px bg-white"></div>
                    {/each}
                </div>

                <svg viewBox="0 0 1000 300" class="w-full h-full overflow-visible" preserveAspectRatio="none">
                    {#if getGlobalTrendPath()}
                        <!-- Gradient Fill -->
                        <defs>
                            <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" style="stop-color:rgb(var(--primary-500-rgb));stop-opacity:0.2" />
                                <stop offset="100%" style="stop-color:rgb(var(--primary-500-rgb));stop-opacity:0" />
                            </linearGradient>
                        </defs>
                        <path d="{getGlobalTrendPath()} L 1000 300 L 0 300 Z" fill="url(#grad)" />
                        
                        <!-- Main Line -->
                        <path 
                            d={getGlobalTrendPath()} 
                            fill="none" 
                            stroke="currentColor" 
                            stroke-width="4" 
                            class="text-primary-400 drop-shadow-[0_0_8px_rgba(var(--primary-500-rgb),0.5)]"
                            vector-effect="non-scaling-stroke" 
                            stroke-linecap="round" 
                            stroke-linejoin="round" 
                        />
                    {/if}
                </svg>

                <!-- Indicator for threshold if not zoomed? Or just a line -->
                {#if !$userSettings.zoomGraph}
                    <div class="absolute w-full border-t border-dashed border-red-500/30 z-0" style="bottom: { ($userSettings.insufficientThreshold - 1) / 9 * 100 }%">
                        <span class="absolute right-2 -top-4 text-[9px] font-black text-red-500/50 uppercase">Grens ({$userSettings.insufficientThreshold})</span>
                    </div>
                {/if}
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
               <div class="p-4 rounded-2xl bg-surface-800/40 border border-white/5">
                   <p class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Totaal</p>
                   <p class="text-xl font-bold text-gray-100 mt-1">{getGlobalGrades().length}</p>
               </div>
               <div class="p-4 rounded-2xl bg-surface-800/40 border border-white/5">
                   <p class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Voldoendes</p>
                   <p class="text-xl font-bold text-accent-400 mt-1">{getGlobalGrades().filter(g => isVoldoende(g)).length}</p>
               </div>
               <div class="p-4 rounded-2xl bg-surface-800/40 border border-white/5">
                   <p class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Onvoldoendes</p>
                   <p class="text-xl font-bold text-red-400 mt-1">{getGlobalGrades().filter(g => !isVoldoende(g)).length}</p>
               </div>
               <div class="p-4 rounded-2xl bg-surface-800/40 border border-white/5">
                   <p class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Hoogste</p>
                   <p class="text-xl font-bold text-gray-100 mt-1">{ Math.max(...getGlobalGrades().map(g => getNumericValue(g.CijferStr))).toFixed(1) }</p>
               </div>
            </div>

            <!-- Detailed List -->
            <div class="mt-8 space-y-2">
                <h3 class="text-[9px] font-black text-gray-500 uppercase tracking-[0.2em] px-2 mb-4">Volledige Geschiedenis</h3>
                {#each getGlobalGrades().reverse() as grade}
                    {@const d = new Date(grade.DatumIngevoerd)}
                    <div class="flex items-center justify-between p-3 rounded-2xl bg-surface-800/30 border border-white/5 hover:bg-surface-800/50 transition-colors group">
                        <div class="flex items-center gap-4 min-w-0">
                            <div class="w-10 h-10 rounded-xl bg-surface-900 flex flex-col items-center justify-center shrink-0 border border-white/5">
                                <span class="text-[8px] text-gray-500 font-bold uppercase">{d.toLocaleDateString('nl-NL', { month: 'short' })}</span>
                                <span class="text-sm font-black text-gray-300">{d.getDate()}</span>
                            </div>
                            <div class="min-w-0">
                                <p class="text-xs font-bold text-gray-200 truncate">{grade.Vak?.Omschrijving ?? 'Onbekend'}</p>
                                <p class="text-[10px] text-gray-500 truncate">{grade.CijferKolom?.KolomOmschrijving ?? 'Cijfer'}</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-4 shrink-0">
                            {#if grade.Weging}
                                <span class="text-[9px] font-black text-gray-600 uppercase bg-surface-900 px-1.5 py-0.5 rounded-lg border border-white/5 opacity-0 group-hover:opacity-100 transition-opacity">×{grade.Weging}</span>
                            {/if}
                            <span class="text-base font-black {isVoldoende(grade) ? 'text-accent-400' : 'text-red-400'}">
                                {grade.CijferStr}
                            </span>
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    {:else if currentTab === 'recent'}
      <!-- Chronological Recent Grades -->
      <div class="space-y-3">
        {#each getRecentGrades() as grade}
          {@const d = new Date(grade.DatumIngevoerd)}
          <div class="glass flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-2xl gap-3 transition-colors hover:bg-surface-800/30">
            <div class="flex items-center gap-4 min-w-0">
              <div class="w-12 h-12 rounded-xl bg-surface-800 border border-surface-700/50 flex flex-col items-center justify-center shrink-0">
                <span class="text-xs text-gray-400 font-medium uppercase leading-tight">{d.toLocaleDateString('nl-NL', { month: 'short' })}</span>
                <span class="text-lg font-bold text-gray-200 leading-tight">{d.getDate()}</span>
              </div>
              <div class="min-w-0">
                <p class="text-sm font-semibold text-gray-200 truncate">{grade.Vak?.Omschrijving ?? 'Onbekend Vak'}</p>
                <p class="text-sm text-gray-400 truncate">{grade.CijferKolom?.KolomOmschrijving ?? grade.CijferKolom?.KolomNaam ?? 'Cijfer'}</p>
                <div class="flex items-center gap-2 mt-1">
                  {#if grade.Docent}
                    <span class="text-xs text-gray-500">{grade.Docent}</span>
                  {/if}
                  {#if grade.Weging && grade.CijferKolom?.KolomSoort === 1}
                     <span class="text-[9px] font-black text-gray-600 uppercase bg-surface-800/50 px-1.5 py-0.5 rounded-lg border border-white/5">×{grade.Weging}</span>
                  {/if}
                </div>
              </div>
            </div>
            
            <div class="flex items-center sm:justify-end shrink-0 pl-16 sm:pl-0">
              <span class="text-2xl font-bold {isVoldoende(grade) ? 'text-accent-400' : 'text-red-400'}">
                {grade.CijferStr}
              </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
