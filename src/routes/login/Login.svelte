<script lang="ts">
  import { isLoggedIn, loginError, accountInfo, personId, profilePicture } from '$lib/stores';
  import { startLoginFlow, getPersonId, getProfilePicture, handleAuthCallback } from '$lib/api';
  import Button from '$lib/components/Button.svelte';

  let loading = $state(false);
  let error = $state('');

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
      {#if !loading}
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
  </div>
</div>
