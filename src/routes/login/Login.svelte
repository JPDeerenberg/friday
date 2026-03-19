<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { isLoggedIn, personId, accountInfo, profilePicture } from '$lib/stores';
  import { startLoginFlow, getPersonId, getProfilePicture } from '$lib/api';

  let tenant = $state('');
  let loading = $state(false);
  let error = $state('');
  let unlistenSuccess: UnlistenFn | null = null;
  let unlistenError: UnlistenFn | null = null;

  onMount(async () => {
    // Listen for successful authentication from the Tauri backend
    unlistenSuccess = await listen('auth-success', async (event: any) => {
      const account = event.payload;
      accountInfo.set(account);

      try {
        const pid = await getPersonId();
        personId.set(pid);
        isLoggedIn.set(true);

        try {
          const pic = await getProfilePicture(pid);
          profilePicture.set(pic);
        } catch (_) {}
      } catch (e: any) {
        error = e?.toString() ?? 'Failed to complete login setup';
        loading = false;
      }
    });

    // Listen for authentication errors from the Tauri backend
    unlistenError = await listen('auth-error', (event: any) => {
      error = event.payload?.toString() ?? 'Login failed';
      loading = false;
    });
  });

  onDestroy(() => {
    if (unlistenSuccess) unlistenSuccess();
    if (unlistenError) unlistenError();
  });

  async function startLogin() {
    if (!tenant.includes('.magister.net')) {
      tenant = tenant.trim() + '.magister.net';
    }
    loading = true;
    error = '';

    try {
      await startLoginFlow(tenant);
      // We stay in the loading state until the auth-success or auth-error event fires
    } catch (e: any) {
      error = e?.toString() ?? 'Inloggen mislukt';
      loading = false;
    }
  }
</script>

<div class="flex items-center justify-center min-h-screen bg-surface-950 p-4">
  <div class="w-full max-w-md">
    <!-- Logo -->
    <div class="text-center mb-8">
      <div class="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary-500 via-primary-600 to-accent-500 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-primary-500/20">
        <span class="text-3xl font-bold text-white">M</span>
      </div>
      <h1 class="text-2xl font-bold text-gray-100">Magister Agenda</h1>
      <p class="text-sm text-gray-500 mt-1">Log in met je Magister account</p>
    </div>

    <!-- Login card -->
    <div class="glass rounded-2xl p-6 space-y-5">
      {#if !loading}
        <div>
          <label for="tenant" class="block text-sm font-medium text-gray-300 mb-2">School</label>
          <input
            id="tenant"
            type="text"
            bind:value={tenant}
            placeholder="jouwschool.magister.net"
            class="w-full px-4 py-3 rounded-xl bg-surface-800 border border-surface-700 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/50 text-sm"
            onkeydown={(e) => e.key === 'Enter' && startLogin()}
          />
        </div>

        <button
          onclick={startLogin}
          disabled={!tenant.trim()}
          class="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 text-white font-semibold text-sm hover:from-primary-400 hover:to-primary-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary-500/20 active:scale-[0.98]"
        >
          Inloggen via Magister
        </button>
      {:else}
        <div class="text-center space-y-4 py-4">
          <div class="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p class="text-sm text-gray-300 font-medium">Bezig met inloggen...</p>
          <p class="text-xs text-gray-500">Er is een apart venster geopend. Rond daar het inloggen af.</p>
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
