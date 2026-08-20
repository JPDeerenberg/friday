<script lang="ts">
  import { userSettings } from '$lib/stores';
  import { currentPage } from '$lib/stores';
  import { triggerTestNotification, notifyNewMessage, notifyNewGrade, notifyDeadline, notifyCalendarChange,
           triggerSync, getDebugInfo, getSyncStateDebug, clearSyncState, setSyncInterval, getSyncInterval, getNightSleepConfig, setNightSleepConfig, getDisableAllNotifications, setDisableAllNotifications, getDndAccessStatus,
           exportAllData } from '$lib/api';
  import { getAiConfig, setAiConfig, validateAiKey, listAiModels, type AiConfig, type AiProviderType, AI_PROVIDERS } from '$lib/ai';
  import { sectionIcon } from '$lib/icons';
  import ColorSwatchPicker from '$lib/components/ColorSwatchPicker.svelte';
  import Switch from '$lib/components/Switch.svelte';
  import Button from '$lib/components/Button.svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { onMount } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';

  let isMobile = $state(false);
  let testingNotification = $state<string | null>(null);
  let activeSection = $state('ai');
  let activeSectionTitle = $state('AI Assistent');
  // Layout: viewport-based (matches the app's `md` breakpoint), used for sidebar vs master–detail.
  let isDesktopLayout = $state(true);
  // Mobile master–detail: 'list' shows the section list, 'detail' shows a section page
  let mobilePanel = $state<'list' | 'detail'>('list');

  // Section navigation items (sidebar on desktop, list on mobile)
  const navItems = $derived.by(() => {
    const items = sections
      .filter(s => !s.hideIfDesktop || isMobile)
      .map(s => ({ id: s.id, title: s.title }));
    items.push({ id: 'debug', title: 'Systeem Debug' });
    items.push({ id: 'about', title: 'Over de app' });
    return items;
  });

  function selectSection(id: string) {
    activeSection = id;
    const match = navItems.find(n => n.id === id);
    if (match) activeSectionTitle = match.title;
    if (!isDesktopLayout) {
      mobilePanel = 'detail';
    } else {
      // Scroll the content area back to top for a clean section switch
      document.querySelector('.settings-scroll')?.scrollTo({ top: 0 });
    }
  }

  function goToSectionList() {
    mobilePanel = 'list';
  }

  // --- Debug panel state ---
  let debugOpen = $state(false);
  let debugInfo = $state<Record<string, any> | null>(null);
  let debugLoading = $state(false);
  let syncStateRaw = $state<string | null>(null);
  let syncStateVisible = $state(false);
  let clearStateResult = $state<string | null>(null);
  let forceSyncBusy = $state(false);
  let intervalSeconds = $state(900); // 15 min default (WorkManager minimum)
  let intervalResult = $state<string | null>(null);
  let disableSyncAtNight = $state(false);
  let disableSyncAtNightStart = $state(22);
  let disableSyncAtNightEnd = $state(7);
  let disableAllNotifications = $state(false);
  let dndAccessGranted = $state<boolean | null>(null);
  let logs = $state<{ time: string; level: 'info' | 'warn' | 'error'; msg: string }[]>([]);
  let exportBusy = $state(false);
  let exportResult = $state<string | null>(null);
  let pickingDir = $state(false);

  // --- AI config state ---
  let aiApiKey = $state('');
  let aiBaseUrl = $state('https://api.openai.com/v1');
  let aiModel = $state('gpt-4o-mini');
  let aiEnabled = $state(false);
  let aiProvider = $state<AiProviderType>('openai');
  let aiUseDataAccess = $state(true); // Whether to use tool calling with Magister data
  let aiTesting = $state(false);
  let aiTestResult = $state<string | null>(null);
  let aiTestSuccess = $state(false);
  let aiSaving = $state(false);
  let aiLoaded = $state(false);
  let aiShowKey = $state(false);
  /** True when an API key is stored on-device (the key itself is never sent to the frontend). */
  let aiHasKey = $state(false);

  // --- GitHub repo info ---
  let repoStats = $state<{ stars: number; forks: number; openIssues: number } | null>(null);
  let repoStatsError = $state<string | null>(null);

  function addLog(level: 'info' | 'warn' | 'error', msg: string) {
    const time = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logs = [{ time, level, msg }, ...logs].slice(0, 50);
  }



  onMount(() => {
    isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // Viewport-based layout detection (matches the app's `md` Tailwind breakpoint = 768px)
    const mq = window.matchMedia('(min-width: 768px)');
    isDesktopLayout = mq.matches;
    const onMqChange = (e: MediaQueryListEvent) => { isDesktopLayout = e.matches; };
    mq.addEventListener('change', onMqChange);
    window.addEventListener('resize', onMqChange as any);

    // Load sync interval from native
    getSyncInterval().then((interval) => {
        if (interval && interval > 0) {
            intervalSeconds = interval;
        }
    }).catch(e => {
        console.error("Failed to load sync interval", e);
    });

    getNightSleepConfig().then((config) => {
        if (config) {
            disableSyncAtNight = config.enabled;
            disableSyncAtNightStart = config.startHour;
            disableSyncAtNightEnd = config.endHour;
        }
    }).catch(e => {
        console.error("Failed to load night sleep config", e);
    });

    getDisableAllNotifications().then((disabled) => {
        disableAllNotifications = disabled;
    }).catch(e => {
        console.error("Failed to load disable all notifications config", e);
    });

    getDndAccessStatus().then((granted) => {
        dndAccessGranted = granted;
    }).catch(e => {
        console.error("Failed to load DND access status", e);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        getDndAccessStatus().then((granted) => { dndAccessGranted = granted; }).catch(() => {});
      }
    });

    // Fetch GitHub repo stats
    fetch('https://api.github.com/repos/JPDeerenberg/friday')
      .then(r => {
        if (!r.ok) throw new Error(`Status ${r.status}`);
        return r.json();
      })
      .then(data => {
        repoStats = { stars: data.stargazers_count, forks: data.forks_count, openIssues: data.open_issues_count };
      })
      .catch(e => {
        repoStatsError = `Kon repo info niet laden: ${e.message || e}`;
      });

    // Load AI config
    getAiConfig().then((config: AiConfig) => {
      aiApiKey = config.api_key;
      aiHasKey = config.has_api_key;
      aiBaseUrl = config.base_url;
      aiModel = config.model;
      aiEnabled = config.enabled;
      aiProvider = config.provider || 'openai';
      aiUseDataAccess = config.use_data_access ?? true;
      aiLoaded = true;
    }).catch(e => {
      console.error("Failed to load AI config", e);
      aiLoaded = true;
    });
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
    const clamped = Math.max(900, intervalSeconds); // WorkManager 15-min floor
    addLog('info', `Setting interval to ${clamped}s (${Math.round(clamped/60)} min)...`);
    try {
      intervalResult = await setSyncInterval(clamped);
      addLog('info', `Interval set: ${intervalResult}`);
    } catch (e) {
      intervalResult = `Error: ${e}`;
      addLog('error', `Set interval failed: ${e}`);
    }
  }

  async function applyNightSleep() {
    addLog('info', `Setting night sleep to ${disableSyncAtNight} (${disableSyncAtNightStart}-${disableSyncAtNightEnd})...`);
    try {
      const result = await setNightSleepConfig(disableSyncAtNight, disableSyncAtNightStart, disableSyncAtNightEnd);
      addLog('info', `Night sleep set: ${result}`);
    } catch (e) {
      addLog('error', `Set night sleep failed: ${e}`);
    }
  }

  async function applyDisableAllNotifications() {
    addLog('info', `Setting disable all notifications to ${disableAllNotifications}...`);
    try {
      const result = await setDisableAllNotifications(disableAllNotifications);
      addLog('info', `Disable notifications set: ${result}`);
    } catch (e) {
      addLog('error', `Set disable notifications failed: ${e}`);
    }
  }

  async function doExport() {
    exportBusy = true;
    exportResult = null;
    addLog('info', 'Exporteren gestart...');
    try {
      const result = await exportAllData();
      if (result.success) {
        if (isMobile) {
          const zipFile = result.files[0] ?? 'friday-export.zip';
          exportResult = `✅ 1 zip-bestand gedeeld: ${zipFile}`;
          addLog('info', `Export voltooid: ${zipFile} gedeeld`);
        } else {
          const fileList = result.files.join(', ');
          exportResult = `✅ ${result.files.length} bestanden geëxporteerd: ${fileList}`;
          addLog('info', `Export voltooid: ${result.files.length} bestanden`);
        }
      } else {
        exportResult = `❌ Fout: ${result.error ?? 'Onbekende fout'}`;
        addLog('error', `Export mislukt: ${result.error}`);
      }
    } catch (e) {
      exportResult = `❌ Fout: ${e}`;
      addLog('error', `Export mislukt: ${e}`);
    } finally {
      exportBusy = false;
    }
  }

  async function pickDownloadDir() {
    pickingDir = true;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Kies downloadmap',
      });
      if (selected && typeof selected === 'string') {
        userSettings.update(s => ({ ...s, downloadDir: selected }));
      }
    } catch (e) {
      console.error('Map kiezen mislukt:', e);
    } finally {
      pickingDir = false;
    }
  }

  function clearDownloadDir() {
    userSettings.update(s => ({ ...s, downloadDir: '' }));
  }

  function toggleDebug() {
    debugOpen = !debugOpen;
    if (debugOpen && !debugInfo) loadDebugInfo();
  }

  async function saveAiConfig() {
    aiSaving = true;
    try {
      await setAiConfig(aiApiKey, aiBaseUrl, aiModel, aiEnabled, aiProvider, aiUseDataAccess);
      aiTestResult = null;
    } catch (e) {
      aiTestResult = `❌ Opslaan mislukt: ${e}`;
      aiTestSuccess = false;
    } finally {
      aiSaving = false;
    }
  }

  async function testAiConnection() {
    aiTesting = true;
    aiTestResult = null;
    try {
      // Save first, then test
      await setAiConfig(aiApiKey, aiBaseUrl, aiModel, true, aiProvider, aiUseDataAccess);
      const valid = await validateAiKey();
      if (valid) {
        aiTestResult = '✅ Verbinding succesvol! AI is klaar voor gebruik.';
        aiTestSuccess = true;
      } else {
        aiTestResult = '❌ Verbinding mislukt. Controleer je API-sleutel en URL.';
        aiTestSuccess = false;
      }
    } catch (e) {
      aiTestResult = `❌ Fout: ${e}`;
      aiTestSuccess = false;
    } finally {
      aiTesting = false;
    }
  }

  const aiBaseUrlPresets = [
    { value: 'https://api.openai.com/v1', label: 'OpenAI' },
    { value: 'http://localhost:11434/v1', label: 'Ollama (lokaal)' },
    { value: 'http://localhost:1234/v1', label: 'LM Studio (lokaal)' },
  ];

  const sections: any[] = [
    {
      id: 'ai',
      title: 'AI Assistent',
      description: 'Configureer AI voor studiedvies, cijferanalyse, samenvattingen en meer.',
      isAi: true,
    },
    {
      id: 'agenda',
      title: 'Agenda',
      settings: [
        { id: 'showWeekend', label: 'Toon Weekend', description: 'Laat zaterdag en zondag zien in de agenda.', type: 'toggle' },
        { id: 'weekView', label: 'Weekweergave', description: 'Toon een weekoverzicht met tijdlijn op grotere schermen.', type: 'select', options: [
          { value: 'auto', label: 'Automatisch (desktop)' },
          { value: 'on', label: 'Altijd aan' },
          { value: 'off', label: 'Altijd uit' }
        ]},
        { id: 'hideCancelled', label: 'Uitgevallen lessen verbergen', description: 'Verberg lessen die als uitgevallen zijn gemarkeerd.', type: 'toggle' },
        { id: 'combineLessons', label: 'Lessen combineren', description: 'Combineer opeenvolgende lessen van hetzelfde vak.', type: 'toggle' },
        { id: 'showBreakSeparator', label: 'Pauze Indicatie', description: 'Toon pauzes tussen lessen met hun duur.', type: 'toggle' },
        { id: 'breakThresholdMinutes', label: 'Pauze Drempel (min)', description: 'Aantal minuten pauze voordat lessen worden gesplitst op de homepagina.', type: 'number', min: 1, max: 120, step: 1 },
      ]
    },
    {
      id: 'cijfers',
      title: 'Cijfers',
      settings: [
        { id: 'roundedGraphs', label: 'Afgeronde Grafieken', description: 'Maak de lijnen in de grafieken gladder.', type: 'toggle' },
        { id: 'highlightFailing', label: 'Onvoldoendes Markeren', description: 'Geef onvoldoendes een rode kleur.', type: 'toggle' },
        { id: 'decimalPoints', label: 'Decimalen', description: 'Aantal decimalen voor gemiddelden.', type: 'number', min: 0, max: 2 },
        { id: 'insufficientThreshold', label: 'Onvoldoende Grens', description: 'Cijfer waaronder iets als onvoldoende wordt gezien.', type: 'number', step: 0.1, min: 1, max: 10 },
      ]
    },
    {
      id: 'thema',
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
      id: 'meldingen',
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
      id: 'meldingen-testen',
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
    },
    {
      id: 'exporteren',
      title: 'Exporteren',
      settings: [
        { id: 'exportAll', label: 'Alles Exporteren', description: 'Exporteer al je data (lessen, cijfers, opdrachten, etc.) naar JSON-bestanden.', type: 'action', action: () => doExport() },
      ]
    },
    {
      id: 'downloads',
      title: 'Downloads',
      settings: [
        { id: 'downloadDir', label: 'Downloadmap', description: 'Kies waar gedownloade bestanden worden opgeslagen. Leeg = systeemstandaard.', type: 'download-dir' },
      ]
    },
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

<div class="flex flex-col h-full bg-surface-950">
  <!-- Header -->
  <header class="shrink-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-3">
    <div class="flex items-center gap-3">
      <button
        onclick={() => (!isDesktopLayout && mobilePanel === 'detail') ? goToSectionList() : goBack()}
        class="p-2 -ml-2 rounded-full text-gray-500 hover:text-primary-400 transition-all"
        aria-label="Terug"
      >
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <h1 class="text-title-large text-gray-100 truncate">
        {!isDesktopLayout && mobilePanel === 'detail' ? activeSectionTitle : 'Instellingen'}
      </h1>
    </div>
  </header>

  {#if !isDesktopLayout && mobilePanel === 'list'}
    <!-- Mobile: section list (master) -->
    <nav class="flex-1 overflow-y-auto p-3 space-y-1">
      {#each navItems as item}
        <button
          onclick={() => selectSection(item.id)}
          class="w-full flex items-center gap-3 px-3 py-3.5 rounded-m3-md transition-all text-left border border-transparent hover:bg-surface-800/60 active:scale-[0.99]"
        >
          <span class="text-primary-400 flex items-center justify-center w-8 h-8 rounded-m3-sm bg-primary-500/10 shrink-0">
            {@html sectionIcon(item.id)}
          </span>
          <span class="flex-1 text-title-small text-gray-100">{item.title}</span>
          <svg class="w-4 h-4 text-gray-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      {/each}
    </nav>
  {:else}
    <div class="flex flex-1 min-h-0">
    <!-- Desktop: section navigation sidebar -->
    <aside class="hidden md:flex flex-col w-56 shrink-0 border-r border-surface-800/50 bg-surface-900/40 h-full">
      <nav class="flex-1 py-4 px-2 space-y-1 overflow-y-auto no-scrollbar">
        {#each navItems as item}
          <button
            onclick={() => selectSection(item.id)}
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-m3-sm text-label-large transition-all text-left
              {activeSection === item.id
                ? 'bg-primary-container text-on-primary-container'
                : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}"
          >
            {@html sectionIcon(item.id)}
            <span class="truncate">{item.title}</span>
          </button>
        {/each}
      </nav>
    </aside>

    <main class="settings-scroll flex-1 overflow-y-auto">
      <div class="max-w-3xl mx-auto w-full p-6 space-y-10 pb-20">
        <!-- Desktop: active section title -->
        <div class="hidden md:flex items-center justify-between">
          <div>
            <h1 class="text-title-large text-gray-100">{activeSectionTitle}</h1>
            <p class="text-label-medium text-gray-500 mt-1">{sections.find(s => s.id === activeSection)?.description || 'Diagnoseer synchronisatie, notificaties en systeemstatus.'}</p>
          </div>
        </div>

    {#each sections as section, i}
      {#if (!section.hideIfDesktop || isMobile) && section.id === activeSection}
        <section id="settings-{section.id}" in:fly={{ y: 20, delay: 0 }} class="space-y-4">

        {#if section.isAi}
          <!-- AI Configuration Card -->
          {#if aiLoaded}
            <div class="glass p-6 rounded-m3-md border-primary-500/20 space-y-5 transition-all hover:bg-surface-800/40">
              <p class="text-body-medium text-gray-500 leading-relaxed">Configureer AI voor studiedvies, cijferanalyse, samenvattingen en meer.</p>

              <!-- Enable toggle -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-title-small text-gray-100">AI Assistent inschakelen</p>
                  <p class="text-label-medium text-gray-500 mt-1">Zet AI aan voor alle pagina's</p>
                </div>
                <Switch
                  checked={aiEnabled}
                  onCheckedChange={(v) => { aiEnabled = v; saveAiConfig(); }}
                  ariaLabel="AI Assistent inschakelen"
                />
              </div>

              <div class="w-full h-px bg-white/5"></div>

              <!-- API Key -->
              <div class="space-y-2">
                <label for="aiApiKey" class="text-label-medium text-gray-500">API Sleutel</label>
                <div class="flex gap-2">
                  <input
                    id="aiApiKey"
                    type={aiShowKey ? 'text' : 'password'}
                    bind:value={aiApiKey}
                    placeholder={aiHasKey ? '•••••••• (opgeslagen)' : 'sk-...'}
                    class="flex-1 bg-surface-800/80 border border-white/10 rounded-m3-xs px-4 py-3 text-body-medium text-white placeholder-gray-600 focus:outline-none focus:border-primary-500/50 transition-all font-mono"
                  />
                  <button
                    onclick={() => aiShowKey = !aiShowKey}
                    disabled={!aiApiKey}
                    class="px-3 py-2 rounded-m3-full bg-surface-800/60 border border-white/10 text-gray-400 hover:text-white transition-all text-label-medium disabled:opacity-40"
                  >
                    {aiShowKey ? 'Verberg' : 'Toon'}
                  </button>
                </div>
                {#if aiHasKey && !aiApiKey}
                  <p class="text-label-small text-gray-500">
                    Er is al een sleutel opgeslagen. Laat dit veld leeg om de huidige te behouden, of voer een nieuwe sleutel in om deze te vervangen.
                  </p>
                {/if}
              </div>

              <!-- Base URL -->
              <div class="space-y-2">
                <label for="aiBaseUrl" class="text-label-medium text-gray-500">API Basis URL</label>
                <input
                  id="aiBaseUrl"
                  type="text"
                  bind:value={aiBaseUrl}
                  class="w-full bg-surface-800/80 border border-white/10 rounded-m3-xs px-4 py-3 text-body-medium text-white placeholder-gray-600 focus:outline-none focus:border-primary-500/50 transition-all font-mono"
                />
                <div class="flex flex-wrap gap-2 mt-2">
                  {#each aiBaseUrlPresets as preset}
                    <button
                      onclick={() => aiBaseUrl = preset.value}
                      class="px-3 py-1.5 rounded-m3-sm bg-surface-800/60 border border-white/5 text-label-medium text-gray-400 hover:text-white hover:bg-surface-700/60 transition-all {aiBaseUrl === preset.value ? 'border-primary-500/30 text-primary-400' : ''}"
                    >
                      {preset.label}
                    </button>
                  {/each}
                </div>
              </div>

              <!-- Provider -->
              <div class="space-y-2">
                <span class="text-label-medium text-gray-500">AI Provider</span>
                <div class="grid grid-cols-2 gap-2">
                  {#each Object.entries(AI_PROVIDERS) as [key, info]}
                    <button
                      onclick={() => {
                        aiProvider = key as AiProviderType;
                        aiBaseUrl = info.defaultBaseUrl;
                        aiModel = info.defaultModel;
                      }}
                      class="px-3 py-2.5 rounded-m3-sm border text-label-medium transition-all text-left
 {aiProvider === key
 ? 'bg-primary-500/20 border-primary-500/40 text-primary-300 shadow-lg shadow-primary-500/10'
 : 'bg-surface-800/60 border-white/5 text-gray-400 hover:bg-surface-700/60 hover:text-gray-200'}"
                    >
                      <span class="block text-label-medium">{info.label}</span>
                      <span class="block text-label-small opacity-70 mt-0.5">{info.description}</span>
                    </button>
                  {/each}
                </div>
              </div>

              <!-- Model -->
              <div class="space-y-2">
                <label for="aiModel" class="text-label-medium text-gray-500">Model</label>
                <input
                  id="aiModel"
                  type="text"
                  bind:value={aiModel}
                  placeholder="gpt-4o-mini"
                  class="w-full bg-surface-800/80 border border-white/10 rounded-m3-xs px-4 py-3 text-body-medium text-white placeholder-gray-600 focus:outline-none focus:border-primary-500/50 transition-all"
                />
              </div>

              <div class="w-full h-px bg-white/5"></div>

              <!-- Data Access Toggle -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-title-small text-gray-100">Toegang tot schoolgegevens</p>
                  <p class="text-label-medium text-gray-500 mt-1 leading-relaxed">
                    Laat AI je rooster, cijfers, opdrachten en berichten uitlezen via tool calling
                  </p>
                </div>
                <Switch
                  checked={aiUseDataAccess}
                  onCheckedChange={(v) => aiUseDataAccess = v}
                  ariaLabel="Toegang tot schoolgegevens"
                />
              </div>

              {#if aiUseDataAccess}
                <div class="rounded-m3-md px-4 py-3 bg-primary-500/5 border border-primary-500/10 text-body-medium text-gray-400 leading-relaxed">
                  <span class="text-label-medium text-primary-400">✓ Data-toegang ingeschakeld</span><br>
                  De AI kan nu o.a.:
                  <ul class="mt-1 space-y-1 list-disc list-inside">
                    <li>Je lesrooster ophalen voor vandaag of morgen</li>
                    <li>Recente cijfers en gemiddelden bekijken</li>
                    <li>Huiswerk en opdrachten opzoeken</li>
                    <li>Berichten en absentie checken</li>
                    <li>Een compleet dagoverzicht geven</li>
                  </ul>
                </div>
              {:else}
                <div class="rounded-m3-md px-4 py-3 bg-amber-500/5 border border-amber-500/10 text-body-medium text-gray-400 leading-relaxed">
                  <span class="text-label-medium text-amber-400">⚠ Data-toegang uitgeschakeld</span><br>
                  De AI kan alleen algemene vragen beantwoorden zonder je schoolgegevens te zien.
                </div>
              {/if}

              <!-- Actions -->
              <div class="flex gap-3 pt-2">
                <Button
                  variant="filled"
                  onclick={saveAiConfig}
                  disabled={aiSaving}
                  class="flex-1"
                >
                  {aiSaving ? '⏳ Opslaan...' : 'Opslaan'}
                </Button>
                <button
                  onclick={testAiConnection}
                  disabled={aiTesting || (!aiApiKey && !aiHasKey)}
                  class="flex-1 py-3 rounded-m3-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all text-label-large disabled:opacity-50"
                >
                  {aiTesting ? '⏳ Testen...' : 'Test verbinding'}
                </button>
              </div>

              {#if aiTestResult}
                <div class="rounded-m3-md px-5 py-3 text-body-small {aiTestSuccess ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}">
                  {aiTestResult}
                </div>
              {/if}
            </div>
          {:else}
            <div class="glass p-8 rounded-m3-md border-white/5 flex items-center justify-center">
              <div class="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          {/if}
        {:else}
        <div class="space-y-2">
          {#each section.settings as setting}
            <div class="glass p-5 rounded-m3-md border-white/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-6 transition-all hover:bg-surface-800/40">
              <div class="flex-1">
                <p class="text-title-small text-gray-100">{setting.label}</p>
                <p class="text-label-medium text-gray-500 mt-1 leading-relaxed">{setting.description}</p>
              </div>

              {#if setting.type === 'toggle'}
                <Switch
                  checked={$userSettings[setting.id]}
                  onCheckedChange={(v) => updateToggle(setting.id, v)}
                  ariaLabel={setting.label}
                />
              {:else if setting.type === 'number'}
                <input
                  type="number"
                  value={$userSettings[setting.id]}
                  oninput={(e) => updateNumber(setting.id, e.currentTarget.value)}
                  min={setting.min}
                  max={setting.max}
                  step={setting.step ?? 1}
                  class="w-20 px-3 py-2 rounded-m3-xs bg-surface-950 border border-surface-700 text-title-small text-gray-100 text-center focus:outline-none focus:border-primary-500 shadow-inner"
                />
              {:else if setting.type === 'theme-picker'}
                <ColorSwatchPicker
                  colors={themeColors}
                  value={$userSettings[setting.id]}
                  onSelect={(id) => updateSetting(setting.id, id)}
                />
              {:else if setting.type === 'select'}
                <select
                  value={$userSettings[setting.id]}
                  onchange={(e) => updateSetting(setting.id, e.currentTarget.value)}
                  class="bg-surface-800 border-none text-gray-200 text-label-medium rounded-m3-sm px-4 py-2.5 outline-none cursor-pointer hover:bg-surface-700 transition-colors shadow-sm"
                >
                  {#each setting.options as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else if setting.type === 'action'}
                <Button
                  variant="tonal"
                  onclick={() => setting.action()}
                  disabled={setting.id === 'exportAll' ? exportBusy : (testingNotification === setting.id.split('test')[1])}
                  class="px-5"
                >
                  {#if setting.id === 'exportAll'}
                    {#if exportBusy}
                      <span class="animate-pulse">⏳ Bezig met exporteren...</span>
                    {:else}
                      Exporteren
                    {/if}
                  {:else if testingNotification === setting.id.split('test')[1]}
                    <span class="animate-pulse">⏳ Wachten...</span>
                  {:else}
                    Testen
                  {/if}
                </Button>
                {#if setting.id === 'exportAll' && exportResult}
                  <p class="text-label-small text-gray-400 font-mono mt-2 text-right max-w-[200px] leading-relaxed">{exportResult}</p>
                {/if}
              {:else if setting.type === 'download-dir'}
                <div class="flex items-center gap-2">
                  {#if $userSettings.downloadDir}
                    <button
                      onclick={clearDownloadDir}
                      class="text-label-medium text-red-400 hover:text-red-300 transition-colors px-2 py-1"
                    >
                      Herstel
                    </button>
                  {/if}
                  <Button
                    variant="tonal"
                    onclick={pickDownloadDir}
                    disabled={pickingDir}
                    class="px-5"
                  >
                    {pickingDir ? '⏳ ...' : 'Map Kiezen'}
                  </Button>
                </div>
                {#if $userSettings.downloadDir}
                  <p class="text-label-small text-gray-500 font-mono mt-2 text-right max-w-[200px] truncate leading-relaxed" title={$userSettings.downloadDir}>
                    {$userSettings.downloadDir}
                  </p>
                {:else}
                  <p class="text-label-small text-gray-600 mt-2 text-right">Systeemstandaard</p>
                {/if}
              {/if}
            </div>
            {#if setting.id === 'notifyAutoDnd' && $userSettings.notifyAutoDnd && dndAccessGranted === false}
              <div class="glass p-4 rounded-m3-md border border-amber-500/20 bg-amber-500/5 flex items-center justify-between gap-4 -mt-1">
                <p class="text-label-medium text-amber-400 leading-relaxed">
                  Niet Storen-toegang is nog niet verleend. Automatisch Niet Storen werkt hierdoor niet.
                </p>
                <button
                  onclick={openDndSettings}
                  class="shrink-0 bg-amber-500/15 text-amber-400 text-label-medium rounded-m3-full px-4 py-2 hover:bg-amber-500/25 transition-all active:scale-95 border border-amber-500/20"
                >
                  Toegang verlenen
                </button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      </section>
      {/if}
    {/each}

    <!-- ===== DEBUG SECTION ===== -->
    {#if activeSection === 'debug'}
    <section id="settings-debug" in:fly={{ y: 20, delay: 0 }}>
      <button
        onclick={toggleDebug}
        class="w-full flex items-center justify-between px-2 mb-4 group"
      >
        <h2 class="text-label-medium text-gray-600 group-hover:text-amber-500 transition-colors flex items-center gap-2">
          <svg class="w-3 h-3 md:hidden text-amber-500/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          <span class="md:hidden">Systeem Debug</span>
        </h2>
        <div class="flex items-center gap-2">
          <span class="text-label-small text-gray-700">
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
            <div class="debug-card rounded-m3-md p-5 space-y-4 shadow-xl">
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
                    <p class="info-tile-value font-mono text-label-small break-all opacity-80">{debugInfo.dataDir ?? '?'}</p>
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
            <div class="debug-card rounded-m3-md p-8 flex flex-col items-center justify-center gap-4 text-center">
               <svg class="w-10 h-10 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
               <p class="text-label-medium text-gray-600 max-w-[150px]">Geen debug info geladen</p>
               <button onclick={loadDebugInfo} class="debug-btn-primary px-8">Info ophalen</button>
            </div>
          {/if}

          <!-- Sync interval -->
          <div class="debug-card rounded-m3-md p-6 space-y-4">
            <div class="flex items-center justify-between">
              <p class="debug-label">Sync frequentie</p>
              <div class="px-3 py-1 bg-amber-500/15 rounded-m3-sm border border-amber-500/20">
                <span class="text-label-medium text-amber-500 tabular-nums">{intervalLabel(intervalSeconds)}</span>
              </div>
            </div>
            <input
              type="range"
              min="900" max="3600" step="300"
              bind:value={intervalSeconds}
              class="w-full h-2 bg-surface-800 rounded-full appearance-none cursor-pointer accent-amber-500 shadow-inner"
            />
            <p class="text-label-small text-gray-600 text-center -mt-1">Android staat een minimum van 15 minuten toe voor achtergrondsynchronisatie.</p>
            <div class="flex gap-2">
              {#each [900, 1800, 3600] as preset}
                <button
                  onclick={() => { intervalSeconds = preset; }}
                  class="flex-1 text-label-medium rounded-m3-full py-2
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
              <p class="text-label-small text-amber-400 font-mono text-center bg-amber-500/5 py-2 rounded-m3-sm">{intervalResult}</p>
            {/if}
          </div>

          <!-- Night Sleep & Notifications -->
          <div class="debug-card rounded-m3-md p-6 space-y-6">
            <div class="space-y-4">
                <div class="flex items-center justify-between">
                  <p class="debug-label">Nachtrust</p>
                  <Switch
                    checked={disableSyncAtNight}
                    onCheckedChange={(v) => { disableSyncAtNight = v; applyNightSleep(); }}
                    ariaLabel="Nachtrust"
                  />
                </div>
                {#if disableSyncAtNight}
                  <div class="flex gap-4 items-center" transition:slide>
                      <div class="flex-1 space-y-2">
                          <label for="disableSyncStart" class="text-label-medium text-gray-500">Start Uur</label>
                          <input id="disableSyncStart" type="number" min="0" max="23" bind:value={disableSyncAtNightStart} onchange={applyNightSleep} class="w-full bg-surface-800 text-gray-300 rounded-m3-xs p-2 text-center text-title-small border border-white/5" />
                      </div>
                      <div class="flex-1 space-y-2">
                          <label for="disableSyncEnd" class="text-label-medium text-gray-500">Eind Uur</label>
                          <input id="disableSyncEnd" type="number" min="0" max="23" bind:value={disableSyncAtNightEnd} onchange={applyNightSleep} class="w-full bg-surface-800 text-gray-300 rounded-m3-xs p-2 text-center text-title-small border border-white/5" />
                      </div>
                  </div>
                {/if}
            </div>

            <div class="w-full h-[1px] bg-white/5"></div>

            <div class="flex items-center justify-between">
                <div>
                    <p class="debug-label">Notificaties Uitzetten</p>
                    <p class="text-body-small text-red-400 mt-1 max-w-[200px]">Stopt alle achtergrond notificaties volledig</p>
                </div>
                <Switch
                    checked={disableAllNotifications}
                    onCheckedChange={(v) => { disableAllNotifications = v; applyDisableAllNotifications(); }}
                    ariaLabel="Notificaties uitzetten"
                  />
            </div>
          </div>

          <!-- Actions row -->
          <div class="grid grid-cols-2 gap-3">
            <button
              onclick={doForceSync}
              disabled={forceSyncBusy}
              class="debug-card rounded-m3-md p-6 flex flex-col items-center gap-3 hover:bg-surface-700/40 transition-all active:scale-[0.98] disabled:opacity-50 ring-1 ring-white/5"
            >
              <div class="w-12 h-12 rounded-m3-md bg-amber-500/10 text-amber-500 flex items-center justify-center shadow-inner">
                <svg class="w-6 h-6 {forceSyncBusy ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
              </div>
              <div class="text-center">
                <p class="text-label-medium text-gray-200">Force Sync</p>
                <p class="text-label-small text-gray-600 mt-1">Nu ophalen</p>
              </div>
            </button>
            <button
              onclick={doClearState}
              class="debug-card rounded-m3-md p-6 flex flex-col items-center gap-3 hover:bg-red-500/10 transition-all active:scale-[0.98] ring-1 ring-white/5"
            >
              <div class="w-12 h-12 rounded-m3-md bg-red-500/10 text-red-400 flex items-center justify-center shadow-inner">
                <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              </div>
              <div class="text-center">
                <p class="text-label-medium text-red-400">Baseline</p>
                <p class="text-label-small text-gray-600 mt-1">State wissen</p>
              </div>
            </button>
          </div>

          <!-- Logs -->
          <div class="debug-card rounded-m3-md p-5 space-y-4 overflow-hidden relative">
            <div class="flex items-center justify-between relative z-10">
              <p class="debug-label">Systeemboodschappen</p>
              <button onclick={() => logs = []} class="text-label-medium text-gray-600 hover:text-red-400 transition-colors">
                Opschonen
              </button>
            </div>
            <div class="space-y-2 max-h-60 overflow-y-auto no-scrollbar relative z-10 pr-1">
              {#each logs as log}
                <div class="flex gap-3 items-start p-2.5 rounded-m3-sm bg-surface-950/40 border border-white/5" transition:slide={{ duration: 150 }}>
                  <span class="text-label-small text-gray-700 shrink-0 tabular-nums">{log.time}</span>
                  <div class="flex-1 min-w-0">
                    <p class="text-label-small font-mono text-gray-400 break-words leading-relaxed">
                      <span class="{log.level === 'error' ? 'text-red-500' : log.level === 'warn' ? 'text-amber-500' : 'text-emerald-500'} text-label-medium mr-2">
                        {log.level.toUpperCase()}
                      </span>
                      {log.msg}
                    </p>
                  </div>
                </div>
              {:else}
                <div class="py-12 flex flex-col items-center justify-center opacity-30">
                  <svg class="w-10 h-10 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  <p class="text-label-small">Geen activiteiten</p>
                </div>
              {/each}
            </div>
            <!-- Glow effect -->
            <div class="absolute -bottom-10 -right-10 w-40 h-40 bg-primary-500/5 blur-[60px] rounded-full"></div>
          </div>
        </div>
      {/if}
    </section>
    {/if}

    <!-- ===== GITHUB REPO INFO ===== -->
    {#if activeSection === 'about'}
    <section id="settings-about" in:fly={{ y: 20 }}>
      <div class="glass p-6 rounded-m3-md border-white/5 space-y-4 hover:bg-surface-800/40 transition-all">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-m3-sm bg-surface-900 border border-surface-700/50 flex items-center justify-center text-gray-400 group-hover:rotate-6 transition-transform shadow-inner shrink-0">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
          </div>
          <div>
            <h3 class="text-title-small text-gray-100">Friday — Open source</h3>
            <p class="text-label-small text-gray-600 mt-0.5">Bekijk de broncode op GitHub</p>
          </div>
        </div>

        <a
          href="https://github.com/JPDeerenberg/friday"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center justify-between p-4 rounded-m3-md bg-surface-900/60 border border-white/5 hover:bg-surface-800/80 hover:border-primary-500/30 transition-all group/repo active:scale-[0.98]"
        >
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-9 h-9 rounded-m3-sm bg-primary-500/15 flex items-center justify-center text-primary-400 shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            </div>
            <div class="min-w-0">
              <p class="text-title-small text-gray-200 truncate group-hover/repo:text-primary-400 transition-colors">JPDeerenberg/friday</p>
              <p class="text-label-small text-gray-600 mt-0.5">Magister Tauri app — Volg de ontwikkeling</p>
            </div>
          </div>
          <svg class="w-5 h-5 text-gray-600 group-hover/repo:text-primary-400 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>

        <!-- GitHub Stats via API -->
        {#if repoStats}
          <div class="grid grid-cols-3 gap-3">
            <div class="bg-surface-900/50 rounded-m3-sm p-3 text-center border border-white/5">
              <p class="text-title-large text-gray-200 tabular-nums">{repoStats.stars}</p>
              <p class="text-label-small text-gray-600 mt-0.5">Sterren</p>
            </div>
            <div class="bg-surface-900/50 rounded-m3-sm p-3 text-center border border-white/5">
              <p class="text-title-large text-gray-200 tabular-nums">{repoStats.forks}</p>
              <p class="text-label-small text-gray-600 mt-0.5">Forks</p>
            </div>
            <div class="bg-surface-900/50 rounded-m3-sm p-3 text-center border border-white/5">
              <p class="text-title-large text-gray-200 tabular-nums">{repoStats.openIssues}</p>
              <p class="text-label-small text-gray-600 mt-0.5">Issues</p>
            </div>
          </div>
        {:else if repoStatsError}
          <p class="text-label-small text-red-400 text-center font-mono">{repoStatsError}</p>
        {:else}
          <div class="flex items-center justify-center gap-2 py-2">
            <div class="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-label-small text-gray-600">Repo info laden...</span>
          </div>
        {/if}
      </div>
    </section>
    {/if}

    <div class="pt-10 flex flex-col items-center gap-2">
      <div class="w-10 h-[1px] bg-surface-800"></div>
      <p class="text-label-small text-gray-600 text-center">Version 2.2.0 • Friday App</p>
    </div>
      </div>
    </main>
  </div>
  {/if}
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
    font-size: var(--text-label-medium);
    line-height: var(--text-label-medium--line-height);
    letter-spacing: var(--text-label-medium--letter-spacing);
    font-weight: var(--text-label-medium--font-weight);
    color: rgb(75, 85, 99);
  }

  .info-tile {
    display: flex;
    align-items: center;
    gap: 12px;
    background: oklch(1 0 0 / 0.02);
    border-radius: var(--radius-m3-sm);
    padding: 12px 16px;
    min-width: 0;
    border: 1px solid oklch(1 0 0 / 0.03);
  }

  .info-tile-icon {
    flex-shrink: 0;
  }

  .info-tile-title {
    font-size: var(--text-label-small);
    line-height: var(--text-label-small--line-height);
    letter-spacing: var(--text-label-small--letter-spacing);
    font-weight: var(--text-label-small--font-weight);
    color: rgb(107, 114, 128);
  }

  .info-tile-value {
    font-size: var(--text-body-small);
    line-height: var(--text-body-small--line-height);
    letter-spacing: var(--text-body-small--letter-spacing);
    font-weight: 500;
    color: rgb(229, 231, 235);
    margin-top: 4px;
  }

  .debug-btn-primary {
    background: oklch(0.7 0.15 80 / 0.15);
    color: oklch(0.8 0.15 80);
    font-size: var(--text-label-large);
    line-height: var(--text-label-large--line-height);
    letter-spacing: var(--text-label-large--letter-spacing);
    font-weight: var(--text-label-large--font-weight);
    border-radius: var(--radius-m3-full);
    padding: 12px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    border: 1px solid oklch(0.8 0.15 80 / 0.2);
  }
  .debug-btn-primary:active { transform: scale(0.96); }

  .debug-btn-secondary {
    background: oklch(1 0 0 / 0.05);
    color: oklch(1 0 0 / 0.6);
    font-size: var(--text-label-large);
    line-height: var(--text-label-large--line-height);
    letter-spacing: var(--text-label-large--letter-spacing);
    font-weight: var(--text-label-large--font-weight);
    border-radius: var(--radius-m3-full);
    padding: 10px;
    transition: all 0.2s ease;
    border: 1px solid oklch(1 0 0 / 0.08);
  }
  .debug-btn-secondary:hover { background: oklch(1 0 0 / 0.1); color: white; }

  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
