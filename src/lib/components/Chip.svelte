<script lang="ts">
  /**
   * M3 chip primitive — 4 variants per the Material 3 chip spec
   * (m3.material.io/components/chips): assist, filter, input, suggestion.
   * Confirmed via search: M3 chips are "rounded rectangle" (small shape, 8px),
   * NOT pill-shaped like M2's chips — easy mistake to make since buttons ARE
   * pill-shaped, chips are not.
   *
   * - assist: outlined, optional leading icon, triggers an action
   * - filter: toggles `selected`; shows a checkmark and fills with the
   *   secondary-container color when selected
   * - input: represents a discrete piece of user input; shows a trailing
   *   remove (×) button when `onRemove` is passed
   * - suggestion: plain outlined text chip, no icon
   */
  import type { Snippet } from 'svelte';

  type Variant = 'assist' | 'filter' | 'input' | 'suggestion';

  let {
    variant = 'assist',
    selected = false,
    disabled = false,
    onclick,
    onRemove,
    leading,
    children,
    class: className = '',
    ...rest
  }: {
    variant?: Variant;
    selected?: boolean;
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    onRemove?: () => void;
    leading?: Snippet;
    children?: Snippet;
    class?: string;
    [key: string]: any;
  } = $props();

  const isFilterSelected = $derived(variant === 'filter' && selected);

  const baseClasses = $derived(
    isFilterSelected
      ? 'bg-secondary-container text-on-primary-container border border-transparent'
      : 'bg-transparent text-gray-300 border border-surface-700/60 hover:bg-surface-800/40'
  );
</script>

<button
  type="button"
  {disabled}
  {onclick}
  aria-pressed={variant === 'filter' ? selected : undefined}
  class="inline-flex items-center gap-1.5 h-8 px-3 rounded-m3-sm
    text-label-large
    transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none
    {baseClasses} {className}"
  {...rest}
>
  {#if isFilterSelected}
    <svg class="w-4 h-4 -ml-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  {:else if leading}
    <span class="w-4 h-4 -ml-0.5 flex items-center justify-center">{@render leading()}</span>
  {/if}

  {@render children?.()}

  {#if variant === 'input' && onRemove}
    <span
      role="button"
      tabindex="0"
      onclick={(e) => { e.stopPropagation(); onRemove?.(); }}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove?.(); } }}
      class="w-4 h-4 -mr-1 rounded-full flex items-center justify-center hover:bg-white/10"
      aria-label="Verwijderen"
    >
      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </span>
  {/if}
</button>
