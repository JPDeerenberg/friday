<script lang="ts">
  import { isLoggedIn, currentPage } from '$lib/stores';
  import Login from './login/Login.svelte';
  import Dashboard from './dashboard/Dashboard.svelte';
  import Calendar from './calendar/Calendar.svelte';
  import Grades from './grades/Grades.svelte';
  import Messages from './messages/Messages.svelte';
  import Assignments from './assignments/Assignments.svelte';
  import Leermiddelen from './leermiddelen/Leermiddelen.svelte';
  import Afwezigheid from './afwezigheid/Afwezigheid.svelte';
  import Bronnen from './bronnen/Bronnen.svelte';
  import Studiewijzers from './studiewijzers/Studiewijzers.svelte';
  import Activiteiten from './activiteiten/Activiteiten.svelte';
  import Profile from './profile/Profile.svelte';
  import Settings from './settings/Settings.svelte';
</script>

{#if !$isLoggedIn}
  <Login />
{:else if $currentPage === 'calendar'}
  <Calendar />
{:else if $currentPage === 'grades'}
  <Grades />
{:else if $currentPage === 'messages'}
  <Messages />
{:else if $currentPage === 'assignments'}
  <Assignments />
{:else if $currentPage === 'leermiddelen'}
  <Leermiddelen />
{:else if $currentPage === 'afwezigheid'}
  <Afwezigheid />
{:else if $currentPage === 'bronnen'}
  <Bronnen />
{:else if $currentPage === 'studiewijzers'}
  <Studiewijzers />
{:else if $currentPage === 'activiteiten'}
  <Activiteiten />
{:else if $currentPage === 'profile'}
  <Profile />
{:else if $currentPage === 'settings'}
  <Settings />
{:else}
  <Dashboard />
{/if}
