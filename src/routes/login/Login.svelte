<script lang="ts">
  import { isLoggedIn, loginError, accountInfo, personId, profilePicture } from '$lib/stores';
  import { startLoginFlow, getPersonId, getProfilePicture, handleAuthCallback } from '$lib/api';
  import Button from '$lib/components/Button.svelte';
  import InstallPrompt from '$lib/components/InstallPrompt.svelte';

  import { webBackend, saveWebSession, webRequest, webRequestBytes, bytesToBase64 } from '$lib/web-session';

  let loading = $state(false);
  let error = $state('');
  // Cold-start messaging: free Render sleeps after 15 min idle, so the first
  // login of the day can take 30–60 s. Timed messages keep that from looking
  // broken. Deliberately no hard timeout — it would kill legit slow logins.
  let loginStartedAt = $state(0);
  let loginElapsed = $state(0);
  let loginTimer: ReturnType<typeof setInterval> | null = null;

  function startLoginTimer() {
    stopLoginTimer();
    loginStartedAt = Date.now();
    loginElapsed = 0;
    loginTimer = setInterval(() => {
      loginElapsed = Date.now() - loginStartedAt;
    }, 1000);
  }

  function stopLoginTimer() {
    if (loginTimer) clearInterval(loginTimer);
    loginTimer = null;
  }

  // Web build (no Tauri runtime): password-form login against web-api.
  // Desktop/Android keep the OAuth system-browser flow below, untouched.
  const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI__;
  let school = $state('');
  let username = $state('');
  let password = $state('');
  let showPassword = $state(false);

  async function startWebLogin() {
    if (!school.trim() || !username.trim() || !password) {
      error = 'Vul school, gebruikersnaam en wachtwoord in.';
      return;
    }
    loading = true;
    error = '';
    startLoginTimer();
    try {
      const { webBackend, saveWebSession, webRequest, webRequestBytes } = await import('$lib/web-session');
      const be = webBackend();
      const result = await be.login(school.trim(), username.trim(), password);
      await saveWebSession(result.tokens);
      // Password is only in this function's scope — drop it immediately.
      password = '';
      accountInfo.set(await webRequest('GET', 'account?noCache=0'));
      const pid = result.tokens.personId;
      if (pid == null) throw new Error('Geen leerling gevonden bij dit account.');
      personId.set(pid);
      isLoggedIn.set(true);
      try {
        const pic = await webRequestBytes(`leerlingen/${pid}/foto`);
        profilePicture.set(pic ? bytesToBase64(pic) : null);
      } catch (_) {}
    } catch (e: any) {
      const base = e?.withRef?.() ?? e?.message ?? e?.toString() ?? 'Inloggen mislukt';
      error = base;
      loading = false;
    } finally {
      stopLoginTimer();
    }
  }

  // +layout.svelte is the sole owner of processing the deep-link callback
  // and the auth-success/auth-error events now (it's mounted for the
  // app's whole lifetime, unlike this screen) — this just reacts to the
  // shared stores it updates instead of listening for those events itself.
  // This component used to *also* listen for `auth-callback` and invoke
  // the token exchange itself, which meant every redirect back from
  // Magister fired the exchange twice with the same single-use OAuth code;
  // whichever call lost always failed with "No auth flow in progress",
  // which is what made login look stuck.
  $effect(() => {
    if ($isLoggedIn) {
      loading = false;
      stopLoginTimer();
    }
  });

  $effect(() => {
    if ($loginError) {
      error = $loginError;
      loading = false;
    }
  });

  async function startLogin() {
    loading = true;
    error = '';
    loginError.set('');

    try {
      await startLoginFlow();
      // Stay in the loading state until +layout.svelte flips `isLoggedIn`
      // or `loginError` in response to the redirect.
    } catch (e: any) {
      error = e?.toString() ?? 'Inloggen mislukt';
      loading = false;
    }
  }

  let manualUrl = $state('');
  
  async function submitManualUrl() {
    if (!manualUrl.trim()) return;
    error = '';
    try {
      const account = await handleAuthCallback(manualUrl.trim());
      accountInfo.set(account);
      const pid = await getPersonId();
      personId.set(pid);
      isLoggedIn.set(true);
      try {
        const pic = await getProfilePicture(pid);
        profilePicture.set(pic);
      } catch (_) {}
    } catch (e: any) {
      error = e?.toString() ?? 'Handmatige login mislukt. Zorg dat je de volledige "m6loapp://" link kopieert.';
    }
  }
</script>

<div class="flex items-center justify-center min-h-screen bg-surface-950 p-4">
  <div class="w-full max-w-md">
    <!-- Logo -->
    <div class="text-center mb-8">
      <div class="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary-500 via-primary-600 to-accent-500 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-primary-500/20">
        <span class="text-3xl font-bold text-white">F</span>
      </div>
      <h1 class="text-2xl font-bold text-gray-100">Friday</h1>
      <p class="text-sm text-gray-500 mt-1">Log in met je Magister account</p>
    </div>

    <!-- Login card -->
    <div class="glass rounded-2xl p-6 space-y-5">
      {#if !isTauri}
        <!-- Web build: school + username + password (no browser redirect to catch). -->
        {#if !loading}
          <div class="space-y-3">
            <div>
              <label for="friday-school" class="block text-xs text-gray-400 mb-1">School</label>
              <input
                id="friday-school"
                type="text"
                bind:value={school}
                placeholder="Schoolnaam zoals in Magister"
                autocomplete="organization"
                class="w-full px-3 py-2.5 rounded-lg bg-surface-900 border border-surface-600 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/50 text-sm"
                onkeydown={(e) => e.key === 'Enter' && startWebLogin()}
              />
            </div>
            <div>
              <label for="friday-username" class="block text-xs text-gray-400 mb-1">Gebruikersnaam</label>
              <input
                id="friday-username"
                type="text"
                bind:value={username}
                placeholder="Gebruikersnaam"
                autocomplete="username"
                class="w-full px-3 py-2.5 rounded-lg bg-surface-900 border border-surface-600 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/50 text-sm"
                onkeydown={(e) => e.key === 'Enter' && startWebLogin()}
              />
            </div>
            <div>
              <label for="friday-password" class="block text-xs text-gray-400 mb-1">Wachtwoord</label>
              <div class="relative">
                <input
                  id="friday-password"
                  type={showPassword ? 'text' : 'password'}
                  bind:value={password}
                  placeholder="Wachtwoord"
                  autocomplete="current-password"
                  class="w-full px-3 py-2.5 pr-12 rounded-lg bg-surface-900 border border-surface-600 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/50 text-sm"
                  onkeydown={(e) => e.key === 'Enter' && startWebLogin()}
                />
                <button
                  type="button"
                  onclick={() => showPassword = !showPassword}
                  class="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-gray-400 hover:text-gray-200"
                  aria-label={showPassword ? 'Wachtwoord verbergen' : 'Wachtwoord tonen'}
                >
                  {showPassword ? 'Verberg' : 'Toon'}
                </button>
              </div>
            </div>
          </div>
          <Button onclick={startWebLogin} class="w-full">
            Inloggen
          </Button>
          <p class="text-xs text-gray-600 text-center leading-relaxed">
            Je wachtwoord wordt alleen gebruikt om één keer in te loggen en wordt nergens opgeslagen.
          </p>
        {:else}
          <div class="text-center space-y-4 py-4">
            <div class="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
            <p class="text-sm text-gray-300 font-medium">Bezig met inloggen...</p>
            {#if loginElapsed > 8000}
              <p class="text-xs text-gray-500 leading-relaxed">
                De server wordt wakker gemaakt (gratis hosting slaapt bij inactiviteit).
                {#if loginElapsed > 30000}
                  <br />Dit duurt langer dan normaal — nog even geduld…
                {:else}
                  <br />Dit kan een halve minuut duren.
                {/if}
              </p>
            {/if}
          </div>
        {/if}
      {:else if !loading}
        <Button
          onclick={startLogin}
          class="w-full"
        >
          Inloggen bij Friday
        </Button>
      {:else}
        <div class="text-center space-y-4 py-4">
          <div class="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p class="text-sm text-gray-300 font-medium">Bezig met inloggen...</p>
          <p class="text-xs text-gray-500">Rond het inloggen af in de browser. De app hoort daarna vanzelf te heropenen.</p>
        </div>
        
        <div class="mt-6 pt-4 border-t border-surface-700/50">
          <p class="text-xs text-gray-400 mb-3 text-center">Opent de app niet vanzelf? Kopieer de link uit je browser (begint met <code class="bg-surface-900 px-1 rounded">m6loapp://</code>) en plak hem hier:</p>
          <div class="flex gap-2">
            <input
              type="text"
              bind:value={manualUrl}
              placeholder="m6loapp://oauth2redirect/..."
              class="flex-1 px-3 py-2 rounded-lg bg-surface-900 border border-surface-600 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/50 text-xs"
              onkeydown={(e) => e.key === 'Enter' && submitManualUrl()}
            />
            <Button
              onclick={submitManualUrl}
              disabled={!manualUrl.trim()}
              class="px-4"
            >
              Ga
            </Button>
          </div>
        </div>
      {/if}

      {#if error}
        <div class="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      {/if}
    </div>

    <p class="text-center text-xs text-gray-600 mt-6">
      Je gegevens worden lokaal opgeslagen op dit apparaat.
    </p>

    {#if !isTauri}
      <InstallPrompt />
    {/if}
  </div>
</div>
