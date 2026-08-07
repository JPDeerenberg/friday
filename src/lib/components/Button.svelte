<script lang="ts">
  /**
   * M3 button primitive — 5 variants per the Material 3 button spec
   * (m3.material.io/components/buttons): filled, tonal, outlined, text, elevated.
   *
   * Target is authentic M3 (not a blend with the app's old look) — label text
   * uses the real "Label Large" type style (14px/medium/normal-case, confirmed
   * via search), not the old app-wide uppercase-italic-tracking-widest styling.
   * Shape uses rounded-m3-full — standard M3 buttons are pill/stadium-shaped.
   *
   * Known simplification: the "tonal" variant's text reuses .text-on-primary-container
   * rather than a dedicated on-secondary-container token (that token doesn't exist per
   * theme yet — adding it means touching all 8 theme blocks in app.css, out of scope
   * for this pass). Contrast is fine in practice since these palettes are monochromatic,
   * but flagging it as a shortcut, not a "this is definitely spec-correct" claim.
   */
  import type { Snippet } from 'svelte';

  type Variant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated';

  let {
    variant = 'filled',
    disabled = false,
    type = 'button',
    onclick,
    class: className = '',
    children,
    ...rest
  }: {
    variant?: Variant;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    onclick?: (e: MouseEvent) => void;
    class?: string;
    children?: Snippet;
    [key: string]: any;
  } = $props();

  const variantClasses: Record<Variant, string> = {
    filled: 'bg-primary-500 text-on-primary hover:brightness-110 active:brightness-95',
    tonal: 'bg-secondary-container text-on-primary-container hover:brightness-110 active:brightness-95',
    outlined: 'bg-transparent border border-primary-500/40 text-primary-400 hover:bg-primary-500/10',
    text: 'bg-transparent text-primary-400 hover:bg-primary-500/10 px-4',
    elevated: 'elevation-1 text-primary-400 hover:elevation-2',
  };
</script>

<button
  {type}
  {disabled}
  {onclick}
  class="inline-flex items-center justify-center gap-2 h-10 px-6 rounded-m3-full
    text-label-large
    transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none disabled:active:scale-100
    {variantClasses[variant]} {className}"
  {...rest}
>
  {@render children?.()}
</button>
