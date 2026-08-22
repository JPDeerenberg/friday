<script lang="ts">
  import { isLoggedIn, currentPage } from '$lib/stores';
  import { fly } from 'svelte/transition';
  import Login from './login/Login.svelte';

  // Lazy-loaded page components. Each entry becomes its own JS chunk that is
  // only fetched/parsed when the user actually navigates to that page —
  // replaces the previous static imports that forced every page (including
  // Grades' predictor/combinatie logic and the tiptap editor pulled in via
  // Assignments) into a single ~770KB startup bundle.
  const pageLoaders: Record<string, () => Promise<{ default: unknown }>> = {
    dashboard: () => import('./dashboard/Dashboard.svelte'),
    calendar: () => import('./calendar/Calendar.svelte'),
    grades: () => import('./grades/Grades.svelte'),
    messages: () => import('./messages/Messages.svelte'),
    assignments: () => import('./assignments/Assignments.svelte'),
    leermiddelen: () => import('./leermiddelen/Leermiddelen.svelte'),
    afwezigheid: () => import('./afwezigheid/Afwezigheid.svelte'),
    bronnen: () => import('./bronnen/Bronnen.svelte'),
    studiewijzers: () => import('./studiewijzers/Studiewijzers.svelte'),
    activiteiten: () => import('./activiteiten/Activiteiten.svelte'),
    profile: () => import('./profile/Profile.svelte'),
    settings: () => import('./settings/Settings.svelte'),
  };

  // Resolved-component cache keyed by page id, so navigating back to an
  // already-visited page renders instantly with no loading flash.
  const componentCache: Record<string, any> = {};
  let ActivePage = $state<any>(null);

  $effect(() => {
    const page = $currentPage in pageLoaders ? $currentPage : 'dashboard';

    if (componentCache[page]) {
      ActivePage = componentCache[page];
      return;
    }

    let cancelled = false;
    ActivePage = null;

    pageLoaders[page]().then((mod) => {
      componentCache[page] = mod.default;
      if (!cancelled) ActivePage = mod.default;
    });

    return () => {
      cancelled = true;
    };
  });
</script>

{#if !$isLoggedIn}
  {#key $currentPage}
    <div in:fly={{ y: 20, duration: 300 }}>
      <Login />
    </div>
  {/key}
{:else}
  {#key $currentPage}
    <div in:fly={{ y: 12, duration: 250 }}>
      {#if ActivePage}
        <ActivePage />
      {:else}
        <div class="flex items-center justify-center h-[60vh]">
          <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {/if}
    </div>
  {/key}
{/if}
