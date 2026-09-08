<script lang="ts">
  import type { CalendarEvent } from "$lib/types";

  let { event }: { event: CalendarEvent } = $props();

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso.slice(11, 16);
    }
  }

  const vak = $derived(event.Vakken?.[0]?.Naam ?? event.Omschrijving ?? "Les");
  const lokaal = $derived(event.Lokalen?.[0]?.Naam ?? "");
  const start = $derived(formatTime(event.Start));
  const end = $derived(formatTime(event.Einde));
</script>

<div class="flex items-center gap-3 px-3 py-2 rounded-m3-sm bg-surface-800/30 border border-white/5 opacity-60 hover:opacity-80 transition-opacity">
  <div class="w-1.5 h-9 rounded-full bg-gray-600 shrink-0"></div>
  <div class="flex-1 min-w-0">
    <div class="flex items-center gap-2">
      <p class="text-label-medium text-gray-400 truncate">{vak}</p>
      {#if lokaal}
        <span class="text-label-small text-gray-600">· {lokaal}</span>
      {/if}
    </div>
    <p class="text-label-small text-gray-600">
      {start} – {end}
      {#if event.InfoType === 1} · HW{/if}
      {#if event.InfoType === 2} · PW{/if}
    </p>
  </div>
  <span class="text-label-small px-2 py-0.5 rounded-m3-xs bg-surface-700 text-gray-500 border border-white/5">Magister</span>
</div>
