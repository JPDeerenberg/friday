<script lang="ts">
  /**
   * A QR code for `text`, drawn as an SVG (no network, no canvas). White quiet
   * zone and black modules regardless of the theme, so every phone camera can read
   * it. Medium error correction keeps the dots large for a link of this size.
   */
  import { renderSVG } from "uqr";

  let { text, size = 260, label = "QR-code" }: { text: string; size?: number; label?: string } = $props();

  const svg = $derived.by(() => {
    try {
      return renderSVG(text, { ecc: "M", border: 2, whiteColor: "#ffffff", blackColor: "#000000" });
    } catch {
      return "";
    }
  });
</script>

{#if svg}
  <div class="qr" style="width:{size}px;max-width:100%" role="img" aria-label={label}>
    {@html svg}
  </div>
{:else}
  <p class="err">Deze QR-code is te groot. Deel de link in plaats daarvan.</p>
{/if}

<style>
  .qr {
    border-radius: 1rem;
    overflow: hidden;
    background: white;
    line-height: 0;
  }
  .qr :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .err {
    font-size: 0.85rem;
    color: rgb(252 165 165);
  }
</style>
