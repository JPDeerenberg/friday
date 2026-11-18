<script lang="ts">
  /**
   * A small, calm "minpunten" pill for the grades page. Tap for the details: which
   * subjects are close to a sufficient grade and what a little extra would do.
   * Never red, never alarming (see grades/minpunten.ts).
   */
  import type { CompensationResult } from "$lib/grades/compensation";
  import { summarizeMinpunten, describeMinpunten } from "$lib/grades/minpunten";
  import Icon from "$lib/components/Icon.svelte";

  let {
    result,
    passGrade,
    decimals = 1,
  }: {
    result: CompensationResult;
    passGrade: number;
    decimals?: number;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

  const summary = $derived(summarizeMinpunten(result, passGrade));
  const text = $derived(describeMinpunten(summary));
  const nl = (n: number) => n.toFixed(decimals).replace(".", ",");
  const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

  function onWindowClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") open = false;
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onKey} />

{#if result.rows.length > 0}
  <div class="wrap" bind:this={root}>
    <button
      type="button"
      class="pill"
      class:great={text.tone === "great"}
      aria-expanded={open}
      aria-haspopup="dialog"
      onclick={() => (open = !open)}
    >
      <Icon name={text.tone === "great" ? "sparkles" : "sprout"} size={13} />
      {text.headline}
    </button>

    {#if open}
      <div class="pop" role="dialog" aria-label="Minpunten">
        <p class="hint">{text.hint}</p>
        {#if summary.subjects.length > 0}
          <ul>
            {#each summary.subjects as s (s.name)}
              <li>
                <span class="name">{s.name}</span>
                <span class="avg tabular-nums">{nl(s.average)}</span>
                <span class="gap tabular-nums">
                  {s.gap <= 0.005 ? "bijna" : `nog +${nl(s.gap)}`}
                </span>
              </li>
            {/each}
          </ul>
          <p class="foot">
            "Nog +…" is hoeveel je gemiddelde moet stijgen om op een voldoende
            af te ronden.
          </p>
        {/if}
        <p class="sum tabular-nums">
          Pluspunten {summary.pluspunten} · Minpunten {summary.minpunten} · Saldo
          {signed(summary.balance)}
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .wrap {
    position: relative;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.78rem;
    font-weight: 700;
    color: rgb(199 210 254);
    background: rgb(99 102 241 / 0.16);
    border: 1px solid rgb(99 102 241 / 0.3);
    white-space: nowrap;
  }
  .pill.great {
    color: rgb(110 231 183);
    background: rgb(16 185 129 / 0.14);
    border-color: rgb(16 185 129 / 0.3);
  }
  .pop {
    position: absolute;
    z-index: 30;
    top: calc(100% + 0.4rem);
    left: 0;
    width: min(20rem, calc(100vw - 2rem));
    padding: 0.8rem 0.9rem;
    border-radius: 1rem;
    color: white;
    background: color-mix(in oklch, var(--color-surface-900), black 10%);
    border: 1px solid color-mix(in oklch, white, transparent 88%);
    box-shadow: 0 20px 50px -20px black;
  }
  .hint {
    font-size: 0.9rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.5rem;
  }
  li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.6rem;
    align-items: baseline;
    font-size: 0.85rem;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .avg {
    color: rgb(156 163 175);
  }
  .gap {
    min-width: 4.2rem;
    text-align: right;
    font-weight: 700;
    color: rgb(165 180 252);
  }
  .foot,
  .sum {
    font-size: 0.72rem;
    color: rgb(156 163 175);
  }
  .sum {
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid color-mix(in oklch, white, transparent 92%);
  }
</style>
