<script lang="ts">
  import { logout } from '$lib/api';
  import { accountInfo, userSettings } from '$lib/stores';
  import { onMount } from 'svelte';

  async function handleLogout() {
    if (confirm('Weet je zeker dat je wilt uitloggen?')) {
      await logout();
      window.location.reload();
    }
  }

  function updateSetting(key: string, value: any) {
    userSettings.update(s => ({ ...s, [key]: value }));
  }

  let version = $state('0.1.0-alpha');
</script>

<div class="p-4 md:p-6 max-w-2xl mx-auto pb-20">
  <div class="mb-10">
    <h1 class="text-4xl font-bold text-gray-100 tracking-tight">Instellingen</h1>
    <p class="text-gray-500 mt-2 font-medium">Personaliseer je Agenda ervaring</p>
  </div>

  <div class="space-y-8">
    <!-- Account Section -->
    <section class="glass p-8 rounded-[2.5rem] border border-white/5 shadow-2xl">
      <h2 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-8 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-primary-500"></span> Account
      </h2>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-5">
          <div class="w-16 h-16 bg-surface-800 rounded-3xl flex items-center justify-center text-3xl shadow-inner border border-white/5">
            👤
          </div>
          <div>
            <p class="text-xl font-bold text-gray-100">{$accountInfo?.Persoon?.Roepnaam} {$accountInfo?.Persoon?.Achternaam}</p>
            <p class="text-xs text-gray-500 font-bold tracking-widest uppercase mt-1">Magister Student</p>
          </div>
        </div>
        <button 
          onclick={handleLogout}
          class="bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white px-6 py-3 rounded-2xl text-xs font-black transition-all border border-red-500/20 active:scale-95"
        >
          UITLOGGEN
        </button>
      </div>
    </section>

    <!-- Grades & Graphs Section -->
    <section class="glass p-8 rounded-[2.5rem] border border-white/5 shadow-2xl">
      <h2 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-8 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-accent-500"></span> Cijfers & Grafieken
      </h2>
      
      <div class="space-y-6">
        <!-- Rounded Graphs -->
        <div class="flex items-center justify-between group">
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-2xl bg-accent-500/10 flex items-center justify-center text-xl">〰️</div>
            <div>
              <p class="text-sm font-bold text-gray-200">Afgeronde Grafieken</p>
              <p class="text-[10px] text-gray-500 font-medium">Gebruik vloeiende lijnen in de trendlijn</p>
            </div>
          </div>
          <button 
            onclick={() => updateSetting('roundedGraphs', !$userSettings.roundedGraphs)}
            aria-label="Schakel afgeronde grafieken in"
            class="w-12 h-6 rounded-full transition-colors relative {$userSettings.roundedGraphs ? 'bg-accent-500' : 'bg-surface-800'}"
          >
            <div class="absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform {$userSettings.roundedGraphs ? 'translate-x-6' : 'translate-x-0'}"></div>
          </button>
        </div>

        <!-- Highlight Failing -->
        <div class="flex items-center justify-between group border-t border-white/5 pt-6">
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-2xl bg-red-500/10 flex items-center justify-center text-xl">🚩</div>
            <div>
              <p class="text-sm font-bold text-gray-200">Onvoldoendes Markeren</p>
              <p class="text-[10px] text-gray-500 font-medium">Geef onvoldoendes een opvallende kleur</p>
            </div>
          </div>
          <button 
            onclick={() => updateSetting('highlightFailing', !$userSettings.highlightFailing)}
            aria-label="Schakel onvoldoende markering in"
            class="w-12 h-6 rounded-full transition-colors relative {$userSettings.highlightFailing ? 'bg-accent-500' : 'bg-surface-800'}"
          >
            <div class="absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform {$userSettings.highlightFailing ? 'translate-x-6' : 'translate-x-0'}"></div>
          </button>
        </div>

        <!-- Decimal Points -->
        <div class="flex items-center justify-between group border-t border-white/5 pt-6">
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-2xl bg-primary-500/10 flex items-center justify-center text-xl">🔢</div>
            <div>
              <p class="text-sm font-bold text-gray-200">Decimalen</p>
              <p class="text-[10px] text-gray-500 font-medium">Aantal getallen achter de komma</p>
            </div>
          </div>
          <div class="flex bg-surface-800 p-1 rounded-xl">
             {#each [0, 1, 2] as d}
               <button 
                 onclick={() => updateSetting('decimalPoints', d)}
                 class="px-3 py-1 rounded-lg text-[10px] font-black transition-all { $userSettings.decimalPoints === d ? 'bg-white text-surface-950' : 'text-gray-500 hover:text-gray-300'}"
               >
                 {d}
               </button>
             {/each}
          </div>
        </div>

        <!-- Insufficient Threshold -->
        <div class="flex items-center justify-between group border-t border-white/5 pt-6">
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-2xl bg-orange-500/10 flex items-center justify-center text-xl">📏</div>
            <div>
              <p class="text-sm font-bold text-gray-200">Onvoldoende Grens</p>
              <p class="text-[10px] text-gray-500 font-medium">Vanaf welk cijfer is het een voldoende?</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
             <span class="text-xs font-bold text-gray-400">{$userSettings.insufficientThreshold.toFixed(1)}</span>
             <input 
               type="range" min="1" max="10" step="0.1" 
               value={$userSettings.insufficientThreshold}
               oninput={(e) => updateSetting('insufficientThreshold', parseFloat(e.currentTarget.value))}
               class="w-24 accent-accent-500 h-1 bg-surface-800 rounded-lg appearance-none cursor-pointer"
             />
          </div>
        </div>

        <!-- Graph Zoom -->
        <div class="flex items-center justify-between group border-t border-white/5 pt-6">
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-2xl bg-pink-500/10 flex items-center justify-center text-xl">🔍</div>
            <div>
              <p class="text-sm font-bold text-gray-200">Grafiek Zoom</p>
              <p class="text-[10px] text-gray-500 font-medium">Focus grafieken op je cijferbereik</p>
            </div>
          </div>
          <button 
            onclick={() => updateSetting('zoomGraph', !$userSettings.zoomGraph)}
            aria-label="Schakel grafiek zoom in"
            class="w-12 h-6 rounded-full transition-colors relative {$userSettings.zoomGraph ? 'bg-accent-500' : 'bg-surface-800'}"
          >
            <div class="absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform {$userSettings.zoomGraph ? 'translate-x-6' : 'translate-x-0'}"></div>
          </button>
        </div>
      </div>
    </section>

    <!-- App Section -->
    <section class="glass p-8 rounded-[2.5rem] border border-white/5 shadow-2xl">
      <h2 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-8 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-blue-500"></span> Applicatie
      </h2>
      <div class="space-y-6">
         <div class="flex items-center justify-between group">
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-2xl bg-blue-500/10 flex items-center justify-center text-xl">🎨</div>
              <div>
                <p class="text-sm font-bold text-gray-200">Thema</p>
                <p class="text-[10px] text-gray-500 font-medium">Agenda past zich aan jou aan</p>
              </div>
            </div>
            <select class="bg-surface-800 border-none rounded-xl px-4 py-2 text-xs font-bold text-gray-300 focus:outline-none appearance-none cursor-pointer hover:bg-surface-700 transition-colors">
               <option value="dark">Donker (Vibrant)</option>
               <option value="light" disabled>Licht (Binnenkort)</option>
            </select>
         </div>

         <div class="flex items-center justify-between group border-t border-white/5 pt-6">
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-2xl bg-gray-500/10 flex items-center justify-center text-xl">ℹ️</div>
              <div>
                <p class="text-sm font-bold text-gray-200">Softwareversie</p>
                <p class="text-[10px] text-gray-500 font-medium">De huidige versie van deze app</p>
              </div>
            </div>
            <span class="text-[10px] font-black text-primary-400 bg-primary-400/10 px-3 py-1.5 rounded-full ring-1 ring-primary-400/20">{version}</span>
         </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="text-center py-6 opacity-40">
       <p class="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2">Built for students • 2026</p>
       <div class="w-4 h-0.5 bg-surface-700 mx-auto rounded-full"></div>
    </footer>
  </div>
</div>

<style>
  /* Redundant CSS removed to fix Tailwind parsing */
</style>
