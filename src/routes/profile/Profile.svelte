<script lang="ts">
  import { personId } from '$lib/stores';
  import { getProfileInfo, getProfileAddresses, getCareerInfo, getProfilePicture } from '$lib/api';
  import { onMount } from 'svelte';

  let info = $state<any>(null);
  let addresses = $state<any[]>([]);
  let career = $state<any>(null);
  let profilePic = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    const pid = $personId;
    if (!pid) return;
    try {
      [info, addresses, career, profilePic] = await Promise.all([
        getProfileInfo(pid),
        getProfileAddresses(pid),
        getCareerInfo(pid),
        getProfilePicture(pid)
      ]);
    } catch (e) {
      console.error('Error loading profile:', e);
    }
    loading = false;
  });
</script>

<div class="p-6 max-w-4xl mx-auto h-full overflow-y-auto no-scrollbar pb-20">
  <div class="mb-10 text-center">
    <div class="relative inline-block">
       <div class="w-32 h-32 rounded-3xl overflow-hidden border-4 border-surface-800 shadow-2xl mx-auto bg-surface-900 flex items-center justify-center">
         {#if profilePic}
           <img src="data:image/jpeg;base64,{profilePic}" alt="Profielfoto" class="w-full h-full object-cover" />
         {:else}
           <span class="text-4xl text-gray-700">👤</span>
         {/if}
       </div>
    </div>
    <h1 class="text-3xl font-bold text-gray-100 mt-6">{career?.Stamnummer || ''}</h1>
    <p class="text-primary-400 font-medium tracking-wide uppercase text-xs mt-1">{career?.Opleiding || 'Leerling'}</p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Contact Info -->
      <section class="glass p-6 rounded-3xl border border-surface-700/30">
        <h2 class="text-lg font-bold text-gray-100 mb-6 flex items-center gap-2">
           <span class="text-primary-400">📱</span> Contactgegevens
        </h2>
        <div class="space-y-4">
           <div>
             <span class="text-[10px] font-bold text-gray-500 uppercase block mb-1">E-mailadres</span>
             <p class="text-sm text-gray-200">{info?.Emailadres || 'Niet opgegeven'}</p>
           </div>
           <div>
             <span class="text-[10px] font-bold text-gray-500 uppercase block mb-1">Mobiel</span>
             <p class="text-sm text-gray-200">{info?.Mobiel || 'Niet opgegeven'}</p>
           </div>
        </div>
      </section>

      <!-- Career Info -->
      <section class="glass p-6 rounded-3xl border border-surface-700/30">
        <h2 class="text-lg font-bold text-gray-100 mb-6 flex items-center gap-2">
           <span class="text-primary-400">🎓</span> Opleiding
        </h2>
        <div class="space-y-4">
           <div>
             <span class="text-[10px] font-bold text-gray-500 uppercase block mb-1">Stamnummer</span>
             <p class="text-sm text-gray-200">{career?.Stamnummer || 'Onbekend'}</p>
           </div>
           <div>
             <span class="text-[10px] font-bold text-gray-500 uppercase block mb-1">Groep</span>
             <p class="text-sm text-gray-200">{career?.Groep || 'Geen groep'}</p>
           </div>
        </div>
      </section>

      <!-- Addresses -->
      <section class="glass p-6 rounded-3xl border border-surface-700/30 md:col-span-2">
        <h2 class="text-lg font-bold text-gray-100 mb-6 flex items-center gap-2">
           <span class="text-primary-400">🏠</span> Adressen
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {#each addresses as addr}
            <div class="bg-surface-800/50 p-4 rounded-2xl border border-surface-700/50">
              <span class="px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider bg-surface-700 text-gray-400 mb-3 inline-block">
                {addr.Type === 1 ? 'Woonadres' : 'Postadres'}
              </span>
              <p class="text-sm text-gray-100 font-medium">{addr.Straat} {addr.Huisnummer}{addr.Toevoeging || ''}</p>
              <p class="text-xs text-gray-500 mt-1">{addr.Postcode} {addr.Woonplaats}</p>
              <p class="text-xs text-gray-500">{addr.Land || 'Nederland'}</p>
            </div>
          {/each}
        </div>
      </section>
    </div>
  {/if}
</div>
