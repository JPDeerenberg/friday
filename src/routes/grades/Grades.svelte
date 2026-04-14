<script lang="ts">
  import { personId, userSettings } from '$lib/stores';
  import { getSchoolyears, getGrades, formatDate, getBulkGradeExtraInfo, formatTeacherName } from '$lib/api';
  import { onMount } from 'svelte';

  let schoolyears = $state<any[]>([]);
  let selectedYear = $state<any>(null);
  let grades = $state<any[]>([]);
  let subjects = $state<any[]>([]);
  let snapshots = $state<{ id: string; date: string; name: string; subjects: any[] }[]>([]);
  let loading = $state(true);
  let selectedSubject = $state<string | null>(null);
  let currentTab = $state<'vakken' | 'recent' | 'tools'>('vakken');
  let activeSnapshot = $state<any | null>(null);
  let errorMessage = $state<string | null>(null);

  // Subject Sort Filter
  let subjectSortMode = $state<'alfabetisch' | 'nieuwste' | 'hoogste' | 'laagste' | 'meeste'>('alfabetisch');

  function getSortedSubjects() {
    let sorted = [...subjects];
    switch (subjectSortMode) {
      case 'alfabetisch':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'nieuwste':
        sorted.sort((a, b) => {
          const aDate = a.grades[0]?.DatumIngevoerd ?? '';
          const bDate = b.grades[0]?.DatumIngevoerd ?? '';
          return bDate.localeCompare(aDate);
        });
        break;
      case 'hoogste':
        sorted.sort((a, b) => (b.avg || 0) - (a.avg || 0));
        break;
      case 'laagste':
        sorted.sort((a, b) => (a.avg || 0) - (b.avg || 0));
        break;
      case 'meeste':
        sorted.sort((a, b) => b.grades.length - a.grades.length);
        break;
    }
    return sorted;
  }

  // Recent tab filter
  let recentFilter = $state<'today' | 'week' | 'all'>('all');

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
    if (points.length === 2) {
      return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
    }
    
    // Using a more robust Catmull-Rom to Cubic Bezier conversion for smoothness
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      
      d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
    }
    return d;
  }

  async function init() {
    loading = true;
    errorMessage = null;
    const pid = $personId;
    if (!pid) { loading = false; return; }
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
    } catch (e: any) { 
      console.error('Error loading schoolyears:', e); 
      errorMessage = e.message || String(e);
    }
    loading = false;
  }

  onMount(() => {
    const cached = localStorage.getItem('grades_cache');
    if (cached) { 
        try {
            const data = JSON.parse(cached); 
            schoolyears = data.schoolyears; 
            subjects = data.subjects; 
        } catch {}
    }
    const savedSnapshots = localStorage.getItem('grade_snapshots');
    if (savedSnapshots) snapshots = JSON.parse(savedSnapshots);
    init();
  });

  async function loadGrades() {
    if (!selectedYear?.id || !$personId) return;
    loading = true;
    errorMessage = null;
    try {
      // Pass the date part of the endpoint manually to be extra safe
      const peildatum = selectedYear.einde.split('T')[0];
      const fetchedGrades = await getGrades($personId, selectedYear.id, peildatum);
      
      const relevantColumns = [...new Set(fetchedGrades
        .filter(g => g.CijferKolom?.KolomSoort === 1)
        .map(g => g.CijferKolom.Id))];
      
      if (relevantColumns.length > 0) {
        try {
          const weightsMap = await getBulkGradeExtraInfo($personId, selectedYear.id, relevantColumns);
          grades = fetchedGrades.map(g => {
            const extra = weightsMap[g.CijferKolom.Id];
            if (extra) return { ...g, Weging: extra.Weging, description: extra.WerkInformatieOmschrijving || extra.KolomOmschrijving };
            return g;
          });
        } catch (e) { 
            console.warn('Error loading extra grade info:', e);
            grades = fetchedGrades; 
        }
      } else { 
          grades = fetchedGrades; 
      }
      subjects = getSubjects();
      localStorage.setItem('grades_cache', JSON.stringify({ schoolyears, subjects }));
    } catch (e: any) { 
        console.error('Error loading grades:', e); 
        errorMessage = e.message || String(e);
    }
    loading = false;
  }

  function createSnapshot() {
    const name = prompt('Geef deze snapshot een naam:', `Snapshot ${new Date().toLocaleDateString()}`);
    if (!name) return;
    const newSnapshot = { id: crypto.randomUUID(), date: new Date().toISOString(), name, subjects: JSON.parse(JSON.stringify(subjects)) };
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
    return Array.from(subjectMap.entries()).map(([name, subGrades]) => {
      let totalPoints = 0, totalWeight = 0;
      const validGrades: { value: number; weight: number }[] = [];
      subGrades.filter(g => g.CijferStr && g.TeltMee).forEach(g => {
        const val = parseFloat(g.CijferStr.replace(',', '.'));
        const w = typeof g.Weging === 'number' ? g.Weging : 1;
        if (!isNaN(val)) { totalPoints += val * w; totalWeight += w; validGrades.push({ value: val, weight: w }); }
      });
      const avg = totalWeight > 0 ? totalPoints / totalWeight : 0;
      return {
        name, abbr: subGrades[0]?.Vak?.Afkorting ?? '',
        grades: subGrades.sort((a: any, b: any) => (b.DatumIngevoerd ?? '').localeCompare(a.DatumIngevoerd ?? '')),
        validGrades, totalPoints, totalWeight, avg,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
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
    let list = [...grades]
      .filter(g => g.CijferStr && g.DatumIngevoerd && g.CijferKolom?.KolomSoort === 1)
      .sort((a, b) => b.DatumIngevoerd.localeCompare(a.DatumIngevoerd));

    if (recentFilter === 'today') {
      const today = new Date().toDateString();
      list = list.filter(g => new Date(g.DatumIngevoerd).toDateString() === today);
    } else if (recentFilter === 'week') {
      const now = new Date();
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; // Monday=0
      const monday = new Date(now); monday.setDate(now.getDate() - dayOfWeek); monday.setHours(0,0,0,0);
      list = list.filter(g => new Date(g.DatumIngevoerd) >= monday);
    }
    return list;
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
    const w = 100, h = 40;
    let minY = 1, maxY = 10;
    if ($userSettings.zoomGraph) {
      minY = Math.max(1, Math.min(...chronoGrades) - 0.5);
      maxY = Math.min(10, Math.max(...chronoGrades) + 0.5);
    }
    const points = chronoGrades.map((g, i) => ({
      x: (i / (chronoGrades.length - 1)) * w,
      y: h - ((g - minY) / (maxY - minY)) * h
    }));
    if ($userSettings.roundedGraphs) {
      let d = `M ${points[0].x},${points[0].y}`;
      if (points.length === 2) {
          return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
      }
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const cp1x = p1.x + (p2.x - p1.x) / 2;
        d += ` C ${cp1x},${p1.y} ${cp1x},${p2.y} ${p2.x},${p2.y}`;
      }
      return d;
    }
    return `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`;
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

  // Calculator
  let calcSubjectName = $state('');
  let calcTargetAvg = $state(5.5);
  let calcWeight = $state(1);
  let simulationGrades = $state<{ value: number; weight: number }[]>([]);
  let includeSimInAvg = $state(true);

  function addSimulationGrade() {
    simulationGrades = [...simulationGrades, { value: 5.5, weight: 1 }];
  }

  function removeSimulationGrade(index: number) {
    simulationGrades = simulationGrades.filter((_, i) => i !== index);
  }

  function getRequiredGrade(subject: any): string {
    if (subject.totalWeight === 0) return '?';
    let simulatedPoints = 0, simulatedWeight = 0;
    for (const g of simulationGrades) { simulatedPoints += g.value * g.weight; simulatedWeight += g.weight; }
    const currentPoints = subject.totalPoints + simulatedPoints;
    const currentWeight = subject.totalWeight + simulatedWeight;
    const required = (calcTargetAvg * (currentWeight + calcWeight) - currentPoints) / calcWeight;
    if (required > 10) return 'Onmogelijk (>10)';
    if (required < 1) return '1.0';
    return required.toFixed($userSettings.decimalPoints);
  }

  function getPredictedAverage(subject: any): string {
    let simulatedPoints = 0, simulatedWeight = 0;
    for (const g of simulationGrades) { simulatedPoints += g.value * g.weight; simulatedWeight += g.weight; }
    const totalP = (subject.totalPoints || 0) + (includeSimInAvg ? simulatedPoints : 0);
    const totalW = (subject.totalWeight || 0) + (includeSimInAvg ? simulatedWeight : 0);
    return totalW > 0 ? (totalP / totalW).toFixed($userSettings.decimalPoints) : '0';
  }

  function getProgressPercent(subject: any): number {
    const current = subject.avg;
    const predicted = parseFloat(getPredictedAverage(subject));
    return Math.min(100, Math.max(0, (predicted / 10) * 100));
  }

  function getMinGradeForPass(subject: any): string | null {
    if (subject.totalWeight === 0) return null;
    const threshold = $userSettings.insufficientThreshold;
    const required = (threshold * (subject.totalWeight + 1) - subject.totalPoints) / 1;
    if (required <= 1) return null; // Already passing without any extra
    if (required > 10) return null; // Pass impossible
    return required.toFixed(1);
  }

  function getNewOverallAverage(subject: any): string {
    const validSubjects = subjects.filter((s: any) => s.avg > 0);
    if (validSubjects.length === 0) return getPredictedAverage(subject);
    let totalAverages = 0;
    for (const sub of validSubjects) {
      if (sub.name === subject.name) {
         totalAverages += parseFloat(getPredictedAverage(subject));
      } else {
         totalAverages += sub.avg;
      }
    }
    return (totalAverages / validSubjects.length).toFixed($userSettings.decimalPoints);
  }

  let historicalAverages = $state<{ year: string; avg: number; id: number }[]>([]);
  let loadingHistory = $state(false);

  async function loadHistoricalAverages() {
    if (historicalAverages.length > 0) return; // Already loaded
    if (!$personId) return; // Needs personId
    loadingHistory = true;
    const results = [];
    try {
        for (const year of schoolyears) {
            if (!year.einde) continue;
            const peildatum = year.einde.split('T')[0];
            const fetchedGrades = await getGrades($personId, year.id, peildatum);
            
            const subMap = new Map<string, { totalP: number, totalW: number }>();
            for (const grade of fetchedGrades) {
               if (!grade.Vak || grade.CijferKolom?.KolomSoort !== 1 || !grade.CijferStr || !grade.TeltMee) continue;
               const val = parseFloat(grade.CijferStr.replace(',', '.'));
               const w = typeof grade.Weging === 'number' ? grade.Weging : 1;
               if (!isNaN(val)) {
                   const s = subMap.get(grade.Vak.Omschrijving) || { totalP: 0, totalW: 0 };
                   s.totalP += val * w;
                   s.totalW += w;
                   subMap.set(grade.Vak.Omschrijving, s);
               }
            }
            let validAvgCount = 0, sumAvgs = 0;
            for (const s of subMap.values()) {
                if (s.totalW > 0) {
                    sumAvgs += s.totalP / s.totalW;
                    validAvgCount++;
                }
            }
            if (validAvgCount > 0) {
                results.push({ id: year.id, year: year.groep?.code ?? year.studie?.code ?? '?', avg: sumAvgs / validAvgCount });
            }
        }
    } catch(e) { console.error(e); }
    historicalAverages = results.sort((a,b) => a.id - b.id);
    loadingHistory = false;
  }
</script>

<div class="flex flex-col bg-surface-950">
  <!-- Sticky Header -->
  <div class="sticky top-0 z-10 bg-surface-950/95 backdrop-blur border-b border-surface-800/50 px-4 py-3 pb-0">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-black text-white italic tracking-tighter">Cijfers</h1>
        <button
          onclick={() => selectYear(selectedYear)}
          aria-label="Vernieuwen"
          class="p-1.5 text-gray-500 hover:text-primary-400 transition-all hover:scale-110 active:scale-95"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
      <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar max-w-[200px] justify-end">
        {#each schoolyears as year}
          <button
            onclick={() => selectYear(year)}
            class="px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider shrink-0
                   {selectedYear?.id === year.id
                     ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25'
                     : 'bg-surface-800 text-gray-500 hover:bg-surface-700 hover:text-gray-300'}"
          >
            {year.groep?.code ?? year.studie?.code ?? '?'}
          </button>
        {/each}
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-1 bg-surface-900 p-1 rounded-2xl border border-white/5 mb-3">
      {#each [
        { id: 'vakken', label: 'Vakken', icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>' },
        { id: 'recent', label: 'Recent', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
        { id: 'tools', label: 'Tools', icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>' },
      ] as tab}
        <button
          onclick={() => currentTab = tab.id as any}
          class="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all
                 {currentTab === tab.id ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25' : 'text-gray-500 hover:text-gray-300'}"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            {@html tab.icon}
          </svg>
          {tab.label}
        </button>
      {/each}
    </div>
  </div>

  <main class="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">
    {#if activeSnapshot}
      <div class="bg-amber-500/10 border border-amber-500/30 rounded-3xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <div class="w-11 h-11 rounded-2xl bg-amber-500/20 flex items-center justify-center text-amber-400">
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3L14.5 4z"/><circle cx="12" cy="13" r="3"/></svg>
          </div>
          <div>
            <p class="text-[11px] font-black text-amber-500 uppercase tracking-widest">Snapshot Actief</p>
            <h3 class="text-base font-black text-white italic tracking-tight">{activeSnapshot.name}</h3>
            <p class="text-[10px] text-gray-500 font-bold uppercase">{new Date(activeSnapshot.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
          </div>
        </div>
        <button onclick={returnToLiveData} class="px-5 py-2 rounded-2xl bg-amber-500 text-black text-xs font-black uppercase tracking-widest shadow-lg shadow-amber-500/25 active:scale-95 transition-all">
          Terug naar Live
        </button>
      </div>
    {/if}

    {#if loading}
      <div class="flex flex-col items-center justify-center py-24 gap-4">
        <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-xs text-gray-500 font-bold uppercase tracking-widest animate-pulse">Cijfers ophalen...</p>
      </div>
    {:else if errorMessage}
      <div class="glass p-8 rounded-[2rem] flex flex-col items-center text-center gap-6 border-red-500/20">
        <div class="w-16 h-16 rounded-3xl bg-red-500/10 flex items-center justify-center text-red-500">
          <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div class="space-y-2">
          <h3 class="text-xl font-black text-white italic tracking-tighter">Oeps! Er ging iets mis</h3>
          <p class="text-sm text-gray-500 max-w-xs">{errorMessage}</p>
        </div>
        <button 
          onclick={init}
          class="px-8 py-3 rounded-2xl bg-white text-black text-xs font-black uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-xl shadow-white/10"
        >
          Opnieuw Proberen
        </button>
      </div>
    {:else}

      <!-- ======= VAKKEN TAB ======= -->
      {#if currentTab === 'vakken'}
        <!-- Overall trend graph -->
        {#if subjects.length > 0}
          {@const path = getOverallTrendPath()}
          {@const validSubjects = subjects.filter(s => s.avg > 0)}
          {@const overallAvg = validSubjects.length > 0 ? validSubjects.reduce((a, b) => a + b.avg, 0) / validSubjects.length : 0}
          <div class="glass p-6 rounded-[2rem] space-y-4 overflow-hidden relative shadow-2xl">
            <div class="absolute inset-0 bg-gradient-to-br from-primary-500/15 via-transparent to-accent-500/8"></div>
            <div class="flex items-center justify-between relative z-10">
              <div>
                <h2 class="text-xl font-black text-white italic tracking-tight">Cijferverloop</h2>
                <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-0.5">Chronologisch overzicht</p>
              </div>
              <div class="flex flex-col items-end">
                <span class="text-3xl font-black italic {isVoldoende(overallAvg) ? 'text-primary-400' : 'text-red-400'}">{overallAvg.toFixed(2)}</span>
                <span class="text-[9px] font-black text-gray-600 uppercase tracking-tight">Totaal Gem.</span>
              </div>
            </div>
            <div class="h-40 w-full relative z-10 mt-2">
              <svg viewBox="0 0 300 100" class="w-full h-full overflow-visible" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:var(--color-primary-500);stop-opacity:0.2" />
                    <stop offset="100%" style="stop-color:var(--color-primary-500);stop-opacity:0" />
                  </linearGradient>
                </defs>
                {#if path}
                  <path d="{path} V 100 H 0 Z" fill="url(#gradeGrad)" />
                  <path d={path} fill="none" stroke="var(--color-primary-400)" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
                  {#each getChronologicalGrades().slice(-10) as g, i}
                    {@const chrono = getChronologicalGrades()}
                    {@const total = chrono.length}
                    {@const idx = total > 10 ? total - 10 + i : i}
                    {@const x = (idx / (total - 1)) * 300}
                    {@const y = 100 - ((getNumericValue(g.CijferStr) - 1) / 9) * 100}
                    <circle cx={x} cy={y} r="3" fill="var(--color-primary-500)" stroke="white" stroke-width="1.5" />
                    {#if i === (total > 10 ? 9 : total - 1)}
                       <text x={x} y={y - 8} text-anchor="end" class="text-[8px] font-black fill-white italic uppercase tracking-tighter">
                          {g.CijferStr}
                       </text>
                    {/if}
                  {/each}
                  <!-- Average line -->
                  <line x1="0" y1={100 - ((overallAvg - 1) / 9) * 100} x2="300" y2={100 - ((overallAvg - 1) / 9) * 100} stroke="white" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.3" />
                {/if}
              </svg>
            </div>
          </div>
        {/if}

        <!-- Subject Filters -->
        <div class="flex items-center justify-between mb-4 mt-6">
          <h3 class="text-xs font-black text-white uppercase tracking-widest">Alle Vakken</h3>
          <select bind:value={subjectSortMode} class="bg-surface-800 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-primary-500 font-bold block appearance-none text-right">
            <option value="alfabetisch">Op Alfabet (A-Z)</option>
            <option value="nieuwste">Nieuwste Cijfers</option>
            <option value="hoogste">Hoogste Gemiddelde</option>
            <option value="laagste">Laagste Gemiddelde</option>
            <option value="meeste">Meeste Cijfers</option>
          </select>
        </div>

        <!-- Subject list -->
        <div class="space-y-2.5">
          {#each getSortedSubjects() as subject}
            {@const minForPass = getMinGradeForPass(subject)}
            <div class="glass rounded-2xl overflow-hidden">
              <button
                onclick={() => selectedSubject = selectedSubject === subject.name ? null : subject.name}
                class="w-full flex items-center justify-between p-4 hover:bg-surface-800/20 text-left transition-colors"
              >
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl bg-primary-500/15 border border-primary-500/20 flex items-center justify-center text-primary-300 font-black text-[11px] shrink-0 shadow-inner">
                    {subject.abbr.toUpperCase().slice(0, 3)}
                  </div>
                  <div>
                    <p class="text-sm font-bold text-gray-200">{subject.name}</p>
                    <div class="flex items-center gap-2 mt-0.5">
                      <p class="text-xs text-gray-600">{subject.grades.length} cijfer{subject.grades.length !== 1 ? 's' : ''}</p>
                      {#if minForPass && !isVoldoende(subject.avg)}
                        <span class="text-[9px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-md font-black">Min. {minForPass} voor voldoende</span>
                      {/if}
                    </div>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  {#if getTrendPath(subject)}
                    {@const chrono = [...subject.grades].filter(g => g.CijferStr && g.TeltMee && !isNaN(getNumericValue(g.CijferStr))).map(g => getNumericValue(g.CijferStr))}
                    {@const lastVal = chrono[chrono.length-1]}
                    {@const minY = $userSettings.zoomGraph ? Math.max(1, Math.min(...chrono) - 0.5) : 1}
                    {@const maxY = $userSettings.zoomGraph ? Math.min(10, Math.max(...chrono) + 0.5) : 10}
                    {@const lastY = 40 - ((lastVal - minY) / (maxY - minY)) * 40}
                    <div class="w-16 h-8 hidden sm:block shrink-0">
                      <svg viewBox="0 0 100 40" class="w-full h-full overflow-visible" preserveAspectRatio="none">
                        <path d={getTrendPath(subject)} fill="none" stroke="var(--color-primary-400)" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
                        <circle cx="100" cy={lastY} r="2.5" fill="var(--color-primary-400)" />
                      </svg>
                    </div>
                  {/if}
                  {#if subject.avg > 0}
                    <span class="text-xl font-black {isVoldoende(subject.avg) ? 'text-accent-400' : 'text-red-400'}">
                      {subject.avg.toFixed($userSettings.decimalPoints)}
                    </span>
                  {/if}
                  <svg class="w-4 h-4 text-gray-600 transition-transform {selectedSubject === subject.name ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
                </div>
              </button>

              {#if selectedSubject === subject.name}
                <div class="border-t border-surface-700/50 p-4 space-y-4">
                  
                  <!-- Detailed Subject Graph -->
                  {#if getTrendPath(subject)}
                    {@const chronoG = [...subject.grades].filter(g => g.CijferStr && g.TeltMee && !isNaN(getNumericValue(g.CijferStr))).sort((a,b) => (a.DatumIngevoerd ?? '').localeCompare(b.DatumIngevoerd ?? ''))}
                    {@const chronoVals = chronoG.map(g => getNumericValue(g.CijferStr))}
                    {@const minY = $userSettings.zoomGraph ? Math.max(1, Math.min(...chronoVals) - 0.5) : 1}
                    {@const maxY = $userSettings.zoomGraph ? Math.min(10, Math.max(...chronoVals) + 0.5) : 10}
                    <div class="h-32 w-full relative bg-surface-900/50 rounded-xl p-3 border border-white/5">
                      <p class="absolute top-2 left-3 text-[9px] font-black uppercase text-gray-500">Cijferverloop</p>
                      <svg viewBox="0 0 100 40" class="w-full h-full overflow-visible mt-2" preserveAspectRatio="none">
                        
                        <path d={getTrendPath(subject)} fill="none" stroke="var(--color-primary-400)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
                        
                        {#each chronoVals as gVal, idx}
                          {@const cx = (idx / (chronoVals.length - 1)) * 100 || 50}
                          {@const cy = 40 - ((gVal - minY) / (maxY - minY)) * 40}
                          <circle cx={cx} cy={cy} r="1.5" fill="var(--color-primary-500)" stroke="var(--color-surface-900)" stroke-width="0.5" />
                          {#if idx === chronoVals.length - 1}
                             <text x={cx} y={cy - 4} text-anchor="middle" class="text-[5px] font-black fill-white italic tracking-tighter">{gVal.toFixed(1)}</text>
                          {/if}
                        {/each}
                      </svg>
                    </div>
                  {/if}

                  <div class="space-y-2">
                    {#each subject.grades as grade}
                    <div class="flex items-center justify-between p-3 rounded-xl bg-surface-800/50 border border-white/4">
                      <div class="min-w-0 flex-1">
                        <p class="text-sm text-gray-300 font-medium">
                          {grade.CijferKolom?.KolomOmschrijving ?? grade.CijferKolom?.KolomNaam ?? 'Cijfer'}
                        </p>
                        <div class="flex items-center gap-2 mt-0.5 flex-wrap">
                          {#if grade.DatumIngevoerd}
                            <span class="text-xs text-gray-600">{formatDateShort(grade.DatumIngevoerd)}</span>
                          {/if}
                          {#if grade.Docent}
                            <span class="text-xs text-gray-600">• {formatTeacherName(grade.Docent)}</span>
                          {/if}
                          {#if grade.Weging}
                            <span class="text-[10px] text-gray-600 bg-surface-700 px-1.5 py-0.5 rounded-md font-bold">×{grade.Weging}</span>
                          {/if}
                        </div>
                      </div>
                      <span class="text-lg font-black ml-4 {isVoldoende(grade) ? 'text-primary-400' : 'text-red-400'}">
                        {grade.CijferStr}
                      </span>
                    </div>
                  {/each}
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>

      <!-- ======= RECENT TAB ======= -->
      {:else if currentTab === 'recent'}
        <!-- Date filter chips -->
        <div class="flex items-center gap-2">
          {#each [
            { id: 'today', label: 'Vandaag' },
            { id: 'week', label: 'Deze week' },
            { id: 'all', label: 'Alles' },
          ] as f}
            <button
              onclick={() => recentFilter = f.id as any}
              class="px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-wide transition-all whitespace-nowrap
                     {recentFilter === f.id
                       ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25'
                       : 'bg-surface-800 text-gray-400 hover:text-gray-200 border border-white/5'}"
            >
              {f.label}
            </button>
          {/each}
          <span class="ml-auto text-xs text-gray-600 font-bold">{getRecentGrades().length} cijfer{getRecentGrades().length !== 1 ? 's' : ''}</span>
        </div>

        {#if getRecentGrades().length === 0}
          <div class="flex flex-col items-center justify-center py-20 text-center">
            <svg class="w-12 h-12 text-gray-700 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <p class="text-gray-600 text-sm font-bold">Geen cijfers {recentFilter === 'today' ? 'vandaag' : recentFilter === 'week' ? 'deze week' : ''}</p>
          </div>
        {:else}
          <div class="space-y-2.5">
            {#each getRecentGrades() as grade}
              {@const d = new Date(grade.DatumIngevoerd)}
              <div class="glass flex items-center justify-between p-4 rounded-2xl gap-3">
                <div class="flex items-center gap-3.5">
                  <div class="w-12 h-12 rounded-2xl bg-surface-800 border border-surface-700/50 flex flex-col items-center justify-center shrink-0">
                    <span class="text-[10px] text-gray-500 font-bold uppercase leading-none">{d.toLocaleDateString('nl-NL', { month: 'short' })}</span>
                    <span class="text-lg font-black text-gray-200 leading-tight">{d.getDate()}</span>
                  </div>
                  <div>
                    <p class="text-sm font-bold text-gray-200">{grade.Vak?.Omschrijving ?? 'Onbekend'}</p>
                    <p class="text-xs text-gray-600">{grade.CijferKolom?.KolomOmschrijving ?? 'Cijfer'}</p>
                    {#if grade.Weging}
                      <span class="text-[9px] text-gray-600 bg-surface-800 border border-surface-700/50 px-1.5 py-0.5 rounded-md font-bold">×{grade.Weging}</span>
                    {/if}
                  </div>
                </div>
                <div class="flex flex-col items-end gap-1">
                  <span class="text-2xl font-black {isVoldoende(grade) ? 'text-accent-400' : 'text-red-400'}">
                    {grade.CijferStr}
                  </span>
                  {#if grade.TeltMee === false}
                    <span class="text-[9px] text-gray-600 font-bold bg-surface-800 px-1.5 py-0.5 rounded-md border border-surface-700/50">Telt niet mee</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

      <!-- ======= TOOLS TAB ======= -->
      {:else if currentTab === 'tools'}
        <div class="space-y-8 pb-10">

          <!-- Calculator -->
          <div>
            <div class="flex items-center gap-3 mb-4">
              <div class="w-8 h-8 rounded-xl bg-primary-500/15 flex items-center justify-center text-primary-400">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 10h8M8 14h8M8 18h8M8 6h8"/></svg>
              </div>
              <h2 class="text-xl font-black text-white italic tracking-tighter">Calculator</h2>
            </div>

            <div class="glass p-5 rounded-3xl space-y-5">
              <!-- Subject select -->
              <div>
                <label for="calcSubject" class="block text-[10px] text-gray-500 font-black uppercase tracking-widest mb-1.5">Kies een vak</label>
                <select id="calcSubject" bind:value={calcSubjectName} class="w-full bg-surface-800 border border-surface-600/50 rounded-xl px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-primary-500">
                  <option value="">Selecteer vak...</option>
                  {#each subjects as s}
                    <option value={s.name}>{s.name} (Gem: {(s.avg || 0).toFixed(2)})</option>
                  {/each}
                </select>
              </div>

              {#if calcSubjectName}
                {@const s = subjects.find(x => x.name === calcSubjectName)}
                {#if s}
                  <!-- Target + Weight inputs -->
                  <div class="grid grid-cols-2 gap-4">
                    <div class="bg-surface-800/40 border border-white/5 rounded-2xl p-3">
                      <label for="calcTargetAvg" class="block text-[9px] text-gray-500 font-black uppercase tracking-widest mb-2 text-center">Doelgemiddelde</label>
                      <input id="calcTargetAvg" type="number" step="0.1" min="1" max="10" bind:value={calcTargetAvg}
                        class="w-full bg-surface-900 border border-primary-500/20 rounded-xl px-3 py-2 text-base font-black text-center text-primary-400 focus:outline-none focus:border-primary-500 transition-all" />
                    </div>
                    <div class="bg-surface-800/40 border border-white/5 rounded-2xl p-3">
                      <label for="calcWeight" class="block text-[9px] text-gray-500 font-black uppercase tracking-widest mb-2 text-center">Toets weging (×{calcWeight})</label>
                      <div class="flex items-center gap-2 px-1">
                        <input id="calcWeight" type="range" min="1" max="5" step="1" bind:value={calcWeight}
                          class="flex-1 accent-primary-500" />
                      </div>
                    </div>
                  </div>

                  <!-- Required grade result -->
                  <div class="relative group">
                    <div class="absolute -inset-0.5 bg-gradient-to-r from-primary-500 to-accent-500 rounded-3xl blur opacity-20 group-hover:opacity-40 transition duration-1000"></div>
                    <div class="relative bg-surface-900 border border-white/10 rounded-3xl p-6 flex flex-col items-center justify-center shadow-2xl">
                      <p class="text-[10px] text-gray-500 font-black uppercase tracking-[0.2em] mb-1">Cijfer nodig voor een {calcTargetAvg.toFixed(1)}</p>
                      <span class="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white via-primary-400 to-accent-400 italic italic tracking-tighter drop-shadow-sm">
                        {getRequiredGrade(s)}
                      </span>
                    </div>
                  </div>

                  <!-- Progress bar: current → predicted -->
                  <div class="space-y-2">
                    <div class="flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
                      <span class="text-gray-500">Huidig: <span class="text-gray-300">{s.avg.toFixed($userSettings.decimalPoints)}</span></span>
                      <span class="text-gray-500">Voorspeld: <span class="{parseFloat(getPredictedAverage(s)) >= $userSettings.insufficientThreshold ? 'text-accent-400' : 'text-red-400'}">{getPredictedAverage(s)}</span></span>
                    </div>
                    <div class="h-2 bg-surface-800 rounded-full overflow-hidden border border-surface-700/50">
                      <div
                        class="h-full rounded-full transition-all duration-500 {parseFloat(getPredictedAverage(s)) >= $userSettings.insufficientThreshold ? 'bg-gradient-to-r from-primary-600 to-accent-400' : 'bg-gradient-to-r from-red-600 to-red-400'}"
                        style="width: {getProgressPercent(s)}%"
                      ></div>
                    </div>
                    
                    <div class="grid grid-cols-2 gap-4 mt-4 pt-2 border-t border-white/5">
                      <div class="bg-surface-800/30 rounded-2xl p-4 flex flex-col items-center justify-center">
                         <span class="text-3xl font-black italic tracking-tighter drop-shadow-md {parseFloat(getPredictedAverage(s)) >= $userSettings.insufficientThreshold ? 'text-white' : 'text-red-400'}">
                           {getPredictedAverage(s)}
                         </span>
                         <p class="text-[8px] text-gray-500 font-black uppercase tracking-widest mt-1 text-center">Nieuw Vak Gem.</p>
                      </div>
                      <div class="bg-surface-800/30 rounded-2xl p-4 flex flex-col items-center justify-center shadow-inner">
                         <span class="text-3xl font-black italic tracking-tighter drop-shadow-md text-primary-300">
                           {getNewOverallAverage(s)}
                         </span>
                         <p class="text-[8px] text-gray-500 font-black uppercase tracking-widest mt-1 text-center">Nieuw Totaal Gem.</p>
                      </div>
                    </div>
                  </div>

                  <div class="h-px bg-surface-700/40"></div>

                  <!-- Simulation grades -->
                  <div class="space-y-3">
                    <div class="flex items-center justify-between">
                      <span class="text-[10px] text-gray-500 font-black uppercase tracking-widest">Simulatie Cijfers</span>
                      <div class="flex items-center gap-3">
                        <label class="flex items-center gap-1.5 text-[10px] text-gray-500 font-bold cursor-pointer">
                          <input type="checkbox" bind:checked={includeSimInAvg} class="accent-primary-500 rounded" />
                          Meenemen in gem.
                        </label>
                        <button onclick={addSimulationGrade} class="flex items-center gap-1 text-[10px] font-black text-primary-400 hover:text-primary-300 uppercase tracking-widest">
                          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg>
                          Voeg toe
                        </button>
                      </div>
                    </div>
                    <div class="space-y-2">
                      {#each simulationGrades as sim, idx}
                        <div class="flex items-center gap-2.5">
                          <div class="flex-1 grid grid-cols-2 gap-2">
                            <div>
                              <label class="text-[9px] text-gray-600 font-black uppercase block mb-0.5">Cijfer</label>
                              <input type="number" step="0.1" min="1" max="10" bind:value={sim.value}
                                class="w-full bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-sm text-white font-bold focus:outline-none focus:border-primary-500" />
                            </div>
                            <div>
                              <label class="text-[9px] text-gray-600 font-black uppercase block mb-0.5">Weging</label>
                              <input type="number" step="1" min="1" bind:value={sim.weight}
                                class="w-full bg-surface-800 border border-surface-700 rounded-lg px-2 py-1.5 text-sm text-white font-bold focus:outline-none focus:border-primary-500" />
                            </div>
                          </div>
                          <button onclick={() => removeSimulationGrade(idx)} class="p-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors mt-4">
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              {/if}
            </div>
          </div>

          <div class="h-px w-3/4 mx-auto bg-gradient-to-r from-transparent via-surface-600 to-transparent"></div>

          <!-- Vergelijk Schooljaren -->
          <div>
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-xl bg-accent-500/15 flex items-center justify-center text-accent-400">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>
                </div>
                <h2 class="text-xl font-black text-white italic tracking-tighter">Voortgang Jaren</h2>
              </div>
              {#if historicalAverages.length === 0}
                <button onclick={loadHistoricalAverages} disabled={loadingHistory} class="px-4 py-2 bg-surface-800 text-xs font-black text-gray-300 uppercase tracking-widest rounded-xl hover:bg-surface-700 hover:text-white transition active:scale-95 disabled:opacity-50 disabled:active:scale-100">
                  {loadingHistory ? 'Laden...' : 'Laad Data'}
                </button>
              {/if}
            </div>

            <div class="glass p-5 rounded-3xl min-h-[160px] flex flex-col justify-center">
              {#if historicalAverages.length === 0}
                 <p class="text-center text-xs text-gray-500 font-bold max-w-xs mx-auto">Krijg een compleet totaaloverzicht van je prestaties door de jaren heen.</p>
              {:else}
                 {@const maxAvg = Math.max(...historicalAverages.map(h => h.avg), 7)}
                 {@const minAvg = Math.min(...historicalAverages.map(h => h.avg), 5)}
                 <div class="flex items-end justify-between gap-2 h-32 pt-4 px-2">
                   
                   {#each historicalAverages as hist}
                     {@const heightPct = Math.max(10, ((hist.avg - minAvg + 0.5) / (maxAvg - minAvg + 1)) * 100)}
                     <div class="flex flex-col items-center flex-1 group">
                       <span class="text-xs font-black text-white mb-2 opacity-0 group-hover:opacity-100 transition duration-300">{hist.avg.toFixed(2)}</span>
                       <div class="w-full max-w-[40px] bg-gradient-to-t from-primary-600/50 to-primary-400 rounded-t-xl transition-all duration-700 hover:brightness-125" style="height: {heightPct}%"></div>
                       <span class="text-[9px] font-black uppercase tracking-tighter text-gray-400 mt-3 truncate w-full text-center">{hist.year}</span>
                     </div>
                   {/each}
                 </div>
              {/if}
            </div>
          </div>

          <div class="h-px w-3/4 mx-auto bg-gradient-to-r from-transparent via-surface-600 to-transparent"></div>

          <!-- Snapshots -->
          <div>
            <div class="flex items-center justify-between mb-5">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-xl bg-amber-500/15 flex items-center justify-center text-amber-400">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3L14.5 4z"/><circle cx="12" cy="13" r="3"/></svg>
                </div>
                <h2 class="text-xl font-black text-white italic tracking-tighter">Snapshots</h2>
              </div>
              <button onclick={createSnapshot} class="flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-primary-500 text-white text-xs font-black uppercase tracking-widest active:scale-95 transition-all shadow-lg shadow-primary-500/25">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg>
                Nieuw
              </button>
            </div>

            {#if snapshots.length === 0}
              <div class="flex flex-col items-center justify-center py-14 rounded-[2rem] border border-dashed border-white/8 text-center">
                <svg class="w-10 h-10 text-gray-700 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3L14.5 4z"/><circle cx="12" cy="13" r="3"/></svg>
                <p class="text-gray-500 font-bold text-sm">Geen snapshots</p>
                <p class="text-[11px] text-gray-700 font-bold uppercase tracking-widest mt-1.5 px-8">Maak een snapshot om je stand van nu te bewaren</p>
              </div>
            {:else}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                {#each snapshots as snapshot}
                  <div
                    onclick={() => viewSnapshot(snapshot)}
                    onkeydown={(e) => e.key === 'Enter' && viewSnapshot(snapshot)}
                    role="button" tabindex="0"
                    class="text-left bg-surface-800/50 border border-white/6 rounded-3xl p-5 hover:scale-[1.02] active:scale-[0.98] transition-all group overflow-hidden relative cursor-pointer"
                  >
                    <div class="absolute inset-0 bg-gradient-to-br from-primary-500/8 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div class="flex items-center justify-between mb-4 relative z-10">
                      <div>
                        <h3 class="text-base font-black text-white italic tracking-tight">{snapshot.name}</h3>
                        <p class="text-[9px] text-gray-600 uppercase font-black tracking-widest mt-0.5">
                          {new Date(snapshot.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                        </p>
                      </div>
                      <button
                        onclick={(e) => { e.stopPropagation(); deleteSnapshot(snapshot.id); }}
                        aria-label="Verwijderen"
                        class="p-2 rounded-2xl bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white transition-all opacity-0 group-hover:opacity-100"
                      >
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                      </button>
                    </div>
                    <div class="grid grid-cols-3 gap-2 relative z-10">
                      {#each snapshot.subjects.slice(0, 3) as sub}
                        <div class="px-2 py-2 rounded-2xl bg-surface-950 border border-white/5 flex flex-col items-center">
                          <span class="text-[9px] font-black text-gray-600 uppercase tracking-tighter truncate w-full text-center mb-0.5">{sub.abbr.slice(0, 3)}</span>
                          <span class="text-sm font-black {sub.avg >= $userSettings.insufficientThreshold ? 'text-primary-400' : 'text-red-400'} italic">{(sub.avg || 0).toFixed(1)}</span>
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

<style>
  .glass {
    background: rgba(30, 41, 59, 0.45);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.06);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
  }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
