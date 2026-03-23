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
</script>

<div class="h-screen flex flex-col overflow-hidden bg-surface-950">
  <header class="h-16 shrink-0 border-b border-surface-800/50 flex items-center justify-between px-6 bg-surface-900/50 backdrop-blur-xl z-20 shadow-xl">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-lg bg-primary-500/20 flex items-center justify-center text-primary-400 text-sm shadow-[0_0_15px_rgba(59,130,246,0.1)]">
        👤
      </div>
      <h1 class="text-lg font-bold text-gray-100 italic tracking-tight leading-none">Mijn Profiel</h1>
    </div>
    <button 
      onclick={loadProfile}
      class="p-2 rounded-xl hover:bg-surface-800/50 transition-colors text-gray-500 hover:text-primary-400"
    >
      <span class="text-lg">🔄</span>
    </button>
  </header>

  <main class="flex-1 overflow-y-auto custom-scrollbar bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.03),transparent_40%)]">
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
            <div class="absolute -inset-4 bg-gradient-to-tr from-primary-600 to-purple-600 rounded-[3rem] blur-2xl opacity-20 group-hover:opacity-40 transition-opacity duration-700"></div>
            <div class="relative w-40 h-40 rounded-[2.5rem] overflow-hidden border-4 border-surface-800 shadow-2xl bg-surface-900/80 backdrop-blur-md flex items-center justify-center ring-1 ring-white/5">
              {#if profilePic}
                <img src="data:image/jpeg;base64,{profilePic}" alt="Avatar" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" />
              {:else}
                <span class="text-6xl group-hover:scale-110 transition-transform duration-500">👤</span>
              {/if}
            </div>
            <div class="absolute -bottom-2 -right-2 w-10 h-10 bg-primary-500 rounded-2xl flex items-center justify-center text-white shadow-lg border-4 border-surface-950">
               <span class="text-sm">💎</span>
            </div>
          </div>

          <div class="mt-8 space-y-2">
            <h2 class="text-3xl font-black text-white italic tracking-tighter">
               {career?.StamNr || 'Student'}
            </h2>
            <div class="flex items-center justify-center gap-3">
               <span class="px-3 py-1 rounded-full bg-primary-500/10 text-primary-400 text-[10px] font-black uppercase tracking-widest border border-primary-500/20 shadow-sm">
                  {career?.Studie || 'Geen opleiding'}
               </span>
               <span class="px-3 py-1 rounded-full bg-purple-500/10 text-purple-400 text-[10px] font-black uppercase tracking-widest border border-purple-500/20 shadow-sm">
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
              <div class="w-10 h-10 rounded-xl bg-surface-900/80 border border-surface-700/50 flex items-center justify-center text-xl">🏠</div>
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
