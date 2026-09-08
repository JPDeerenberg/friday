<script lang="ts">
  import type { AiScheduleItem } from "$lib/ai-schedule-types";
  import type { CalendarEvent } from "$lib/types";
  import AiScheduleItemCard from "./AiScheduleItemCard.svelte";
  import MagisterEventGhost from "./MagisterEventGhost.svelte";
  import UpdateScheduleButton from "./UpdateScheduleButton.svelte";
  import AddAiScheduleItemModal from "./AddAiScheduleItemModal.svelte";

  let {
    aiItems = $bindable<AiScheduleItem[]>([]),
    magisterEvents = $bindable<CalendarEvent[]>([]),
    onUpdateSchedule,
    onComplete,
    onDismiss,
    onDelete,
    onUpdateItem,
    onCreateItem
  }: {
    aiItems: AiScheduleItem[];
    magisterEvents: CalendarEvent[];
    onUpdateSchedule: () => Promise<void>;
    onComplete: (id: string) => void;
    onDismiss: (id: string) => void;
    onDelete: (id: string) => void;
    onUpdateItem: (item: AiScheduleItem) => void;
    onCreateItem: (item: AiScheduleItem) => Promise<void>;
  } = $props();

  let showAddModal = $state(false);

  // Group by day
  type DayGroup = {
    date: string; // YYYY-MM-DD
    label: string;
    aiItems: AiScheduleItem[];
    lessons: CalendarEvent[];
  };

  function groupByDay(): DayGroup[] {
    const start = new Date();
    start.setHours(0,0,0,0);
    const days: DayGroup[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const isoDate = d.toISOString().slice(0,10);
      const label = d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "short" });
      const dayAi = aiItems.filter(a => a.start.slice(0,10) === isoDate || a.end.slice(0,10) === isoDate);
      // Sort by start
      dayAi.sort((a,b) => a.start.localeCompare(b.start));
      const dayLessons = magisterEvents.filter(e => e.Start.slice(0,10) === isoDate);
      dayLessons.sort((a,b) => a.Start.localeCompare(b.Start));
      days.push({ date: isoDate, label, aiItems: dayAi, lessons: dayLessons });
    }
    return days;
  }

  const days = $derived(groupByDay());
  const hasItems = $derived(aiItems.length > 0);
</script>

<div class="space-y-6">
  <UpdateScheduleButton onUpdate={onUpdateSchedule} />

  <div class="flex items-center justify-between">
    <h2 class="text-title-medium text-white">Planning — deze week + volgende week</h2>
    <button
      onclick={() => (showAddModal = true)}
      class="px-4 py-2 rounded-m3-sm bg-surface-800 border border-white/10 text-white text-label-medium hover:bg-surface-700"
    >
      + Item toevoegen
    </button>
  </div>

  {#if !hasItems}
    <div class="glass p-8 rounded-m3-md border-white/5 text-center">
      <p class="text-body-large text-gray-400">Nog geen plan — druk op 'Update AI Schedule'</p>
      <p class="text-body-small text-gray-600 mt-2">De AI maakt een planning voor deze week + volgende week, met slaap en vrije tijd zichtbaar.</p>
    </div>
  {/if}

  <div class="space-y-6">
    {#each days as day}
      <div class="space-y-3">
        <h3 class="text-title-small text-gray-300 capitalize sticky top-0 bg-surface-950/80 backdrop-blur py-2 z-10 border-b border-white/5">{day.label} <span class="text-label-small text-gray-600 font-mono">· {day.date}</span></h3>

        {#if day.lessons.length === 0 && day.aiItems.length === 0}
          <p class="text-label-small text-gray-600 italic px-2">Geen lessen of planning — vrije dag</p>
        {/if}

        <!-- Lessons (ghost) -->
        {#if day.lessons.length > 0}
          <div class="space-y-1">
            <p class="text-label-small text-gray-500 uppercase tracking-widest">Magister lessen</p>
            {#each day.lessons as ev}
              <MagisterEventGhost event={ev} />
            {/each}
          </div>
        {/if}

        <!-- AI items -->
        {#if day.aiItems.length > 0}
          <div class="space-y-2">
            {#each day.aiItems as item}
              <AiScheduleItemCard
                item={item}
                onComplete={onComplete}
                onDismiss={onDismiss}
                onDelete={onDelete}
                onUpdate={onUpdateItem}
              />
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <AddAiScheduleItemModal bind:open={showAddModal} onCreate={onCreateItem} />
</div>
