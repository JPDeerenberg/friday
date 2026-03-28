<script lang="ts">
  import { personId } from '$lib/stores';
  import { getProfileInfo, getProfileAddresses, getCareerInfo, getProfilePicture } from '$lib/api';
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';

  let info = $state<any>(null);
  let addresses = $state<any[]>([]);
  let career = $state<any>(null);
  let profilePic = $state<string | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    await loadProfile();
  });

  async function loadProfile() {
    const pid = $personId;
    if (!pid) return;
    loading = true;
    error = null;

    const tasks = [
      getProfileInfo(pid).then(r => info = r).catch(e => console.error('Info fail:', e)),
      getProfileAddresses(pid).then(r => addresses = r).catch(e => console.error('Addr fail:', e)),
      getCareerInfo(pid).then(r => career = r).catch(e => console.error('Career fail:', e)),
      getProfilePicture(pid).then(r => profilePic = r).catch(e => console.error('Pic fail:', e))
    ];

    try {
      const results = await Promise.allSettled(tasks);
      
      // Specifically check if info or career failed
      const infoPromise = results[0];
      const addrPromise = results[1];
      const careerPromise = results[2];

      if (infoPromise.status === 'rejected') console.error('Info task failed:', infoPromise.reason);
      if (careerPromise.status === 'rejected') console.error('Career task failed:', careerPromise.reason);

      if (!info && !career) {
         const firstError = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
         error = firstError ? String(firstError.reason) : "Kon profielgegevens niet inladen (Geen info/career).";
      }
    } catch (e) {
      console.error('Profile load error:', e);
      error = "Er is iets misgegaan: " + String(e);
    } finally {
      loading = false;
    }
  }

  function getAbsenceType(type: number, code: string) {
    const iconBase = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">`;
    switch (code) {
      case 'Z': return { label: 'Ziek', color: 'text-blue-400 border-blue-400/20 bg-blue-400/10', iconSvg: iconBase + `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>` };
      case 'L': return { label: 'Te laat', color: 'text-yellow-400 border-yellow-400/20 bg-yellow-400/10', iconSvg: iconBase + `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>` };
      case 'V': return { label: 'Verwijderd', color: 'text-red-400 border-red-400/20 bg-red-400/10', iconSvg: iconBase + `<circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/></svg>` };
      default: return { label: 'Afwezig', color: 'text-gray-400 border-surface-700/50 bg-surface-800/40', iconSvg: iconBase + `<circle cx="12" cy="12" r="10"/><line x1="8" x2="16" y1="12" y2="12"/></svg>` };
    }
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <header class="sticky top-0 z-10 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-3">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-100 italic tracking-tighter">Profiel</h1>
        <button 
          onclick={loadProfile} 
          aria-label="Vernieuwen"
          class="p-2 text-gray-500 hover:text-primary-400 transition-all hover:scale-110 active:scale-95"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
  </header>

  <main class="bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.03),transparent_40%)] pb-10">
    {#if loading && !info}
      <div class="h-full flex flex-col items-center justify-center gap-6">
        <div class="w-14 h-14 border-4 border-primary-500/10 border-t-primary-500 rounded-full animate-spin shadow-[0_0_30px_rgba(59,130,246,0.15)]"></div>
        <p class="text-[10px] font-black text-gray-500 uppercase tracking-[0.4em] animate-pulse">Profiel inladen...</p>
      </div>
    {:else if error && !info}
      <div class="max-w-xl mx-auto mt-20 p-12 glass rounded-[3rem] text-center space-y-8 border-red-500/10 bg-red-500/[0.02]">
         <div class="w-24 h-24 bg-red-500/10 rounded-full flex items-center justify-center mx-auto text-5xl shadow-lg border border-red-500/20">
            ⚠️
         </div>
         <div class="space-y-2">
            <h3 class="text-2xl font-black text-white italic tracking-tight">Oeps!</h3>
            <p class="text-gray-400 text-sm">{error}</p>
         </div>
         <button onclick={loadProfile} class="px-8 py-3 rounded-2xl bg-surface-800 hover:bg-surface-700 text-white text-[10px] font-black uppercase tracking-[0.25em] transition-all">
            Opnieuw proberen
         </button>
      </div>
    {:else}
      <div class="max-w-4xl mx-auto p-8 lg:p-14 space-y-12">
        <section in:fly={{ y: 20 }} class="flex flex-col items-center text-center">
          <div class="relative group">
            <div class="absolute -inset-4 bg-gradient-to-tr from-primary-500 to-accent-500 rounded-[3rem] blur-2xl opacity-20 group-hover:opacity-40 transition-opacity duration-700"></div>
            <div class="relative w-40 h-40 rounded-[2.5rem] overflow-hidden border-4 border-surface-800 shadow-2xl bg-surface-900/80 backdrop-blur-md flex items-center justify-center ring-1 ring-white/5">
              {#if profilePic}
                <img src="data:image/jpeg;base64,{profilePic}" alt="Avatar" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" />
              {:else}
                <div class="text-gray-500 group-hover:scale-110 transition-transform duration-500">
                  <svg class="w-16 h-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
              {/if}
            </div>
            <div class="absolute -bottom-2 -right-2 w-10 h-10 bg-primary-500 rounded-2xl flex items-center justify-center text-white shadow-lg border-4 border-surface-950">
               <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </div>
          </div>

          <div class="mt-8 space-y-2">
            <h2 class="text-3xl font-black text-white italic tracking-tighter">
               {career?.StamNr || 'Student'}
            </h2>
            <div class="flex items-center justify-center gap-3">
               <span class="px-3 py-1 rounded-full bg-primary-500/10 text-primary-500 text-[10px] font-black uppercase tracking-widest border border-primary-500/20 shadow-sm">
                  {career?.Studie || 'Geen opleiding'}
               </span>
               <span class="px-3 py-1 rounded-full bg-secondary-container text-on-primary-container text-[10px] font-black uppercase tracking-widest border border-white/5 shadow-sm">
                  {career?.Klas || 'Zonder groep'}
               </span>
            </div>
          </div>
        </section>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div in:fly={{ y: 20, delay: 100 }} class="glass p-8 rounded-[2.5rem] border-surface-800/50 shadow-xl space-y-8 hover:bg-surface-800/40 transition-colors group">
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-xl bg-surface-900/80 border border-surface-700/50 flex items-center justify-center text-xl group-hover:scale-110 transition-transform">📱</div>
              <h3 class="text-sm font-black text-gray-500 uppercase tracking-[0.2em] italic">Contact</h3>
            </div>
            <div class="grid gap-6">
              <div class="space-y-1">
                <span class="text-[9px] font-black text-primary-400 uppercase tracking-widest block opacity-60">E-mail</span>
                <p class="text-gray-200 font-bold tracking-tight break-all">{info?.EmailAdres || 'Niet beschikbaar'}</p>
              </div>
              <div class="space-y-1">
                <span class="text-[9px] font-black text-primary-400 uppercase tracking-widest block opacity-60">Mobiel</span>
                <p class="text-gray-200 font-bold tracking-tight">{info?.Mobiel || 'Niet opgegeven'}</p>
              </div>
            </div>
          </div>

          <div in:fly={{ y: 20, delay: 200 }} class="glass p-8 rounded-[2.5rem] border-surface-800/50 shadow-xl space-y-8 hover:bg-surface-800/40 transition-colors group">
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-xl bg-surface-900/80 border border-surface-700/50 flex items-center justify-center text-xl group-hover:scale-110 transition-transform">🎓</div>
              <h3 class="text-sm font-black text-gray-500 uppercase tracking-[0.2em] italic">Opleiding</h3>
            </div>
            <div class="grid gap-6">
              <div class="space-y-1">
                <span class="text-[9px] font-black text-primary-400 uppercase tracking-widest block opacity-60">Leerlingnummer</span>
                <p class="text-gray-200 font-bold tracking-tight">{career?.StamNr || 'Onbekend'}</p>
              </div>
              <div class="space-y-1">
                <span class="text-[9px] font-black text-primary-400 uppercase tracking-widest block opacity-60">Status</span>
                <p class="text-gray-200 font-bold tracking-tight">Actief Ingeschreven</p>
              </div>
            </div>
          </div>

          <div in:fly={{ y: 20, delay: 300 }} class="md:col-span-2 glass p-8 rounded-[2.5rem] border-surface-800/50 shadow-xl space-y-8">
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-xl bg-surface-900/80 border border-surface-700/50 flex items-center justify-center text-primary-400">
                 <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              </div>
              <h3 class="text-sm font-black text-gray-500 uppercase tracking-[0.2em] italic">Adressen</h3>
            </div>
            {#if addresses.length === 0}
               <div class="py-10 text-center opacity-30 italic text-sm">Geen adresgegevens gevonden</div>
            {:else}
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {#each addresses as addr}
                  <div class="bg-surface-900/50 p-6 rounded-[2rem] border border-surface-800/50 hover:bg-surface-800/60 transition-all group shadow-inner">
                    <div class="mb-4">
                       <span class="px-3 py-1 rounded-xl text-[9px] font-black uppercase tracking-widest bg-surface-800 text-gray-400 border border-surface-700/50 group-hover:text-primary-400 group-hover:border-primary-500/20 transition-colors shadow-sm">
                         {addr.Type === 1 ? 'Woonadres' : 'Postadres'}
                       </span>
                    </div>
                    <p class="text-gray-100 font-bold text-lg tracking-tight mb-1">{addr.Straat} {addr.Huisnummer}{addr.Toevoeging || ''}</p>
                    <div class="flex items-center gap-2 text-gray-500 font-bold text-xs uppercase tracking-tighter">
                       <span>{addr.Postcode}</span>
                       <span class="w-1 h-1 bg-surface-700 rounded-full"></span>
                       <span>{addr.Woonplaats}</span>
                    </div>
                    <p class="text-[10px] text-gray-600 font-black uppercase tracking-widest mt-2">{addr.Land || 'Nederland'}</p>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div in:fade={{ delay: 500 }} class="pt-8 text-center opacity-40">
           <span class="text-[9px] font-black text-gray-600 uppercase tracking-[0.5em]">Beveiligde Gegevens Magister Cloud</span>
        </div>
      </div>
    {/if}
  </main>
</div>

<style>
  /* Redundant CSS removed to fix Tailwind parsing */
</style>
