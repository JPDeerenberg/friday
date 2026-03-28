<script lang="ts">
  import { userSettings } from '$lib/stores';
  import { currentPage } from '$lib/stores';
  import { triggerTestNotification } from '$lib/api';
  import { fade, fly } from 'svelte/transition';
  import { onMount } from 'svelte';

  let isMobile = $state(false);

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

  const sections: any[] = [
    {
      title: 'Agenda',
      settings: [
        { id: 'showWeekend', label: 'Toon Weekend', description: 'Laat zaterdag en zondag zien in de agenda.', type: 'toggle' },
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
        { id: 'testNotification', label: 'Test Notificatie', description: 'Stuur een testbericht om te controleren of meldingen werken.', type: 'action', action: async () => {
          try {
            await triggerTestNotification();
            alert('Test notificatie is verstuurd!');
          } catch (e) {
            alert('Fout bij het versturen: ' + e);
          }
        } },
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
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <!-- Sticky Header -->
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-3">
    <div class="flex items-center gap-4">
      <button onclick={goBack} class="p-2 text-gray-500 hover:text-primary-400 transition-all" aria-label="Terug">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <h1 class="text-xl font-bold text-gray-100 italic tracking-tighter">Instellingen</h1>
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
                <p class="text-[10px] text-gray-500 font-medium mt-1">{setting.description}</p>
              </div>

              {#if setting.type === 'toggle'}
                <label class="relative inline-flex items-center cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={$userSettings[setting.id]} 
                    onchange={(e) => updateToggle(setting.id, e.currentTarget.checked)}
                    class="sr-only peer"
                  >
                  <div class="w-11 h-6 bg-surface-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-500/80"></div>
                </label>
              {:else if setting.type === 'number'}
                <input 
                  type="number" 
                  value={$userSettings[setting.id]}
                  oninput={(e) => updateNumber(setting.id, e.currentTarget.value)}
                  min={setting.min}
                  max={setting.max}
                  step={setting.step ?? 1}
                  class="w-20 px-3 py-2 rounded-xl bg-surface-900 border border-surface-700 text-sm text-gray-100 text-center focus:outline-none focus:border-primary-500"
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
                                   : 'border-transparent opacity-60 group-hover:opacity-100 group-hover:scale-105'}"></div>
                      <span class="text-[8px] font-black uppercase tracking-tighter text-gray-500 group-hover:text-gray-300 transition-colors">{color.label}</span>
                    </button>
                  {/each}
                </div>
              {:else if setting.type === 'select'}
                <select 
                  value={$userSettings[setting.id]}
                  onchange={(e) => updateSetting(setting.id, e.currentTarget.value)}
                  class="bg-surface-800 border-none text-gray-200 text-xs font-black uppercase tracking-widest rounded-xl px-3 py-2 outline-none cursor-pointer hover:bg-surface-700 transition-colors"
                >
                  {#each setting.options as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else if setting.type === 'action'}
                <button 
                  onclick={() => setting.action()}
                  class="bg-primary-500/15 text-primary-400 text-xs font-bold uppercase tracking-widest rounded-xl px-4 py-2 hover:bg-primary-500/25 transition-all active:scale-95"
                >
                  🚀 Test
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </section>
      {/if}
    {/each}

    <div class="pt-6 border-t border-surface-800/50">
      <p class="text-[9px] text-gray-600 font-black uppercase tracking-widest text-center">Versie 1.2.0 • Made with ❤️</p>
    </div>
  </main>
</div>

<style>
  .glass {
    background: rgba(30, 41, 59, 0.4);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
</style>
