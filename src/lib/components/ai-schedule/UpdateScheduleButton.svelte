<script lang="ts">
  let {
    onUpdate,
    disabled = false
  }: {
    onUpdate: () => Promise<void>;
    disabled?: boolean;
  } = $props();

  let loading = $state(false);

  async function handleClick() {
    if (loading || disabled) return;
    loading = true;
    try {
      await onUpdate();
    } catch (e) {
      console.error("Update AI Schedule failed", e);
    } finally {
      loading = false;
    }
  }
</script>

<button
  onclick={handleClick}
  disabled={loading || disabled}
  class="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-m3-md bg-primary-500 text-white text-title-small hover:bg-primary-600 disabled:opacity-50 transition-all shadow-lg shadow-primary-500/20 active:scale-[0.98]"
>
  {#if loading}
    <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
    <span>Bezig met plannen...</span>
  {:else}
    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
    <span>Update AI Schedule</span>
  {/if}
</button>
<p class="text-label-small text-gray-600 text-center mt-2">Deze week + volgende week — houdt rekening met lessen, slaap en je blokkades.</p>
