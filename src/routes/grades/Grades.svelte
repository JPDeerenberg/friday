<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { getSchoolyears, getGrades, formatDate, getBulkGradeExtraInfo, formatTeacherName } from '$lib/api';
  import { onMount } from 'svelte';

  let schoolyears = $state<any[]>([]);
  let selectedYear = $state<any>(null);
  let grades = $state<any[]>([]);
  let subjects = $state<any[]>([]);
  let snapshots = $state<{ id: string; date: string; name: string; subjects: any[] }[]>([]);
  let showSnapshots = $state(false);
  let loading = $state(true);
  let selectedSubject = $state<string | null>(null);
  let currentTab = $state<'vakken' | 'recent' | 'tools'>('vakken');
  let activeSnapshot = $state<any | null>(null);

  function getChronologicalGrades() {
    return subjects.flatMap((s: any) => s.grades.map((g: any) => ({ ...g, subAbbr: s.abbr, subName: s.name })))
      .filter((g: any) => g.CijferStr && g.DatumIngevoerd && !isNaN(getNumericValue(g.CijferStr)))
      .sort((a: any, b: any) => a.DatumIngevoerd.localeCompare(b.DatumIngevoerd));
  }

  function getOverallTrendPath() {
    const chrono = getChronologicalGrades();
    if (chrono.length < 2) return '';
    const points = chrono.map((g, i) => ({
      x: (i / (chrono.length - 1)) * 300,
      y: 100 - ((getNumericValue(g.CijferStr) - 1) / 9) * 100
    }));

    let d = `M ${points[0].x},${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const cp1x = p0.x + (p1.x - p0.x) / 2;
      d += ` C ${cp1x},${p0.y} ${cp1x},${p1.y} ${p1.x},${p1.y}`;
    }
    return d;
  }

  onMount(async () => {
    // Load cache
    const cached = localStorage.getItem('grades_cache');
    if (cached) {
      const data = JSON.parse(cached);
      schoolyears = data.schoolyears;
      subjects = data.subjects;
    }
    
    // Load snapshots
    const savedSnapshots = localStorage.getItem('grade_snapshots');
    if (savedSnapshots) {
      snapshots = JSON.parse(savedSnapshots);
    }

    const pid = $personId;
    if (!pid) return;

    try {
      schoolyears = await getSchoolyears(pid, '2013-01-01', formatDate(new Date()));

      if (schoolyears.length > 0) {
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
      
      const relevantColumns = [...new Set(fetchedGrades
        .filter(g => g.CijferKolom?.KolomSoort === 1)
        .map(g => g.CijferKolom.Id))];

      if (relevantColumns.length > 0) {
        try {
          const weightsMap = await getBulkGradeExtraInfo($personId, selectedYear.id, relevantColumns);
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
      
      subjects = getSubjects();
      localStorage.setItem('grades_cache', JSON.stringify({ schoolyears, subjects }));
    } catch (e) {
      console.error('Error loading grades:', e);
    }
    loading = false;
  }

  function createSnapshot() {
    const name = prompt('Geef deze snapshot een naam:', `Snapshot ${new Date().toLocaleDateString()}`);
    if (!name) return;
    
    const newSnapshot = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      name,
      subjects: JSON.parse(JSON.stringify(subjects))
    };
    
    snapshots = [newSnapshot, ...snapshots];
    localStorage.setItem('grade_snapshots', JSON.stringify(snapshots));
  }

  function deleteSnapshot(id: string) {
    snapshots = snapshots.filter(s => s.id !== id);
    localStorage.setItem('grade_snapshots', JSON.stringify(snapshots));
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

  function viewSnapshot(snapshot: any) {
    subjects = snapshot.subjects;
    activeSnapshot = snapshot;
    currentTab = 'vakken';
  }

  function returnToLiveData() {
    activeSnapshot = null;
    loadGrades();
  }

  let calcSubjectName = $state('');
  let calcTargetAvg = $state(5.5);
  let calcWeight = $state(1);
  let simulationGrades = $state<{ value: number; weight: number }[]>([]);

  function addSimulationGrade() {
    simulationGrades = [...simulationGrades, { value: 5.5, weight: 1 }];
  }

  function removeSimulationGrade(index: number) {
    simulationGrades = simulationGrades.filter((_, i) => i !== index);
  }

  function getRequiredGrade(subject: any): string {
    if (subject.totalWeight === 0) return '?';
    
    let simulatedPoints = 0;
    let simulatedWeight = 0;
    for (const g of simulationGrades) {
      simulatedPoints += g.value * g.weight;
      simulatedWeight += g.weight;
    }

    const currentPoints = subject.totalPoints + simulatedPoints;
    const currentWeight = subject.totalWeight + simulatedWeight;
    
    const required = (calcTargetAvg * (currentWeight + calcWeight) - currentPoints) / calcWeight;
    if (required > 10) return 'Onmogelijk (>10)';
    if (required < 1) return '1.0';
    return required.toFixed($userSettings.decimalPoints);
  }

  function getPredictedAverage(subject: any): string {
    let simulatedPoints = 0;
    let simulatedWeight = 0;
    for (const g of simulationGrades) {
      simulatedPoints += g.value * g.weight;
      simulatedWeight += g.weight;
    }
    const totalP = (subject.totalPoints || 0) + simulatedPoints;
    const totalW = (subject.totalWeight || 0) + simulatedWeight;
    return totalW > 0 ? (totalP / totalW).toFixed($userSettings.decimalPoints) : '0';
  }
</script>

<div class="flex flex-col bg-surface-950">
  <!-- Sticky Header -->
  <div class="sticky top-0 z-10 bg-surface-950/95 backdrop-blur border-b border-surface-800/50 px-4 py-3 pb-4">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-100 italic tracking-tighter">Cijfers</h1>
        <button 
          onclick={() => selectYear(selectedYear)} 
          aria-label="Vernieuwen"
          class="p-2 text-gray-500 hover:text-primary-400 transition-all hover:scale-110 active:scale-95"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
      <div class="flex items-center gap-2 overflow-x-auto no-scrollbar max-w-[200px] justify-end">
        {#each schoolyears as year}
          <button
            onclick={() => selectYear(year)}
            class="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider shrink-0
                   {selectedYear?.id === year.id
                     ? 'bg-primary-500 text-on-primary shadow-lg shadow-primary-500/20'
                     : 'bg-surface-800 text-gray-400 hover:bg-surface-700'}"
          >
            {year.groep?.code ?? year.studie?.code ?? '?'}
          </button>
        {/each}
      </div>
    </div>


    <!-- Tabs -->
    <div class="flex items-center gap-1 bg-surface-900 p-1 rounded-2xl border border-white/5">
      <button
        onclick={() => currentTab = 'vakken'}
        class="flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all
               {currentTab === 'vakken' ? 'bg-primary-500 text-on-primary shadow-lg shadow-primary-500/20' : 'text-gray-500 hover:text-gray-300'}"
      >
        Vakken
      </button>
      <button
        onclick={() => currentTab = 'recent'}
        class="flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all
               {currentTab === 'recent' ? 'bg-primary-500 text-on-primary shadow-lg shadow-primary-500/20' : 'text-gray-500 hover:text-gray-300'}"
      >
        Recent
      </button>
      <button
        onclick={() => currentTab = 'tools'}
        class="flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all
               {currentTab === 'tools' ? 'bg-primary-500 text-on-primary shadow-lg shadow-primary-500/20' : 'text-gray-500 hover:text-gray-300'}"
      >
        Tools
      </button>
    </div>
  </div>

  <main class="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
    {#if activeSnapshot}
      <div class="bg-amber-500/10 border border-amber-500/30 rounded-3xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 rounded-2xl bg-amber-500/20 flex items-center justify-center text-amber-500 text-2xl">📸</div>
          <div>
            <p class="text-xs font-black text-amber-500 uppercase tracking-widest">Snapshot Actief</p>
            <h3 class="text-lg font-black text-white italic tracking-tight">{activeSnapshot.name}</h3>
            <p class="text-[10px] text-gray-400 font-bold uppercase tracking-tight">{new Date(activeSnapshot.date).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' })}</p>
          </div>
        </div>
        <button onclick={returnToLiveData} class="px-6 py-2.5 rounded-2xl bg-amber-500 text-on-primary text-xs font-black uppercase tracking-widest shadow-lg shadow-amber-500/20 active:scale-95 transition-all">
          Terug naar Live
        </button>
      </div>
    {/if}

    {#if loading}
      <div class="flex items-center justify-center py-20">
        <div class="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    {:else}
      {#if currentTab === 'vakken'}
        <!-- Overview Chronological Graph -->
        {#if subjects.length > 0}
          {@const path = getOverallTrendPath()}
          <div class="glass p-6 rounded-[2.5rem] space-y-4 overflow-hidden relative shadow-2xl">
            <div class="absolute inset-0 bg-gradient-to-br from-primary-500/10 via-transparent to-accent-500/5"></div>
            <div class="flex items-center justify-between relative z-10">
              <div>
                <h2 class="text-xl font-black text-white italic tracking-tight">Cijferverloop</h2>
                <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-0.5">Chronologisch overzicht alle vakken</p>
              </div>
              <div class="flex flex-col items-end">
                <span class="text-2xl font-black text-primary-400 italic">{(subjects.reduce((a, b) => a + (b.avg || 0), 0) / subjects.length || 0).toFixed(2)}</span>
                <span class="text-[9px] font-black text-gray-600 uppercase tracking-tighter">Totaal Gemiddelde</span>
              </div>
            </div>
            
            <div class="h-40 w-full relative z-10 mt-2">
              <svg viewBox="0 0 300 100" class="w-full h-full overflow-visible" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:rgb(var(--color-primary-500));stop-opacity:0.2" />
                    <stop offset="100%" style="stop-color:rgb(var(--color-primary-500));stop-opacity:0" />
                  </linearGradient>
                </defs>
                {#if path}
                  <path d="{path} L 300,100 L 0,100 Z" fill="url(#grad)" />
                  <path d={path} fill="none" stroke="currentColor" stroke-width="3" class="text-primary-500" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
                  
                  <!-- Dots for last few grades -->
                  {#each getChronologicalGrades().slice(-5) as g, i}
                     {@const chrono = getChronologicalGrades()}
                     {@const idx = chrono.length - 5 + i}
                     {@const x = (idx / (chrono.length - 1)) * 300}
                     {@const y = 100 - ((getNumericValue(g.CijferStr) - 1) / 9) * 100}
                     <circle cx={x} cy={y} r="3" class="fill-white stroke-primary-500 stroke-2 shadow-lg" />
                  {/each}
                {/if}
              </svg>
            </div>
          </div>
        {/if}

        <div class="space-y-3">
          {#each subjects as subject}
            <div class="glass rounded-2xl overflow-hidden">
              <button
                onclick={() => selectedSubject = selectedSubject === subject.name ? null : subject.name}
                class="w-full flex items-center justify-between p-4 hover:bg-surface-800/30 text-left"
              >
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl bg-primary-500/15 flex items-center justify-center text-primary-400 font-bold text-xs shrink-0">
                    {subject.abbr.toUpperCase().slice(0, 3)}
                  </div>
                  <div>
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
                    <span class="text-xl font-bold {isVoldoende(subject.avg) ? 'text-accent-500' : 'text-red-400'}">
                      {subject.avg.toFixed($userSettings.decimalPoints)}
                    </span>
                  {/if}
                  <span class="text-gray-600 text-sm">{selectedSubject === subject.name ? '▲' : '▼'}</span>
                </div>
              </button>

              {#if selectedSubject === subject.name}
                <div class="border-t border-surface-700/50 p-4 space-y-2">
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
                            <span class="text-xs text-gray-600">• {formatTeacherName(grade.Docent)}</span>
                          {/if}
                          {#if grade.Weging}
                            <span class="text-xs text-gray-500">× {grade.Weging}</span>
                          {/if}
                        </div>
                      </div>
                      <span class="text-lg font-bold ml-3 {isVoldoende(grade) ? 'text-primary-500' : 'text-red-400'}">
                        {grade.CijferStr}
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else if currentTab === 'recent'}
        <div class="space-y-3">
          {#each getRecentGrades() as grade}
            {@const d = new Date(grade.DatumIngevoerd)}
            <div class="glass flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-2xl gap-3">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-xl bg-surface-800 border border-surface-700/50 flex flex-col items-center justify-center shrink-0">
                  <span class="text-xs text-gray-400 font-medium uppercase leading-tight">{d.toLocaleDateString('nl-NL', { month: 'short' })}</span>
                  <span class="text-lg font-bold text-gray-200 leading-tight">{d.getDate()}</span>
                </div>
                <div>
                  <p class="text-sm font-semibold text-gray-200">{grade.Vak?.Omschrijving ?? 'Onbekend'}</p>
                  <p class="text-xs text-gray-500">{grade.CijferKolom?.KolomOmschrijving ?? 'Cijfer'}</p>
                </div>
              </div>
              <span class="text-2xl font-bold {isVoldoende(grade) ? 'text-accent-400' : 'text-red-400'}">
                {grade.CijferStr}
              </span>
            </div>
          {/each}
        </div>
      {:else if currentTab === 'tools'}
        <div class="space-y-8 pb-10">

          <!-- Calculator -->
          <div>
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-xl font-bold text-gray-100 flex items-center gap-2">🧮 Calculator</h2>
            </div>
            <div class="glass p-5 rounded-3xl space-y-4">
              <div>
                <label for="calcSubject" class="block text-[10px] text-gray-500 font-black uppercase mb-1">Kies een vak</label>
                <select id="calcSubject" bind:value={calcSubjectName} class="w-full bg-surface-800 border border-surface-600 rounded-xl px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500">
                  <option value="">Selecteer vak...</option>
                  {#each subjects as s}
                     <option value={s.name}>{s.name} (Gemiddeld: {(s.avg || 0).toFixed(2)})</option>
                  {/each}
                </select>
              </div>
              
              {#if calcSubjectName}
                {@const s = subjects.find(x => x.name === calcSubjectName)}
                {#if s}
                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label for="calcTargetAvg" class="block text-[10px] text-gray-500 font-black uppercase mb-1">Gewenst Gem.</label>
                      <input id="calcTargetAvg" type="number" step="0.1" bind:value={calcTargetAvg} class="w-full bg-surface-800 border border-surface-600 rounded-xl px-3 py-2 text-sm font-bold text-primary-400 focus:outline-none focus:border-primary-500" />
                    </div>
                    <div>
                      <label for="calcWeight" class="block text-[10px] text-gray-500 font-black uppercase mb-1">Toets Weging</label>
                      <input id="calcWeight" type="number" step="1" bind:value={calcWeight} class="w-full bg-surface-800 border border-surface-600 rounded-xl px-3 py-2 text-sm font-bold text-primary-400 focus:outline-none focus:border-primary-500" />
                    </div>
                  </div>
                  <div class="mt-2 bg-surface-800 border border-primary-500/20 rounded-2xl p-4 flex justify-between items-center shadow-[inset_0_2px_10px_rgba(0,0,0,0.2)]">
                    <span class="text-[11px] text-gray-500 font-black uppercase tracking-widest">Te halen voor {calcTargetAvg}</span>
                    <span class="text-3xl font-black text-primary-500 italic drop-shadow-lg">{getRequiredGrade(s)}</span>
                  </div>

                  <div class="h-px bg-surface-700/50 my-2"></div>

                  <div class="space-y-3">
                    <div class="flex items-center justify-between">
                      <span class="text-[10px] text-gray-500 font-black uppercase tracking-widest">Simulatie Cijfers</span>
                      <button onclick={addSimulationGrade} class="text-[10px] font-black text-primary-400 uppercase tracking-widest hover:text-primary-300">
                        + Voeg Toe
                      </button>
                    </div>
                    
                    <div class="space-y-2">
                       {#each simulationGrades as sim, idx}
                         <div class="flex items-center gap-2 animate-in fade-in slide-in-from-left-2 transition-all">
                           <input type="number" step="0.1" bind:value={sim.value} class="w-20 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white" />
                           <span class="text-gray-600">×</span >
                           <input type="number" step="1" bind:value={sim.weight} class="w-16 bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-xs text-white" />
                           <button onclick={() => removeSimulationGrade(idx)} class="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg">
                             <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                           </button>
                         </div>
                       {/each}
                    </div>

                    <div class="mt-4 p-4 rounded-2xl bg-primary-500/5 border border-primary-500/20 flex flex-col items-center justify-center text-center">
                      <p class="text-[9px] text-primary-400 font-black uppercase tracking-[0.2em] mb-1">Nieuw Voorspeld Gemiddelde</p>
                      <span class="text-4xl font-black text-white italic tracking-tighter drop-shadow-[0_0_15px_rgba(var(--m3-primary-rgb),0.3)]">{getPredictedAverage(s)}</span>
                    </div>
                  </div>
                {/if}
              {/if}
            </div>
          </div>

          <!-- Divider -->
          <div class="h-px w-3/4 mx-auto bg-gradient-to-r from-transparent via-surface-600 to-transparent"></div>

          <!-- Snapshots -->
          <div>
            <div class="flex items-center justify-between mb-6">
              <h2 class="text-xl font-bold text-gray-100 flex items-center gap-2">📸 Snapshots</h2>
              <button onclick={createSnapshot} class="px-5 py-2.5 rounded-2xl bg-primary-500 text-on-primary text-xs font-black uppercase tracking-widest active:scale-95 transition-all shadow-lg shadow-primary-500/20">
                + Maak Nieuw
              </button>
            </div>

            {#if snapshots.length === 0}
              <div class="flex flex-col items-center justify-center py-16 bg-surface-900/40 rounded-[2rem] border border-dashed border-white/5 text-center">
                <p class="text-gray-400 font-bold">Geen snapshots bewaard.</p>
                <p class="text-[11px] text-gray-600 uppercase tracking-widest mt-2 px-8">Maak een snapshot om je cijfers van dit moment te bevriezen en later terug te kijken!</p>
              </div>
            {:else}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                {#each snapshots as snapshot}
                  <div 
                    onclick={() => viewSnapshot(snapshot)} 
                    onkeydown={(e) => e.key === 'Enter' && viewSnapshot(snapshot)}
                    role="button"
                    tabindex="0"
                    class="text-left bg-surface-800 border border-white/5 rounded-3xl p-5 shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all group overflow-hidden relative cursor-pointer"
                  >
                    <div class="absolute inset-0 bg-gradient-to-br from-primary-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    
                    <div class="flex items-center justify-between mb-5 relative z-10">
                      <div>
                        <h3 class="text-lg font-black text-white italic tracking-tight">{snapshot.name}</h3>
                        <p class="text-[9px] text-gray-500 uppercase font-black tracking-widest mt-0.5">{new Date(snapshot.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</p>
                      </div>
                      <button onclick={(e) => { e.stopPropagation(); deleteSnapshot(snapshot.id); }} aria-label="Verwijderen" class="p-2.5 rounded-2xl bg-red-500/10 text-red-400 hover:text-white hover:bg-red-500 transition-all opacity-0 group-hover:opacity-100">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                      </button>
                    </div>
                    <div class="grid grid-cols-3 gap-2 relative z-10">
                      {#each snapshot.subjects.slice(0, 3) as sub}
                        <div class="px-3 py-2 rounded-2xl bg-surface-950 border border-white/5 flex flex-col justify-center items-center">
                          <span class="text-[9px] font-black text-gray-600 uppercase tracking-tighter w-full text-center truncate mb-0.5">{sub.abbr.slice(0, 3)}</span>
                          <span class="text-base font-black {sub.avg >= $userSettings.insufficientThreshold ? 'text-primary-400' : 'text-red-400'} italic">{(sub.avg || 0).toFixed(1)}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </main>
</div>
