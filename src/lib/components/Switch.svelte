<script lang="ts">
  /**
   * M3 switch primitive (m3.material.io/components/switch).
   *
   * Track is 52×32px (rounded-full), thumb is 24px. Selected track fills with
   * the primary color; unselected track uses an outlined surface-container.
   * Handles hover/focus/active/disabled states and exposes a controlled
   * `checked` value with an `onCheckedChange` callback that receives the next
   * boolean — replaces the app's former raw, custom-styled `<input type="checkbox">`
   * toggles with a spec-accurate, accessible switch.
   */
  let {
    checked = false,
    disabled = false,
    ariaLabel = '',
    onCheckedChange,
    class: className = '',
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    onCheckedChange?: (value: boolean) => void;
    class?: string;
    [key: string]: any;
  } = $props();

  function toggle() {
    if (disabled) return;
    onCheckedChange?.(!checked);
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  {disabled}
  onclick={toggle}
  class="inline-flex items-center shrink-0 w-[52px] h-8 rounded-full p-[4px] transition-colors
    {checked
      ? 'bg-primary-500 hover:brightness-110'
      : 'bg-surface-800 border border-surface-700 hover:bg-surface-700/60'}
    disabled:opacity-40 disabled:pointer-events-none {className}"
  {...rest}
>
  <span
    class="w-6 h-6 rounded-full bg-white shadow transition-transform duration-200
      {checked ? 'translate-x-[20px]' : 'translate-x-0'}"
  ></span>
</button>
