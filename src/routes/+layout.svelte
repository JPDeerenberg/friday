<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { isLoggedIn, personId, accountInfo, profilePicture, currentPage } from '$lib/stores';
  import { restoreSession, getAccount, getPersonId, getProfilePicture, handleAuthCallback } from '$lib/api';

  let { children } = $props();
  let loading = $state(true);
  let sidebarCollapsed = $state(false);

  async function handleLogin(account: any) {
    accountInfo.set(account);
    const pid = await getPersonId();
    personId.set(pid);
    isLoggedIn.set(true);
    try {
      const pic = await getProfilePicture(pid);
      profilePicture.set(pic);
    } catch (_) {}
  }

  onMount(async () => {
    const unlistenCallback = await listen('auth-callback', async (event) => {
      const url = event.payload as string;
      try {
        const account = await handleAuthCallback(url);
        await handleLogin(account);
      } catch (e) {
        console.error('Auth callback error:', e);
      }
    });

    const unlistenSuccess = await listen('auth-success', async (event) => {
      await handleLogin(event.payload);
    });

    const unlistenError = await listen('auth-error', (event) => {
      console.error('Auth error:', event.payload);
    });

    try {
      const restored = await restoreSession();
      if (restored) {
        const account = await getAccount();
        const pid = await getPersonId();
        accountInfo.set(account);
        personId.set(pid);
        isLoggedIn.set(true);

        try {
          const pic = await getProfilePicture(pid);
          profilePicture.set(pic);
        } catch (_) {}
      }
    } catch (_) {}
    loading = false;

    return () => {
      unlistenCallback();
      unlistenSuccess();
      unlistenError();
    };
  });

  const navGroups = [
    {
      label: 'Overzicht',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: '🏠' },
        { id: 'calendar', label: 'Agenda', icon: '📅' },
        { id: 'grades', label: 'Cijfers', icon: '📊' },
      ]
    },
    {
      label: 'Leren',
      items: [
        { id: 'assignments', label: 'Opdrachten', icon: '📝' },
        { id: 'leermiddelen', label: 'Leermiddelen', icon: '📚' },
        { id: 'studiewijzers', label: 'Studiewijzers', icon: '📖' },
      ]
    },
    {
      label: 'School',
      items: [
        { id: 'afwezigheid', label: 'Afwezigheid', icon: '🏃' },
        { id: 'activiteiten', label: 'Activiteiten', icon: '🎟️' },
        { id: 'bronnen', label: 'Bronnen', icon: '📁' },
      ]
    },
    {
      label: 'Communicatie',
      items: [
        { id: 'messages', label: 'Berichten', icon: '✉️' },
      ]
    }
  ];

  function navigate(page: string) {
    currentPage.set(page);
  }
</script>

{#if loading}
  <div class="flex items-center justify-center h-screen bg-surface-950">
    <div class="flex flex-col items-center gap-4">
      <div class="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-gray-400 text-sm">Laden...</p>
    </div>
  </div>
{:else}
  <div class="flex h-screen overflow-hidden bg-surface-950">
    {#if $isLoggedIn}
      <!-- Sidebar -->
      <aside class="flex flex-col {sidebarCollapsed ? 'w-16' : 'w-56'} bg-surface-900 border-r border-surface-700/50 transition-all duration-300">
        <!-- Logo -->
        <div class="flex items-center gap-3 px-4 py-5 border-b border-surface-700/50">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center text-white font-bold text-sm shrink-0">
            M
          </div>
          {#if !sidebarCollapsed}
            <span class="text-base font-semibold text-gray-100 truncate">Magister</span>
          {/if}
        </div>

        <!-- Nav items -->
        <nav class="flex-1 py-3 px-2 space-y-6 overflow-y-auto no-scrollbar">
          {#each navGroups as group}
            <div class="space-y-1">
              {#if !sidebarCollapsed}
                <h3 class="px-3 text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">{group.label}</h3>
              {/if}
              {#each group.items as item}
                <button
                  onclick={() => navigate(item.id)}
                  title={sidebarCollapsed ? item.label : ''}
                  class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all group
                         {$currentPage === item.id
                           ? 'bg-primary-500/15 text-primary-400'
                           : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}"
                >
                  <span class="text-lg shrink-0 group-hover:scale-110 transition-transform">{item.icon}</span>
                  {#if !sidebarCollapsed}
                    <span class="truncate">{item.label}</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/each}
        </nav>

        <!-- Profile section -->
        <button 
          onclick={() => navigate('profile')}
          class="border-t border-surface-700/50 p-3 hover:bg-surface-800 transition-colors w-full text-left"
        >
          <div class="flex items-center gap-3">
            {#if $profilePicture}
              <img src="data:image/jpeg;base64,{$profilePicture}" alt="Profielfoto" class="w-8 h-8 rounded-full object-cover shrink-0" />
            {:else}
              <div class="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center text-white text-xs font-semibold shrink-0">
                {$accountInfo?.Persoon?.Roepnaam?.[0] ?? '?'}
              </div>
            {/if}
            {#if !sidebarCollapsed}
              <div class="min-w-0">
                <p class="text-sm font-medium text-gray-200 truncate">{$accountInfo?.Persoon?.Roepnaam ?? 'Gebruiker'}</p>
                <p class="text-xs text-gray-500 truncate">Profiel bekijken</p>
              </div>
            {/if}
          </div>
        </button>

        <!-- Settings button -->
        <button
          onclick={() => navigate('settings')}
          class="w-full flex items-center gap-3 px-5 py-3 text-sm font-medium text-gray-400 hover:bg-surface-800 hover:text-gray-200 border-t border-surface-700/50 transition-all"
        >
          <span class="text-lg shrink-0">⚙️</span>
          {#if !sidebarCollapsed}
            <span class="truncate">Instellingen</span>
          {/if}
        </button>

        <!-- Collapse toggle -->
        <button
          onclick={() => sidebarCollapsed = !sidebarCollapsed}
          class="p-3 text-gray-500 hover:text-gray-300 border-t border-surface-700/50 text-sm"
        >
          {sidebarCollapsed ? '→' : '←'}
        </button>
      </aside>
    {/if}

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto">
      {@render children()}
    </main>
  </div>
{/if}
