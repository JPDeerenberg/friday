<script lang="ts">
  import { personId, resumedAt } from '$lib/stores';
  import { getProfileInfo, getProfileAddresses, getCareerInfo, getProfilePicture, getAccount } from '$lib/api';
  import { cacheGet, cacheRefresh } from '$lib/cache';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import Button from '$lib/components/Button.svelte';
  import IconButton from '$lib/components/IconButton.svelte';
  import Card from '$lib/components/Card.svelte';
  import Chip from '$lib/components/Chip.svelte';
  import type { Account, ProfileAddress, ProfileCareer, ProfileInfo } from '$lib/types';

  let info = $state<ProfileInfo | null>(null);
  let addresses = $state<ProfileAddress[]>([]);
  let career = $state<ProfileCareer | null>(null);
  let profilePic = $state<string | null>(null);
  let account = $state<Account | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    await loadProfile();
  });

  async function fetchAllProfileData(pid: number): Promise<{
    info: ProfileInfo | null;
    addresses: ProfileAddress[];
    career: ProfileCareer | null;
    profilePic: string | null;
    account: Account | null;
  }> {
    const result = {
      info: null as ProfileInfo | null,
      addresses: [] as ProfileAddress[],
      career: null as ProfileCareer | null,
      profilePic: null as string | null,
      account: null as Account | null,
    };
    const tasks = [
      getProfileInfo(pid).then(r => result.info = r).catch(e => console.error('Info fail:', e)),
      getProfileAddresses(pid).then(r => result.addresses = r).catch(e => console.error('Addr fail:', e)),
      getCareerInfo(pid).then(r => result.career = r).catch(e => console.error('Career fail:', e)),
      getProfilePicture(pid).then(r => result.profilePic = r).catch(e => console.error('Pic fail:', e)),
      getAccount().then(r => result.account = r).catch(e => console.error('Account fail:', e)),
    ];
    await Promise.allSettled(tasks);
    return result;
  }

  // Foreground resume: force-refresh profile when app returns from background
  let resumedSeen = $state(false);
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) { resumedSeen = true; return; }
    if ($personId !== null) loadProfile(true);
  });

  async function loadProfile(force = false) {
    const pid = $personId;
    if (!pid) return;
    if (!info) loading = true;
    error = null;

    try {
      const data = force
        ? await cacheRefresh(`profile_${pid}`, () => fetchAllProfileData(pid), 5 * 60 * 1000)
        : await cacheGet(`profile_${pid}`, () => fetchAllProfileData(pid), 5 * 60 * 1000);
      info = data.info;
      addresses = data.addresses;
      career = data.career;
      profilePic = data.profilePic;
      account = data.account;
      if (!info && !career && !account) {
        error = 'Kon profielgegevens niet inladen.';
      }
    } catch (e) {
      console.error('Profile load error:', e);
      error = 'Er is iets misgegaan: ' + String(e);
    } finally {
      loading = false;
    }
  }

  // ── Derived getters ──────────────────────────────────────────────────────

  const displayName = $derived.by(() => {
    const persoon = account?.Persoon;
    const roepnaam = persoon?.Roepnaam ?? '';
    const tussenvoegsel = persoon?.Tussenvoegsel ?? '';
    const achternaamRaw = persoon?.Achternaam ?? '';
    const achternaam = tussenvoegsel ? `${tussenvoegsel} ${achternaamRaw}` : achternaamRaw;
    return { roepnaam, achternaam };
  });

  /** Calculate age from YYYY-MM-DD birthdate string. */
  function calcAge(birthdateStr: string | null | undefined): number | null {
    if (!birthdateStr) return null;
    const birth = new Date(birthdateStr);
    if (isNaN(birth.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
  }

  /** Format a YYYY-MM-DD date as Dutch locale string. */
  function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /** Returns how many days into the current school year we are (school year starts ~Aug 1). */
  function schoolYearProgress(): { daysIn: number; totalDays: number; percent: number; yearLabel: string } {
    const now = new Date();
    const yr = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const start = new Date(yr, 7, 1); // Aug 1
    const end = new Date(yr + 1, 5, 30); // Jun 30 next year
    const daysIn = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86400000));
    const totalDays = Math.floor((end.getTime() - start.getTime()) / 86400000);
    const percent = Math.min(100, Math.round((daysIn / totalDays) * 100));
    return { daysIn, totalDays, percent, yearLabel: `${yr}–${yr + 1}` };
  }

  const age = $derived.by(() => {
    const persoon = account?.Persoon;
    return calcAge(persoon?.Geboortedatum);
  });

  const birthdate = $derived.by(() => {
    const persoon = account?.Persoon;
    return formatDate(persoon?.Geboortedatum);
  });

  const progress = $derived(schoolYearProgress());
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-4 mb-6">
      <div class="flex items-center justify-between max-w-4xl mx-auto w-full">
        <h1 class="text-title-large text-gray-100">Mijn profiel</h1>
        <IconButton
          onclick={() => loadProfile(true)}
          class="hover:rotate-180 duration-700"
          aria-label="Vernieuwen"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </IconButton>
      </div>
  </header>

  <main class="flex-1 pb-20">
    {#if loading && !info}
      <div class="h-full flex flex-col items-center justify-center py-40 gap-4">
        <div class="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-label-medium text-gray-500 animate-pulse">Profielgegevens ophalen...</p>
      </div>
    {:else if error && !info}
      <div class="max-w-xl mx-auto mt-20 mx-4">
        <Card variant="outlined" class="text-center space-y-6">
          <div class="w-20 h-20 bg-red-500/10 rounded-m3-lg flex items-center justify-center mx-auto text-red-500">
            <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
          </div>
          <div class="space-y-2">
            <h3 class="text-headline-small text-white">Inladen mislukt</h3>
            <p class="text-body-medium text-gray-400">{error}</p>
          </div>
          <Button variant="filled" onclick={() => loadProfile(true)} class="w-full">Opnieuw proberen</Button>
        </Card>
      </div>
    {:else}
      <div class="max-w-4xl mx-auto px-6 space-y-10">
        <section in:fly={{ y: 20 }} class="flex flex-col items-center text-center">
          <div class="relative group">
            <div class="absolute -inset-6 bg-gradient-to-tr from-primary-500 to-accent-500 rounded-[3rem] blur-[40px] opacity-20 group-hover:opacity-40 transition-opacity duration-1000"></div>
            <div class="relative w-40 h-40 rounded-m3-xl overflow-hidden border-4 border-surface-800/80 shadow-2xl bg-surface-900/40 backdrop-blur-md flex items-center justify-center ring-1 ring-white/10 group-hover:scale-105 transition-transform duration-700">
              {#if profilePic}
                <img src="data:image/jpeg;base64,{profilePic}" alt="Profielfoto" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-1000" />
              {:else}
                <div class="text-gray-600 group-hover:text-primary-400 transition-colors duration-500">
                  <svg class="w-16 h-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
              {/if}
            </div>
            <div class="absolute -bottom-1 -right-1 w-11 h-11 bg-gradient-to-br from-primary-500 to-primary-600 rounded-m3-md flex items-center justify-center text-white shadow-xl border-4 border-surface-950 group-hover:rotate-12 transition-transform duration-500">
               <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </div>
          </div>

          <div class="mt-8 space-y-3">
            <h2 class="text-headline-large text-white">
               {displayName.roepnaam || 'Gebruiker'} {displayName.achternaam || ''}
            </h2>
            <div class="flex flex-wrap items-center justify-center gap-2">
               <Chip variant="assist">{career?.Studie || 'Opleiding'}</Chip>
               <Chip variant="assist">Klas {career?.Klas || '—'}</Chip>
               {#if age}
                 <Chip variant="assist">{age} jaar</Chip>
               {/if}
            </div>
          </div>
        </section>

        <!-- School year progress bar -->
        {#if progress.daysIn > 0}
          <div in:fly={{ y: 20, delay: 80 }}>
            <Card variant="filled" class="space-y-3">
              <div class="flex items-center justify-between mb-1">
                <span class="text-label-medium text-gray-400">Schooljaar {progress.yearLabel}</span>
                <span class="text-label-medium text-primary-400">{progress.percent}%</span>
              </div>
              <div class="relative h-2 bg-surface-800 rounded-full overflow-hidden">
                <div
                  class="absolute inset-y-0 left-0 bg-gradient-to-r from-primary-500 to-accent-500 rounded-full transition-all duration-1000"
                  style="width: {progress.percent}%"
                ></div>
              </div>
              <div class="flex justify-between text-body-small text-gray-500">
                <span>Dag {progress.daysIn}</span>
                <span>{progress.totalDays - progress.daysIn} dagen resterend</span>
              </div>
            </Card>
          </div>
        {/if}

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div in:fly={{ y: 20, delay: 100 }}>
            <Card variant="elevated" class="space-y-6 h-full">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-m3-md bg-surface-800 flex items-center justify-center text-primary-400">
                  <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </div>
                <h3 class="text-title-medium text-gray-200">Bereikbaarheid</h3>
              </div>
              <div class="grid gap-5">
                <div class="space-y-1">
                  <span class="text-label-small text-primary-400 block">Privé e-mail</span>
                  <p class="text-body-large text-gray-100 break-all">{info?.EmailAdres || 'Niet ingevuld'}</p>
                </div>
                <div class="space-y-1">
                  <span class="text-label-small text-primary-400 block">Telefoonnummer</span>
                  <p class="text-body-large text-gray-100">{info?.Mobiel || 'Niet beschikbaar'}</p>
                </div>
                {#if birthdate !== '—'}
                  <div class="space-y-1">
                    <span class="text-label-small text-primary-400 block">Geboortedatum</span>
                    <p class="text-body-large text-gray-100">{birthdate}{age ? ` (${age} jaar)` : ''}</p>
                  </div>
                {/if}
              </div>
            </Card>
          </div>

          <div in:fly={{ y: 20, delay: 200 }}>
            <Card variant="elevated" class="space-y-6 h-full">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-m3-md bg-surface-800 flex items-center justify-center text-accent-400">
                   <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
                </div>
                <h3 class="text-title-medium text-gray-200">School info</h3>
              </div>
              <div class="grid gap-5">
                <div class="space-y-1">
                  <span class="text-label-small text-accent-400 block">Stamnummer</span>
                  <p class="text-body-large text-gray-100">{career?.StamNr || 'Onbekend'}</p>
                </div>
                {#if career?.Klas}
                  <div class="space-y-1">
                    <span class="text-label-small text-accent-400 block">Klas</span>
                    <p class="text-body-large text-gray-100">{career?.Klas}</p>
                  </div>
                {/if}
                <div class="space-y-1">
                  <span class="text-label-small text-accent-400 block">Status</span>
                  <span class="inline-block mt-1 px-3 py-1 rounded-m3-full bg-primary-container text-on-primary-container text-label-medium w-fit">Ingeschreven</span>
                </div>
              </div>
            </Card>
          </div>

          <div in:fly={{ y: 20, delay: 300 }} class="md:col-span-2">
            <Card variant="elevated" class="space-y-8">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-m3-md bg-surface-800 flex items-center justify-center text-primary-400">
                   <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                </div>
                <div>
                  <h3 class="text-title-medium text-gray-200">Woonadres &amp; contactgegevens</h3>
                  <p class="text-label-small text-gray-500 mt-0.5">Officieel geregistreerd</p>
                </div>
              </div>

              {#if addresses.length === 0}
                 <div class="py-16 text-center opacity-50 border border-dashed border-surface-700 rounded-m3-md">
                   <p class="text-body-medium">Geen adresgegevens gevonden</p>
                 </div>
              {:else}
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {#each addresses as addr}
                    <div class="bg-surface-950/50 p-6 rounded-m3-md border border-white/5 hover:bg-surface-800/60 transition-all">
                      <div class="mb-4">
                         <Chip variant="assist">{addr.Type === 1 ? 'Woonadres' : 'Postadres'}</Chip>
                      </div>
                      <div>
                        <p class="text-title-medium text-white mb-1">{addr.Straat} {addr.Huisnummer}{addr.Toevoeging || ''}</p>
                        <div class="flex items-center gap-2 text-gray-400 text-body-medium">
                           <span>{addr.Postcode}</span>
                           <span class="w-1 h-1 bg-surface-700 rounded-full"></span>
                           <span>{addr.Woonplaats}</span>
                        </div>
                        <p class="text-label-small text-gray-500 mt-3">{addr.Land || 'Nederland'}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </Card>
          </div>
        </div>

        <div in:fade={{ delay: 500 }} class="pt-8 pb-4 text-center opacity-50 flex flex-col items-center gap-3">
           <div class="w-12 h-px bg-surface-800"></div>
           <span class="text-label-small text-gray-500">Beveiligd door Magister Cloud Authentication</span>
        </div>
      </div>
    {/if}
  </main>
</div>
