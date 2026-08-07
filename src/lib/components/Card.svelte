<script lang="ts">
  /**
   * M3 card primitive — 3 variants per the Material 3 card spec
   * (m3.material.io/components/cards): elevated, filled, outlined.
   *
   * Target is authentic, standard M3 — the goal is no longer to blend with the
   * app's old look, so shape defaults to "md" (12px, the real M3 default for
   * cards) and `glass` (the old app's signature backdrop-blur effect) defaults
   * to false. Both are still available as opt-ins if a specific screen wants
   * them, but nothing should default toward the old aesthetic anymore.
   */
  import type { Snippet } from 'svelte';

  type Variant = 'elevated' | 'filled' | 'outlined';
  type Shape = 'md' | 'lg' | 'xl';

  let {
    variant = 'elevated',
    shape = 'md',
    glass = false,
    class: className = '',
    children,
    ...rest
  }: {
    variant?: Variant;
    shape?: Shape;
    glass?: boolean;
    class?: string;
    children?: Snippet;
    [key: string]: any;
  } = $props();

  const shapeClasses: Record<Shape, string> = {
    md: 'rounded-m3-md',  // 12px — true M3 default for cards
    lg: 'rounded-m3-lg',  // 16px
    xl: 'rounded-m3-xl',  // 28px — old app used 40-48px, well past even this
  };

  const variantClasses: Record<Variant, string> = {
    elevated: glass ? 'glass' : 'elevation-1 hover:elevation-2',
    filled: 'bg-surface-800 border border-transparent',
    outlined: 'bg-transparent border border-surface-700/60',
  };
</script>

<div class="p-8 {shapeClasses[shape]} {variantClasses[variant]} {className}" {...rest}>
  {@render children?.()}
</div>
