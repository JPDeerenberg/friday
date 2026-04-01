<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { isLoggedIn, personId, accountInfo, profilePicture, currentPage, userSettings } from '$lib/stores';
  import { restoreSession, getAccount, getPersonId, getProfilePicture, handleAuthCallback } from '$lib/api';
  import { get } from 'svelte/store';
  import { fade } from 'svelte/transition';

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

  onMount(() => {
    let unlistenCallback: any, unlistenSuccess: any, unlistenError: any, unlistenBack: any;

    (async () => {
      unlistenCallback = await listen('auth-callback', async (event) => {
        const url = event.payload as string;
        try {
          const account = await handleAuthCallback(url);
          await handleLogin(account);
        } catch (e) {
          console.error('Auth callback error:', e);
        }
      });

      unlistenSuccess = await listen('auth-success', async (event) => {
        await handleLogin(event.payload);
      });

      unlistenError = await listen('auth-error', (event) => {
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

      unlistenBack = await listen('tauri://back-button', () => {
        if (mobileSidebarOpen) {
          mobileSidebarOpen = false;
          return;
        }
        const cp = get(currentPage);
        if (cp !== 'dashboard') {
          currentPage.set('dashboard');
        }
      });
    })();
    
    const handlePopstate = () => {
      const cp = get(currentPage);
      if (cp !== 'dashboard') {
        currentPage.set('dashboard');
      }
    };
    window.addEventListener('popstate', handlePopstate);

    return () => {
      if (unlistenCallback) unlistenCallback();
      if (unlistenSuccess) unlistenSuccess();
      if (unlistenError) unlistenError();
      if (unlistenBack) unlistenBack();
      window.removeEventListener('popstate', handlePopstate);
    };
  });

  $effect(() => {
    const cp = $currentPage;
    if (cp !== 'dashboard') {
      window.history.pushState({ page: cp }, "");
    }
  });

  // Bottom nav items (most used pages)
  const bottomNavItems = [
    { id: 'dashboard', label: 'Home', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>` },
    { id: 'calendar', label: 'Agenda', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>` },
    { id: 'grades', label: 'Cijfers', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.105 13.123l2.895-2.123 2.895 2.123 5.105-4.123"/><path d="M3 21h18"/><path d="M3 3v18h18"/></svg>` },
    { id: 'messages', label: 'Berichten', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><rect width="20" height="14" x="2" y="5" rx="2"/></svg>` },
    { id: 'more', label: 'Meer', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>` },
  ];

  const navGroups = [
    {
      label: 'Overzicht',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>` },
        { id: 'calendar', label: 'Agenda', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>` },
        { id: 'grades', label: 'Cijfers', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.105 13.123l2.895-2.123 2.895 2.123 5.105-4.123"/><path d="M3 21h18"/><path d="M3 3v18h18"/></svg>` },
      ]
    },
    {
      label: 'Leren',
      items: [
        { id: 'assignments', label: 'Opdrachten', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>` },
        { id: 'leermiddelen', label: 'Leermiddelen', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>` },
        { id: 'studiewijzers', label: 'Studiewijzers', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>` },
      ]
    },
    {
      label: 'School',
      items: [
        { id: 'afwezigheid', label: 'Afwezigheid', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>` },
        { id: 'activiteiten', label: 'Activiteiten', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2v20"/><path d="M2 12h20"/><path d="M12 12l5 5"/></svg>` },
        { id: 'bronnen', label: 'Bronnen', icon: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>` },
      ]
    },
    {
      label: 'Communicatie',
      items: [
        { 
          id: 'messages', 
          label: 'Berichten', 
          icon: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><rect width="20" height="14" x="2" y="5" rx="2"/></svg>` 
        },
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
  <div
    class="flex flex-col md:flex-row h-[100dvh] overflow-hidden bg-surface-950 pt-[env(safe-area-inset-top)] theme-{$userSettings.themeColor} mode-{$userSettings.backgroundMode}"
    style="--custom-primary: {$userSettings.customThemeColor || '#8b5cf6'}"
  >
    {#if $isLoggedIn}

      <!-- ====== MOBILE: "More" drawer (slides in from bottom) ====== -->
      {#if mobileSidebarOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 bg-black/60 z-40 md:hidden" onclick={() => mobileSidebarOpen = false}></div>
        <div class="fixed bottom-[60px] left-0 right-0 z-50 md:hidden bg-surface-900 border border-surface-700/50 rounded-t-3xl shadow-2xl overflow-y-auto max-h-[70dvh]">
          <div class="flex items-center justify-between px-5 py-4 border-b border-surface-700/50">
            <div class="flex items-center gap-3 p-6 mb-2">
              <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 overflow-hidden">
                <img src="/logo.png" alt="Friday Logo" class="w-full h-full object-cover" />
              </div>
              <div class="flex flex-col">
                <h1 class="text-xl font-black text-white italic tracking-tighter" in:fade>Friday</h1>
                <p class="text-[8px] font-bold text-primary-400 uppercase tracking-widest" in:fade>Menu</p>
              </div>
            </div>
            <button onclick={() => mobileSidebarOpen = false} class="text-gray-400 p-1">
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
                    <span class="text-xl shrink-0">{@html item.icon}</span>
                    <span class="truncate">{item.label}</span>
                  </button>
                {/each}
              </div>
            {/each}
            <!-- Profile at bottom of drawer -->
            <div class="space-y-1 border-t border-surface-700/50 pt-4">
              <button onclick={() => navigate('profile')} class="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-medium text-gray-400 hover:bg-surface-800 hover:text-gray-200 transition-all">
                {#if $profilePicture}
                  <img src="data:image/jpeg;base64,{$profilePicture}" alt="Profiel" class="w-6 h-6 rounded-full object-cover shrink-0" />
                {:else}
                  <span class="text-primary-400">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </span>
                {/if}
                <span>Profiel</span>
              </button>
            </div>
            <!-- Settings inside drawer -->
            <div class="px-6 py-4 border-t border-surface-800/50 mt-auto">
              <button 
                onclick={() => navigate('settings')} 
                class="w-full flex items-center gap-4 px-4 py-3 rounded-2xl bg-surface-800/40 text-gray-300 hover:text-white transition-all border border-white/5 shadow-sm active:scale-95"
              >
                <span class="text-primary-400">
                   <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                </span>
                <span class="text-xs font-black uppercase tracking-widest italic">Instellingen</span>
              </button>
            </div>

            <button
              onclick={() => isLoggedIn.set(false)}
              class="w-full flex items-center gap-4 px-6 py-5 text-red-400 hover:bg-red-400/5 transition-colors border-t border-surface-800/50"
            >
              <span class="text-xl">
                 <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
              </span>
              <span class="text-sm font-black uppercase tracking-[0.2em]">Uitloggen</span>
            </button>
          </nav>
        </div>
      {/if}

      <!-- ====== DESKTOP: Sidebar ====== -->
      <aside class="hidden md:flex flex-col {sidebarCollapsed ? 'w-16' : 'w-56'} bg-surface-900 border-r border-surface-700/50 transition-all duration-300 shrink-0">
        <!-- Logo -->
        <div class="flex items-center gap-3 px-4 py-5 border-b border-surface-700/50 shrink-0">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 overflow-hidden">
            <img src="/logo.png" alt="Friday" class="w-full h-full object-cover" />
          </div>
          {#if !sidebarCollapsed}
            <span class="text-base font-black text-white italic tracking-tighter truncate">Friday</span>
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
                  <span class="text-lg shrink-0 group-hover:scale-110 transition-transform">
                    {@html item.icon}
                  </span>
                  {#if !sidebarCollapsed}
                    <span class="truncate tracking-tight font-bold">{item.label}</span>
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
        <button onclick={() => navigate('settings')} class="w-full flex items-center gap-3 px-5 py-3 text-sm font-bold text-gray-400 hover:bg-surface-800 hover:text-gray-200 border-t border-surface-700/50 transition-all group">
          <span class="text-lg shrink-0 text-primary-400 group-hover:rotate-45 transition-transform duration-500">
             <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </span>
          {#if !sidebarCollapsed}
            <span class="truncate italic tracking-tight uppercase text-[10px] font-black">Instellingen</span>
          {/if}
        </button>

        <!-- Bottom Nav Items (Icons Only) -->
        <div class="p-3 border-t border-surface-800/50 flex items-center justify-around bg-surface-950/50">
          {#each bottomNavItems.slice(0, 4) as item}
            <button 
              onclick={() => navigate(item.id)}
              class="p-2.5 rounded-xl transition-all {$currentPage === item.id ? 'bg-primary-500 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300 hover:bg-surface-800'}"
            >
              {@html item.icon}
            </button>
          {/each}
        </div>

        <button onclick={() => sidebarCollapsed = !sidebarCollapsed} class="p-3 text-gray-500 hover:text-gray-300 border-t border-surface-800/50 text-sm shrink-0 bg-surface-950/30">
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
      <nav class="fixed md:hidden bottom-0 left-0 right-0 z-30 bg-surface-950/95 backdrop-blur-md border-t border-surface-800/50 flex items-stretch h-[60px] pb-[env(safe-area-inset-bottom)]">
        {#each bottomNavItems as item}
          <button
            onclick={() => handleBottomNav(item.id)}
            class="flex-1 flex flex-col items-center justify-center gap-1 transition-all {isBottomActive(item.id) ? 'text-primary-400' : 'text-gray-500'}"
          >
            {@html item.icon}
            <span class="text-[9px] font-black uppercase tracking-widest">{item.label}</span>
          </button>
        {/each}
      </nav>
    {/if}
  </div>
{/if}
