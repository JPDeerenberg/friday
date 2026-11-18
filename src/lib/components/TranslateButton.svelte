<script lang="ts">
  /**
   * "Vertaal" button for homework written in another language. Only shows up when
   * the text looks non-Dutch; shows the translation under the button, with the
   * original one tap away. Uses the student's own AI key (see translate.ts).
   */
  import { htmlToText, shouldOfferTranslation } from "$lib/translate-text";
  import { translateToDutch } from "$lib/translate";
  import { recordQuestEvent } from "$lib/quests-store";
  import Icon from "$lib/components/Icon.svelte";

  let {
    source,
    class: className = "",
  }: { source: string | null | undefined; class?: string } = $props();

  const plain = $derived(htmlToText(source));
  const offer = $derived(shouldOfferTranslation(plain));

  let phase = $state<"idle" | "loading" | "done" | "error">("idle");
  let translation = $state("");
  let error = $state("");
  let showOriginal = $state(false);
  let seq = 0;

  // A different homework text (another lesson opened) starts from scratch.
  $effect(() => {
    void plain;
    seq++;
    phase = "idle";
    translation = "";
    error = "";
    showOriginal = false;
  });

  async function run() {
    if (phase === "loading") return;
    const mine = ++seq;
    phase = "loading";
    error = "";
    try {
      const out = await translateToDutch(plain);
      if (mine !== seq) return;
      translation = out;
      phase = "done";
      recordQuestEvent("translated");
    } catch (e) {
      if (mine !== seq) return;
      error = e instanceof Error ? e.message : String(e);
      phase = "error";
    }
  }
</script>

{#if offer}
  <div class="tr {className}">
    {#if phase !== "done"}
      <button
        type="button"
        class="btn"
        onclick={run}
        disabled={phase === "loading"}
      >
        <Icon name="languages" size={14} />
        {phase === "loading" ? "Vertalen…" : "Vertaal naar Nederlands"}
      </button>
    {/if}

    {#if phase === "error"}
      <p class="err" role="alert">{error}</p>
    {/if}

    {#if phase === "done"}
      <div class="box" aria-live="polite">
        <div class="head">
          <span class="head-label"
            ><Icon name="languages" size={14} /> Vertaald naar het Nederlands</span
          >
          <button
            type="button"
            class="link"
            onclick={() => (showOriginal = !showOriginal)}
          >
            {showOriginal ? "Verberg origineel" : "Toon origineel"}
          </button>
        </div>
        <p class="text">{translation}</p>
        {#if showOriginal}
          <p class="orig">{plain}</p>
        {/if}
        <p class="note">
          Vertaald door je AI-assistent: controleer belangrijke dingen.
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .tr {
    margin-top: 0.6rem;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.85rem;
    border-radius: 9999px;
    font-size: 0.8rem;
    font-weight: 700;
    color: rgb(199 210 254);
    background: rgb(99 102 241 / 0.16);
    border: 1px solid rgb(99 102 241 / 0.3);
  }
  .btn:disabled {
    opacity: 0.6;
  }
  .err {
    margin-top: 0.4rem;
    font-size: 0.8rem;
    color: rgb(252 165 165);
  }
  .box {
    border-radius: 1rem;
    padding: 0.7rem 0.85rem;
    background: rgb(99 102 241 / 0.1);
    border: 1px solid rgb(99 102 241 / 0.25);
  }
  .head-label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.72rem;
    font-weight: 700;
    color: rgb(165 180 252);
    margin-bottom: 0.35rem;
  }
  .link {
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .text,
  .orig {
    white-space: pre-wrap;
    font-size: 0.92rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .orig {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid rgb(255 255 255 / 0.1);
    color: rgb(156 163 175);
  }
  .note {
    margin-top: 0.45rem;
    font-size: 0.68rem;
    color: rgb(156 163 175);
  }
</style>
