<script lang="ts">
  import { onMount } from "svelte";
  import { personId, userSettings, resumedAt } from "$lib/stores";
  import { get } from "svelte/store";
  import { formatDate } from "$lib/api";
  import { formatTime } from "$lib/format";
  import * as schedApi from "$lib/ai-schedule";
  import type { AiScheduleItem } from "$lib/ai-schedule-types";
  import type { CalendarEvent } from "$lib/types";
  import Button from "$lib/components/Button.svelte";
  import IconButton from "$lib/components/IconButton.svelte";
  import AddAiScheduleItemModal from "$lib/components/ai-schedule/AddAiScheduleItemModal.svelte";
  import { fly, slide } from "svelte/transition";

  let appointments = $state<CalendarEvent[]>([]);
  let aiItems = $state<AiScheduleItem[]>([]);
  let selectedDate = $state(new Date());
  let loading = $state(true);
  let updating = $state(false);
  let error = $state<string | null>(null);
  let showAddModal = $state(false);
  let now = $state(new Date());

  $effect(() => {
    const t = setInterval(() => { now = new Date(); }, 60000);
    return () => clearInterval(t);
  });

  let loadedStart = $state<Date | null>(null);
  let loadedEnd = $state<Date | null>(null);

  onMount(() => {
    loadMerged(true);
  });

  let resumedSeen = false;
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) { resumedSeen = true; return; }
    if (get(personId) !== null) loadMerged(true);
  });

  async function loadMerged(force = false) {
    const pid = get(personId);
    if (!pid) { loading = false; return; }
    if (!force && loadedStart && loadedEnd) {
      const bs = new Date(loadedStart); bs.setDate(bs.getDate() + 3);
      const be = new Date(loadedEnd); be.setDate(be.getDate() - 3);
      if (selectedDate >= bs && selectedDate <= be) return;
    }
    loading = true;
    error = null;
    try {
      const start = new Date(selectedDate); start.setDate(start.getDate() - 14);
      const end = new Date(selectedDate); end.setDate(end.getDate() + 14);
      loadedStart = start; loadedEnd = end;
      const merged = await schedApi.getMergedSchedule(
        start.toISOString().slice(0, 19),
        end.toISOString().slice(0, 19),
        pid
      );
      appointments = merged.magister_events;
      aiItems = merged.ai_items;
    } catch (e) {
      error = String(e);
      console.error("loadMerged failed", e);
    } finally {
      loading = false;
    }
  }

  async function handleUpdate() {
    if (updating) return;
    updating = true;
    error = null;
    try {
      const s = get(userSettings);
      await schedApi.updateAiSchedule({
        bedtime: s.aiSchedule.bedtime,
        wakeTime: s.aiSchedule.wakeTime,
        blockedTimes: s.aiSchedule.blockedTimes,
      });
      loadedStart = null; loadedEnd = null;
      await loadMerged(true);
    } catch (e) {
      error = String(e);
    } finally {
      updating = false;
    }
  }

  function navigateToDay(d: Date) {
    selectedDate = new Date(d);
    loadMerged();
  }
  function nextDay() {
    const n = new Date(selectedDate); n.setDate(n.getDate() + 1);
    if (!get(userSettings).showWeekend && (n.getDay() === 0 || n.getDay() === 6)) {
      n.setDate(n.getDate() + (n.getDay() === 6 ? 2 : 1));
    }
    navigateToDay(n);
  }
  function prevDay() {
    const p = new Date(selectedDate); p.setDate(p.getDate() - 1);
    if (!get(userSettings).showWeekend && (p.getDay() === 0 || p.getDay() === 6)) {
      p.setDate(p.getDate() - (p.getDay() === 0 ? 2 : 1));
    }
    navigateToDay(p);
  }
  function goToToday() { navigateToDay(new Date()); }

  // ---- week pills (same as Agenda) ----
  const weekData = $derived.by(() => {
    const d = new Date(selectedDate);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    const length = get(userSettings).showWeekend ? 7 : 5;
    return Array.from({ length }, (_, i) => {
      const date = new Date(monday); date.setDate(date.getDate() + i);
      const dayStr = date.toDateString();
      const dayLessons = appointments.filter(a => {
        if (!a.Start) return false;
        const ad = new Date(a.Start);
        return !isNaN(ad.getTime()) && ad.toDateString() === dayStr;
      });
      const dayAi = aiItems.filter(a => a.start.slice(0, 10) === date.toISOString().slice(0, 10));
      return {
        date,
        isToday: dayStr === new Date().toDateString(),
        isSelected: dayStr === selectedDate.toDateString(),
        hasTest: dayLessons.some(a => [2, 3, 4, 5].includes(a.InfoType)),
        hasHomework: dayLessons.some(a => a.InfoType === 1 && !a.Afgerond),
        hasPlan: dayAi.some(a => a.item_type !== "free_time" && a.item_type !== "sleep" && a.status === "planned"),
      };
    });
  });

  type MergedItem =
    | { kind: "lesson"; event: CalendarEvent; sortKey: string }
    | { kind: "ai"; item: AiScheduleItem; sortKey: string }
    | { kind: "now" };

  const dayMerged = $derived.by((): MergedItem[] => {
    const dayStr = selectedDate.toDateString();
    let lessons = appointments.filter(a => {
      if (!a.Start) return false;
      const dd = new Date(a.Start);
      return !isNaN(dd.getTime()) && dd.toDateString() === dayStr;
    });
    if (get(userSettings).hideCancelled) {
      lessons = lessons.filter(a => a.Status !== 4 && a.Status !== 5);
    }
    lessons.sort((a, b) => (a.Start ?? "").localeCompare(b.Start ?? ""));

    const isoDay = selectedDate.toISOString().slice(0, 10);
    let ai = aiItems.filter(a => a.start.slice(0, 10) === isoDay || a.end.slice(0, 10) === isoDay);
    // Hide dismissed; show planned/in_progress/completed. Hide free_time/sleep clutter?
    // Keep sleep + free_time visible but muted (user asked sleep visible). Show all except dismissed.
    ai = ai.filter(a => a.status !== "dismissed");
    ai.sort((a, b) => a.start.localeCompare(b.start));

    const merged: Exclude<MergedItem, { kind: "now" }>[] = [
      ...lessons.map(e => ({ kind: "lesson" as const, event: e, sortKey: e.Start ?? "" })),
      ...ai.map(i => ({ kind: "ai" as const, item: i, sortKey: i.start })),
    ];
    merged.sort((a, b) => (a.sortKey ?? "").localeCompare(b.sortKey ?? ""));

    // Now-marker for today
    const out: MergedItem[] = [];
    const isToday = selectedDate.toDateString() === now.toDateString();
    let inserted = false;
    for (const m of merged) {
      if (isToday && !inserted && m.sortKey > now.toISOString().slice(0, 19)) {
        out.push({ kind: "now" });
        inserted = true;
      }
      out.push(m);
    }
    if (isToday && !inserted) out.push({ kind: "now" });
    return out;
  });

  function getInfoLabel(info: number) {
    if (info === 1) return "Huiswerk";
    if (info === 2) return "Toets";
    if (info === 3) return "Tentamen";
    if (info === 4) return "SO";
    if (info === 5) return "Mondeling";
    return "Afspraak";
  }
  function getInfoColor(info: number, afgerond = false) {
    if (info === 1) {
      if (afgerond) return "border-surface-600 text-gray-400 bg-surface-700/40 opacity-60";
      return "border-primary-400/60 text-primary-200 bg-primary-500/25";
    }
    if ([2, 3, 4, 5].includes(info)) return "border-red-400/60 text-red-200 bg-red-500/25";
    return "border-surface-600 text-gray-300 bg-surface-700/50";
  }
  function aiTypeLabel(t: string) {
    const m: Record<string, string> = {
      assignment_work: "Huiswerk", study_block: "Leren", homework_review: "Review",
      custom: "Eigen", break: "Pauze", free_time: "Vrij", sleep: "Slaap",
    };
    return m[t] ?? t;
  }
  function aiCardStyle(item: AiScheduleItem): string {
    if (item.status === "completed") return "bg-surface-800/50 border-surface-700/40 opacity-60";
    if (item.item_type === "sleep") return "bg-indigo-500/8 border-indigo-500/25 opacity-80";
    if (item.item_type === "free_time") return "bg-surface-800/40 border-surface-700/30 opacity-60";
    if (item.item_type === "homework_review") return "bg-amber-500/10 border-amber-500/40";
    if (item.urgency >= 4) return "bg-red-500/8 border-red-500/30";
    if (item.item_type === "study_block") return "bg-emerald-500/8 border-emerald-500/30";
    return "bg-primary-500/10 border-primary-500/40";
  }

  async function doComplete(id: string) {
    const prev = aiItems.find(i => i.id === id);
    aiItems = aiItems.map(i => i.id === id ? { ...i, status: "completed" as const } : i);
    try { await schedApi.completeAiScheduleItem(id); }
    catch (e) { if (prev) aiItems = aiItems.map(i => i.id === id ? prev : i); error = String(e); }
  }
  async function doDismiss(id: string) {
    const prev = [...aiItems];
    aiItems = aiItems.filter(i => i.id !== id || true);
    // optimistic: mark dismissed then filter out (dismissed hidden)
    aiItems = aiItems.map(i => i.id === id ? { ...i, status: "dismissed" as const } : i);
    aiItems = aiItems.filter(i => i.status !== "dismissed");
    try { await schedApi.dismissAiScheduleItem(id); }
    catch (e) { aiItems = prev; error = String(e); }
  }
  async function doDelete(id: string) {
    const prev = [...aiItems];
    aiItems = aiItems.filter(i => i.id !== id);
    try { await schedApi.deleteAiScheduleItem(id); }
    catch (e) { aiItems = prev; error = String(e); }
  }
  async function doCreate(item: AiScheduleItem) {
    try {
      const created = await schedApi.createAiScheduleItem(item);
      aiItems = [...aiItems, created];
    } catch (e) { error = String(e); }
  }

  function lesuurLabel(e: CalendarEvent): string {
    const lv = e.LesuurVan ?? null, lt = e.LesuurTotMet ?? null;
    if (lv && lt && lv !== lt) return `${lv}–${lt}`;
    if (lv) return `${lv}`;
    return "—";
  }
</script>

<div class="flex flex-col h-full bg-surface-950">
  <!-- Header — same pattern as Agenda -->
  <header class="sticky top-0 z-20 bg-surface-950/90 backdrop-blur-xl border-b border-surface-800/30 px-3 py-2 md:px-4 md:py-2.5">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <label class="flex flex-col relative cursor-pointer group min-w-0 shrink">
          <input
            type="date"
            class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            style="color-scheme: dark;"
            value={selectedDate.toISOString().split("T")[0]}
            onchange={(e) => { if (e.currentTarget.value) navigateToDay(new Date(e.currentTarget.value)); }}
          />
          <p class="text-label-small text-primary-400 group-hover:text-primary-300 transition-colors leading-none truncate">
            {selectedDate.toLocaleDateString("nl-NL", { month: "long" })}
          </p>
          <h2 class="text-title-medium md:text-headline-small text-white leading-tight group-hover:text-gray-200 transition-colors truncate">
            {selectedDate.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric" })}
          </h2>
        </label>
        <IconButton onclick={() => { loadedStart = null; loadedEnd = null; loadMerged(true); }} title="Verversen" aria-label="Verversen" class="hover:rotate-180 duration-500 shrink-0">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </IconButton>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <IconButton onclick={prevDay} title="Vorige dag" aria-label="Vorige dag">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </IconButton>
        <Button variant="tonal" onclick={goToToday} class="px-4 h-8!">Vandaag</Button>
        <IconButton onclick={nextDay} title="Volgende dag" aria-label="Volgende dag">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </IconButton>
      </div>
    </div>

    <!-- Day chooser — same as Agenda -->
    <div data-daybar class="mt-2 flex justify-between gap-1 overflow-x-auto no-scrollbar" style="touch-action: pan-y;">
      {#each weekData as { date, isToday, isSelected, hasTest, hasHomework, hasPlan }}
        <button
          onclick={() => navigateToDay(new Date(date))}
          class="flex-1 flex flex-col items-center py-1.5 px-0.5 rounded-m3-sm transition-all border min-w-[38px] relative {isSelected ? 'bg-primary-500 border-primary-400 text-white shadow-md shadow-primary-500/25' : 'bg-surface-800/60 border-white/5 text-gray-400 hover:bg-surface-700 hover:text-gray-200'}"
        >
          <span class="text-label-small opacity-60">{date.toLocaleDateString("nl-NL", { weekday: "short" }).slice(0, 2)}</span>
          <span class="text-title-small leading-none">{date.getDate()}</span>
          <div class="flex gap-0.5 mt-0.5 h-1">
            {#if hasTest}
              <div class="w-1 h-1 rounded-full bg-red-500"></div>
            {:else if hasHomework}
              <div class="w-1 h-1 rounded-full bg-primary-400"></div>
            {/if}
            {#if hasPlan}
              <div class="w-1 h-1 rounded-full bg-emerald-400"></div>
            {:else if isToday && !isSelected && !hasTest && !hasHomework}
              <div class="w-1 h-1 rounded-full bg-primary-500 animate-pulse"></div>
            {/if}
          </div>
        </button>
      {/each}
    </div>

    <!-- Update AI Schedule — the only automation trigger -->
    <div class="mt-2 flex gap-2">
      <button
        onclick={handleUpdate}
        disabled={updating || loading}
        class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-m3-md bg-primary-500 text-white text-label-large hover:bg-primary-600 disabled:opacity-50 transition-all active:scale-[0.99]"
      >
        {#if updating}
          <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          <span>Bezig met plannen...</span>
        {:else}
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          <span>Update AI Schedule</span>
        {/if}
      </button>
      <button
        onclick={() => (showAddModal = true)}
        class="px-4 py-2.5 rounded-m3-md bg-surface-800 border border-white/10 text-white text-label-large hover:bg-surface-700"
        title="Eigen item toevoegen"
      >+</button>
    </div>
  </header>

  <main class="flex-1 overflow-y-auto p-2 md:p-3 space-y-2 md:space-y-3 custom-scrollbar">
    {#if error}
      <div class="bg-red-500/10 border border-red-500/20 rounded-m3-md p-3 text-body-small text-red-300">{error}</div>
    {/if}
    {#if loading}
      <div class="flex flex-col items-center justify-center py-16 gap-3">
        <div class="w-10 h-10 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-label-medium text-gray-600 animate-pulse">Planning ophalen...</p>
      </div>
    {:else if dayMerged.length === 0}
      <div class="flex-1 flex flex-col items-center justify-center py-16 text-center space-y-4">
        <div class="w-20 h-20 rounded-full bg-surface-800/80 border border-surface-700/50 flex items-center justify-center">
          <svg class="w-8 h-8 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>
        </div>
        <div>
          <h3 class="text-headline-small text-white mb-1">Geen lessen of planning</h3>
          <p class="text-body-medium text-gray-500 max-w-[260px] leading-relaxed">Druk op 'Update AI Schedule' om huiswerk, toetsen en studieblokken te laten inplannen.</p>
        </div>
      </div>
    {:else}
      {#each dayMerged as m, i}
        {#if m.kind === "now"}
          <div class="flex items-center gap-2 px-1" aria-hidden="true">
            <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
            <div class="h-0.5 flex-1 bg-red-500 rounded-full"></div>
            <span class="text-label-small text-red-400 tabular-nums shrink-0">Nu · {formatTime(now.toISOString())}</span>
          </div>
        {:else if m.kind === "lesson"}
          {@const app = m.event}
          <div
            in:fly={{ y: 12, duration: 200, delay: Math.min(i * 20, 200) }}
            class="w-full text-left rounded-m3-md p-3 md:p-4 flex gap-3 md:gap-4 border {app.InfoType === 1 && !app.Afgerond ? 'bg-primary-500/14 border-primary-500/40' : app.Status === 4 || app.Status === 5 ? 'bg-red-500/8 border-red-500/30' : 'bg-surface-800/60 border-surface-700/40'}"
          >
            <div class="flex flex-col items-center justify-center min-w-[36px] md:min-w-[42px] gap-0.5">
              <span class="text-label-small {app.Status === 4 || app.Status === 5 ? 'text-red-400' : 'text-primary-400'}">Les</span>
              <span class="text-title-large text-white leading-none">{lesuurLabel(app)}</span>
              <div class="h-px w-4 bg-surface-600 my-0.5"></div>
              <span class="text-label-small text-primary-300/80">{formatTime(app.Start)}</span>
            </div>
            <div class="w-px bg-surface-600/50 my-1"></div>
            <div class="flex-1 min-w-0 flex flex-col justify-center">
              <div class="flex items-center justify-between gap-1.5 mb-0.5">
                <span class="text-title-medium text-white truncate">{app.Vakken?.[0]?.Naam || app.Omschrijving || "Vrij"}</span>
                {#if app.Docenten?.[0]}
                  <span class="text-label-small text-gray-500 shrink-0 bg-surface-900/60 px-1.5 py-0.5 rounded-m3-sm border border-white/5">{app.Docenten[0].Naam}</span>
                {/if}
              </div>
              <div class="flex items-center gap-2.5 text-label-small text-gray-400">
                <span class="truncate">{app.Lokatie || "—"}</span>
                <span>Tot {formatTime(app.Einde)}</span>
              </div>
              {#if app.Status === 4 || app.Status === 5}
                <div class="mt-1.5 flex"><span class="px-2 py-0.5 rounded-m3-sm text-label-small border border-red-500/40 text-red-400 bg-red-500/10">Uitgevallen</span></div>
              {:else if app.InfoType && app.InfoType !== 0}
                <div class="mt-1.5 flex"><span class="px-2 py-0.5 rounded-m3-sm text-label-small border {getInfoColor(app.InfoType, !!app.Afgerond)}">{getInfoLabel(app.InfoType)}</span></div>
              {/if}
            </div>
          </div>
        {:else}
          {@const item = m.item}
          {#if item.item_type === "sleep"}
            <div class="flex items-center gap-3 px-4 py-1.5 opacity-50">
              <div class="w-8 flex flex-col items-center"><div class="h-3 w-0.5 bg-indigo-500/40"></div></div>
              <div class="flex-1 flex items-center gap-2">
                <span class="text-label-small text-indigo-300/80">🌙 Slaap {formatTime(item.start)} – {formatTime(item.end)}</span>
              </div>
            </div>
          {:else if item.item_type === "free_time"}
            <div class="flex items-center gap-3 px-4 py-1 opacity-40 hover:opacity-80 transition-opacity">
              <div class="w-8 flex flex-col items-center"><div class="h-3 w-0.5 bg-surface-700"></div></div>
              <div class="flex-1 text-label-small text-gray-500">Vrij {formatTime(item.start)} – {formatTime(item.end)}</div>
            </div>
          {:else}
            <div
              in:fly={{ y: 12, duration: 200, delay: Math.min(i * 20, 200) }}
              class="w-full text-left rounded-m3-md p-3 md:p-4 flex gap-3 md:gap-4 border relative overflow-hidden {aiCardStyle(item)}"
            >
              <div class="flex flex-col items-center justify-center min-w-[36px] md:min-w-[42px] gap-0.5">
                <span class="text-label-small text-emerald-300">AI</span>
                <span class="text-title-large text-white leading-none">U{item.urgency}</span>
                <div class="h-px w-4 bg-surface-600 my-0.5"></div>
                <span class="text-label-small text-primary-300/80">{formatTime(item.start)}</span>
              </div>
              <div class="w-px bg-surface-600/50 my-1"></div>
              <div class="flex-1 min-w-0 flex flex-col justify-center">
                <div class="flex items-center gap-1.5 mb-0.5 flex-wrap">
                  <span class="text-title-medium text-white truncate">{item.title}</span>
                  <span class="text-label-small px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">{aiTypeLabel(item.item_type)}</span>
                  {#if item.source === "user"}<span class="text-label-small px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20">Jij</span>{/if}
                  {#if item.status === "completed"}<span class="text-label-small px-1.5 py-0.5 rounded bg-surface-700 text-gray-300">Klaar</span>{/if}
                </div>
                {#if item.description}
                  <p class="text-body-small text-gray-400 line-clamp-2">{item.description}</p>
                {/if}
                <p class="text-label-small text-gray-500 mt-0.5">Tot {formatTime(item.end)}{item.related_subject ? ` · ${item.related_subject}` : ""}{item.estimated_minutes ? ` · ${item.estimated_minutes} min` : ""}</p>
                <div class="flex gap-1.5 mt-2 flex-wrap">
                  {#if item.status !== "completed"}
                    <button onclick={() => doComplete(item.id)} class="px-3 py-1.5 rounded-m3-xs bg-emerald-500/15 border border-emerald-500/20 text-emerald-300 text-label-small hover:bg-emerald-500/25">✓ Klaar</button>
                    <button onclick={() => doDismiss(item.id)} class="px-3 py-1.5 rounded-m3-xs bg-surface-800 border border-white/10 text-gray-400 text-label-small hover:bg-surface-700">Negeren</button>
                  {/if}
                  <button onclick={() => doDelete(item.id)} class="px-3 py-1.5 rounded-m3-xs bg-red-500/10 border border-red-500/20 text-red-400 text-label-small hover:bg-red-500/20">Wis</button>
                </div>
              </div>
            </div>
          {/if}
        {/if}
      {/each}
    {/if}
  </main>

  <AddAiScheduleItemModal bind:open={showAddModal} onCreate={doCreate} />
</div>

<style>
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  .custom-scrollbar::-webkit-scrollbar { width: 3px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
</style>
