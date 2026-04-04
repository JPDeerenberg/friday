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
      const infoPromise = results[0];
      const careerPromise = results[2];

      if (!info && !career) {
         const firstError = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
         error = firstError ? String(firstError.reason) : "Kon profielgegevens niet inladen.";
      }
    } catch (e) {
      console.error('Profile load error:', e);
      error = "Er is iets misgegaan: " + String(e);
    } finally {
      loading = false;
    }
  }
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur px-4 py-4 mb-6">
      <div class="flex items-center justify-between max-w-4xl mx-auto w-full">
        <h1 class="text-xl font-black text-gray-100 italic tracking-tighter uppercase">Mijn Profiel</h1>
        <button 
          onclick={loadProfile} 
          class="p-2.5 rounded-2xl bg-surface-800/50 text-gray-500 hover:text-primary-400 transition-all hover:rotate-180 duration-700 active:scale-95 border border-white/5 shadow-lg"
          aria-label="Vernieuwen"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
  </header>

  <main class="flex-1 pb-20">
    {#if loading && !info}
      <div class="h-full flex flex-col items-center justify-center py-40 gap-4">
        <div class="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin shadow-[0_0_20px_rgba(var(--color-primary-500),0.3)]"></div>
        <p class="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em] animate-pulse">Profielgegevens ophalen...</p>
      </div>
    {:else if error && !info}
      <div class="max-w-xl mx-auto mt-20 p-10 glass rounded-[3rem] text-center space-y-6 border-red-500/20 bg-red-500/[0.03] shadow-2xl mx-4">
         <div class="w-20 h-20 bg-red-500/10 rounded-[2rem] flex items-center justify-center mx-auto text-red-500 border border-red-500/20 shadow-inner">
            <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
         </div>
         <div class="space-y-2">
            <h3 class="text-2xl font-black text-white italic tracking-tighter uppercase">Inladen mislukt</h3>
            <p class="text-gray-500 text-[11px] font-bold uppercase tracking-widest leading-relaxed">{error}</p>
         </div>
         <button onclick={loadProfile} class="w-full py-4 rounded-2xl bg-surface-800 text-white text-[10px] font-black uppercase tracking-[0.3em] transition-all hover:bg-surface-700 active:scale-95 shadow-lg border border-white/5">
            Opnieuw Proberen
         </button>
      </div>
    {:else}
      <div class="max-w-4xl mx-auto px-6 space-y-12">
        <section in:fly={{ y: 20 }} class="flex flex-col items-center text-center">
          <div class="relative group">
            <div class="absolute -inset-6 bg-gradient-to-tr from-primary-500 to-accent-500 rounded-[3rem] blur-[40px] opacity-20 group-hover:opacity-40 transition-opacity duration-1000"></div>
            <div class="relative w-44 h-44 rounded-[3.5rem] overflow-hidden border-4 border-surface-800/80 shadow-2xl bg-surface-900/40 backdrop-blur-md flex items-center justify-center ring-1 ring-white/10 group-hover:scale-105 transition-transform duration-700">
              {#if profilePic}
                <img src="data:image/jpeg;base64,{profilePic}" alt="Profielfoto" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-1000" />
              {:else}
                <div class="text-gray-600 group-hover:text-primary-400 transition-colors duration-500">
                  <svg class="w-16 h-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
              {/if}
            </div>
            <div class="absolute -bottom-1 -right-1 w-12 h-12 bg-gradient-to-br from-primary-500 to-primary-600 rounded-3xl flex items-center justify-center text-white shadow-xl border-4 border-surface-950 group-hover:rotate-12 transition-transform duration-500">
               <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </div>
          </div>

          <div class="mt-10 space-y-3">
            <h2 class="text-3xl md:text-4xl font-black text-white italic tracking-tighter uppercase leading-none">
               {info?.Roepnaam || 'Gebruiker'} {info?.Achternaam || ''}
            </h2>
            <div class="flex flex-wrap items-center justify-center gap-3">
               <div class="px-4 py-1.5 rounded-full glass border-primary-500/30 text-primary-400 text-[10px] font-black uppercase tracking-[0.2em] shadow-sm">
                  {career?.Studie || 'Opleiding'}
               </div>
               <div class="px-4 py-1.5 rounded-full glass border-accent-500/30 text-accent-400 text-[10px] font-black uppercase tracking-[0.2em] shadow-sm">
                  Klas {career?.Klas || '—'}
               </div>
            </div>
          </div>
        </section>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div in:fly={{ y: 20, delay: 100 }} class="glass p-8 rounded-[2.5rem] border-white/5 shadow-2xl space-y-8 group hover:bg-surface-800/40 transition-all">
            <div class="flex items-center gap-4">
              <div class="w-12 h-12 rounded-2xl bg-surface-900 border border-surface-700/50 flex items-center justify-center text-primary-400 group-hover:rotate-6 transition-transform shadow-inner">
                <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              </div>
              <h3 class="text-[11px] font-black text-gray-500 uppercase tracking-[0.3em] font-mono italic opacity-60">Bereikbaarheid</h3>
            </div>
            <div class="grid gap-6">
              <div class="space-y-1.5 px-2 border-l-2 border-primary-500/20">
                <span class="text-[9px] font-black text-primary-400 uppercase tracking-widest block opacity-70">Privé E-mail</span>
                <p class="text-gray-100 font-black tracking-tight break-all text-sm">{info?.EmailAdres || 'Niet ingevuld'}</p>
              </div>
              <div class="space-y-1.5 px-2 border-l-2 border-primary-500/20">
                <span class="text-[9px] font-black text-primary-400 uppercase tracking-widest block opacity-70">Telefoonnummer</span>
                <p class="text-gray-100 font-black tracking-tight text-sm italic">{info?.Mobiel || 'Niet beschikbaar'}</p>
              </div>
            </div>
          </div>

          <div in:fly={{ y: 20, delay: 200 }} class="glass p-8 rounded-[2.5rem] border-white/5 shadow-2xl space-y-8 group hover:bg-surface-800/40 transition-all">
            <div class="flex items-center gap-4">
              <div class="w-12 h-12 rounded-2xl bg-surface-900 border border-surface-700/50 flex items-center justify-center text-accent-400 group-hover:-rotate-6 transition-transform shadow-inner">
                 <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
              </div>
              <h3 class="text-[11px] font-black text-gray-500 uppercase tracking-[0.3em] font-mono italic opacity-60">School Info</h3>
            </div>
            <div class="grid gap-6">
              <div class="space-y-1.5 px-2 border-l-2 border-accent-500/20">
                <span class="text-[9px] font-black text-accent-400 uppercase tracking-widest block opacity-70">Stamnummer</span>
                <p class="text-gray-100 font-black tracking-tighter text-sm italic">{career?.StamNr || 'Onbekend'}</p>
              </div>
              <div class="space-y-1.5 px-2 border-l-2 border-accent-500/20">
                <span class="text-[9px] font-black text-accent-400 uppercase tracking-widest block opacity-70">Status</span>
                <p class="text-emerald-400 font-black text-[10px] uppercase tracking-[0.2em] bg-emerald-500/10 px-3 py-1 rounded-lg w-fit mt-1 border border-emerald-500/20">Ingeschreven</p>
              </div>
            </div>
          </div>

          <div in:fly={{ y: 20, delay: 300 }} class="md:col-span-2 glass p-10 rounded-[3rem] border-white/5 shadow-2xl space-y-10 group">
            <div class="flex items-center gap-5">
              <div class="w-12 h-12 rounded-2xl bg-surface-950 border border-surface-800 flex items-center justify-center text-primary-400 shadow-inner group-hover:scale-110 transition-transform">
                 <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              </div>
              <div>
                <h3 class="text-sm font-black text-white italic tracking-tight uppercase">Woonadres & Contactgegevens</h3>
                <p class="text-[10px] font-black text-gray-600 uppercase tracking-widest mt-1">Officieel Geregistreerd</p>
              </div>
            </div>
            
            {#if addresses.length === 0}
               <div class="py-16 text-center opacity-40 glass rounded-3xl border-dashed border-white/10">
                 <p class="text-[10px] font-black uppercase tracking-[0.3em]">Geen adresgegevens gevonden</p>
               </div>
            {:else}
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-8">
                {#each addresses as addr}
                  <div class="bg-surface-950/50 p-8 rounded-[2.5rem] border border-white/5 hover:bg-surface-800/60 hover:border-primary-500/20 transition-all group/addr shadow-inner relative overflow-hidden">
                    <div class="absolute inset-0 bg-gradient-to-br from-primary-500/5 to-transparent opacity-0 group-hover/addr:opacity-100 transition-opacity"></div>
                    <div class="mb-6 relative z-10">
                       <span class="px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-[0.2em] bg-surface-900 text-gray-500 border border-white/5 group-hover/addr:text-primary-400 group-hover/addr:border-primary-500/30 transition-all shadow-sm">
                         {addr.Type === 1 ? 'Woonadres' : 'Postadres'}
                       </span>
                    </div>
                    <div class="relative z-10">
                      <p class="text-white font-black text-xl italic tracking-tight mb-2 group-hover/addr:translate-x-1 transition-transform">{addr.Straat} {addr.Huisnummer}{addr.Toevoeging || ''}</p>
                      <div class="flex items-center gap-3 text-gray-500 font-bold text-xs uppercase tracking-tighter">
                         <span class="group-hover/addr:text-gray-300 transition-colors">{addr.Postcode}</span>
                         <span class="w-1.5 h-1.5 bg-surface-800 rounded-full"></span>
                         <span class="group-hover/addr:text-gray-300 transition-colors">{addr.Woonplaats}</span>
                      </div>
                      <p class="text-[10px] text-gray-600 font-black uppercase tracking-[0.2em] mt-4 opacity-70">{addr.Land || 'Nederland'}</p>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div in:fade={{ delay: 500 }} class="pt-10 pb-4 text-center opacity-40 flex flex-col items-center gap-3">
           <div class="w-12 h-px bg-surface-800"></div>
           <span class="text-[9px] font-black text-gray-600 uppercase tracking-[0.5em] italic">Beveiligd door Magister Cloud Authentication</span>
        </div>
      </div>
    {/if}
  </main>
</div>

<style>
  .glass {
    background: oklch(0.12 0.02 290 / 0.5);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid oklch(1 0 0 / 0.05);
    box-shadow: 0 20px 50px -20px rgba(0, 0, 0, 0.5);
  }
</style>
