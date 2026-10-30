<script lang="ts">
  /** "N hidden grades — tap to open a pack" card, with a quick "show all". */
  let {
    count,
    onopen,
    onpeek,
    class: className = "",
  }: {
    count: number;
    onopen: () => void;
    /** Show every grade without opening it (for checking / calculating). */
    onpeek?: () => void;
    class?: string;
  } = $props();
</script>

<div
  class="pending-banner flex w-full items-stretch gap-2 rounded-m3-md p-2 {className}"
>
  <button
    type="button"
    onclick={onopen}
    class="group flex min-w-0 flex-1 items-center gap-3 rounded-m3-sm p-2 text-left transition-transform active:scale-[0.99]"
  >
    <span class="badge" aria-hidden="true">
      <span class="ping motion-reduce:hidden"></span>
      <span class="relative">🎁</span>
    </span>
    <span class="min-w-0 flex-1">
      <span class="block text-title-small text-white">
        {count === 1 ? "1 verborgen cijfer" : `${count} verborgen cijfers`}
      </span>
      <span class="block text-label-medium text-gray-400">
        Tik om een pakketje te openen
      </span>
    </span>
  </button>
  {#if onpeek}
    <button
      type="button"
      onclick={onpeek}
      class="peek"
      aria-label="Alle cijfers tonen"
      title="Alle cijfers tonen"
    >
      <svg
        class="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        ><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle
          cx="12"
          cy="12"
          r="3"
        /></svg
      >
      <span>Alles tonen</span>
    </button>
  {/if}
</div>

<style>
  .pending-banner {
    background: linear-gradient(
      120deg,
      color-mix(
        in srgb,
        var(--color-primary-500) 14%,
        var(--color-surface-900)
      ),
      var(--color-surface-900)
    );
    border: 1px solid
      color-mix(in srgb, var(--color-primary-500) 32%, transparent);
  }
  .badge {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    border-radius: 0.75rem;
    font-size: 1.5rem;
    background: color-mix(in srgb, var(--color-primary-500) 18%, transparent);
  }
  .ping {
    position: absolute;
    inset: 0;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--color-primary-500) 24%, transparent);
    animation: ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
  }
  .peek {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
    flex-shrink: 0;
    padding: 0 0.85rem;
    border-radius: 0.75rem;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: #d1d5db;
    background: rgba(255, 255, 255, 0.06);
    transition: background 0.15s;
  }
  .peek:hover {
    background: rgba(255, 255, 255, 0.12);
  }
  @keyframes ping {
    75%,
    100% {
      transform: scale(1.45);
      opacity: 0;
    }
  }
</style>
