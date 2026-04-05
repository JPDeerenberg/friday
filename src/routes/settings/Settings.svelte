<script lang="ts">
  import { userSettings } from '$lib/stores';
  import { currentPage } from '$lib/stores';
  import { triggerTestNotification, notifyNewMessage, notifyNewGrade, notifyDeadline, notifyCalendarChange,
           triggerSync, getDebugInfo, getSyncStateDebug, clearSyncState, setSyncInterval } from '$lib/api';
  import { fade, fly, slide } from 'svelte/transition';
  import { onMount } from 'svelte';

  let isMobile = $state(false);
  let testingNotification = $state<string | null>(null);

  // --- Debug panel state ---
  let debugOpen = $state(false);
  let debugInfo = $state<Record<string, any> | null>(null);
  let debugLoading = $state(false);
  let syncStateRaw = $state<string | null>(null);
  let syncStateVisible = $state(false);
  let clearStateResult = $state<string | null>(null);
  let forceSyncBusy = $state(false);
  let intervalSeconds = $state(300); // 5 min default
  let intervalResult = $state<string | null>(null);
  let logs = $state<{ time: string; level: 'info' | 'warn' | 'error'; msg: string }[]>([]);

  function addLog(level: 'info' | 'warn' | 'error', msg: string) {
    const time = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logs = [{ time, level, msg }, ...logs].slice(0, 50);
  }

  onMount(() => {
    isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  });

  function goBack() {
    currentPage.set('dashboard');
  }

  function updateToggle(id: string, value: boolean) {
    userSettings.update(s => ({ ...s, [id]: value }));
  }

  function updateNumber(id: string, value: string) {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      userSettings.update(s => ({ ...s, [id]: num }));
    }
  }

  async function testNotificationType(type: string, title: string, message: string) {
    testingNotification = type;
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      switch (type) {
        case 'message': await notifyNewMessage(title, message, 'Test Sender'); break;
        case 'grade':   await notifyNewGrade(title, message, '12345'); break;
        case 'deadline': await notifyDeadline(title, message, '67890'); break;
        case 'calendar': await notifyCalendarChange(title, message, 'event_123'); break;
        default: await triggerTestNotification();
      }
    } catch (e) {
      alert('Fout bij het versturen: ' + e);
    } finally {
      testingNotification = null;
    }
  }

  async function openDndSettings() {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_notification_policy_settings');
    } catch (e) {
      alert('Kan instellingen niet openen: ' + e);
    }
  }

  // --- Debug actions ---
  async function loadDebugInfo() {
    debugLoading = true;
    addLog('info', 'Fetching debug info...');
    try {
      const raw = await getDebugInfo();
      debugInfo = JSON.parse(raw);
      addLog('info', `Debug info loaded. Token: ${debugInfo?.tokenFile?.exists ? '✅' : '❌'}`);
    } catch (e) {
      addLog('error', `Failed to load debug info: ${e}`);
      debugInfo = null;
    } finally {
      debugLoading = false;
    }
  }

  async function loadSyncState() {
    addLog('info', 'Fetching sync_state.json...');
    try {
      const result = await getSyncStateDebug();
      syncStateRaw = result;
      syncStateVisible = true;
      if (result.startsWith('STATE_FILE_NOT_FOUND')) {
        const paths = result.split('\n').slice(2).join(', ');
        addLog('warn', `State file not found. Checked: ${paths}`);
      } else {
        const pathLine = result.split('\n')[0] ?? '';
        addLog('info', `State file gevonden — ${pathLine} (${result.length} chars)`);
      }
    } catch (e) {
      addLog('error', `Failed to read state: ${e}`);
      syncStateRaw = `Error: ${e}`;
      syncStateVisible = true;
    }
  }

  async function doClearState() {
    addLog('warn', 'Clearing sync state...');
    try {
      clearStateResult = await clearSyncState();
      addLog('info', `State cleared: ${clearStateResult}`);
      syncStateRaw = null;
      syncStateVisible = false;
      await new Promise(r => setTimeout(r, 800));
      await loadDebugInfo();
    } catch (e) {
      clearStateResult = `Error: ${e}`;
      addLog('error', `Clear state failed: ${e}`);
    }
  }

  async function doForceSync() {
    forceSyncBusy = true;
    addLog('info', 'Triggering force sync...');
    try {
      await triggerSync();
      addLog('info', 'Force sync triggered ✅ — wachten op resultaat...');
      await new Promise(r => setTimeout(r, 5000));
      addLog('info', 'Auto-refresh na sync...');
      await loadDebugInfo();
      await loadSyncState();
    } catch (e) {
      addLog('error', `Force sync failed: ${e}`);
    } finally {
      forceSyncBusy = false;
    }
  }

  async function applyInterval() {
    addLog('info', `Setting interval to ${intervalSeconds}s (${Math.round(intervalSeconds/60)} min)...`);
    try {
      intervalResult = await setSyncInterval(intervalSeconds);
      addLog('info', `Interval set: ${intervalResult}`);
    } catch (e) {
      intervalResult = `Error: ${e}`;
      addLog('error', `Set interval failed: ${e}`);
    }
  }

  function toggleDebug() {
    debugOpen = !debugOpen;
    if (debugOpen && !debugInfo) loadDebugInfo();
  }

  const sections: any[] = [
    {
      title: 'Agenda',
      settings: [
        { id: 'showWeekend', label: 'Toon Weekend', description: 'Laat zaterdag en zondag zien in de agenda.', type: 'toggle' },
        { id: 'hideCancelled', label: 'Uitgevallen lessen verbergen', description: 'Verberg lessen die als uitgevallen zijn gemarkeerd.', type: 'toggle' },
        { id: 'combineLessons', label: 'Lessen combineren', description: 'Combineer opeenvolgende lessen van hetzelfde vak.', type: 'toggle' },
        { id: 'showBreakSeparator', label: 'Pauze indicatie', description: 'Toon pauzes tussen lessen met hun duur.', type: 'toggle' },
      ]
    },
    {
      title: 'Cijfers',
      settings: [
        { id: 'roundedGraphs', label: 'Afgeronde Grafieken', description: 'Maak de lijnen in de grafieken gladder.', type: 'toggle' },
        { id: 'highlightFailing', label: 'Onvoldoendes Markeren', description: 'Geef onvoldoendes een rode kleur.', type: 'toggle' },
        { id: 'decimalPoints', label: 'Decimalen', description: 'Aantal decimalen voor gemiddelden.', type: 'number', min: 0, max: 2 },
        { id: 'insufficientThreshold', label: 'Onvoldoende Grens', description: 'Cijfer waaronder iets als onvoldoende wordt gezien.', type: 'number', step: 0.1, min: 1, max: 10 },
      ]
    },
    {
      title: 'Thema',
      settings: [
        { id: 'themeColor', label: 'Primaire Kleur', description: 'Kies de hoofdkleur van de app.', type: 'theme-picker' },
        { id: 'backgroundMode', label: 'Achtergrond', description: 'Kies hoe donker de achtergrond moet zijn.', type: 'select', options: [
          { value: 'normal', label: 'Normaal (Getint)' },
          { value: 'amoled', label: 'AMOLED (Zwart)' }
        ]},
      ]
    },
    {
      title: 'Meldingen',
      settings: [
        { id: 'notifyMessages', label: 'Berichten', description: 'Melding bij nieuwe berichten.', type: 'toggle', notificationType: 'message' },
        { id: 'notifyGrades', label: 'Nieuwe Cijfers', description: 'Melding bij nieuwe cijfers.', type: 'toggle', notificationType: 'grade' },
        { id: 'notifyDeadlines', label: 'Deadlines', description: 'Melding bij opdrachten en deadlines.', type: 'toggle', notificationType: 'deadline' },
        { id: 'notifyCalendar', label: 'Agenda Wijzigingen', description: 'Melding bij agenda wijzigingen.', type: 'toggle', notificationType: 'calendar' },
        { id: 'notifyAutoDnd', label: 'Autom. Niet Storen', description: 'Zet DND aan tijdens lessen (Android DND toegang nodig).', type: 'toggle' },
      ],
      hideIfDesktop: true
    },
    {
      title: 'Meldingen Testen',
      settings: [
        { id: 'testMessage', label: 'Bericht Notificatie', description: 'Test bericht notificatie.', type: 'action', action: () => testNotificationType('message', 'Nieuw Bericht', 'Je hebt een nieuw bericht van Test Sender') },
        { id: 'testGrade', label: 'Cijfer Notificatie', description: 'Test cijfer notificatie.', type: 'action', action: () => testNotificationType('grade', 'Nieuw Cijfer', 'Er is een nieuw cijfer toegevoegd') },
        { id: 'testDeadline', label: 'Deadline Notificatie', description: 'Test deadline notificatie.', type: 'action', action: () => testNotificationType('deadline', 'Deadline Aankomst', 'Een opdracht deadline nadert') },
        { id: 'testCalendar', label: 'Agenda Notificatie', description: 'Test agenda notificatie.', type: 'action', action: () => testNotificationType('calendar', 'Agenda Gewijzigd', 'Er is een wijziging in je agenda') },
        { id: 'testBasic', label: 'Basis Test', description: 'Standaard test notificatie.', type: 'action', action: () => testNotificationType('test', 'Test Notificatie', 'Dit is een test van het Friday meldingen systeem!') },
        { id: 'openDndSettings', label: 'DND Toegang', description: 'Open Android instellingen voor Niet Storen toegang.', type: 'action', action: () => openDndSettings() },
      ],
      hideIfDesktop: true
    }
  ];

  const themeColors = [
    { id: 'violet', bg: 'bg-[#a855f7]', label: 'Violet' },
    { id: 'pink', bg: 'bg-[#ec4899]', label: 'Roze' },
    { id: 'red', bg: 'bg-[#ef4444]', label: 'Rood' },
    { id: 'orange', bg: 'bg-[#fb923c]', label: 'Oranje' },
    { id: 'yellow', bg: 'bg-[#eab308]', label: 'Geel' },
    { id: 'green', bg: 'bg-[#22c55e]', label: 'Groen' },
    { id: 'cyan', bg: 'bg-[#06b6d4]', label: 'Cyaan' },
    { id: 'blue', bg: 'bg-[#3b82f6]', label: 'Blauw' },
  ];

  function updateSetting(id: string, value: any) {
    userSettings.update(s => ({ ...s, [id]: value }));
  }

  function intervalLabel(s: number) {
    if (s < 120) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} uur`;
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <!-- Sticky Header -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-3">
    <div class="flex items-center gap-4">
      <button onclick={goBack} class="p-2 text-gray-500 hover:text-primary-400 transition-all font-black text-lg" aria-label="Terug">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <h1 class="text-xl font-black text-gray-100 italic tracking-tighter">Instellingen</h1>
    </div>
  </header>

  <main class="max-w-3xl mx-auto w-full p-6 space-y-10 pb-20">
    {#each sections as section, i}
      {#if !section.hideIfDesktop || isMobile}
        <section in:fly={{ y: 20, delay: i * 100 }} class="space-y-4">
          <h2 class="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] px-2">{section.title}</h2>
        
        <div class="space-y-2">
          {#each section.settings as setting}
            <div class="glass p-5 rounded-3xl border-white/5 flex items-center justify-between gap-6 transition-all hover:bg-surface-800/40">
              <div class="flex-1">
                <p class="text-sm font-bold text-gray-100">{setting.label}</p>
                <p class="text-[10px] text-gray-500 font-medium mt-1 uppercase tracking-widest leading-relaxed">{setting.description}</p>
              </div>

              {#if setting.type === 'toggle'}
                <label class="relative inline-flex items-center cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={$userSettings[setting.id]} 
                    onchange={(e) => updateToggle(setting.id, e.currentTarget.checked)}
                    class="sr-only peer"
                  >
                  <div class="w-11 h-6 bg-surface-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-500/80 shadow-inner"></div>
                </label>
              {:else if setting.type === 'number'}
                <input 
                  type="number" 
                  value={$userSettings[setting.id]}
                  oninput={(e) => updateNumber(setting.id, e.currentTarget.value)}
                  min={setting.min}
                  max={setting.max}
                  step={setting.step ?? 1}
                  class="w-20 px-3 py-2 rounded-xl bg-surface-950 border border-surface-700 text-sm text-gray-100 text-center font-black focus:outline-none focus:border-primary-500 shadow-inner"
                />
              {:else if setting.type === 'theme-picker'}
                <div class="grid grid-cols-4 gap-3 py-1">
                  {#each themeColors as color}
                    <button
                      onclick={() => updateSetting(setting.id, color.id)}
                      class="group flex flex-col items-center gap-1.5"
                    >
                      <div class="w-10 h-10 rounded-full {color.bg} transition-all border-2
                                 {$userSettings[setting.id] === color.id 
                                   ? 'border-white scale-110 shadow-lg shadow-white/20' 
                                   : 'border-transparent opacity-60 group-hover:opacity-100 group-hover:scale-105 shadow-inner'}"></div>
                      <span class="text-[8px] font-black uppercase tracking-tighter text-gray-600 group-hover:text-gray-400 transition-colors">{color.label}</span>
                    </button>
                  {/each}
                </div>
              {:else if setting.type === 'select'}
                <select 
                  value={$userSettings[setting.id]}
                  onchange={(e) => updateSetting(setting.id, e.currentTarget.value)}
                  class="bg-surface-800 border-none text-gray-200 text-[10px] font-black uppercase tracking-widest rounded-xl px-4 py-2.5 outline-none cursor-pointer hover:bg-surface-700 transition-colors shadow-sm"
                >
                  {#each setting.options as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else if setting.type === 'action'}
                <button 
                  onclick={() => setting.action()}
                  disabled={testingNotification === setting.id.split('test')[1]}
                  class="bg-primary-500/15 text-primary-400 text-[10px] font-black uppercase tracking-widest rounded-xl px-5 py-2.5 hover:bg-primary-500/25 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-wait border border-primary-500/10 shadow-sm"
                >
                  {#if testingNotification === setting.id.split('test')[1]}
                    <span class="animate-pulse">⏳ Wachten...</span>
                  {:else}
                    Testen
                  {/if}
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </section>
      {/if}
    {/each}

    <!-- ===== DEBUG SECTION ===== -->
    <section in:fly={{ y: 20, delay: sections.length * 100 }}>
      <button
        onclick={toggleDebug}
        class="w-full flex items-center justify-between px-2 mb-4 group"
      >
        <h2 class="text-[10px] font-black text-gray-600 uppercase tracking-[0.3em] group-hover:text-amber-500 transition-colors flex items-center gap-2">
          <svg class="w-3 h-3 text-amber-500/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          Systeem Debug
        </h2>
        <div class="flex items-center gap-2">
          <span class="text-[9px] font-black text-gray-700 uppercase tracking-widest">
            {debugOpen ? 'Verbergen' : 'Tonen'}
          </span>
          <svg
            class="w-4 h-4 text-gray-600 transition-transform duration-200 {debugOpen ? 'rotate-180' : ''}"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
          ><path d="m6 9 6 6 6-6"/></svg>
        </div>
      </button>

      {#if debugOpen}
        <div transition:slide={{ duration: 250 }} class="space-y-4">

          <!-- System info cards -->
          {#if debugInfo}
            <div class="debug-card rounded-3xl p-5 space-y-4 shadow-xl">
              <p class="debug-label">Systeeminformatie</p>
              <div class="grid grid-cols-2 gap-3">
                <div class="info-tile">
                  <span class="info-tile-icon text-amber-500">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L22 22"/></svg>
                  </span>
                  <div class="min-w-0">
                    <p class="info-tile-title">Token</p>
                    <p class="info-tile-value">{debugInfo.tokenFile?.exists ? `Geldig (${debugInfo.tokenFile.sizeBytes}B)` : 'Missend'}</p>
                  </div>
                </div>
                <div class="info-tile">
                  <span class="info-tile-icon text-primary-400">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                  </span>
                  <div class="min-w-0">
                    <p class="info-tile-title">Sync State</p>
                    <p class="info-tile-value truncate">{debugInfo.stateFile?.summary || 'Geen bestand'}</p>
                  </div>
                </div>
                <div class="info-tile col-span-2">
                  <span class="info-tile-icon text-gray-500">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  </span>
                  <div class="min-w-0">
                    <p class="info-tile-title">Data Path</p>
                    <p class="info-tile-value font-mono text-[9px] break-all opacity-80">{debugInfo.dataDir ?? '?'}</p>
                  </div>
                </div>
              </div>
              <button onclick={loadDebugInfo} disabled={debugLoading}
                class="debug-btn-secondary w-full flex items-center justify-center gap-2">
                <svg class="w-3.5 h-3.5 {debugLoading ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                {debugLoading ? 'Laden...' : 'Gegevens verversen'}
              </button>
            </div>
          {:else}
            <div class="debug-card rounded-3xl p-8 flex flex-col items-center justify-center gap-4 text-center">
               <svg class="w-10 h-10 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
               <p class="text-[10px] font-black text-gray-600 uppercase tracking-widest max-w-[150px]">Geen debug info geladen</p>
               <button onclick={loadDebugInfo} class="debug-btn-primary px-8">Info ophalen</button>
            </div>
          {/if}

          <!-- Sync interval -->
          <div class="debug-card rounded-3xl p-6 space-y-4">
            <div class="flex items-center justify-between">
              <p class="debug-label">Sync frequentie</p>
              <div class="px-3 py-1 bg-amber-500/15 rounded-lg border border-amber-500/20">
                <span class="text-xs font-black text-amber-500 tabular-nums">{intervalLabel(intervalSeconds)}</span>
              </div>
            </div>
            <input
              type="range"
              min="60" max="3600" step="60"
              bind:value={intervalSeconds}
              class="w-full h-2 bg-surface-800 rounded-full appearance-none cursor-pointer accent-amber-500 shadow-inner"
            />
            <div class="flex gap-2">
              {#each [60, 300, 900, 1800, 3600] as preset}
                <button
                  onclick={() => { intervalSeconds = preset; }}
                  class="flex-1 text-[9px] font-black uppercase tracking-widest rounded-xl py-2
                    {intervalSeconds === preset
                      ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/20'
                      : 'bg-surface-800 text-gray-500 hover:text-gray-300 transition-all active:scale-95'}"
                >
                  {intervalLabel(preset)}
                </button>
              {/each}
            </div>
            <button onclick={applyInterval} class="debug-btn-primary w-full py-3.5 shadow-lg shadow-amber-500/20">
              Interval Toepassen
            </button>
            {#if intervalResult}
              <p class="text-[9px] text-amber-400 font-mono text-center bg-amber-500/5 py-2 rounded-lg">{intervalResult}</p>
            {/if}
          </div>

          <!-- Actions row -->
          <div class="grid grid-cols-2 gap-3">
            <button
              onclick={doForceSync}
              disabled={forceSyncBusy}
              class="debug-card rounded-3xl p-6 flex flex-col items-center gap-3 hover:bg-surface-700/40 transition-all active:scale-[0.98] disabled:opacity-50 ring-1 ring-white/5"
            >
              <div class="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center shadow-inner">
                <svg class="w-6 h-6 {forceSyncBusy ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
              </div>
              <div class="text-center">
                <p class="text-[11px] font-black text-gray-200 uppercase tracking-widest italic">Force Sync</p>
                <p class="text-[8px] text-gray-600 font-bold uppercase mt-1">Nu ophalen</p>
              </div>
            </button>
            <button
              onclick={doClearState}
              class="debug-card rounded-3xl p-6 flex flex-col items-center gap-3 hover:bg-red-500/10 transition-all active:scale-[0.98] ring-1 ring-white/5"
            >
              <div class="w-12 h-12 rounded-2xl bg-red-500/10 text-red-400 flex items-center justify-center shadow-inner">
                <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              </div>
              <div class="text-center">
                <p class="text-[11px] font-black text-red-400 uppercase tracking-widest italic">Baseline</p>
                <p class="text-[8px] text-gray-600 font-bold uppercase mt-1">State wissen</p>
              </div>
            </button>
          </div>

          <!-- Logs -->
          <div class="debug-card rounded-3xl p-5 space-y-4 overflow-hidden relative">
            <div class="flex items-center justify-between relative z-10">
              <p class="debug-label">Systeemboodschappen</p>
              <button onclick={() => logs = []} class="text-[10px] font-black text-gray-600 hover:text-red-400 transition-colors uppercase tracking-widest">
                Opschonen
              </button>
            </div>
            <div class="space-y-2 max-h-60 overflow-y-auto no-scrollbar relative z-10 pr-1">
              {#each logs as log}
                <div class="flex gap-3 items-start p-2.5 rounded-xl bg-surface-950/40 border border-white/5" transition:slide={{ duration: 150 }}>
                  <span class="text-[10px] font-black text-gray-700 shrink-0 tabular-nums">{log.time}</span>
                  <div class="flex-1 min-w-0">
                    <p class="text-[10px] font-mono text-gray-400 break-words leading-relaxed">
                      <span class="{log.level === 'error' ? 'text-red-500' : log.level === 'warn' ? 'text-amber-500' : 'text-emerald-500'} font-black mr-2">
                        {log.level.toUpperCase()}
                      </span>
                      {log.msg}
                    </p>
                  </div>
                </div>
              {:else}
                <div class="py-12 flex flex-col items-center justify-center opacity-30">
                  <svg class="w-10 h-10 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  <p class="text-[9px] font-black uppercase tracking-[0.2em]">Geen activiteiten</p>
                </div>
              {/each}
            </div>
            <!-- Glow effect -->
            <div class="absolute -bottom-10 -right-10 w-40 h-40 bg-primary-500/5 blur-[60px] rounded-full"></div>
          </div>
        </div>
      {/if}
    </section>

    <div class="pt-10 flex flex-col items-center gap-2">
      <div class="w-10 h-[1px] bg-surface-800"></div>
      <p class="text-[9px] text-gray-600 font-black uppercase tracking-[0.4em] text-center">Version 1.2.0 • Friday App</p>
    </div>
  </main>
</div>

<style>
  .glass {
    background: oklch(0.15 0.02 290 / 0.5);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid oklch(1 0 0 / 0.05);
    box-shadow: 0 10px 30px -10px rgba(0,0,0,0.4);
  }

  .debug-card {
    background: oklch(0.1 0.01 290 / 0.8);
    border: 1px solid oklch(0.8 0.15 80 / 0.1);
    backdrop-filter: blur(30px);
  }

  .debug-label {
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgb(75, 85, 99);
  }

  .info-tile {
    display: flex;
    align-items: center;
    gap: 12px;
    background: oklch(1 0 0 / 0.02);
    border-radius: 18px;
    padding: 12px 16px;
    min-width: 0;
    border: 1px solid oklch(1 0 0 / 0.03);
  }

  .info-tile-icon {
    flex-shrink: 0;
  }

  .info-tile-title {
    font-size: 8px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: rgb(107, 114, 128);
    line-height: 1;
  }

  .info-tile-value {
    font-size: 11px;
    font-weight: 800;
    color: rgb(229, 231, 235);
    margin-top: 4px;
    line-height: normal;
  }

  .debug-btn-primary {
    background: oklch(0.7 0.15 80 / 0.15);
    color: oklch(0.8 0.15 80);
    font-size: 10px;
    font-weight: 950;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    border-radius: 16px;
    padding: 12px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    border: 1px solid oklch(0.8 0.15 80 / 0.2);
    font-style: italic;
  }
  .debug-btn-primary:active { transform: scale(0.96); }

  .debug-btn-secondary {
    background: oklch(1 0 0 / 0.05);
    color: oklch(1 0 0 / 0.6);
    font-size: 10px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    border-radius: 14px;
    padding: 10px;
    transition: all 0.2s ease;
    border: 1px solid oklch(1 0 0 / 0.08);
  }
  .debug-btn-secondary:hover { background: oklch(1 0 0 / 0.1); color: white; }

  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
