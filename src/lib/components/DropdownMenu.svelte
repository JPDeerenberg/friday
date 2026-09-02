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
  let menuTop = $state(0);
  let menuLeft = $state(0);
  let menuWidth = $state(260);

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

  function updatePosition() {
    if (!triggerWrapEl || !containerEl) return;
    const rect = triggerWrapEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(280, vw - 24);
    menuWidth = width;
    // Center under trigger, then clamp to viewport with 12px margin
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(12, Math.min(left, vw - width - 12));
    let top = rect.bottom + 8;
    // If not enough space below, flip above
    const estHeight = containerEl.offsetHeight || 220;
    if (top + estHeight > vh - 12 && rect.top - estHeight - 8 > 12) {
      top = rect.top - estHeight - 8;
    }
    menuTop = top;
    menuLeft = left;
  }

  $effect(() => {
    if (open) {
      // Wait for DOM to render then measure
      requestAnimationFrame(() => {
        requestAnimationFrame(() => updatePosition());
      });
      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition, true);
      return () => {
        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
      };
    }
  });

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
      class="fixed z-50 min-w-[200px] rounded-m3-md bg-surface-900 border border-white/10 shadow-3xl overflow-hidden elevation-3 md:absolute"
      style="top: {menuTop}px; left: {menuLeft}px; width: {menuWidth}px; max-width: calc(100vw - 24px);"
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
