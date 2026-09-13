<script lang="ts">
  // "Add to Home Screen" coach marks. iOS has no beforeinstallprompt —
  // installation is manual via Share, and push only works when installed
  // (iOS 16.4+), so this is shown on the web login screen, not buried in settings.
  let dismissed = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem('friday_install_dismissed') === '1',
  );
  let isIos = $state(false);
  let isStandalone = $state(false);
  let deferredPrompt = $state<any>(null);

  $effect(() => {
    const ua = navigator.userAgent;
    isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e;
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  });

  function dismiss() {
    dismissed = true;
    try {
      localStorage.setItem('friday_install_dismissed', '1');
    } catch {}
  }

  async function install() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
      dismiss();
    }
  }
</script>

{#if !dismissed && !isStandalone}
  <div class="mt-4 rounded-2xl border border-primary-500/20 bg-primary-500/5 p-4">
    <div class="flex items-start justify-between gap-3">
      <p class="text-sm text-gray-200 font-medium">Zet Friday op je beginscherm</p>
      <button onclick={dismiss} class="text-gray-500 hover:text-gray-300 text-lg leading-none" aria-label="Sluiten">×</button>
    </div>
    {#if isIos}
      <ol class="mt-2 space-y-1.5 text-xs text-gray-400 leading-relaxed list-none">
        <li><span class="text-primary-400 font-semibold">1.</span> Tik onderaan op <span class="text-gray-200">Deel</span>
          <svg class="w-3.5 h-3.5 inline -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
        </li>
        <li><span class="text-primary-400 font-semibold">2.</span> Kies <span class="text-gray-200">Zet op beginscherm</span></li>
        <li><span class="text-primary-400 font-semibold">3.</span> Open Friday vanaf je beginscherm — zo werkt hij als app, inclusief meldingen</li>
      </ol>
    {:else if deferredPrompt}
      <p class="mt-2 text-xs text-gray-400 leading-relaxed">Installeer Friday als app voor een volledig scherm en snellere start.</p>
      <button
        onclick={install}
        class="mt-3 w-full px-4 py-2.5 rounded-lg bg-primary-500 text-white text-sm font-medium hover:bg-primary-600 transition-colors"
      >
        Installeren
      </button>
    {:else}
      <p class="mt-2 text-xs text-gray-400 leading-relaxed">
        Open het browsermenu en kies <span class="text-gray-200">Toevoegen aan startscherm</span> of
        <span class="text-gray-200">App installeren</span> om Friday als app te gebruiken.
      </p>
    {/if}
  </div>
{/if}
