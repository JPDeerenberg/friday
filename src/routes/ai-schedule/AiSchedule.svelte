<script lang="ts">
  import { onMount } from "svelte";
  import { personId, userSettings } from "$lib/stores";
  import { get } from "svelte/store";
  import * as api from "$lib/ai-schedule";
  import type { AiScheduleItem } from "$lib/ai-schedule-types";
  import type { CalendarEvent } from "$lib/types";
  import AiScheduleTimeline from "$lib/components/ai-schedule/AiScheduleTimeline.svelte";
  import Button from "$lib/components/Button.svelte";

  let aiItems = $state<AiScheduleItem[]>([]);
  let magisterEvents = $state<CalendarEvent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Keep track of subject averages for prefill (computed from completed items)
  let subjectAverages = $state<Record<string, number>>({});

  function computeWindow(): { start: string; end: string } {
    const today = new Date();
    const isoDate = (d: Date) => d.toISOString().slice(0, 10);
    const isoDateTime = (d: Date) => {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    // Planning window: today through coming Sunday + next week
    const day = today.getDay();
    const diffToMonday = today.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(today);
    monday.setDate(diffToMonday);
    const thisSunday = new Date(monday);
    thisSunday.setDate(monday.getDate() + 6);
    const nextSunday = new Date(thisSunday);
    nextSunday.setDate(thisSunday.getDate() + 7);
    const start = isoDateTime(new Date(today.setHours(0,0,0,0)));
    const end = isoDateTime(new Date(nextSunday.setHours(23,59,59,0)));
    return { start, end };
  }

  async function loadMerged() {
    const pid = get(personId);
    if (!pid) {
      loading = false;
      return;
    }
    const { start, end } = computeWindow();
    try {
      const merged = await api.getMergedSchedule(start, end, pid);
      aiItems = merged.ai_items;
      magisterEvents = merged.magister_events;
      // Compute subject averages from completed items for prefill hint
      const avg: Record<string, number[]> = {};
      for (const it of aiItems) {
        if (it.status === "completed" && it.related_subject && it.estimated_minutes) {
          if (!avg[it.related_subject]) avg[it.related_subject] = [];
          avg[it.related_subject].push(it.estimated_minutes);
        }
      }
      const out: Record<string, number> = {};
      for (const [subj, arr] of Object.entries(avg)) {
        out[subj] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
      }
      subjectAverages = out;
      error = null;
    } catch (e) {
      error = String(e);
      console.error("loadMerged failed", e);
    } finally {
      loading = false;
    }
  }

  async function handleUpdate() {
    loading = true;
    error = null;
    try {
      const updated = await api.updateAiSchedule();
      // Reload merged to also get fresh magister events
      await loadMerged();
      // If update returned items, use them (they should match merged)
      if (updated.length > 0 && aiItems.length === 0) {
        aiItems = updated;
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function handleComplete(id: string) {
    // optimistic
    const prev = aiItems.find(i => i.id === id);
    aiItems = aiItems.map(i => i.id === id ? { ...i, status: "completed" as const, completed_at: new Date().toISOString() } : i);
    try {
      await api.completeAiScheduleItem(id);
    } catch (e) {
      // revert
      if (prev) aiItems = aiItems.map(i => i.id === id ? prev : i);
      error = String(e);
    }
  }

  async function handleDismiss(id: string) {
    const prev = aiItems.find(i => i.id === id);
    aiItems = aiItems.map(i => i.id === id ? { ...i, status: "dismissed" as const } : i);
    try {
      await api.dismissAiScheduleItem(id);
    } catch (e) {
      if (prev) aiItems = aiItems.map(i => i.id === id ? prev : i);
      error = String(e);
    }
  }

  async function handleDelete(id: string) {
    const prev = [...aiItems];
    aiItems = aiItems.filter(i => i.id !== id);
    try {
      await api.deleteAiScheduleItem(id);
    } catch (e) {
      aiItems = prev;
      error = String(e);
    }
  }

  async function handleUpdateItem(updated: AiScheduleItem) {
    const prev = aiItems.find(i => i.id === updated.id);
    aiItems = aiItems.map(i => i.id === updated.id ? updated : i);
    try {
      const saved = await api.updateAiScheduleItem(updated);
      aiItems = aiItems.map(i => i.id === saved.id ? saved : i);
    } catch (e) {
      if (prev) aiItems = aiItems.map(i => i.id === updated.id ? prev : i);
      error = String(e);
    }
  }

  async function handleCreate(item: AiScheduleItem) {
    try {
      const created = await api.createAiScheduleItem(item);
      aiItems = [...aiItems, created].sort((a,b) => a.start.localeCompare(b.start));
    } catch (e) {
      error = String(e);
    }
  }

  onMount(() => {
    loadMerged();
  });
</script>

<div class="flex flex-col bg-surface-950 min-h-full">
  <header class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur">
    <div class="flex items-center justify-between px-4 py-3">
      <h1 class="text-title-large text-white">Friday's Plan</h1>
      <Button variant="text" onclick={loadMerged} disabled={loading}>Vernieuwen</Button>
    </div>
  </header>

  <main class="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
    {#if loading}
      <div class="flex flex-col items-center justify-center py-16 gap-3">
        <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-label-small text-gray-500">Planning laden...</p>
      </div>
    {:else}
      {#if error}
        <div class="p-4 rounded-m3-sm bg-red-500/10 border border-red-500/20 text-red-300 text-body-small">{error}</div>
      {/if}
      <AiScheduleTimeline
        bind:aiItems={aiItems}
        bind:magisterEvents={magisterEvents}
        onUpdateSchedule={handleUpdate}
        onComplete={handleComplete}
        onDismiss={handleDismiss}
        onDelete={handleDelete}
        onUpdateItem={handleUpdateItem}
        onCreateItem={handleCreate}
      />
    {/if}
  </main>
</div>
