<script lang="ts">
  // <img> that can load Authorization-gated URLs (Magister covers, etc.).
  // Browsers can't attach headers to <img>, so same-endpoint images are
  // fetched with the session Bearer into a Blob object URL. Anything else
  // passes through; on any failure the fallback slot renders instead.
  import { onMount } from 'svelte';
  import { loadWebSession, sessionTierA } from '$lib/web-session';
  import { webAuthedImageUrl } from '$lib/web-tier-b';

  let {
    src,
    alt = '',
    class: cls = '',
    children,
  }: { src: string | null | undefined; alt?: string; class?: string; children?: import('svelte').Snippet } = $props();

  let resolved = $state<string | null>(null);
  let failed = $state(false);

  onMount(async () => {
    if (!src) {
      failed = true;
      return;
    }
    if (!/^https?:\/\//.test(src)) {
      resolved = src; // site-relative asset: nothing to authorize
      return;
    }
    try {
      const tokens = await loadWebSession();
      if (!tokens) {
        failed = true;
        return;
      }
      resolved = await webAuthedImageUrl(sessionTierA(), tokens, src);
      if (!resolved) failed = true;
    } catch {
      failed = true;
    }
  });
</script>

{#if resolved && !failed}
  <img src={resolved} {alt} class={cls} onerror={() => (failed = true)} />
{:else}
  {@render children?.()}
{/if}
