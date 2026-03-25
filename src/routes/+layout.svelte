<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { isLoggedIn, personId, accountInfo, profilePicture, currentPage } from '$lib/stores';
  import { restoreSession, getAccount, getPersonId, getProfilePicture, handleAuthCallback } from '$lib/api';

  let { children } = $props();
  let loading = $state(true);
  let sidebarCollapsed = $state(false);
  let mobileSidebarOpen = $state(false);

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

  // Bottom nav items (most used pages)
  const bottomNavItems = [
    { id: 'dashboard', label: 'Home', icon: '🏠' },
    { id: 'calendar', label: 'Agenda', icon: '📅' },
    { id: 'grades', label: 'Cijfers', icon: '📊' },
    { id: 'messages', label: 'Berichten', icon: '✉️' },
    { id: 'more', label: 'Meer', icon: '☰' },
  ];

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
    mobileSidebarOpen = false;
  }

  function handleBottomNav(id: string) {
    if (id === 'more') {
      mobileSidebarOpen = !mobileSidebarOpen;
    } else {
      navigate(id);
    }
  }

  // Whether a bottom nav item is "active"
  function isBottomActive(id: string): boolean {
    if (id === 'more') return mobileSidebarOpen || !bottomNavItems.slice(0, 4).some(i => i.id === $currentPage);
    return $currentPage === id;
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
  <div class="flex flex-col md:flex-row h-[100dvh] overflow-hidden bg-surface-950 pt-[env(safe-area-inset-top)]">
    {#if $isLoggedIn}

      <!-- ====== MOBILE: "More" drawer (slides in from bottom) ====== -->
      {#if mobileSidebarOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 bg-black/60 z-40 md:hidden" onclick={() => mobileSidebarOpen = false}></div>
        <div class="fixed bottom-[60px] left-0 right-0 z-50 md:hidden bg-surface-900 border border-surface-700/50 rounded-t-3xl shadow-2xl overflow-y-auto max-h-[70dvh]">
          <div class="flex items-center justify-between px-5 py-4 border-b border-surface-700/50">
            <span class="text-base font-semibold text-gray-100">Menu</span>
            <button onclick={() => mobileSidebarOpen = false} class="text-gray-400 p-1 hover:text-white">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          </div>
          <nav class="p-4 space-y-5 pb-6">
            {#each navGroups as group}
              <div class="space-y-1">
                <h3 class="px-3 text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">{group.label}</h3>
                {#each group.items as item}
                  <button
                    onclick={() => navigate(item.id)}
                    class="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-medium transition-all
                           {$currentPage === item.id
                             ? 'bg-primary-500/15 text-primary-400'
                             : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}"
                  >
                    <span class="text-xl shrink-0">{item.icon}</span>
                    <span class="truncate">{item.label}</span>
                  </button>
                {/each}
              </div>
            {/each}
            <!-- Profile + Settings at bottom of drawer -->
            <div class="space-y-1 border-t border-surface-700/50 pt-4">
              <button onclick={() => navigate('profile')} class="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-medium text-gray-400 hover:bg-surface-800 hover:text-gray-200 transition-all">
                {#if $profilePicture}
                  <img src="data:image/jpeg;base64,{$profilePicture}" alt="Profiel" class="w-6 h-6 rounded-full object-cover shrink-0" />
                {:else}
                  <span class="text-xl">👤</span>
                {/if}
                <span>Profiel</span>
              </button>
              <button onclick={() => navigate('settings')} class="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-medium text-gray-400 hover:bg-surface-800 hover:text-gray-200 transition-all">
                <span class="text-xl">⚙️</span>
                <span>Instellingen</span>
              </button>
            </div>
          </nav>
        </div>
      {/if}

      <!-- ====== DESKTOP: Sidebar ====== -->
      <aside class="hidden md:flex flex-col {sidebarCollapsed ? 'w-16' : 'w-56'} bg-surface-900 border-r border-surface-700/50 transition-all duration-300 shrink-0">
        <!-- Logo -->
        <div class="flex items-center gap-3 px-4 py-5 border-b border-surface-700/50 shrink-0">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center text-white font-bold text-sm shrink-0">M</div>
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
        <button onclick={() => navigate('profile')} class="border-t border-surface-700/50 p-3 hover:bg-surface-800 transition-colors w-full text-left">
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
        <button onclick={() => navigate('settings')} class="w-full flex items-center gap-3 px-5 py-3 text-sm font-medium text-gray-400 hover:bg-surface-800 hover:text-gray-200 border-t border-surface-700/50 transition-all">
          <span class="text-lg shrink-0">⚙️</span>
          {#if !sidebarCollapsed}
            <span class="truncate">Instellingen</span>
          {/if}
        </button>

        <!-- Collapse toggle -->
        <button onclick={() => sidebarCollapsed = !sidebarCollapsed} class="p-3 text-gray-500 hover:text-gray-300 border-t border-surface-700/50 text-sm shrink-0">
          {sidebarCollapsed ? '→' : '←'}
        </button>
      </aside>
    {/if}

    <!-- Main content — on mobile add bottom padding so content isn't behind the tab bar -->
    <main class="flex-1 overflow-y-auto {$isLoggedIn ? 'pb-[60px] md:pb-0' : ''}">
      {@render children()}
    </main>

    <!-- ====== MOBILE: Fixed bottom tab bar ====== -->
    {#if $isLoggedIn}
      <nav class="fixed md:hidden bottom-0 left-0 right-0 z-30 bg-surface-900/95 backdrop-blur-sm border-t border-surface-700/50 flex items-stretch h-[60px]">
        {#each bottomNavItems as item}
          <button
            onclick={() => handleBottomNav(item.id)}
            class="flex-1 flex flex-col items-center justify-center gap-0.5 py-1 transition-colors
                   {isBottomActive(item.id) ? 'text-primary-400' : 'text-gray-500'}"
          >
            <span class="text-xl leading-none">{item.icon}</span>
            <span class="text-[10px] font-medium leading-none">{item.label}</span>
          </button>
        {/each}
      </nav>
    {/if}
  </div>
{/if}
