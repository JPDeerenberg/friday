<script lang="ts">
  /**
   * Renders a semantic icon from `$lib/icons`. Decorative by default
   * (`aria-hidden`); pass `label` when the icon is the only content and needs
   * an accessible name.
   *
   * Usage: <Icon name="trophy" size={16} class="text-amber-300" />
   */
  import { ICONS, type IconName } from "$lib/icons";

  let {
    name,
    size = 16,
    strokeWidth = 2,
    label,
    class: className = "",
    ...rest
  }: {
    name: IconName;
    size?: number;
    strokeWidth?: number;
    /** Accessible name. Omit for decorative icons. */
    label?: string;
    class?: string;
    [key: string]: any;
  } = $props();

  const Glyph = $derived(ICONS[name]);
</script>

<Glyph
  {size}
  {strokeWidth}
  class="shrink-0 align-[-0.125em] {className}"
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label}
  {...rest}
/>
