<script lang="ts">
  import type { AiScheduleItem, AiScheduleItemType } from "$lib/ai-schedule-types";
  import DurationUrgencyInput from "./DurationUrgencyInput.svelte";

  let {
    open = $bindable(false),
    onCreate
  }: {
    open: boolean;
    onCreate: (item: AiScheduleItem) => Promise<void>;
  } = $props();

  let title = $state("");
  let description = $state("");
  let itemType = $state<AiScheduleItemType>("custom");
  let start = $state("");
  let end = $state("");
  let urgency = $state(3);
  let estimatedMinutes = $state<number | null>(45);
  let relatedSubject = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Default start/end to now + 1h
  $effect(() => {
    if (open && !start) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
      start = fmt(now);
      const later = new Date(now.getTime() + 60 * 60000);
      end = fmt(later);
    }
  });

  async function handleCreate() {
    if (!title.trim() || !start || !end) {
      error = "Titel, start en einde zijn verplicht.";
      return;
    }
    error = null;
    saving = true;
    try {
      const nowIso = new Date().toISOString().slice(0,19);
      const item: AiScheduleItem = {
        id: "",
        title: title.trim(),
        description: description.trim() || null,
        item_type: itemType,
        start,
        end,
        status: "planned",
        urgency,
        related_assignment_id: null,
        related_calendar_event_id: null,
        related_subject: relatedSubject.trim() || null,
        estimated_minutes: estimatedMinutes,
        duration_source: estimatedMinutes ? "user_entered" : null,
        source: "user",
        created_at: nowIso,
        updated_at: nowIso,
        completed_at: null
      };
      await onCreate(item);
      // reset
      title = "";
      description = "";
      itemType = "custom";
      relatedSubject = "";
      open = false;
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4">
    <button class="absolute inset-0 w-full h-full cursor-default" onclick={() => (open = false)} aria-label="Sluiten"></button>

    <div class="glass border border-surface-700/40 rounded-t-m3-xl md:rounded-m3-xl w-full md:max-w-lg shadow-2xl relative flex flex-col max-h-[90vh]">
      <div class="flex items-center justify-between px-5 py-4 border-b border-surface-800 shrink-0">
        <h3 class="text-title-large text-gray-100">Nieuw item toevoegen</h3>
        <button onclick={() => (open = false)} class="w-8 h-8 rounded-full bg-surface-800 hover:bg-surface-700 text-gray-400 flex items-center justify-center">✕</button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-4">
        {#if error}
          <div class="p-3 rounded-m3-sm bg-red-500/10 border border-red-500/20 text-red-300 text-body-small">{error}</div>
        {/if}

        <div class="space-y-2">
          <label for="itemTitle" class="text-label-medium text-gray-500">Titel *</label>
          <input id="itemTitle" type="text" bind:value={title} placeholder="Bijv. Wiskunde herhalen" class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-white focus:outline-none focus:border-primary-500" />
        </div>

        <div class="space-y-2">
          <label for="itemType" class="text-label-medium text-gray-500">Type</label>
          <select id="itemType" bind:value={itemType} class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-white">
            <option value="custom">Eigen</option>
            <option value="study_block">Studieblok</option>
            <option value="assignment_work">Huiswerk</option>
            <option value="break">Pauze</option>
          </select>
          <p class="text-label-small text-gray-600">
            {#if itemType === "study_block"} Voorbereiding zonder specifieke opdracht (bijv. leren voor toets).{:else if itemType === "assignment_work"} Tijd om een specifieke opdracht te maken (heeft opdracht-ID).{:else if itemType === "custom"} Eigen planning. {/if}
          </p>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-2">
            <label for="itemStart" class="text-label-medium text-gray-500">Start *</label>
            <input id="itemStart" type="datetime-local" bind:value={start} class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-white" />
          </div>
          <div class="space-y-2">
            <label for="itemEnd" class="text-label-medium text-gray-500">Einde *</label>
            <input id="itemEnd" type="datetime-local" bind:value={end} class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-white" />
          </div>
        </div>

        <div class="space-y-2">
          <label for="relatedSubject" class="text-label-medium text-gray-500">Vak (optioneel)</label>
          <input id="relatedSubject" type="text" bind:value={relatedSubject} placeholder="Bijv. Wiskunde" class="w-full px-3 py-2.5 rounded-m3-xs bg-surface-800 border border-surface-700 text-white" />
        </div>

        <DurationUrgencyInput bind:minutes={estimatedMinutes} bind:urgency={urgency} label="Duur & urgentie" />

        <p class="text-label-small text-gray-600">Dit item wordt als <span class="text-amber-300">Jij (User)</span> gemarkeerd en blijft behouden bij de volgende 'Update AI Schedule' — AI-items met status Planned worden wel herschikt.</p>
      </div>

      <div class="shrink-0 border-t border-surface-800 px-5 py-4 bg-surface-900 flex gap-3">
        <button onclick={() => (open = false)} class="flex-1 py-3 rounded-m3-sm bg-surface-800 border border-white/10 text-gray-300">Annuleren</button>
        <button onclick={handleCreate} disabled={saving || !title.trim() || !start || !end} class="flex-1 py-3 rounded-m3-sm bg-primary-500 text-white disabled:opacity-40"> {saving ? "Bezig..." : "Toevoegen"} </button>
      </div>
    </div>
  </div>
{/if}
