<script lang="ts">
  /** Home-screen teaser that opens the Wrapped story. */
  import { seasonLabel, seasonOf } from "#lib/cards.ts";
  import Icon from "#lib/components/Icon.svelte";

  let { onopen }: { onopen: () => void } = $props();
  const season = seasonOf(null);
</script>

<button
  type="button"
  class="wrapped"
  onclick={onopen}
  aria-label="Bekijk je Wrapped"
>
  <span class="glow" aria-hidden="true"></span>
  <span class="title"><Icon name="clapperboard" size={17} /> Jouw Wrapped</span>
  <span class="sub"
    >Je schooljaar {seasonLabel(season)} tot nu toe, in een paar tikken.</span
  >
  <span class="go">Bekijken →</span>
</button>

<style>
  .wrapped {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    width: 100%;
    text-align: left;
    border-radius: 1.5rem;
    padding: 1.2rem 1.3rem;
    color: white;
    border: 1px solid rgb(236 72 153 / 0.35);
    background:
      radial-gradient(
        120% 120% at 100% 0%,
        rgb(236 72 153 / 0.35),
        transparent 60%
      ),
      linear-gradient(135deg, rgb(88 28 135 / 0.7), rgb(30 27 75 / 0.8));
    transition: transform 0.15s ease;
  }
  .wrapped:active {
    transform: scale(0.985);
  }
  .glow {
    position: absolute;
    right: -2rem;
    bottom: -3rem;
    width: 9rem;
    height: 9rem;
    border-radius: 9999px;
    background: rgb(251 191 36 / 0.25);
    filter: blur(40px);
  }
  .title {
    position: relative;
    font-size: 1.25rem;
    font-weight: 900;
  }
  .sub {
    position: relative;
    font-size: 0.9rem;
    color: rgb(233 213 255 / 0.9);
  }
  .go {
    position: relative;
    margin-top: 0.3rem;
    font-size: 0.85rem;
    font-weight: 800;
    color: rgb(252 211 77);
  }
  @media (prefers-reduced-motion: reduce) {
    .wrapped {
      transition: none;
    }
  }
</style>
