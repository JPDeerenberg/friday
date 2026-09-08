<script lang="ts">
  import type { DurationSource } from "$lib/ai-schedule-types";

  let {
    minutes = $bindable<number | null>(null),
    urgency = $bindable<number>(3),
    durationSource = $bindable<DurationSource | null>(null),
    subject = $bindable<string | null>(null),
    subjectAverage = $bindable<number | null>(null),
    onSave,
    saving = $bindable(false),
    label = "Duur & urgentie"
  }: {
    minutes: number | null;
    urgency: number;
    durationSource?: DurationSource | null;
    subject?: string | null;
    subjectAverage?: number | null;
    onSave?: (data: { minutes: number; urgency: number }) => void | Promise<void>;
    saving?: boolean;
    label?: string;
  } = $props();

  let localMinutes = $state(minutes?.toString() ?? "");
  let localUrgency = $state(urgency);

  $effect(() => {
    localMinutes = minutes?.toString() ?? "";
  });
  $effect(() => {
    localUrgency = urgency;
  });

  // Prefill hint from subject average if no minutes yet
  let hint = $derived(
    subjectAverage && !minutes ? `Gem. voor ${subject ?? "dit vak"}: ${subjectAverage} min` : null
  );

  function applyAverage() {
    if (subjectAverage) {
      localMinutes = String(subjectAverage);
      minutes = subjectAverage;
      durationSource = "subject_average";
    }
  }

  async function handleSave() {
    const m = parseInt(localMinutes, 10);
    if (isNaN(m) || m <= 0 || m > 600) return;
    minutes = m;
    urgency = localUrgency;
    await onSave?.({ minutes: m, urgency: localUrgency });
  }

  function urgencyColor(u: number): string {
    if (u >= 5) return "bg-red-500";
    if (u >= 4) return "bg-orange-500";
    if (u >= 3) return "bg-amber-500";
    if (u >= 2) return "bg-primary-500";
    return "bg-gray-500";
  }

  function urgencyLabel(u: number): string {
    return ["", "Laag", "Mild", "Gem.", "Hoog", "Kritiek"][u] ?? "";
  }
</script>

<div class="glass p-4 rounded-m3-md border-white/5 space-y-4">
  <div class="flex items-center justify-between">
    <p class="text-label-medium text-gray-400">{label}</p>
    {#if durationSource}
      <span class="text-label-small px-2 py-0.5 rounded-full bg-surface-800 border border-white/5 text-gray-500">
        {durationSource === "user_entered" ? "Door jou ingevuld" : durationSource === "subject_average" ? "Vak-gemiddelde" : "AI-schatting"}
      </span>
    {/if}
  </div>

  <!-- Duration input -->
  <div class="space-y-2">
    <label for="duration-input" class="text-label-small text-gray-500">Geschatte duur (minuten)</label>
    <div class="flex gap-2">
      <input
        id="duration-input"
        type="number"
        min="1"
        max="600"
        bind:value={localMinutes}
        placeholder={subjectAverage ? String(subjectAverage) : "bijv. 45"}
        class="flex-1 bg-surface-800 border border-white/10 rounded-m3-xs px-4 py-3 text-body-medium text-white placeholder-gray-600 focus:outline-none focus:border-primary-500/50"
      />
      {#if hint}
        <button
          type="button"
          onclick={applyAverage}
          class="px-3 py-2 rounded-m3-xs bg-primary-500/15 border border-primary-500/20 text-primary-300 text-label-small hover:bg-primary-500/25"
        >
          Gebruik {subjectAverage}m
        </button>
      {/if}
    </div>
    {#if hint}
      <p class="text-label-small text-gray-600">{hint} — tik om over te nemen.</p>
    {/if}
  </div>

  <!-- Urgency meter -->
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <label for="urgency-slider" class="text-label-small text-gray-500">Urgentie</label>
      <span class="text-label-small px-2 py-0.5 rounded-m3-sm border {urgencyColor(localUrgency)} text-white">{localUrgency} · {urgencyLabel(localUrgency)}</span>
    </div>
    <input
      id="urgency-slider"
      type="range"
      min="1"
      max="5"
      step="1"
      bind:value={localUrgency}
      oninput={() => (urgency = localUrgency)}
      class="w-full h-2 bg-surface-800 rounded-full appearance-none cursor-pointer accent-primary-500"
    />
    <div class="flex justify-between text-label-small text-gray-600">
      <span>Laag</span>
      <span>Kritiek</span>
    </div>
  </div>

  {#if onSave}
    <button
      type="button"
      onclick={handleSave}
      disabled={saving || !localMinutes || parseInt(localMinutes, 10) <= 0}
      class="w-full py-3 rounded-m3-sm bg-primary-500 text-white text-label-large hover:bg-primary-600 disabled:opacity-40 transition-colors"
    >
      {saving ? "Opslaan..." : "Opslaan"}
    </button>
  {/if}
</div>
