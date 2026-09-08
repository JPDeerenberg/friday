<script lang="ts">
  import type { AiScheduleItem } from "$lib/ai-schedule-types";
  import DurationUrgencyInput from "./DurationUrgencyInput.svelte";

  let {
    item,
    onComplete,
    onDismiss,
    onDelete,
    onUpdate
  }: {
    item: AiScheduleItem;
    onComplete: (id: string) => void;
    onDismiss: (id: string) => void;
    onDelete: (id: string) => void;
    onUpdate: (item: AiScheduleItem) => void;
  } = $props();

  let editing = $state(false);
  // svelte-ignore state_referenced_locally
  let editMinutes = $state(item.estimated_minutes ?? null);
  // svelte-ignore state_referenced_locally
  let editUrgency = $state(item.urgency);

  function urgencyColor(u: number): string {
    if (u >= 5) return "border-red-500/40 bg-red-500/10 text-red-400";
    if (u >= 4) return "border-orange-500/40 bg-orange-500/10 text-orange-400";
    if (u >= 3) return "border-amber-500/40 bg-amber-500/10 text-amber-400";
    if (u >= 2) return "border-primary-500/30 bg-primary-500/10 text-primary-300";
    return "border-white/10 bg-surface-800 text-gray-400";
  }

  function typeLabel(t: string): string {
    const map: Record<string, string> = {
      assignment_work: "Huiswerk",
      study_block: "Studieblok",
      homework_review: "Review",
      custom: "Eigen",
      break: "Pauze",
      free_time: "Vrij",
      sleep: "Slaap"
    };
    return map[t] ?? t;
  }

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso.slice(11, 16);
    }
  }

  function timeRange(): string {
    return `${formatTime(item.start)} – ${formatTime(item.end)}`;
  }

  let isFreeOrSleep = $derived(item.item_type === "free_time" || item.item_type === "sleep");
</script>

<div class="glass p-4 rounded-m3-md border-white/5 space-y-3 hover:bg-surface-800/40 transition-colors {item.status === 'completed' ? 'opacity-60' : ''} {item.status === 'dismissed' ? 'opacity-40 border-dashed' : ''}">
  <div class="flex items-start justify-between gap-3">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <h3 class="text-title-small text-white truncate">{item.title}</h3>
        <span class="text-label-small px-2 py-0.5 rounded-full border {urgencyColor(item.urgency)}">U{item.urgency}</span>
        <span class="text-label-small px-2 py-0.5 rounded-full bg-surface-800 border border-white/5 text-gray-500">{typeLabel(item.item_type)}</span>
        {#if item.source === "ai_chat"}
          <span class="text-label-small px-1.5 py-0.5 rounded bg-primary-500/15 text-primary-300 border border-primary-500/20">AI</span>
        {:else}
          <span class="text-label-small px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20">Jij</span>
        {/if}
        {#if item.status !== "planned"}
          <span class="text-label-small px-2 py-0.5 rounded-full bg-surface-700 text-gray-300 capitalize">{item.status.replace("_", " ")}</span>
        {/if}
      </div>
      {#if item.description}
        <p class="text-body-small text-gray-400 mt-1 line-clamp-2">{item.description}</p>
      {/if}
      <p class="text-label-small text-gray-500 mt-1 flex items-center gap-2">
        <span>🕒 {timeRange()}</span>
        {#if item.related_subject}
          <span>· {item.related_subject}</span>
        {/if}
        {#if item.estimated_minutes}
          <span>· {item.estimated_minutes} min</span>
        {/if}
      </p>
    </div>
  </div>

  {#if editing && !isFreeOrSleep}
    <DurationUrgencyInput
      bind:minutes={editMinutes}
      bind:urgency={editUrgency}
      durationSource={item.duration_source}
      subject={item.related_subject}
      onSave={async ({ minutes, urgency }) => {
        const updated: AiScheduleItem = {
          ...item,
          estimated_minutes: minutes,
          urgency,
          duration_source: "user_entered",
          updated_at: new Date().toISOString()
        };
        // Adjust end time if duration changed: keep start, recompute end
        try {
          const s = new Date(item.start);
          const e = new Date(s.getTime() + minutes * 60000);
          const pad = (n: number) => String(n).padStart(2, "0");
          updated.end = `${e.getFullYear()}-${pad(e.getMonth()+1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}:${pad(e.getSeconds())}`;
        } catch {}
        onUpdate(updated);
        editing = false;
      }}
    />
  {/if}

  <div class="flex flex-wrap gap-2">
    {#if !isFreeOrSleep}
      <button
        onclick={() => onComplete(item.id)}
        disabled={item.status === "completed"}
        class="flex-1 min-w-[90px] px-3 py-2 rounded-m3-xs bg-emerald-500/15 border border-emerald-500/20 text-emerald-400 text-label-small hover:bg-emerald-500/25 disabled:opacity-40"
      >
        ✓ Voltooid
      </button>
      <button
        onclick={() => onDismiss(item.id)}
        disabled={item.status === "dismissed"}
        class="flex-1 min-w-[90px] px-3 py-2 rounded-m3-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 text-label-small hover:bg-amber-500/20 disabled:opacity-40"
      >
        ⊘ Negeren
      </button>
      <button
        onclick={() => (editing = !editing)}
        class="px-3 py-2 rounded-m3-xs bg-surface-800 border border-white/10 text-gray-300 text-label-small hover:bg-surface-700"
      >
        {editing ? "Annuleer" : "Wijzig"}
      </button>
    {:else}
      <span class="text-label-small text-gray-600 italic">{item.item_type === "sleep" ? "Slaap — vaste rusttijd" : "Vrije tijd — nog te plannen"}</span>
    {/if}
    <button
      onclick={() => onDelete(item.id)}
      class="px-3 py-2 rounded-m3-xs bg-red-500/10 border border-red-500/20 text-red-400 text-label-small hover:bg-red-500/20"
    >
      Verwijder
    </button>
  </div>
</div>
