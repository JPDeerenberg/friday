<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import type { Snippet } from 'svelte';

  let {
    open = $bindable(false),
    trigger,
    children,
    align = 'right',
    class: className = ''
  }: {
    open?: boolean;
    trigger: Snippet<[() => void, boolean]>;
    children: Snippet;
    align?: 'left' | 'right';
    class?: string;
  } = $props();

  let containerEl: HTMLDivElement | undefined = $state(undefined);
  let triggerWrapEl: HTMLDivElement | undefined = $state(undefined);

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  function handleClickOutside(e: MouseEvent) {
    if (!open) return;
    const target = e.target as Node;
    if (containerEl && !containerEl.contains(target) && triggerWrapEl && !triggerWrapEl.contains(target)) {
      close();
    }
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  });
</script>

<div class="relative inline-flex {className}">
  <div bind:this={triggerWrapEl}>
    {@render trigger(toggle, open)}
  </div>

  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] md:hidden" onclick={close}></div>
    <div
      bind:this={containerEl}
      class="absolute top-full mt-2 z-50 min-w-[220px] max-w-[min(280px,calc(100vw-24px))] rounded-m3-md bg-surface-900 border border-white/10 shadow-3xl overflow-hidden elevation-3
        {align === 'right' ? 'right-0' : 'left-0'}"
      role="menu"
      in:scale={{ duration: 140, start: 0.96 }}
      out:fade={{ duration: 100 }}
    >
      <div class="py-1.5">
        {@render children()}
      </div>
    </div>
  {/if}
</div>
