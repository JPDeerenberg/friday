<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Moon, X } from "@lucide/svelte";
  import { personId, userSettings, resumedAt } from "#lib/stores.ts";
  import { get } from "svelte/store";
  import { formatTime } from "#lib/format.ts";
  import { displayTeacherName } from "#lib/teachers.ts";
  import * as schedApi from "#lib/ai-schedule.ts";
  import type { AiScheduleItem } from "#lib/ai-schedule-types.ts";
  import type {
    Absence,
    CalendarAttachment,
    CalendarEvent,
  } from "#lib/types.ts";
  import {
    createCalendarEvent,
    deleteCalendarEvent,
    downloadFile,
    getCalendarEvent,
    toggleCalendarEventDone,
  } from "#lib/api.ts";
  import { pickDownloadHref, describeDownload } from "#lib/attachments.ts";
  import { recordQuestEvent } from "#lib/quests-store.ts";
  import { homeworkKey } from "#lib/quests.ts";
  import HtmlRenderer from "#lib/components/HtmlRenderer.svelte";
  import TranslateButton from "#lib/components/TranslateButton.svelte";
  import Button from "#lib/components/Button.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import DropdownMenu from "#lib/components/DropdownMenu.svelte";
  import AddAiScheduleItemModal from "#lib/components/ai-schedule/AddAiScheduleItemModal.svelte";
  import { on } from "svelte/events";
  import { fly, slide } from "svelte/transition";
  import { clearAiPageContext, setAiPageContext } from "#lib/ai-context.ts";

  let appointments = $state<CalendarEvent[]>([]);
  let aiItems = $state<AiScheduleItem[]>([]);
  let selectedDate = $state(new Date());
  let loading = $state(true);
  let updating = $state(false);
  let error = $state<string | null>(null);
  let updateNote = $state<string | null>(null);
  let showAddModal = $state(false);
  let now = $state(new Date());
  let viewMenuOpen = $state(false);

  // ---- lesson detail (agenda parity) ----
  let showDetail = $state(false);
  let selectedAppointment = $state<CalendarEvent | null>(null);
  let loadingDetail = $state(false);
  let editMode = $state(false);
  let editContent = $state("");
  let localOverrides = $state<Record<string, string>>({});
  let deletingAppointment = $state(false);
  let downloadingFile = $state<string | null>(null);
  let isCreating = $state(false);
  let createError = $state("");
  let newApp = $state({
    omschrijving: "",
    lokatie: "",
    inhoud: "",
    start: "",
    einde: "",
  });
  let showTimeCalculator = $state(false);
  let calcMode = $state<"lopen" | "fiets" | "auto">("fiets");
  let calcTravelMinutes = $state(15);
  let calcVisitMinutes = $state(30);
  let calcAppointmentTime = $state("");

  const calcResult = $derived.by(() => {
    if (!/^\d{2}:\d{2}$/.test(calcAppointmentTime)) return null;
    const [h, m] = calcAppointmentTime.split(":").map(Number);
    const base = new Date(selectedDate);
    base.setHours(h, m, 0, 0);
    const depart = new Date(base.getTime() - calcTravelMinutes * 60_000);
    const back = new Date(
      base.getTime() + (calcVisitMinutes + calcTravelMinutes) * 60_000,
    );
    return { depart, back };
  });

  function applyCalculatedTime() {
    if (!calcResult) return;
    const pad = (n: number) => String(n).padStart(2, "0");
    newApp.start = `${pad(calcResult.depart.getHours())}:${pad(calcResult.depart.getMinutes())}`;
    newApp.einde = `${pad(calcResult.back.getHours())}:${pad(calcResult.back.getMinutes())}`;
    const modeLabel =
      calcMode === "lopen" ? "Lopen" : calcMode === "fiets" ? "Fiets" : "Auto";
    const note = `Vervoer: ${modeLabel} (${calcTravelMinutes} min heen, ${calcTravelMinutes} min terug), ${calcVisitMinutes} min ter plaatse.`;
    newApp.inhoud = newApp.inhoud ? `${newApp.inhoud}\n${note}` : note;
    showTimeCalculator = false;
  }

  // Latest plan mutation, excluding sleep/free-time fillers. Used for the
  // compact freshness line and the AI page context.
  const lastPlanUpdate = $derived.by(() => {
    const stamps = aiItems
      .filter((i) => i.item_type !== "free_time" && i.item_type !== "sleep")
      .map((i) => i.updated_at)
      .filter(Boolean)
      .sort();
    return stamps.at(-1) ?? null;
  });

  const planIsStale = $derived.by(() => {
    if (!lastPlanUpdate) return false;
    const t = new Date(lastPlanUpdate).getTime();
    return !isNaN(t) && now.getTime() - t > 24 * 60 * 60 * 1000;
  });

  const lastPlanLabel = $derived.by(() => {
    if (!lastPlanUpdate) return "Plan nog niet bijgewerkt";
    const d = new Date(lastPlanUpdate);
    if (isNaN(d.getTime())) return "Plan bijgewerkt";
    const day = d.toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "short",
    });
    const time = d.toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `Plan bijgewerkt: ${day} ${time}`;
  });

  $effect(() => {
    setAiPageContext({
      page: "ai-schedule",
      selectedDate: selectedDate.toISOString().slice(0, 10),
      selectedLessonId: showDetail ? (selectedAppointment?.Id ?? null) : null,
      selectedSubject:
        (showDetail
          ? selectedAppointment?.Vakken?.[0]?.Naam ||
            selectedAppointment?.Omschrijving
          : null) ?? null,
      planItemCount: aiItems.filter(
        (i) => i.item_type !== "free_time" && i.item_type !== "sleep",
      ).length,
      lastPlanUpdate,
    });
  });

  $effect(() => {
    const t = setInterval(() => {
      now = new Date();
    }, 60000);
    return () => clearInterval(t);
  });

  // Desktop detection (same as Agenda) — drives week-view default + grid.
  let isDesktop = $state(false);
  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => {
      isDesktop = mq.matches;
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  const showWeekView = $derived.by(() => {
    const mode = $userSettings.weekView ?? "auto";
    if (mode === "on") return true;
    if (mode === "off") return false;
    return isDesktop;
  });

  let loadedStart = $state<Date | null>(null);
  let loadedEnd = $state<Date | null>(null);

  function skipWeekendForward(d: Date): Date {
    const next = new Date(d);
    if (next.getDay() === 6) next.setDate(next.getDate() + 2);
    else if (next.getDay() === 0) next.setDate(next.getDate() + 1);
    return next;
  }

  // Today, or the next school day when weekends are hidden. Keeps the
  // "Vandaag" button consistent with the weekend-skip navigation.
  const todayTarget = $derived.by(() => {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return $userSettings.showWeekend ? t : skipWeekendForward(t);
  });

  const isOnToday = $derived(
    selectedDate.toDateString() === todayTarget.toDateString(),
  );

  // If weekends are hidden while the plan sits on Sat/Sun, jump to Monday.
  $effect(() => {
    if (!$userSettings.showWeekend) {
      const day = selectedDate.getDay();
      if (day === 0 || day === 6)
        selectedDate = skipWeekendForward(selectedDate);
    }
  });

  onMount(() => {
    recordQuestEvent("plan_checked");
    try {
      const saved = localStorage.getItem("calendar_overrides");
      if (saved) localOverrides = JSON.parse(saved);
    } catch {
      localOverrides = {};
    }
    if (!$userSettings.showWeekend) {
      const skipped = skipWeekendForward(selectedDate);
      if (skipped.getTime() !== selectedDate.getTime()) selectedDate = skipped;
    }
    loadMerged(true);
    // Live refresh after AI plan mutations (Phase 7 item 4): web CustomEvent
    // from the facade, Tauri event from the Rust arms.
    const onChanged = () => refreshAll();
    window.addEventListener(schedApi.AI_SCHEDULE_CHANGED_EVENT, onChanged);
    let unlisten: (() => void) | null = null;
    const isTauri =
      typeof window !== "undefined" && !!(window as any).__TAURI__;
    if (isTauri) {
      import("@tauri-apps/api/event")
        .then(({ listen }) => listen("ai-schedule-changed", () => refreshAll()))
        .then((off) => {
          unlisten = off;
        })
        .catch(() => {});
    }
    return () => {
      window.removeEventListener(schedApi.AI_SCHEDULE_CHANGED_EVENT, onChanged);
      unlisten?.();
      clearAiPageContext("ai-schedule");
    };
  });

  let resumedSeen = false;
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) {
      resumedSeen = true;
      return;
    }
    if (get(personId) !== null) untrack(() => loadMerged(true));
  });

  async function loadMerged(force = false) {
    const pid = get(personId);
    if (!pid) {
      loading = false;
      return;
    }
    if (!force && loadedStart && loadedEnd) {
      const bs = new Date(loadedStart);
      bs.setDate(bs.getDate() + 3);
      const be = new Date(loadedEnd);
      be.setDate(be.getDate() - 3);
      if (selectedDate >= bs && selectedDate <= be) return;
    }
    loading = true;
    error = null;
    try {
      const start = new Date(selectedDate);
      start.setDate(start.getDate() - 14);
      const end = new Date(selectedDate);
      end.setDate(end.getDate() + 14);
      loadedStart = start;
      loadedEnd = end;
      const merged = await schedApi.getMergedSchedule(
        start.toISOString().slice(0, 19),
        end.toISOString().slice(0, 19),
        pid,
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
    updateNote = null;
    try {
      const s = get(userSettings);
      const items = await schedApi.updateAiSchedule({
        bedtime: s.aiSchedule.bedtime,
        wakeTime: s.aiSchedule.wakeTime,
        blockedTimes: s.aiSchedule.blockedTimes,
        afterSchoolBufferMin: s.aiSchedule.afterSchoolBufferMin,
        planInSchoolGaps: s.aiSchedule.planInSchoolGaps,
      });
      loadedStart = null;
      loadedEnd = null;
      await loadMerged(true);
      const planned = items.filter(
        (i) => i.item_type !== "free_time" && i.item_type !== "sleep",
      );
      const homework = planned.filter(
        (i) =>
          i.item_type === "assignment_work" ||
          i.item_type === "homework_review" ||
          i.item_type === "study_block",
      ).length;
      updateNote =
        planned.length === 0
          ? "Planning bijgewerkt — er staat niets open voor deze periode."
          : `Planning bijgewerkt: ${planned.length} blokken, waarvan ${homework} voor huiswerk of toetsen.`;
    } catch (e) {
      error = String(e);
    } finally {
      updating = false;
    }
  }

  async function openLesson(app: CalendarEvent) {
    if (!app.Id) return;
    loadingDetail = true;
    showDetail = true;
    selectedAppointment = app;
    try {
      const pid = get(personId);
      if (pid) {
        const fetched = await getCalendarEvent(pid, app.Id);
        // The detail endpoint does not merge absences; keep the list-level
        // absence so the badge does not vanish when the sheet opens.
        selectedAppointment = {
          ...fetched,
          merged_absence: fetched.merged_absence ?? app.merged_absence,
          Afwezigheid: fetched.Afwezigheid ?? app.Afwezigheid,
        };
      }
    } catch {
      selectedAppointment = app;
    }
    const override = localOverrides[String(selectedAppointment?.Id)];
    if (override && selectedAppointment)
      selectedAppointment = { ...selectedAppointment, Inhoud: override };
    editContent = selectedAppointment?.Inhoud || "";
    editMode = false;
    loadingDetail = false;
  }

  function closeDetail() {
    showDetail = false;
    selectedAppointment = null;
    editMode = false;
  }

  function saveLocalOverride() {
    const sel = selectedAppointment;
    if (!sel) return;
    localOverrides[String(sel.Id)] = editContent;
    localStorage.setItem("calendar_overrides", JSON.stringify(localOverrides));
    sel.Inhoud = editContent;
    editMode = false;
    appointments = appointments.map((a) =>
      a.Id === sel.Id ? { ...a, Inhoud: editContent } : a,
    );
    selectedAppointment = { ...sel, Inhoud: editContent };
  }

  async function toggleDone(app: CalendarEvent) {
    try {
      await toggleCalendarEventDone(app);
      app.Afgerond = !app.Afgerond;
      if (app.Afgerond)
        recordQuestEvent("homework_done", 1, homeworkKey(app.Id));
      appointments = [...appointments];
    } catch (e) {
      error = `Huiswerk bijwerken mislukt: ${e}`;
    }
  }

  async function deleteAppointment() {
    const sel = selectedAppointment;
    if (!sel) return;
    const selfUrl =
      sel.self_url ||
      sel.Links?.find((l) => l.Rel === "Self")?.Href?.replace("/api/", "");
    if (!selfUrl) {
      error = "Kan afspraak niet verwijderen: geen link gevonden.";
      return;
    }
    if (!confirm(`"${sel.Omschrijving || "Afspraak"}" verwijderen?`)) return;
    deletingAppointment = true;
    try {
      await deleteCalendarEvent(selfUrl);
      appointments = appointments.filter((a) => a.Id !== sel.Id);
      closeDetail();
    } catch (e) {
      error = `Verwijderen mislukt: ${e}`;
    } finally {
      deletingAppointment = false;
    }
  }

  async function downloadAttachment(bijlage: CalendarAttachment) {
    if (downloadingFile) return;
    const url = pickDownloadHref(bijlage.Links);
    if (!url) {
      error = "Deze bijlage heeft geen downloadlink.";
      return;
    }
    downloadingFile = bijlage.Naam;
    try {
      const outcome = await downloadFile(
        url,
        bijlage.Naam,
        get(userSettings).downloadDir || "",
      );
      const note = describeDownload(outcome);
      if (note) alert(note);
    } catch (e) {
      error = `Download mislukt: ${e}`;
    } finally {
      downloadingFile = null;
    }
  }

  async function createAppointment() {
    const pid = get(personId);
    if (!pid) return;
    createError = "";
    if (!newApp.omschrijving.trim()) {
      createError = "Vul een omschrijving in.";
      return;
    }
    const start = new Date(selectedDate);
    start.setSeconds(0, 0);
    if (/^\d{2}:\d{2}$/.test(newApp.start)) {
      const [h, m] = newApp.start.split(":").map(Number);
      start.setHours(h, m);
    } else start.setHours(9, 0);
    const end = new Date(selectedDate);
    end.setSeconds(0, 0);
    if (/^\d{2}:\d{2}$/.test(newApp.einde)) {
      const [h, m] = newApp.einde.split(":").map(Number);
      end.setHours(h, m);
    } else end.setHours(start.getHours() + 1, start.getMinutes());
    if (end <= start) {
      createError = "Eindtijd moet na begintijd liggen.";
      return;
    }
    try {
      await createCalendarEvent({
        personId: pid,
        start: start.toISOString(),
        einde: end.toISOString(),
        duurtHeleDag: false,
        omschrijving: newApp.omschrijving.trim(),
        lokatie: newApp.lokatie || undefined,
        inhoud: newApp.inhoud || undefined,
        eventType: 1,
      });
      newApp = {
        omschrijving: "",
        lokatie: "",
        inhoud: "",
        start: "",
        einde: "",
      };
      isCreating = false;
      loadedStart = null;
      loadedEnd = null;
      await loadMerged(true);
    } catch (e) {
      createError = `Fout bij aanmaken: ${e}`;
    }
  }

  function navigateToDay(d: Date) {
    selectedDate = new Date(d);
    loadMerged();
  }
  function stepDays(n: number) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + n);
    if (
      !showWeekView &&
      !$userSettings.showWeekend &&
      (d.getDay() === 0 || d.getDay() === 6)
    ) {
      d.setDate(
        d.getDate() +
          (n > 0 ? (d.getDay() === 6 ? 2 : 1) : d.getDay() === 0 ? -2 : -1),
      );
    }
    navigateToDay(d);
  }
  function nextDay() {
    stepDays(showWeekView ? 7 : 1);
  }
  function prevDay() {
    stepDays(showWeekView ? -7 : -1);
  }
  function goToToday() {
    if (isOnToday) return;
    navigateToDay(new Date(todayTarget));
  }

  function lessonsOn(dayStr: string): CalendarEvent[] {
    let list = appointments.filter((a) => {
      if (!a.Start) return false;
      const ad = new Date(a.Start);
      return !isNaN(ad.getTime()) && ad.toDateString() === dayStr;
    });
    if ($userSettings.hideCancelled) {
      list = list.filter((a) => a.Status !== 4 && a.Status !== 5);
    }
    list.sort((a, b) => (a.Start ?? "").localeCompare(b.Start ?? ""));
    if (!$userSettings.combineLessons) return list;

    const out: CalendarEvent[] = [];
    for (const app of list) {
      const last = out.at(-1);
      const same =
        last &&
        last.Vakken?.[0]?.Naam === app.Vakken?.[0]?.Naam &&
        last.Docenten?.[0]?.Naam === app.Docenten?.[0]?.Naam &&
        last.Lokatie === app.Lokatie;
      if (same && last.Einde && app.Start && last.Einde === app.Start) {
        out[out.length - 1] = {
          ...last,
          Einde: app.Einde,
          LesuurTotMet: app.LesuurTotMet || app.LesuurVan,
        };
      } else {
        out.push({ ...app });
      }
    }
    return out;
  }

  function aiOn(isoDay: string, forGrid = false): AiScheduleItem[] {
    let list = aiItems.filter(
      (a) => a.start.slice(0, 10) === isoDay || a.end.slice(0, 10) === isoDay,
    );
    list = list.filter((a) => a.status !== "dismissed");
    if (forGrid) {
      // Week grid stays readable: hide sleep + free-time fillers there
      // (they remain visible in the day view).
      list = list.filter(
        (a) => a.item_type !== "free_time" && a.item_type !== "sleep",
      );
    }
    return list.sort((a, b) => a.start.localeCompare(b.start));
  }

  // ---- week pills (same as Agenda, hidden in week view) ----
  const weekData = $derived.by(() => {
    const d = new Date(selectedDate);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    const length = $userSettings.showWeekend ? 7 : 5;
    return Array.from({ length }, (_, i) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + i);
      const dayStr = date.toDateString();
      const dayLessons = lessonsOn(dayStr);
      const dayAi = aiOn(date.toISOString().slice(0, 10));
      return {
        date,
        isToday: dayStr === new Date().toDateString(),
        isSelected: dayStr === selectedDate.toDateString(),
        hasTest: dayLessons.some((a) => [2, 3, 4, 5].includes(a.InfoType)),
        hasHomework: dayLessons.some((a) => a.InfoType === 1 && !a.Afgerond),
        hasPlan: dayAi.some(
          (a) =>
            a.item_type !== "free_time" &&
            a.item_type !== "sleep" &&
            a.status === "planned",
        ),
      };
    });
  });

  const weekLabel = $derived.by(() => {
    if (weekData.length === 0) return "";
    const first = weekData[0].date;
    const last = weekData[weekData.length - 1].date;
    const f = first.toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "long",
    });
    const l = last.toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "long",
    });
    return `${f} – ${l}`;
  });

  type MergedItem =
    | { kind: "lesson"; event: CalendarEvent; sortKey: string }
    | { kind: "ai"; item: AiScheduleItem; sortKey: string }
    | { kind: "break"; minutes: number; sortKey: string }
    | { kind: "now" };

  /** Gaps between consecutive lessons — same rule as the agenda. */
  function dayBreaks(
    lessons: CalendarEvent[],
  ): { minutes: number; start: string }[] {
    if (!$userSettings.showBreakSeparator) return [];
    const out: { minutes: number; start: string }[] = [];
    for (let i = 1; i < lessons.length; i++) {
      const prev = lessons[i - 1];
      const curr = lessons[i];
      if (!prev.Einde || !curr.Start) continue;
      const diff = Math.round(
        (new Date(curr.Start).getTime() - new Date(prev.Einde).getTime()) /
          60000,
      );
      if (diff > 0 && diff < 240)
        out.push({ minutes: diff, start: prev.Einde });
    }
    return out;
  }

  /** Interleave lessons, AI blocks and breaks chronologically. */
  function mergeItems(
    lessons: CalendarEvent[],
    ai: AiScheduleItem[],
    breaks: { minutes: number; start: string }[],
  ): Exclude<MergedItem, { kind: "now" }>[] {
    const merged: Exclude<MergedItem, { kind: "now" }>[] = [
      ...lessons.map((e) => ({
        kind: "lesson" as const,
        event: e,
        sortKey: e.Start ?? "",
      })),
      ...breaks.map((b) => ({
        kind: "break" as const,
        minutes: b.minutes,
        sortKey: b.start,
      })),
      ...ai.map((i) => ({ kind: "ai" as const, item: i, sortKey: i.start })),
    ];
    merged.sort((a, b) => (a.sortKey ?? "").localeCompare(b.sortKey ?? ""));
    return merged;
  }

  const dayMerged = $derived.by((): MergedItem[] => {
    const dayStr = selectedDate.toDateString();
    const lessons = lessonsOn(dayStr);
    const isoDay = selectedDate.toISOString().slice(0, 10);
    const ai = aiOn(isoDay);
    const merged = mergeItems(lessons, ai, dayBreaks(lessons));

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

  const hiddenCancelledCount = $derived.by(() => {
    if (!$userSettings.hideCancelled) return 0;
    const dayStr = selectedDate.toDateString();
    return appointments.filter((a) => {
      if (!a.Start) return false;
      const d = new Date(a.Start);
      return (
        !isNaN(d.getTime()) &&
        d.toDateString() === dayStr &&
        (a.Status === 4 || a.Status === 5)
      );
    }).length;
  });

  // ---- week view: merged lessons + AI lanes (same grid math as Agenda) ----
  const PX_PER_HOUR = 72;

  type WeekSlot = {
    id: string;
    kind: "lesson" | "ai";
    event?: CalendarEvent;
    item?: AiScheduleItem;
    startMin: number | null;
    endMin: number | null;
    _column: number;
    _columnCount: number;
  };

  function minutesOf(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.getHours() * 60 + d.getMinutes();
  }

  /** ISO-8601 week number, shown in the week grid's top-left corner. */
  function isoWeekNumber(date: Date): number {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  function assignLanes(slots: WeekSlot[]): WeekSlot[] {
    const timed = slots.filter((s) => s.startMin !== null);
    const timeless = slots.filter((s) => s.startMin === null);
    const sorted = [...timed].sort((a, b) => {
      const sa = a.startMin!,
        sb = b.startMin!;
      if (sa !== sb) return sa - sb;
      return (a.endMin ?? sa + 50) - (b.endMin ?? sb + 50);
    });
    const clusters: { maxEnd: number; items: WeekSlot[] }[] = [];
    for (const s of sorted) {
      const e = s.endMin ?? s.startMin! + 50;
      let cluster = clusters[clusters.length - 1];
      if (!cluster || s.startMin! >= cluster.maxEnd) {
        cluster = { maxEnd: e, items: [] };
        clusters.push(cluster);
      } else {
        cluster.maxEnd = Math.max(cluster.maxEnd, e);
      }
      cluster.items.push(s);
    }
    const out: WeekSlot[] = [];
    for (const cluster of clusters) {
      const lanes: number[] = [];
      for (const s of cluster.items) {
        const e = s.endMin ?? s.startMin! + 50;
        let lane = lanes.findIndex((end) => end <= s.startMin!);
        if (lane === -1) {
          lane = lanes.length;
          lanes.push(e);
        } else lanes[lane] = e;
        s._column = lane;
      }
      for (const s of cluster.items) s._columnCount = lanes.length;
      out.push(...cluster.items);
    }
    return [
      ...out,
      ...timeless.map((s) => ({ ...s, _column: 0, _columnCount: 1 })),
    ];
  }

  const weekViewDays = $derived.by(() => {
    const d = new Date(selectedDate);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    const length = $userSettings.showWeekend ? 7 : 5;
    return Array.from({ length }, (_, i) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + i);
      const dayStr = date.toDateString();
      const isoDay = date.toISOString().slice(0, 10);
      const lessons = lessonsOn(dayStr);
      const ai = aiOn(isoDay, true);
      const breaks = dayBreaks(lessons);
      const raw: WeekSlot[] = [
        ...lessons.map((e) => ({
          id: `les-${e.Id}`,
          kind: "lesson" as const,
          event: e,
          startMin: minutesOf(e.Start),
          endMin: minutesOf(e.Einde),
          _column: 0,
          _columnCount: 1,
        })),
        ...ai.map((item) => ({
          id: `ai-${item.id}`,
          kind: "ai" as const,
          item,
          startMin: minutesOf(item.start),
          endMin: minutesOf(item.end),
          _column: 0,
          _columnCount: 1,
        })),
      ];
      return {
        date,
        isToday: dayStr === new Date().toDateString(),
        isSelected: dayStr === selectedDate.toDateString(),
        slots: assignLanes(raw),
        breaks,
        merged: mergeItems(lessons, ai, breaks),
      };
    });
  });

  const grid = $derived.by(() => {
    let minH = 8,
      maxH = 18;
    for (const day of weekViewDays) {
      for (const s of day.slots) {
        if (s.startMin !== null)
          minH = Math.min(minH, Math.floor(s.startMin / 60));
        if (s.endMin !== null) maxH = Math.max(maxH, Math.ceil(s.endMin / 60));
      }
    }
    minH = Math.max(6, minH);
    maxH = Math.min(23, Math.max(18, maxH));
    const hours: number[] = [];
    for (let h = minH; h < maxH; h++) hours.push(h);
    return { minH, maxH, hours, heightPx: (maxH - minH) * PX_PER_HOUR };
  });

  function slotTopPx(s: WeekSlot): number {
    if (s.startMin === null) return 0;
    return ((s.startMin - grid.minH * 60) / 60) * PX_PER_HOUR;
  }
  function slotHeightPx(s: WeekSlot): number {
    if (s.startMin === null) return 40;
    const dur = (s.endMin ?? s.startMin + 50) - s.startMin;
    // Same floor as the agenda: a 40px block still fits two readable lines.
    return Math.max(40, Math.round((dur / 60) * PX_PER_HOUR) - 3);
  }

  const nowMinutes = $derived.by(() => now.getHours() * 60 + now.getMinutes());
  const weekSlotCount = $derived(
    weekViewDays.reduce((sum, d) => sum + d.slots.length, 0),
  );

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
      if (afgerond)
        return "border-surface-600 text-gray-400 bg-surface-700/40 opacity-60";
      return "border-primary-400/60 text-primary-200 bg-primary-500/25";
    }
    if ([2, 3, 4, 5].includes(info))
      return "border-red-400/60 text-red-200 bg-red-500/25";
    return "border-surface-600 text-gray-300 bg-surface-700/50";
  }

  // ---- absence (agenda parity) ----
  // The web transport merges absences into `merged_absence`; some Magister
  // payloads already carry `Afwezigheid` on the event itself.
  function absenceOf(app: CalendarEvent): Absence | null {
    return app.merged_absence ?? app.Afwezigheid ?? null;
  }
  function absenceLabel(a: Absence): string {
    if (a.Verantwoordingtype === 2 || a.Code === "L") return "Te laat";
    if (a.Verantwoordingtype === 3 || a.Code === "S" || a.Code === "Z")
      return "Ziek";
    if (a.Verantwoordingtype === 4 || a.Code === "V") return "Verwijderd";
    if (a.Verantwoordingtype === 7) return "Boeken vergeten";
    if (a.Verantwoordingtype === 8) return "Huiswerk vergeten";
    return "Afwezig";
  }
  function absenceRange(a: Absence): string {
    const from = a.Start ? formatTime(a.Start) : "";
    const to = a.Eind ? formatTime(a.Eind) : "";
    if (from && to) return `${from}–${to}`;
    if (from) return from;
    if (a.Lesuur) return `lesuur ${a.Lesuur}`;
    return "";
  }
  function absenceDetail(a: Absence): string {
    return [absenceRange(a), a.Omschrijving].filter(Boolean).join(" · ");
  }

  function aiTypeLabel(t: string) {
    const m: Record<string, string> = {
      assignment_work: "Huiswerk",
      study_block: "Leren",
      homework_review: "Review",
      custom: "Eigen",
      break: "Pauze",
      free_time: "Vrij",
      sleep: "Slaap",
    };
    return m[t] ?? t;
  }
  function aiCardStyle(item: AiScheduleItem): string {
    if (item.status === "completed")
      return "bg-surface-800/50 border-surface-700/40 opacity-60";
    if (item.item_type === "sleep")
      return "bg-indigo-500/8 border-indigo-500/25 opacity-80";
    if (item.item_type === "free_time")
      return "bg-surface-800/40 border-surface-700/30 opacity-60";
    if (item.item_type === "homework_review")
      return "bg-amber-500/10 border-amber-500/40";
    if (item.urgency >= 4) return "bg-red-500/8 border-red-500/30";
    if (item.item_type === "study_block")
      return "bg-emerald-500/8 border-emerald-500/30";
    return "bg-primary-500/10 border-primary-500/40";
  }

  async function doComplete(id: string) {
    const prev = aiItems.find((i) => i.id === id);
    aiItems = aiItems.map((i) =>
      i.id === id ? { ...i, status: "completed" as const } : i,
    );
    try {
      await schedApi.completeAiScheduleItem(id);
    } catch (e) {
      if (prev) aiItems = aiItems.map((i) => (i.id === id ? prev : i));
      error = String(e);
    }
  }
  async function doDismiss(id: string) {
    const prev = [...aiItems];
    aiItems = aiItems.map((i) =>
      i.id === id ? { ...i, status: "dismissed" as const } : i,
    );
    aiItems = aiItems.filter((i) => i.status !== "dismissed");
    try {
      await schedApi.dismissAiScheduleItem(id);
    } catch (e) {
      aiItems = prev;
      error = String(e);
    }
  }
  async function doDelete(id: string) {
    const prev = [...aiItems];
    aiItems = aiItems.filter((i) => i.id !== id);
    try {
      await schedApi.deleteAiScheduleItem(id);
    } catch (e) {
      aiItems = prev;
      error = String(e);
    }
  }
  async function doCreate(item: AiScheduleItem) {
    try {
      const created = await schedApi.createAiScheduleItem(item);
      aiItems = [...aiItems, created];
    } catch (e) {
      error = String(e);
    }
  }

  function lesuurLabel(e: CalendarEvent): string {
    const lv = e.LesuurVan ?? null,
      lt = e.LesuurTotMet ?? null;
    if (lv && lt && lv !== lt) return `${lv}–${lt}`;
    if (lv) return `${lv}`;
    return "—";
  }

  function refreshAll() {
    appointments = [];
    aiItems = [];
    loadedStart = null;
    loadedEnd = null;
    loadMerged(true);
  }

  // ---- swipe (same as Agenda): horizontal swipe flips day / week ----
  let swipeOffset = $state(0);
  let isAnimating = $state(false);
  let noTransition = $state(false);
  let touchStartX = 0;
  let touchStartY = 0;
  let isDragging = $state(false);
  let isHorizontalSwipe = false;

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isDragging = false;
    isHorizontalSwipe = false;
  }
  function handleTouchMove(e: TouchEvent) {
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (!isDragging && Math.hypot(dx, dy) > 5) {
      isHorizontalSwipe = Math.abs(dx) > Math.abs(dy) * 1.5;
      isDragging = true;
    }
    if (isHorizontalSwipe) {
      e.preventDefault();
      swipeOffset = dx;
    }
  }
  function handleTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (isHorizontalSwipe && Math.abs(dx) > 40) {
      swipeOffset = dx > 0 ? window.innerWidth : -window.innerWidth;
      isAnimating = true;
      setTimeout(() => {
        if (dx > 0) prevDay();
        else nextDay();
        noTransition = true;
        swipeOffset =
          dx > 0 ? -window.innerWidth * 0.3 : window.innerWidth * 0.3;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            noTransition = false;
            swipeOffset = 0;
            isAnimating = false;
          });
        });
      }, 200);
    } else {
      swipeOffset = 0;
    }
    isDragging = false;
  }
  function swipeGesture(node: HTMLDivElement) {
    const removeTouchStart = on(node, "touchstart", handleTouchStart, {
      passive: false,
    });
    const removeTouchMove = on(node, "touchmove", handleTouchMove, {
      passive: false,
    });
    const removeTouchEnd = on(node, "touchend", handleTouchEnd, {
      passive: false,
    });
    return {
      destroy() {
        removeTouchStart();
        removeTouchMove();
        removeTouchEnd();
      },
    };
  }
</script>

<div
  use:swipeGesture
  class="flex flex-col h-full bg-surface-950"
  role="application"
>
  <!-- Header — same pattern as Agenda -->
  <header
    class="sticky top-0 z-20 bg-surface-950/90 backdrop-blur-xl border-b border-surface-800/30 px-3 py-2 md:px-4 md:py-2.5"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <label
          class="flex flex-col relative cursor-pointer group min-w-0 shrink"
        >
          <input
            type="date"
            class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            value={selectedDate.toISOString().split("T")[0]}
            onchange={(e) => {
              if (e.currentTarget.value)
                navigateToDay(new Date(e.currentTarget.value));
            }}
          />
          {#if showWeekView}
            <p
              class="text-label-small text-primary-400 group-hover:text-primary-300 transition-colors leading-none truncate"
            >
              Weekoverzicht
            </p>
            <h2
              class="text-title-medium md:text-headline-small text-white leading-tight group-hover:text-gray-200 transition-colors truncate"
            >
              {weekLabel}
            </h2>
          {:else}
            <p
              class="text-label-small text-primary-400 group-hover:text-primary-300 transition-colors leading-none truncate"
            >
              {selectedDate.toLocaleDateString("nl-NL", { month: "long" })}
            </p>
            <h2
              class="text-title-medium md:text-headline-small text-white leading-tight group-hover:text-gray-200 transition-colors truncate"
            >
              {selectedDate.toLocaleDateString("nl-NL", {
                weekday: "long",
                day: "numeric",
              })}
            </h2>
          {/if}
        </label>
        <!-- Mobile: single overflow menu (same items as Agenda + Update/toevoegen) -->
        <div class="md:hidden shrink-0">
          <DropdownMenu bind:open={viewMenuOpen} align="right">
            {#snippet trigger(toggle, open)}
              <IconButton
                onclick={toggle}
                aria-label="Weergaveopties"
                title="Weergaveopties"
                aria-haspopup="menu"
                aria-expanded={open}
                class="{open
                  ? 'text-primary-400 bg-white/10'
                  : 'text-gray-400'} hover:text-primary-300 shrink-0"
              >
                <svg
                  class="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  ><line x1="3" y1="6" x2="21" y2="6" /><line
                    x1="3"
                    y1="12"
                    x2="21"
                    y2="12"
                  /><line x1="3" y1="18" x2="21" y2="18" /><circle
                    cx="7"
                    cy="6"
                    r="1.2"
                    fill="currentColor"
                    stroke="none"
                  /><circle
                    cx="15"
                    cy="12"
                    r="1.2"
                    fill="currentColor"
                    stroke="none"
                  /><circle
                    cx="9"
                    cy="18"
                    r="1.2"
                    fill="currentColor"
                    stroke="none"
                  /></svg
                >
              </IconButton>
            {/snippet}
            <button
              class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
              onclick={() => {
                viewMenuOpen = false;
                handleUpdate();
              }}
              role="menuitem"
            >
              <svg
                class="w-4 h-4 text-primary-400 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><path
                  d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
                /><path d="M21 3v5h-5" /></svg
              >
              <span class="text-label-medium text-gray-200"
                >Bijwerken (huiswerk &amp; toetsen)</span
              >
            </button>
            <button
              class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
              onclick={() => {
                viewMenuOpen = false;
                showAddModal = true;
              }}
              role="menuitem"
            >
              <svg
                class="w-4 h-4 text-primary-400 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"><path d="M12 5v14M5 12h14" /></svg
              >
              <span class="text-label-medium text-gray-200">Item toevoegen</span
              >
            </button>
            <div class="h-px bg-white/5 my-1"></div>
            <button
              class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
              onclick={() => {
                viewMenuOpen = false;
                refreshAll();
              }}
              role="menuitem"
            >
              <svg
                class="w-4 h-4 text-gray-400 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><path
                  d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
                /><path d="M21 3v5h-5" /></svg
              >
              <span class="text-label-medium text-gray-200"
                >Alleen agenda verversen</span
              >
            </button>
            <div class="h-px bg-white/5 my-1"></div>
            <button
              class="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
              onclick={() =>
                ($userSettings.hideCancelled = !$userSettings.hideCancelled)}
              role="menuitemcheckbox"
              aria-checked={$userSettings.hideCancelled ? "true" : "false"}
            >
              <span class="flex items-center gap-3">
                {#if $userSettings.hideCancelled}
                  <svg
                    class="w-4 h-4 text-gray-400 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    ><path
                      d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"
                    /></svg
                  >
                {:else}
                  <svg
                    class="w-4 h-4 text-primary-400 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    ><path
                      d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"
                    /><circle cx="12" cy="12" r="3" /></svg
                  >
                {/if}
                <span
                  class="text-label-medium {$userSettings.hideCancelled
                    ? 'text-gray-400'
                    : 'text-gray-200'}">Uitgevallen verbergen</span
                >
              </span>
              <span
                class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {$userSettings.hideCancelled
                  ? 'bg-primary-500 border-primary-500 text-on-fill'
                  : 'border-surface-600'}"
              >
                {#if $userSettings.hideCancelled}<svg
                    class="w-2.5 h-2.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"><path d="M5 12l5 5l10 -10" /></svg
                  >{/if}
              </span>
            </button>
            <button
              class="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
              onclick={() =>
                ($userSettings.weekView = showWeekView ? "off" : "on")}
              role="menuitemcheckbox"
              aria-checked={showWeekView ? "true" : "false"}
            >
              <span class="flex items-center gap-3">
                <svg
                  class="w-4 h-4 {showWeekView
                    ? 'text-primary-400'
                    : 'text-gray-400'} shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  ><rect x="3" y="4" width="18" height="16" rx="1" /><line
                    x1="3"
                    y1="10"
                    x2="21"
                    y2="10"
                  /><line x1="9" y1="10" x2="9" y2="20" /><line
                    x1="15"
                    y1="10"
                    x2="15"
                    y2="20"
                  /></svg
                >
                <span
                  class="text-label-medium {showWeekView
                    ? 'text-gray-200'
                    : 'text-gray-400'}">Weekweergave</span
                >
              </span>
              <span
                class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {showWeekView
                  ? 'bg-primary-500 border-primary-500 text-on-fill'
                  : 'border-surface-600'}"
              >
                {#if showWeekView}<svg
                    class="w-2.5 h-2.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"><path d="M5 12l5 5l10 -10" /></svg
                  >{/if}
              </span>
            </button>
            <button
              class="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
              onclick={() =>
                ($userSettings.compactView = !$userSettings.compactView)}
              role="menuitemcheckbox"
              aria-checked={$userSettings.compactView ? "true" : "false"}
            >
              <span class="flex items-center gap-3">
                <svg
                  class="w-4 h-4 {$userSettings.compactView
                    ? 'text-primary-400'
                    : 'text-gray-400'} shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  ><line x1="4" y1="7" x2="20" y2="7" /><line
                    x1="4"
                    y1="17"
                    x2="20"
                    y2="17"
                  /></svg
                >
                <span
                  class="text-label-medium {$userSettings.compactView
                    ? 'text-gray-200'
                    : 'text-gray-400'}">Compacte weergave</span
                >
              </span>
              <span
                class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {$userSettings.compactView
                  ? 'bg-primary-500 border-primary-500 text-on-fill'
                  : 'border-surface-600'}"
              >
                {#if $userSettings.compactView}<svg
                    class="w-2.5 h-2.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"><path d="M5 12l5 5l10 -10" /></svg
                  >{/if}
              </span>
            </button>
          </DropdownMenu>
        </div>
        <!-- Desktop: view buttons (same as Agenda) -->
        <div class="hidden md:flex items-center gap-1.5">
          <IconButton
            onclick={handleUpdate}
            class="hover:rotate-180 duration-500 shrink-0"
            title="Bijwerken — huiswerk, toetsen en vrije tijd opnieuw plannen"
            aria-label="Bijwerken"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path
                d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
              /><path d="M21 3v5h-5" /></svg
            >
          </IconButton>
          <IconButton
            onclick={() =>
              ($userSettings.hideCancelled = !$userSettings.hideCancelled)}
            class="{$userSettings.hideCancelled
              ? 'text-gray-600'
              : 'text-primary-400'} hover:text-primary-300 shrink-0"
            title={$userSettings.hideCancelled
              ? "Uitgevallen lessen tonen"
              : "Uitgevallen lessen verbergen"}
          >
            {#if $userSettings.hideCancelled}
              <svg
                class="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                ><path
                  d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"
                /></svg
              >
            {:else}
              <svg
                class="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                ><path
                  d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"
                /><circle cx="12" cy="12" r="3" /></svg
              >
            {/if}
          </IconButton>
          <IconButton
            onclick={() =>
              ($userSettings.weekView = showWeekView ? "off" : "on")}
            class="{showWeekView
              ? 'text-primary-400'
              : 'text-gray-500'} hover:text-primary-300 shrink-0"
            title={showWeekView ? "Naar dagweergave" : "Naar weekweergave"}
            aria-label={showWeekView ? "Naar dagweergave" : "Naar weekweergave"}
          >
            {#if showWeekView}
              <svg
                class="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><rect x="3" y="4" width="18" height="16" rx="1" /><line
                  x1="3"
                  y1="10"
                  x2="21"
                  y2="10"
                /><line x1="9" y1="10" x2="9" y2="20" /><line
                  x1="15"
                  y1="10"
                  x2="15"
                  y2="20"
                /></svg
              >
            {:else}
              <svg
                class="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><rect x="4" y="4" width="16" height="16" rx="2" /><line
                  x1="4"
                  y1="9"
                  x2="20"
                  y2="9"
                /><circle
                  cx="12"
                  cy="15"
                  r="1.6"
                  fill="currentColor"
                  stroke="none"
                /></svg
              >
            {/if}
          </IconButton>
          <IconButton
            onclick={() =>
              ($userSettings.compactView = !$userSettings.compactView)}
            class="{$userSettings.compactView
              ? 'text-primary-400'
              : 'text-gray-500'} hover:text-primary-300 shrink-0"
            title={$userSettings.compactView
              ? "Normale weergave"
              : "Compacte weergave"}
            aria-label={$userSettings.compactView
              ? "Normale weergave"
              : "Compacte weergave"}
          >
            {#if $userSettings.compactView}
              <svg
                class="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                ><line x1="4" y1="5" x2="20" y2="5" /><line
                  x1="4"
                  y1="10"
                  x2="20"
                  y2="10"
                /><line x1="4" y1="15" x2="20" y2="15" /><line
                  x1="4"
                  y1="20"
                  x2="20"
                  y2="20"
                /></svg
              >
            {:else}
              <svg
                class="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                ><line x1="4" y1="7" x2="20" y2="7" /><line
                  x1="4"
                  y1="17"
                  x2="20"
                  y2="17"
                /></svg
              >
            {/if}
          </IconButton>
          <div class="h-4 w-px bg-surface-700 mx-0.5"></div>
          <!-- Update + add live next to the view buttons -->
          <IconButton
            onclick={handleUpdate}
            class="text-primary-400 hover:text-primary-300 shrink-0 {updating
              ? 'animate-spin'
              : ''}"
            title="Bijwerken — plan deze + volgende week opnieuw"
            aria-label="Bijwerken"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path
                d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
              /><path d="M21 3v5h-5" /></svg
            >
          </IconButton>
          <IconButton
            onclick={() => (showAddModal = true)}
            aria-label="Eigen item toevoegen"
            title="Eigen item toevoegen"
            class="bg-primary-500/15! border! border-primary-500/25! text-primary-400 hover:bg-primary-500/25!"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"><path d="M12 5v14M5 12h14" /></svg
            >
          </IconButton>
          <IconButton
            onclick={() => (isCreating = true)}
            aria-label="Nieuwe agenda-afspraak"
            title="Nieuwe agenda-afspraak"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              ><rect x="3" y="5" width="18" height="16" rx="2" /><path
                d="M16 3v4M8 3v4M3 11h18M12 15v4M10 17h4"
              /></svg
            >
          </IconButton>
        </div>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <!-- Mobile quick actions next to day nav -->
        <div class="flex md:hidden items-center gap-1.5">
          <IconButton
            onclick={handleUpdate}
            title="Bijwerken"
            aria-label="Bijwerken"
            class="bg-primary-500/15! border! border-primary-500/25! text-primary-400 hover:bg-primary-500/25! {updating
              ? 'animate-spin'
              : ''}"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path
                d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
              /><path d="M21 3v5h-5" /></svg
            >
          </IconButton>
          <IconButton
            onclick={() => (showAddModal = true)}
            aria-label="Eigen item toevoegen"
            title="Eigen item toevoegen"
            class="bg-primary-500/15! border! border-primary-500/25! text-primary-400 hover:bg-primary-500/25!"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"><path d="M12 5v14M5 12h14" /></svg
            >
          </IconButton>
        </div>
        <IconButton
          onclick={prevDay}
          title={showWeekView ? "Vorige week" : "Vorige dag"}
          aria-label="Vorige"
        >
          <svg
            class="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg
          >
        </IconButton>
        <Button
          variant="tonal"
          onclick={goToToday}
          disabled={isOnToday}
          title="Naar vandaag"
          aria-label="Naar vandaag"
          class="px-4 h-8!">Vandaag</Button
        >
        <IconButton
          onclick={nextDay}
          title={showWeekView ? "Volgende week" : "Volgende dag"}
          aria-label="Volgende"
        >
          <svg
            class="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg
          >
        </IconButton>
      </div>
    </div>

    <!-- Day chooser — same as Agenda (hidden in week view) -->
    <div
      data-daybar
      class="{showWeekView
        ? 'hidden'
        : ''} mt-2 flex justify-between gap-1 overflow-x-auto no-scrollbar"
      style="touch-action: pan-y;"
    >
      {#each weekData as { date, isToday, isSelected, hasTest, hasHomework, hasPlan }}
        <button
          onclick={() => navigateToDay(new Date(date))}
          class="flex-1 flex flex-col items-center py-1.5 px-0.5 rounded-m3-sm transition-all border min-w-[38px] relative {isSelected
            ? 'bg-primary-500 border-primary-400 text-on-fill shadow-md shadow-primary-500/25'
            : 'bg-surface-800/60 border-white/5 text-gray-400 hover:bg-surface-700 hover:text-gray-200'}"
        >
          <span class="text-label-small opacity-60"
            >{date
              .toLocaleDateString("nl-NL", { weekday: "short" })
              .slice(0, 2)}</span
          >
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
              <div
                class="w-1 h-1 rounded-full bg-primary-500 animate-pulse"
              ></div>
            {/if}
          </div>
        </button>
      {/each}
    </div>

    <!-- Plan freshness — compact, one line, also on mobile -->
    <div
      class="mt-1.5 flex items-center gap-1.5 text-label-small {planIsStale
        ? 'text-amber-400/80'
        : 'text-gray-600'}"
      title={planIsStale
        ? "De planning is meer dan 24 uur geleden bijgewerkt."
        : lastPlanLabel}
    >
      <svg
        class="w-3 h-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg
      >
      <span class="truncate">{lastPlanLabel}</span>
    </div>
  </header>

  <main
    class="flex-1 overflow-y-auto p-2 md:p-3 space-y-2 md:space-y-3 custom-scrollbar"
    style="transform: translateX({swipeOffset}px); transition: {isDragging ||
    noTransition
      ? 'none'
      : 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)'}; will-change: transform; touch-action: pan-y;"
  >
    {#if error}
      <div
        class="bg-red-500/10 border border-red-500/20 rounded-m3-md p-3 text-body-small text-red-300"
      >
        {error}
      </div>
    {/if}
    {#if updateNote}
      <div
        class="bg-emerald-500/10 border border-emerald-500/20 rounded-m3-md p-3 text-body-small text-emerald-300 flex items-start justify-between gap-3"
        transition:slide
      >
        <span>{updateNote}</span>
        <button
          class="text-emerald-400/70 hover:text-emerald-300 shrink-0"
          onclick={() => (updateNote = null)}
          aria-label="Melding sluiten"><X size={16} /></button
        >
      </div>
    {/if}
    {#if hiddenCancelledCount > 0 && !loading && !showWeekView}
      <div
        class="bg-red-500/10 border border-red-500/20 rounded-m3-md p-2.5 md:p-3 flex items-center justify-between mb-2"
        transition:slide
      >
        <div class="flex items-center gap-2.5">
          <div
            class="w-7 h-7 rounded-m3-sm bg-red-500/20 text-red-400 flex items-center justify-center shrink-0"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"><path d="M18 6 6 18M6 6l12 12" /></svg
            >
          </div>
          <div>
            <p class="text-label-medium text-red-400">
              {hiddenCancelledCount} les{hiddenCancelledCount !== 1
                ? "sen"
                : ""} uitgevallen
            </p>
            <p class="text-label-small text-gray-500">
              Zijn momenteel verborgen
            </p>
          </div>
        </div>
        <Button
          variant="tonal"
          onclick={() => ($userSettings.hideCancelled = false)}
          class="px-4 h-8! bg-surface-800! text-gray-300! hover:text-white! hover:bg-surface-700!"
        >
          Tonen
        </Button>
      </div>
    {/if}
    {#if loading}
      <div class="flex flex-col items-center justify-center py-16 gap-3">
        <div
          class="w-10 h-10 border-3 border-primary-500 border-t-transparent rounded-full animate-spin"
        ></div>
        <p class="text-label-medium text-gray-600 animate-pulse">
          Planning ophalen...
        </p>
      </div>
    {:else if showWeekView}
      {#if weekSlotCount === 0}
        <div
          class="flex-1 flex flex-col items-center justify-center py-16 text-center space-y-4"
        >
          <div
            class="w-20 h-20 rounded-full bg-surface-800/80 border border-surface-700/50 flex items-center justify-center"
          >
            <svg
              class="w-8 h-8 text-gray-600"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              ><path d="M8 2v4" /><path d="M16 2v4" /><rect
                width="18"
                height="18"
                x="3"
                y="4"
                rx="2"
              /><path d="M3 10h18" /></svg
            >
          </div>
          <div>
            <h3 class="text-headline-small text-white mb-1">
              Nog geen planning deze week
            </h3>
            <p
              class="text-body-medium text-gray-500 max-w-[260px] leading-relaxed"
            >
              Druk op de update-knop hierboven om huiswerk, toetsen en
              studieblokken te laten inplannen.
            </p>
          </div>
        </div>
      {:else if isDesktop}
        <div
          class="md:rounded-m3-lg md:border border-surface-800/40 overflow-hidden"
        >
          <div class="overflow-x-auto custom-scrollbar">
            <div class="min-w-full flex">
              <div class="w-16 shrink-0 flex flex-col">
                <div
                  class="shrink-0 h-[52px] border-b border-surface-800/40 bg-surface-900/40 flex items-end justify-center pb-1.5"
                >
                  <span class="text-label-small text-gray-600 tabular-nums"
                    >wk {isoWeekNumber(weekViewDays[0].date)}</span
                  >
                </div>
                <div class="relative" style="height: {grid.heightPx}px;">
                  {#each grid.hours as h}
                    <div
                      class="absolute right-2 -translate-y-1/2 text-label-medium text-gray-500 tabular-nums"
                      style="top: {(h - grid.minH) * PX_PER_HOUR}px;"
                    >
                      {String(h).padStart(2, "0")}:00
                    </div>
                  {/each}
                </div>
              </div>
              {#each weekViewDays as day}
                <div
                  class="flex-1 min-w-[140px] border-l border-surface-800/30"
                >
                  <button
                    onclick={() => navigateToDay(new Date(day.date))}
                    class="w-full flex flex-col items-center justify-center gap-0.5 h-[52px] border-b border-surface-800/40 transition-colors {day.isSelected
                      ? 'bg-primary-container text-on-primary-container'
                      : day.isToday
                        ? 'bg-primary-500/10'
                        : 'bg-surface-900/40 hover:bg-surface-800/40'}"
                  >
                    <span
                      class="text-label-medium {day.isSelected
                        ? 'text-on-primary-container'
                        : 'text-gray-500'}"
                    >
                      {day.date.toLocaleDateString("nl-NL", {
                        weekday: "short",
                      })}
                    </span>
                    <span
                      class="text-title-medium {day.isSelected
                        ? 'text-on-primary-container'
                        : 'text-white'} leading-none">{day.date.getDate()}</span
                    >
                    <span class="flex gap-0.5 h-1">
                      {#if day.slots.some((s) => s.kind === "lesson" && s.event && [2, 3, 4, 5].includes(s.event.InfoType))}
                        <span class="w-1 h-1 rounded-full bg-red-500"></span>
                      {:else if day.slots.some((s) => s.kind === "ai")}
                        <span class="w-1 h-1 rounded-full bg-emerald-400"
                        ></span>
                      {/if}
                    </span>
                  </button>
                  <div class="relative" style="height: {grid.heightPx}px;">
                    {#each grid.hours as h}
                      <div
                        class="absolute left-0 right-0 border-t border-surface-800/30 pointer-events-none"
                        style="top: {(h - grid.minH) * PX_PER_HOUR}px;"
                      ></div>
                    {/each}
                    {#if day.isToday}
                      <div
                        class="absolute inset-0 bg-primary-500/5 pointer-events-none"
                      ></div>
                    {/if}
                    {#if day.isToday && nowMinutes >= grid.minH * 60 && nowMinutes <= grid.maxH * 60}
                      <div
                        class="absolute left-0 right-0 z-10 pointer-events-none"
                        style="top: {((nowMinutes - grid.minH * 60) / 60) *
                          PX_PER_HOUR}px;"
                      >
                        <div class="h-0.5 bg-red-500 rounded-full relative">
                          <div
                            class="absolute -left-1 -top-[4px] w-2 h-2 rounded-full bg-red-500"
                          ></div>
                        </div>
                      </div>
                    {/if}
                    {#each day.breaks as br}
                      <div
                        class="absolute left-1 right-1 pointer-events-none"
                        style="top: {(((minutesOf(br.start) ?? 0) -
                          grid.minH * 60) /
                          60) *
                          PX_PER_HOUR}px;"
                        title="{br.minutes} min pauze"
                      >
                        <div
                          class="border-t border-dashed border-surface-500/40"
                        ></div>
                      </div>
                    {/each}
                    {#each day.slots as s}
                      {#if s.kind === "lesson" && s.event}
                        {@const app = s.event}
                        {@const absence = absenceOf(app)}
                        <button
                          type="button"
                          onclick={() => openLesson(app)}
                          class="absolute rounded-m3-sm border px-2 py-1.5 text-left overflow-hidden transition-colors hover:border-primary-500/60 {app.InfoType ===
                            1 && !app.Afgerond
                            ? 'bg-primary-500/16 border-primary-500/40'
                            : app.Status === 4 || app.Status === 5
                              ? 'bg-red-500/10 border-red-500/30'
                              : 'bg-surface-800/80 border-surface-700/50'}"
                          style="top: {slotTopPx(s)}px; height: {slotHeightPx(
                            s,
                          )}px; left: calc({s._column} / {s._columnCount} * 100% + 4px); width: calc(100% / {s._columnCount} - 8px);"
                          title="{app.Vakken?.[0]?.Naam ||
                            app.Omschrijving ||
                            'Vrij'} · {formatTime(app.Start)} – {formatTime(
                            app.Einde,
                          )}"
                        >
                          <p
                            class="text-title-small leading-tight truncate {app.Status ===
                              4 || app.Status === 5
                              ? 'text-red-400 line-through'
                              : 'text-white'}"
                          >
                            {app.Vakken?.[0]?.Naam ||
                              app.Omschrijving ||
                              "Vrij"}
                          </p>
                          <p
                            class="text-label-medium tabular-nums truncate {absence
                              ? 'text-amber-300'
                              : 'text-gray-400'}"
                          >
                            {#if absence}{absenceLabel(absence)} ·
                            {/if}{formatTime(app.Start)}
                          </p>
                        </button>
                      {:else if s.kind === "ai" && s.item}
                        {@const item = s.item}
                        <button
                          onclick={() => navigateToDay(new Date(day.date))}
                          class="absolute rounded-m3-sm border px-2 py-1.5 text-left overflow-hidden transition-all hover:brightness-125 cursor-pointer {item.status ===
                          'completed'
                            ? 'bg-surface-800/50 border-surface-700/40 opacity-60'
                            : 'bg-emerald-500/12 border-emerald-500/40'}"
                          style="top: {slotTopPx(s)}px; height: {slotHeightPx(
                            s,
                          )}px; left: calc({s._column} / {s._columnCount} * 100% + 4px); width: calc(100% / {s._columnCount} - 8px);"
                          title="{item.title} · {formatTime(
                            item.start,
                          )} – {formatTime(item.end)}"
                        >
                          <p
                            class="text-title-small leading-tight truncate text-emerald-100"
                          >
                            {item.title}
                          </p>
                          <p
                            class="text-label-medium text-emerald-300/80 tabular-nums"
                          >
                            U{item.urgency} · {formatTime(item.start)}
                          </p>
                        </button>
                      {/if}
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </div>
      {:else}
        <!-- Mobile week list: day sections with merged rows -->
        <div class="space-y-3">
          {#each weekViewDays as day}
            <div
              class="rounded-m3-md overflow-hidden border {day.isToday
                ? 'border-primary-500/40 bg-primary-500/5'
                : 'border-surface-800/40 bg-surface-900/30'}"
            >
              <button
                onclick={() => navigateToDay(new Date(day.date))}
                class="w-full flex items-center justify-between px-3 py-2 {day.isToday
                  ? 'bg-primary-500/10'
                  : 'bg-surface-900/50'}"
              >
                <span class="flex items-center gap-2">
                  <span
                    class="text-label-medium {day.isToday
                      ? 'text-primary-300'
                      : 'text-gray-500'}"
                  >
                    {day.date.toLocaleDateString("nl-NL", { weekday: "long" })}
                  </span>
                  <span
                    class="text-title-small {day.isToday
                      ? 'text-white'
                      : 'text-gray-300'}">{day.date.getDate()}</span
                  >
                </span>
                {#if day.isToday}
                  <span
                    class="text-label-small text-primary-400 px-2 py-0.5 rounded-m3-full bg-primary-500/15"
                    >Vandaag</span
                  >
                {/if}
              </button>
              <div class="divide-y divide-surface-800/40">
                {#each day.merged as s}
                  {#if s.kind === "lesson" && s.event}
                    {@const app = s.event}
                    {@const absence = absenceOf(app)}
                    <button
                      type="button"
                      onclick={() => openLesson(app)}
                      class="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-800/50 transition-colors"
                    >
                      <span
                        class="text-label-small tabular-nums {app.Status ===
                          4 || app.Status === 5
                          ? 'text-red-400'
                          : 'text-primary-300'} w-10 shrink-0"
                        >{formatTime(app.Start)}</span
                      >
                      <span
                        class="flex-1 min-w-0 text-title-small truncate {app.Status ===
                          4 || app.Status === 5
                          ? 'text-red-400 line-through'
                          : 'text-white'}"
                        >{app.Vakken?.[0]?.Naam ||
                          app.Omschrijving ||
                          "Vrij"}</span
                      >
                      {#if absence}
                        <span
                          class="text-label-small text-amber-300 shrink-0 px-1.5 py-0.5 rounded-m3-full bg-amber-500/15 border border-amber-500/30"
                          title={absenceDetail(absence)}
                          >{absenceLabel(absence)}</span
                        >
                      {/if}
                      {#if app.Lokatie}<span
                          class="text-label-small text-gray-500 shrink-0"
                          >{app.Lokatie}</span
                        >{/if}
                      {#if app.InfoType === 1 && !app.Afgerond}
                        <span
                          class="w-1.5 h-1.5 rounded-full bg-primary-400 shrink-0"
                          title="Huiswerk"
                        ></span>
                      {/if}
                    </button>
                  {:else if s.kind === "break"}
                    <div class="w-full flex items-center gap-2 px-3 py-1">
                      <span class="w-10 shrink-0"></span>
                      <div class="h-px flex-1 bg-surface-600/50"></div>
                      <span
                        class="text-label-small text-gray-500 tabular-nums shrink-0"
                        >{s.minutes} min pauze</span
                      >
                    </div>
                  {:else if s.kind === "ai" && s.item}
                    {@const item = s.item}
                    <div
                      class="w-full flex items-center gap-2 px-3 py-2 text-left bg-emerald-500/5"
                    >
                      <span
                        class="text-label-small tabular-nums text-emerald-300 w-10 shrink-0"
                        >{formatTime(item.start)}</span
                      >
                      <span
                        class="flex-1 min-w-0 text-title-small truncate text-emerald-100"
                        >{item.title}</span
                      >
                      {#if item.status !== "completed"}
                        <button
                          onclick={() => doComplete(item.id)}
                          aria-label="Markeer als klaar"
                          class="w-7 h-7 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 flex items-center justify-center shrink-0"
                        >
                          <svg
                            class="w-3.5 h-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="4"><path d="M20 6L9 17L4 12" /></svg
                          >
                        </button>
                      {/if}
                    </div>
                  {/if}
                {:else}
                  <p class="px-3 py-2.5 text-label-small text-gray-600">
                    Geen lessen of planning
                  </p>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if dayMerged.length === 0}
      <div
        class="flex-1 flex flex-col items-center justify-center py-16 text-center space-y-4"
      >
        <div
          class="w-20 h-20 rounded-full bg-surface-800/80 border border-surface-700/50 flex items-center justify-center"
        >
          <svg
            class="w-8 h-8 text-gray-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            ><path d="M8 2v4" /><path d="M16 2v4" /><rect
              width="18"
              height="18"
              x="3"
              y="4"
              rx="2"
            /><path d="M3 10h18" /></svg
          >
        </div>
        <div>
          <h3 class="text-headline-small text-white mb-1">
            Geen lessen of planning
          </h3>
          <p
            class="text-body-medium text-gray-500 max-w-[260px] leading-relaxed"
          >
            Druk op de update-knop hierboven om huiswerk, toetsen en
            studieblokken te laten inplannen.
          </p>
        </div>
      </div>
    {:else}
      {#each dayMerged as m, i}
        {#if m.kind === "now"}
          <div class="flex items-center gap-2 px-1" aria-hidden="true">
            <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
            <div class="h-0.5 flex-1 bg-red-500 rounded-full"></div>
            <span class="text-label-small text-red-400 tabular-nums shrink-0"
              >Nu · {formatTime(now.toISOString())}</span
            >
          </div>
        {:else if m.kind === "lesson"}
          {@const app = m.event}
          {@const absence = absenceOf(app)}
          <button
            type="button"
            in:fly={{ y: 12, duration: 200, delay: Math.min(i * 20, 200) }}
            onclick={() => openLesson(app)}
            aria-label="Open les {app.Vakken?.[0]?.Naam ||
              app.Omschrijving ||
              'vrij'}"
            class="w-full text-left rounded-m3-md {$userSettings.compactView
              ? 'p-2 flex gap-2'
              : 'p-3 md:p-4 flex gap-3 md:gap-4'} border transition-colors hover:border-primary-500/50 {app.InfoType ===
              1 && !app.Afgerond
              ? 'bg-primary-500/14 border-primary-500/40'
              : app.Status === 4 || app.Status === 5
                ? 'bg-red-500/8 border-red-500/30'
                : 'bg-surface-800/60 border-surface-700/40'}"
          >
            <div
              class="flex flex-col items-center justify-center min-w-[36px] md:min-w-[42px] gap-0.5"
            >
              <span
                class="text-label-small {app.Status === 4 || app.Status === 5
                  ? 'text-red-400'
                  : 'text-primary-400'}">Les</span
              >
              <span class="text-title-large text-white leading-none"
                >{lesuurLabel(app)}</span
              >
              <div class="h-px w-4 bg-surface-600 my-0.5"></div>
              <span class="text-label-small text-primary-300/80"
                >{formatTime(app.Start)}</span
              >
            </div>
            <div class="w-px bg-surface-600/50 my-1"></div>
            <div class="flex-1 min-w-0 flex flex-col justify-center">
              <div class="flex items-center justify-between gap-1.5 mb-0.5">
                <span class="text-title-medium text-white truncate"
                  >{app.Vakken?.[0]?.Naam || app.Omschrijving || "Vrij"}</span
                >
                {#if app.Docenten?.[0] && !$userSettings.compactView}
                  <span
                    class="text-label-small text-gray-500 shrink-0 bg-surface-900/60 px-1.5 py-0.5 rounded-m3-sm border border-white/5"
                    >{displayTeacherName(app.Docenten[0].Naam)}</span
                  >
                {/if}
              </div>
              <div
                class="flex items-center gap-2.5 text-label-small text-gray-400"
              >
                <span class="truncate">{app.Lokatie || "—"}</span>
                <span class="shrink-0">Tot {formatTime(app.Einde)}</span>
                {#if absence && $userSettings.compactView}
                  <span
                    class="text-amber-300 truncate"
                    title={absenceDetail(absence)}>{absenceLabel(absence)}</span
                  >
                {/if}
              </div>
              {#if absence && !$userSettings.compactView}
                <div class="mt-1.5 flex">
                  <span
                    class="px-2 py-0.5 rounded-m3-sm text-label-small border border-amber-500/40 text-amber-300 bg-amber-500/10"
                    title={absenceDetail(absence)}
                    >Afwezig · {absenceLabel(absence)}</span
                  >
                </div>
              {/if}
              {#if !$userSettings.compactView}
                {#if app.Status === 4 || app.Status === 5}
                  <div class="mt-1.5 flex">
                    <span
                      class="px-2 py-0.5 rounded-m3-sm text-label-small border border-red-500/40 text-red-400 bg-red-500/10"
                      >Uitgevallen</span
                    >
                  </div>
                {:else if app.InfoType && app.InfoType !== 0}
                  <div class="mt-1.5 flex">
                    <span
                      class="px-2 py-0.5 rounded-m3-sm text-label-small border {getInfoColor(
                        app.InfoType,
                        !!app.Afgerond,
                      )}">{getInfoLabel(app.InfoType)}</span
                    >
                  </div>
                {/if}
              {/if}
            </div>
          </button>
        {:else if m.kind === "break"}
          <div class="flex items-center gap-3 px-4 py-0.5 opacity-60">
            <div class="w-8 flex justify-center">
              <div class="h-4 w-px bg-surface-600"></div>
            </div>
            <span class="text-label-small text-gray-500"
              >Pauze · {m.minutes} min</span
            >
          </div>
        {:else}
          {@const item = m.item}
          {#if item.item_type === "sleep"}
            <div class="flex items-center gap-3 px-4 py-1.5 opacity-50">
              <div class="w-8 flex flex-col items-center">
                <div class="h-3 w-0.5 bg-indigo-500/40"></div>
              </div>
              <div class="flex-1 flex items-center gap-2">
                <span
                  class="text-label-small text-indigo-300/80 inline-flex items-center gap-1"
                  ><Moon size={12} /> Slaap {formatTime(item.start)} – {formatTime(
                    item.end,
                  )}</span
                >
              </div>
            </div>
          {:else if item.item_type === "free_time"}
            <div
              class="flex items-center gap-3 px-4 py-1 opacity-40 hover:opacity-80 transition-opacity"
            >
              <div class="w-8 flex flex-col items-center">
                <div class="h-3 w-0.5 bg-surface-700"></div>
              </div>
              <div class="flex-1 text-label-small text-gray-500">
                Vrij {formatTime(item.start)} – {formatTime(item.end)}
              </div>
            </div>
          {:else}
            <div
              in:fly={{ y: 12, duration: 200, delay: Math.min(i * 20, 200) }}
              class="w-full text-left rounded-m3-md {$userSettings.compactView
                ? 'p-2 flex gap-2'
                : 'p-3 md:p-4 flex gap-3 md:gap-4'} border relative overflow-hidden {aiCardStyle(
                item,
              )}"
            >
              <div
                class="flex flex-col items-center justify-center min-w-[36px] md:min-w-[42px] gap-0.5"
              >
                <span class="text-label-small text-emerald-300">AI</span>
                <span class="text-title-large text-white leading-none"
                  >U{item.urgency}</span
                >
                <div class="h-px w-4 bg-surface-600 my-0.5"></div>
                <span class="text-label-small text-primary-300/80"
                  >{formatTime(item.start)}</span
                >
              </div>
              <div class="w-px bg-surface-600/50 my-1"></div>
              <div class="flex-1 min-w-0 flex flex-col justify-center">
                <div class="flex items-center gap-1.5 mb-0.5 flex-wrap">
                  <span class="text-title-medium text-white truncate"
                    >{item.title}</span
                  >
                  <span
                    class="text-label-small px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/20"
                    >{aiTypeLabel(item.item_type)}</span
                  >
                  {#if item.source === "user"}<span
                      class="text-label-small px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20"
                      >Jij</span
                    >{/if}
                  {#if item.status === "completed"}<span
                      class="text-label-small px-1.5 py-0.5 rounded bg-surface-700 text-gray-300"
                      >Klaar</span
                    >{/if}
                </div>
                {#if item.description && !$userSettings.compactView}
                  <p class="text-body-small text-gray-400 line-clamp-2">
                    {item.description}
                  </p>
                {/if}
                <p class="text-label-small text-gray-500 mt-0.5">
                  Tot {formatTime(item.end)}{item.related_subject
                    ? ` · ${item.related_subject}`
                    : ""}{item.estimated_minutes
                    ? ` · ${item.estimated_minutes} min`
                    : ""}
                </p>
                <div class="flex gap-1.5 mt-2 flex-wrap">
                  {#if item.status !== "completed"}
                    <button
                      onclick={() => doComplete(item.id)}
                      class="px-3 py-1.5 rounded-m3-xs bg-emerald-500/15 border border-emerald-500/20 text-emerald-300 text-label-small hover:bg-emerald-500/25"
                      >✓ Klaar</button
                    >
                    <button
                      onclick={() => doDismiss(item.id)}
                      class="px-3 py-1.5 rounded-m3-xs bg-surface-800 border border-white/10 text-gray-400 text-label-small hover:bg-surface-700"
                      >Negeren</button
                    >
                  {/if}
                  <button
                    onclick={() => doDelete(item.id)}
                    class="px-3 py-1.5 rounded-m3-xs bg-red-500/10 border border-red-500/20 text-red-400 text-label-small hover:bg-red-500/20"
                    >Wis</button
                  >
                </div>
              </div>
            </div>
          {/if}
        {/if}
      {/each}
    {/if}
  </main>

  <AddAiScheduleItemModal bind:open={showAddModal} onCreate={doCreate} />

  {#if showDetail && selectedAppointment}
    {@const sel = selectedAppointment}
    {@const absence = absenceOf(sel)}
    <div
      class="fixed inset-0 z-50 flex items-end md:items-center justify-center"
    >
      <button
        type="button"
        aria-label="Sluiten"
        class="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onclick={closeDetail}
      ></button>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Lesdetails"
        class="relative w-full md:max-w-lg max-h-[88vh] overflow-y-auto custom-scrollbar bg-surface-900 border border-white/10 rounded-t-m3-xl md:rounded-m3-xl p-4 md:p-6 space-y-4 md:space-y-5 shadow-2xl"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-label-small text-primary-400">
              {sel.LesuurVan
                ? `Lesuur ${lesuurLabel(sel)}`
                : getInfoLabel(sel.InfoType)}
            </p>
            <h2 class="text-title-large text-white truncate">
              {sel.Vakken?.[0]?.Naam || sel.Omschrijving || "Afspraak"}
            </h2>
            <p class="text-body-small text-gray-400">
              {formatTime(sel.Start)} – {formatTime(sel.Einde)}
              {sel.Lokatie ? ` · ${sel.Lokatie}` : ""}
            </p>
          </div>
          <IconButton onclick={closeDetail} aria-label="Sluiten">
            <svg
              class="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"><path d="M18 6 6 18M6 6l12 12" /></svg
            >
          </IconButton>
        </div>

        {#if sel.Docenten?.length}
          <div class="flex flex-wrap gap-1.5">
            {#each sel.Docenten as docent}
              <span
                class="text-label-small px-2 py-1 rounded-m3-sm bg-surface-800 border border-white/5 text-gray-300"
                >{displayTeacherName(docent.Naam)}</span
              >
            {/each}
          </div>
        {/if}

        {#if sel.Status === 4 || sel.Status === 5}
          <p
            class="text-body-small text-red-400 bg-red-500/10 border border-red-500/30 rounded-m3-sm p-2.5"
          >
            Deze les is uitgevallen.
          </p>
        {/if}

        {#if absence}
          <div
            class="rounded-m3-sm border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-0.5"
          >
            <p class="text-label-medium text-amber-300">
              Afwezig · {absenceLabel(absence)}{!absence.Geoorloofd
                ? " · ongeoorloofd"
                : ""}
            </p>
            {#if absenceDetail(absence)}
              <p class="text-label-small text-amber-200/70">
                {absenceDetail(absence)}
              </p>
            {/if}
          </div>
        {/if}

        {#if sel.InfoType === 1}
          <Button
            variant="filled"
            onclick={() => toggleDone(sel)}
            class="w-full {sel.Afgerond
              ? 'bg-emerald-500/10! text-emerald-400! border-2 border-emerald-500/50!'
              : ''}"
          >
            {sel.Afgerond ? "Huiswerk voltooid" : "Markeren als klaar"}
          </Button>
        {/if}

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-label-medium text-gray-100">Huiswerk & inhoud</h3>
            {#if sel.Type === 1}
              <button
                type="button"
                class="text-label-small text-primary-400 hover:text-primary-300"
                onclick={() => (editMode = !editMode)}
                >{editMode ? "Annuleren" : "Bewerken"}</button
              >
            {/if}
          </div>
          {#if loadingDetail}
            <p class="text-body-small text-gray-500">Laden…</p>
          {:else if editMode}
            <textarea
              bind:value={editContent}
              class="w-full h-36 bg-surface-950 border border-primary-500/30 rounded-m3-xs p-3 text-body-medium text-gray-200 focus:outline-none focus:border-primary-500"
              placeholder="Huiswerk bewerken..."></textarea>
            <Button variant="filled" onclick={saveLocalOverride} class="w-full"
              >Opslaan (lokaal)</Button
            >
          {:else if sel.Inhoud}
            <div
              class="p-3 md:p-4 rounded-m3-md bg-surface-950 border border-white/5 prose prose-sm prose-invert max-w-none"
            >
              <HtmlRenderer html={sel.Inhoud} />
              <TranslateButton source={sel.Inhoud} />
            </div>
          {:else}
            <p class="text-body-medium text-gray-600">
              Geen inhoud beschikbaar.
            </p>
          {/if}
        </div>

        {#if sel.Aantekening}
          <div>
            <h3 class="text-label-medium text-gray-100 mb-1">Aantekening</h3>
            <p class="text-body-small text-gray-400">{sel.Aantekening}</p>
          </div>
        {/if}
        {#if sel.Opmerking}
          <div>
            <h3 class="text-label-medium text-gray-100 mb-1">Opmerking</h3>
            <p class="text-body-small text-gray-400">{sel.Opmerking}</p>
          </div>
        {/if}

        {#if sel.Bijlagen?.length}
          <div class="space-y-2">
            <h3 class="text-label-medium text-gray-100">
              Bijlagen ({sel.Bijlagen.length})
            </h3>
            {#each sel.Bijlagen as bijlage}
              <button
                type="button"
                onclick={() => downloadAttachment(bijlage)}
                disabled={downloadingFile === bijlage.Naam}
                class="w-full flex items-center justify-between gap-2 p-2.5 rounded-m3-md bg-surface-950 border border-white/5 hover:border-white/15 text-left disabled:opacity-50"
              >
                <span class="text-body-small text-gray-200 truncate"
                  >{bijlage.Naam}</span
                >
                <span class="text-label-small text-gray-500 shrink-0"
                  >{downloadingFile === bijlage.Naam
                    ? "Bezig…"
                    : bijlage.Grootte
                      ? `${Math.round(bijlage.Grootte / 1024)} KB`
                      : "Download"}</span
                >
              </button>
            {/each}
          </div>
        {/if}

        {#if sel.Type === 1}
          <Button
            variant="tonal"
            onclick={deleteAppointment}
            disabled={deletingAppointment}
            class="w-full text-red-400!"
          >
            {deletingAppointment ? "Verwijderen…" : "Afspraak verwijderen"}
          </Button>
        {/if}
      </div>
    </div>
  {/if}

  {#if isCreating}
    <div
      class="fixed inset-0 z-50 flex items-end md:items-center justify-center"
    >
      <button
        type="button"
        aria-label="Sluiten"
        class="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onclick={() => (isCreating = false)}
      ></button>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nieuwe afspraak"
        class="relative w-full md:max-w-md max-h-[88vh] overflow-y-auto bg-surface-900 border border-white/10 rounded-t-m3-xl md:rounded-m3-xl p-4 md:p-6 space-y-3 md:space-y-4 shadow-2xl"
      >
        <div class="flex items-center justify-between">
          <h2 class="text-title-large text-white">Nieuwe afspraak</h2>
          <IconButton onclick={() => (isCreating = false)} aria-label="Sluiten">
            <svg
              class="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"><path d="M18 6 6 18M6 6l12 12" /></svg
            >
          </IconButton>
        </div>
        <p class="text-body-small text-gray-400">
          {selectedDate.toLocaleDateString("nl-NL", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
        <input
          bind:value={newApp.omschrijving}
          class="w-full bg-surface-950 border border-white/10 rounded-m3-xs px-3 py-2.5 text-body-medium text-white focus:outline-none focus:border-primary-500"
          placeholder="Omschrijving"
        />
        <div class="grid grid-cols-2 gap-2">
          <input
            bind:value={newApp.start}
            type="time"
            class="w-full bg-surface-950 border border-white/10 rounded-m3-xs px-3 py-2.5 text-body-medium text-white focus:outline-none focus:border-primary-500"
          />
          <input
            bind:value={newApp.einde}
            type="time"
            class="w-full bg-surface-950 border border-white/10 rounded-m3-xs px-3 py-2.5 text-body-medium text-white focus:outline-none focus:border-primary-500"
          />
        </div>
        <button
          type="button"
          onclick={() => (showTimeCalculator = !showTimeCalculator)}
          class="text-label-medium text-primary-400 hover:text-primary-300 text-left"
        >
          {showTimeCalculator ? "Verberg tijdcalculator" : "Tijdcalculator"}
        </button>
        {#if showTimeCalculator}
          <div
            class="space-y-3 rounded-m3-md border border-white/10 bg-surface-950/70 p-3"
          >
            <div class="grid grid-cols-3 gap-2">
              {#each ["lopen", "fiets", "auto"] as mode (mode)}
                <button
                  type="button"
                  onclick={() =>
                    (calcMode = mode as "lopen" | "fiets" | "auto")}
                  class="py-1.5 rounded-m3-xs text-label-medium border transition-colors {calcMode ===
                  mode
                    ? 'bg-primary-500/15 border-primary-500/40 text-primary-400'
                    : 'bg-surface-900 border-white/5 text-gray-500'}"
                >
                  {mode === "lopen"
                    ? "Lopen"
                    : mode === "fiets"
                      ? "Fiets"
                      : "Auto"}
                </button>
              {/each}
            </div>
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-label-small text-gray-500">
                <span>Reistijd (min)</span>
                <input
                  type="number"
                  min="0"
                  bind:value={calcTravelMinutes}
                  class="w-full bg-surface-900 border border-white/5 rounded-m3-xs px-3 py-2 text-body-medium text-white focus:outline-none"
                />
              </label>
              <label class="space-y-1 text-label-small text-gray-500">
                <span>Duur ter plaatse (min)</span>
                <input
                  type="number"
                  min="0"
                  bind:value={calcVisitMinutes}
                  class="w-full bg-surface-900 border border-white/5 rounded-m3-xs px-3 py-2 text-body-medium text-white focus:outline-none"
                />
              </label>
            </div>
            <label class="space-y-1 block text-label-small text-gray-500">
              <span>Tijd van de afspraak</span>
              <input
                type="time"
                bind:value={calcAppointmentTime}
                class="w-full bg-surface-900 border border-white/5 rounded-m3-xs px-3 py-2 text-body-medium text-white focus:outline-none"
              />
            </label>
            {#if calcResult}
              <p class="text-label-small text-gray-400">
                Weg om <span class="text-primary-400 tabular-nums"
                  >{formatTime(calcResult.depart.toISOString())}</span
                >, terug om
                <span class="text-primary-400 tabular-nums"
                  >{formatTime(calcResult.back.toISOString())}</span
                >
              </p>
            {/if}
            <Button
              variant="tonal"
              type="button"
              disabled={!calcResult}
              onclick={applyCalculatedTime}
              class="w-full h-9!"
            >
              Toepassen
            </Button>
          </div>
        {/if}
        <input
          bind:value={newApp.lokatie}
          class="w-full bg-surface-950 border border-white/10 rounded-m3-xs px-3 py-2.5 text-body-medium text-white focus:outline-none focus:border-primary-500"
          placeholder="Locatie (optioneel)"
        />
        <textarea
          bind:value={newApp.inhoud}
          class="w-full h-24 bg-surface-950 border border-white/10 rounded-m3-xs px-3 py-2.5 text-body-medium text-white focus:outline-none focus:border-primary-500"
          placeholder="Inhoud (optioneel)"></textarea>
        {#if createError}
          <p class="text-body-small text-red-400">{createError}</p>
        {/if}
        <Button variant="filled" onclick={createAppointment} class="w-full"
          >Afspraak aanmaken</Button
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .custom-scrollbar::-webkit-scrollbar {
    width: 3px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
</style>
