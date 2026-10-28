<script lang="ts">
  /** "N new grades — tap to reveal" card shown above the grades / on the dashboard. */
  let {
    count,
    onopen,
    class: className = "",
  }: {
    count: number;
    onopen: () => void;
    class?: string;
  } = $props();
</script>

<button
  type="button"
  onclick={onopen}
  class="pending-banner group flex w-full items-center gap-4 rounded-m3-md p-4 text-left transition-all active:scale-[0.99] {className}"
>
  <span class="badge" aria-hidden="true">
    <span class="ping motion-reduce:hidden"></span>
    <span class="relative">?</span>
  </span>
  <span class="min-w-0 flex-1">
    <span class="block text-title-small text-white">
      {count === 1 ? "1 nieuw cijfer" : `${count} nieuwe cijfers`}
    </span>
    <span class="block text-label-medium text-gray-400">
      Tik om te onthullen
    </span>
  </span>
  <svg
    class="chev h-5 w-5 shrink-0 transition-transform group-hover:translate-x-1"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="3"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg
  >
</button>

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
  .pending-banner:hover {
    border-color: color-mix(in srgb, var(--color-primary-400) 60%, transparent);
  }

  .badge {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    border-radius: 0.5rem;
    font-size: 1.5rem;
    font-weight: 900;
    color: var(--color-primary-400);
    background: color-mix(in srgb, var(--color-primary-500) 16%, transparent);
  }

  .ping {
    position: absolute;
    inset: 0;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--color-primary-500) 22%, transparent);
    animation: ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
  }

  .chev {
    color: var(--color-primary-400);
  }

  @keyframes ping {
    75%,
    100% {
      transform: scale(1.45);
      opacity: 0;
    }
  }
</style>
