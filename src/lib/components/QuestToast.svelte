<script lang="ts">
  /** Tiny "Missie voltooid" pop-up (bottom, above the navigation), shown for a few seconds. */
  import { questToast } from "$lib/quests-store";
  import { fly } from "svelte/transition";
  import Icon from "$lib/components/Icon.svelte";

  let visible = $state<{ id: number; text: string; awarded: number } | null>(
    null,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const t = $questToast;
    if (!t) return;
    visible = {
      id: t.id,
      text: t.defs.map((d) => d.title).join(" · "),
      awarded: t.awarded,
    };
    clearTimeout(timer);
    timer = setTimeout(() => (visible = null), 3500);
    return () => clearTimeout(timer);
  });
</script>

{#if visible}
  {#key visible.id}
    <div
      class="toast"
      role="status"
      in:fly={{ y: 20, duration: 250 }}
      out:fly={{ y: 20, duration: 200 }}
    >
      <span class="ico"><Icon name="target" size={16} /></span>
      <span class="text">Missie voltooid: {visible.text}</span>
      {#if visible.awarded > 0}<b>+{visible.awarded} MP</b>{/if}
    </div>
  {/key}
{/if}

<style>
  .ico {
    display: flex;
    color: rgb(196 181 253);
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(5.5rem + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    max-width: min(26rem, calc(100vw - 2rem));
    padding: 0.6rem 0.9rem;
    border-radius: 9999px;
    font-size: 0.85rem;
    font-weight: 600;
    color: white;
    background: color-mix(in oklch, var(--color-surface-900), black 15%);
    border: 1px solid rgb(251 191 36 / 0.4);
    box-shadow: 0 12px 30px -12px black;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  b {
    color: rgb(252 211 77);
    white-space: nowrap;
  }
</style>
