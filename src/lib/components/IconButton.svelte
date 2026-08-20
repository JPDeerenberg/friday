<script lang="ts">
  /**
   * M3 icon button primitive (m3.material.io/components/icon-buttons).
   *
   * A circular 40dp (md) touch target with a visible state layer on hover/active
   * and four variants per the M3 spec: standard, filled, tonal, outlined.
   * Accepts an icon via the `children` snippet. Follows the same prop
   * conventions as `Button.svelte` (`variant`, `disabled`, `class`, `...rest`).
   */
  import type { Snippet } from 'svelte';

  type Variant = 'standard' | 'filled' | 'tonal' | 'outlined';
  type Size = 'sm' | 'md' | 'lg';

  let {
    variant = 'standard',
    disabled = false,
    type = 'button',
    size = 'md',
    onclick,
    class: className = '',
    children,
    ...rest
  }: {
    variant?: Variant;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    size?: Size;
    onclick?: (e: MouseEvent) => void;
    class?: string;
    children?: Snippet;
    [key: string]: any;
  } = $props();

  const sizeClasses: Record<Size, string> = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
  };

  const variantClasses: Record<Variant, string> = {
    standard: 'bg-transparent text-on-surface-variant hover:bg-white/10 active:bg-white/15',
    filled: 'bg-primary-500 text-on-primary hover:brightness-110 active:brightness-95',
    tonal: 'bg-secondary-container text-on-secondary-container hover:brightness-110 active:brightness-95',
    outlined: 'bg-transparent border border-surface-700/60 text-on-surface-variant hover:bg-white/10 active:bg-white/15',
  };
</script>

<button
  {type}
  {disabled}
  {onclick}
  class="inline-flex items-center justify-center shrink-0 rounded-m3-full
    {sizeClasses[size]}
    transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none disabled:active:scale-100
    {variantClasses[variant]} {className}"
  {...rest}
>
  {@render children?.()}
</button>