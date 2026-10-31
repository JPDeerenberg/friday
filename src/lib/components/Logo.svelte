<script lang="ts">
  // Brand mark: open book + origami bird + calendar. Vector (not a raster PNG)
  // so it stays sharp at every size and DPI, and drawn with bold solid shapes
  // so it is still readable in a 24–32 px sidebar tile. Fills with currentColor,
  // so it inherits the tile's text colour (white on the brand gradient).
  let {
    class: className = "w-8 h-8",
    title = "Friday",
  }: { class?: string; title?: string } = $props();
</script>

<svg
  class={className}
  viewBox="0 0 32 32"
  fill="currentColor"
  role="img"
  aria-label={title}
>
  <!-- Nudged down so the artwork's optical centre sits in the middle of the box. -->
  <g transform="translate(0 1.95)">
    <!-- Book pages with calendar holes punched out of the right page. -->
    <path
      fill-rule="evenodd"
      d="M2 13.6C7 11.9 12.2 11.9 15.2 13.4V26.6C12.2 24.9 7 24.9 2 25.6ZM16.8 13.4C19.8 11.9 25 11.9 30 13.6V25.6C25 24.9 19.8 24.9 16.8 26.6ZM19.6 16.6H22V19H19.6ZM23.2 16.6H25.6V19H23.2ZM26.8 16.6H29.2V19H26.8ZM19.6 20.2H22V22.6H19.6ZM23.2 20.2H25.6V22.6H23.2ZM26.8 20.2H29.2V22.6H26.8Z"
    />
    <!-- Origami bird rising out of the book. -->
    <path
      d="M10 1.5L17 7.5L22.5 4.5L28 4.8L23.2 7.2L24 9.8L19 12L12.5 13.5L15.5 10.2L12.5 8Z"
    />
  </g>
</svg>
