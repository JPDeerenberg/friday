<script lang="ts">
  type Swatch = { id: string; bg: string; label: string };

  let {
    colors,
    value,
    onSelect,
  }: {
    colors: Swatch[];
    value: string;
    onSelect: (id: string) => void;
  } = $props();
</script>

<div class="grid grid-cols-4 gap-3 w-full sm:w-auto">
  {#each colors as color (color.id)}
    <button
      type="button"
      onclick={() => onSelect(color.id)}
      aria-pressed={value === color.id}
      aria-label={color.label}
      class="group flex flex-col items-center gap-1.5"
    >
      <div
        class="w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center {color.bg} transition-all border-2
          {value === color.id
            ? 'border-white scale-110 shadow-lg shadow-white/25'
            : 'border-transparent opacity-60 group-hover:opacity-100 group-hover:scale-105 shadow-inner'}"
      >
        {#if value === color.id}
          <svg
            class="w-6 h-6 text-white drop-shadow"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        {/if}
      </div>
      <span class="text-label-small text-gray-600 group-hover:text-gray-400 transition-colors">{color.label}</span>
    </button>
  {/each}
</div>
