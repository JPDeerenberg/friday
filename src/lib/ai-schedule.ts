import { invoke } from "@tauri-apps/api/core";
import type { AiScheduleItem, MergedSchedule } from "./ai-schedule-types.ts";
import {
  findScheduleOverlap,
  inRange,
  loadScheduleItems,
  saveScheduleItems,
  validateScheduleItem,
} from "./web-ai-schedule-store.ts";
import {
  dayKey,
  fmtISO,
  fmtYMD,
  generatePlan,
  intervalsOverlapStr,
  isoToWall,
  computeFreeSlots,
  planningWindow,
  wallNow,
  type AssignmentInput,
  type FreeSlot,
  type PlanItem,
  type PlanLesson,
  type ScheduleSettings,
} from "./web-planner.ts";
import { loadSettings } from "./stores.ts";
import { loadWebSession, sessionTierA } from "./web-session.ts";

function isWeb(): boolean {
  return typeof window !== "undefined" && !(window as any).__TAURI__;
}

function toPlanItem(item: AiScheduleItem): PlanItem {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    item_type: item.item_type,
    start: item.start,
    end: item.end,
    status: item.status,
    urgency: item.urgency,
    related_assignment_id: item.related_assignment_id,
    related_calendar_event_id: item.related_calendar_event_id,
    related_subject: item.related_subject,
    estimated_minutes: item.estimated_minutes,
    duration_source: item.duration_source,
    source: item.source,
    created_at: item.created_at,
    updated_at: item.updated_at,
    completed_at: item.completed_at,
  };
}

// === AI Schedule ===

/** Refresh event after plan mutations (Phase 7 item 4). */
export const AI_SCHEDULE_CHANGED_EVENT = "friday:ai-schedule-changed";

export function dispatchScheduleChanged(): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function"
  )
    return;
  window.dispatchEvent(new CustomEvent(AI_SCHEDULE_CHANGED_EVENT));
}

/** One reversible plan mutation (Phase 7 item 5). Mirrors Rust UndoEntry. */
export interface PlanMutation {
  op: string;
  itemId: string;
  before: AiScheduleItem | null;
  after: AiScheduleItem | null;
}

/** Max undo entries kept. Mirrors Rust UNDO_LIMIT. */
export const PLAN_UNDO_LIMIT = 20;

const undoLog: PlanMutation[] = [];

function recordMutation(
  op: string,
  itemId: string,
  before: AiScheduleItem | null,
  after: AiScheduleItem | null,
): void {
  undoLog.push({ op, itemId, before, after });
  while (undoLog.length > PLAN_UNDO_LIMIT) undoLog.shift();
}

/** Test hook: inspect the undo log. */
export function __undoLogForTests(): PlanMutation[] {
  return undoLog;
}

/** Test hook: clear the undo log. */
export function __clearUndoForTests(): void {
  undoLog.length = 0;
}

export async function getAiSchedule(
  start: string,
  end: string,
): Promise<AiScheduleItem[]> {
  if (isWeb()) {
    const s = isoToWall(start);
    const e = isoToWall(end);
    if (s == null || e == null) throw new Error("Ongeldige datum");
    return (await loadScheduleItems()).filter((item) => inRange(item, s, e));
  }
  return invoke("get_ai_schedule", { start, end });
}

export async function createAiScheduleItem(
  item: AiScheduleItem,
): Promise<AiScheduleItem> {
  if (isWeb()) return webCreateItem(item);
  return invoke("create_ai_schedule_item", { item });
}

async function webSaveAll(items: AiScheduleItem[]): Promise<void> {
  await saveScheduleItems(items);
  dispatchScheduleChanged();
}

function webNowIso(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function webCreateItem(item: AiScheduleItem): Promise<AiScheduleItem> {
  const now = webNowIso();
  const fresh: AiScheduleItem = {
    ...item,
    id:
      item.id.trim() ||
      `ai-${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
    created_at: item.created_at || now,
    updated_at: now,
    completed_at:
      item.status === "completed"
        ? (item.completed_at ?? now)
        : item.completed_at,
  };
  validateScheduleItem(fresh);
  const items = await loadScheduleItems();
  // Idempotent: same id exists -> return existing (double-click safe).
  const existing = items.find((i) => i.id === fresh.id);
  if (existing) return existing;
  // Same assignment/event link at overlapping time -> return it.
  if (
    fresh.related_assignment_id != null ||
    fresh.related_calendar_event_id != null
  ) {
    for (const it of items) {
      const sameAssign =
        fresh.related_assignment_id != null &&
        it.related_assignment_id === fresh.related_assignment_id;
      const sameCal =
        fresh.related_calendar_event_id != null &&
        it.related_calendar_event_id === fresh.related_calendar_event_id;
      if ((sameAssign || sameCal) && it.status !== "dismissed") {
        if (intervalsOverlapStr(fresh.start, fresh.end, it.start, it.end))
          return it;
      }
    }
  }
  const conflict = findScheduleOverlap(items, fresh.start, fresh.end, null);
  if (conflict) {
    throw new Error(
      `Overlap: er staat al '${conflict}' gepland op dit tijdstip. Kies een ander tijdstip.`,
    );
  }
  items.push(fresh);
  recordMutation("create_ai_schedule_item", fresh.id, null, fresh);
  await webSaveAll(items);
  return fresh;
}

export async function updateAiScheduleItem(
  item: AiScheduleItem,
): Promise<AiScheduleItem> {
  if (isWeb()) {
    validateScheduleItem(item);
    const items = await loadScheduleItems();
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx < 0) throw new Error(`Item '${item.id}' niet gevonden.`);
    const conflict = findScheduleOverlap(items, item.start, item.end, item.id);
    if (conflict) {
      throw new Error(
        `Overlap: er staat al '${conflict}' gepland op dit tijdstip. Kies een ander tijdstip.`,
      );
    }
    const updated: AiScheduleItem = { ...item, updated_at: webNowIso() };
    if (updated.status === "completed" && !updated.completed_at)
      updated.completed_at = updated.updated_at;
    if (updated.status !== "completed") updated.completed_at = null;
    // Manual edits promote AiChat -> User: the next Update treats the item
    // as a fixed constraint instead of silently rearranging it.
    if (updated.source === "ai_chat") updated.source = "user";
    const before: AiScheduleItem = { ...items[idx] };
    items[idx] = updated;
    recordMutation("update_ai_schedule_item", updated.id, before, updated);
    await webSaveAll(items);
    return updated;
  }
  return invoke("update_ai_schedule_item", { item });
}

export async function deleteAiScheduleItem(id: string): Promise<void> {
  if (isWeb()) {
    const items = await loadScheduleItems();
    const before = items.find((i) => i.id === id);
    if (!before) throw new Error(`Item '${id}' niet gevonden.`);
    await webSaveAll(items.filter((i) => i.id !== id));
    recordMutation("delete_ai_schedule_item", id, before, null);
    return;
  }
  return invoke("delete_ai_schedule_item", { id });
}

export async function completeAiScheduleItem(id: string): Promise<void> {
  if (isWeb()) {
    const items = await loadScheduleItems();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`Item '${id}' niet gevonden.`);
    const before: AiScheduleItem = { ...item };
    item.status = "completed";
    const now = webNowIso();
    item.completed_at = now;
    item.updated_at = now;
    await webSaveAll(items);
    recordMutation("complete_ai_schedule_item", id, before, { ...item });
    return;
  }
  return invoke("complete_ai_schedule_item", { id });
}

export async function dismissAiScheduleItem(id: string): Promise<void> {
  if (isWeb()) {
    const items = await loadScheduleItems();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`Item '${id}' niet gevonden.`);
    const before: AiScheduleItem = { ...item };
    item.status = "dismissed";
    item.updated_at = webNowIso();
    await webSaveAll(items);
    recordMutation("dismiss_ai_schedule_item", id, before, { ...item });
    return;
  }
  return invoke("dismiss_ai_schedule_item", { id });
}

export async function getMergedSchedule(
  start: string,
  end: string,
  personId: number,
): Promise<MergedSchedule> {
  if (isWeb()) {
    const s = isoToWall(start);
    const e = isoToWall(end);
    if (s == null || e == null) throw new Error("Ongeldige datum");
    const ai_items = (await loadScheduleItems()).filter((item) =>
      inRange(item, s, e),
    );
    // Magister events best-effort: never fail the whole merged view.
    let magister_events: MergedSchedule["magister_events"] = [];
    try {
      const tokens = await loadWebSession();
      if (tokens) {
        const data = await sessionTierA().magister<{
          Items?: unknown[];
          items?: unknown[];
        }>(
          tokens,
          "GET",
          `personen/${personId}/afspraken?tot=${end.slice(0, 10)}&van=${start.slice(0, 10)}`,
        );
        magister_events = (data.Items ??
          data.items ??
          []) as MergedSchedule["magister_events"];
      }
    } catch (err) {
      console.warn(
        "getMergedSchedule: Magister fetch failed, showing AI items only",
        err,
      );
    }
    return { magister_events, ai_items };
  }
  return invoke("get_merged_schedule", { start, end, personId });
}

export interface AiScheduleSettingsInput {
  bedtime: string;
  wakeTime: string;
  blockedTimes: { day: string; start: string; end: string }[];
  afterSchoolBufferMin: number;
  planInSchoolGaps: boolean;
}

export async function updateAiSchedule(
  settings?: AiScheduleSettingsInput,
): Promise<AiScheduleItem[]> {
  if (isWeb()) return webPerformUpdate(settings);
  return invoke("update_ai_schedule", {
    bedtime: settings?.bedtime ?? null,
    wakeTime: settings?.wakeTime ?? null,
    blockedTimes: settings?.blockedTimes ?? null,
    afterSchoolBufferMin: settings?.afterSchoolBufferMin ?? null,
    planInSchoolGaps: settings?.planInSchoolGaps ?? null,
  });
}

async function webPerformUpdate(
  settings?: AiScheduleSettingsInput,
): Promise<AiScheduleItem[]> {
  const stored = loadSettings().aiSchedule;
  const planSettings = {
    bedtime: settings?.bedtime ?? stored.bedtime,
    wakeTime: settings?.wakeTime ?? stored.wakeTime,
    blockedTimes: settings?.blockedTimes ?? stored.blockedTimes,
    afterSchoolBufferMin:
      settings?.afterSchoolBufferMin ?? stored.afterSchoolBufferMin,
    planInSchoolGaps: settings?.planInSchoolGaps ?? stored.planInSchoolGaps,
  };
  const tokens = await loadWebSession();
  if (!tokens) throw new Error("Niet ingelogd.");
  const personId = tokens.personId;
  if (personId == null) throw new Error("Niet ingelogd.");

  // Planning window: today through coming Sunday + next week (device-local,
  // mirroring chrono::Local on desktop).
  const todayMs = wallNow();
  const todayDay = dayKey(todayMs);
  const [windowStartDay, windowEndDay] = planningWindow(todayDay);
  const windowStartStr = fmtYMD(windowStartDay * 86_400_000);

  const existingItems = await loadScheduleItems();
  const be = sessionTierA();

  // Lessons in window + 14 days past it (tests need their preparation
  // horizon — same extension as the desktop fetch_magister_events_inner);
  // assignments broad (2013 → +365d) then filtered locally.
  const fetchEndStr = fmtYMD((windowEndDay + 14) * 86_400_000);
  let lessons: PlanLesson[] = [];
  try {
    const data = await be.magister<{ Items?: unknown[]; items?: unknown[] }>(
      tokens,
      "GET",
      `personen/${personId}/afspraken?tot=${fetchEndStr}&van=${windowStartStr}`,
    );
    lessons = toPlanLessons(data.Items ?? data.items ?? []);
  } catch (err) {
    console.warn("updateAiSchedule: lessons fetch failed", err);
  }

  const broadEnd = fmtYMD((dayKey(todayMs) + 365) * 86_400_000);
  let assignmentsRaw: unknown[] = [];
  try {
    const data = await be.magister<{ Items?: unknown[]; items?: unknown[] }>(
      tokens,
      "GET",
      `personen/${personId}/opdrachten?van=2013-01-01&tot=${broadEnd}`,
    );
    assignmentsRaw = (data.Items ?? data.items ?? []) as unknown[];
  } catch (err) {
    console.warn("updateAiSchedule: assignments fetch failed", err);
  }

  // Locked: completed/dismissed/in-progress/User-source in window.
  // FreeTime/Sleep regenerate, never locked.
  const lockedItems = existingItems
    .filter((item) => {
      const s = isoToWall(item.start);
      const e = isoToWall(item.end);
      if (s == null || e == null) return false;
      if (dayKey(e) < windowStartDay || dayKey(s) > windowEndDay) return false;
      if (item.item_type === "free_time" || item.item_type === "sleep")
        return false;
      if (item.status === "completed" || item.status === "dismissed")
        return true;
      if (item.status === "in_progress") return true;
      if (item.source === "user") return true;
      return false;
    })
    .map(toPlanItem);

  // Duration map: prefer UserEntered, else any known (mirrors desktop).
  const durationMap = new Map<number, { minutes: number; source: string }>();
  for (const item of existingItems) {
    if (item.related_assignment_id != null && item.estimated_minutes != null) {
      const src = item.duration_source ?? "ai_estimated";
      const prev = durationMap.get(item.related_assignment_id);
      if (!prev || (src === "user_entered" && prev.source !== "user_entered")) {
        durationMap.set(item.related_assignment_id, {
          minutes: item.estimated_minutes,
          source: src,
        });
      }
    }
  }

  // Assignment inputs: open only (skip Afgesloten; submitted IngeleverdOp
  // still planned unless closed — mirrors desktop).
  const assignmentInputs: AssignmentInput[] = [];
  for (const v of assignmentsRaw) {
    const r = (v ?? {}) as Record<string, unknown>;
    const id = r["Id"] ?? r["id"];
    if (typeof id !== "number") continue;
    const inleveren = (r["InleverenVoor"] ??
      r["inleveren_voor"] ??
      "") as string;
    if (!inleveren) continue;
    const afgesloten = (r["Afgesloten"] ?? r["afgesloten"] ?? false) as boolean;
    if (afgesloten) continue;
    const titelRaw = r["Titel"] ?? r["titel"] ?? r["title"];
    assignmentInputs.push({
      id,
      titel: typeof titelRaw === "string" && titelRaw ? titelRaw : "Opdracht",
      vak: ((r["Vak"] ?? r["vak"]) as string | undefined) ?? null,
      inleveren_voor: inleveren,
      omschrijving:
        ((r["Omschrijving"] ?? r["omschrijving"]) as string | undefined) ??
        null,
    });
  }

  const newItems = generatePlan({
    windowStartDay,
    windowEndDay,
    lessons,
    lockedItems,
    assignments: assignmentInputs,
    existingItems: existingItems.map(toPlanItem),
    settings: planSettings,
    durationMap,
  });

  // Mutate state: prune past completed/dismissed, drop rearrangeable in
  // window, insert new idempotently with the double-book guardrail.
  const items = await loadScheduleItems();
  const nowMs = wallNow();
  const kept = items.filter((item) => {
    const e = isoToWall(item.end);
    if (
      (item.status === "completed" || item.status === "dismissed") &&
      e != null &&
      e < nowMs &&
      dayKey(e) < windowStartDay
    ) {
      return false;
    }
    return true;
  });
  const lockedIds = new Set(lockedItems.map((i) => i.id));
  const working = kept.filter((item) => {
    const s = isoToWall(item.start);
    const e = isoToWall(item.end);
    const inWindow =
      s != null &&
      e != null &&
      dayKey(e) >= windowStartDay &&
      dayKey(s) <= windowEndDay;
    if (!inWindow) return true;
    if (lockedIds.has(item.id)) return true;
    if (item.item_type === "free_time" || item.item_type === "sleep")
      return false;
    if (item.status === "planned" && item.source === "ai_chat") return false;
    return true;
  });
  const toAiItem = (p: PlanItem): AiScheduleItem => ({
    id: p.id,
    title: p.title,
    description: p.description,
    item_type: p.item_type as AiScheduleItem["item_type"],
    start: p.start,
    end: p.end,
    status: p.status as AiScheduleItem["status"],
    urgency: p.urgency,
    related_assignment_id: p.related_assignment_id,
    related_calendar_event_id: p.related_calendar_event_id,
    related_subject: p.related_subject,
    estimated_minutes: p.estimated_minutes,
    duration_source: p.duration_source as AiScheduleItem["duration_source"],
    source: p.source as AiScheduleItem["source"],
    created_at: p.created_at,
    updated_at: p.updated_at,
    completed_at: p.completed_at,
  });
  for (const p of newItems) {
    if (working.some((i) => i.id === p.id)) continue;
    const sameLink = working.some((i) => {
      if (i.status === "dismissed") return false;
      const sameAssign =
        p.related_assignment_id != null &&
        i.related_assignment_id === p.related_assignment_id;
      const sameCal =
        p.related_calendar_event_id != null &&
        i.related_calendar_event_id === p.related_calendar_event_id;
      return (
        (sameAssign || sameCal) &&
        intervalsOverlapStr(p.start, p.end, i.start, i.end)
      );
    });
    if (sameLink) continue;
    if (findScheduleOverlap(working, p.start, p.end, null)) {
      console.warn(`updateAiSchedule: skipping '${p.id}' — overlaps existing`);
      continue;
    }
    working.push(toAiItem(p));
  }
  await webSaveAll(working);
  return working.filter((item) => {
    const s = isoToWall(item.start);
    const e = isoToWall(item.end);
    return (
      s != null &&
      e != null &&
      dayKey(e) >= windowStartDay &&
      dayKey(s) <= windowEndDay
    );
  });
}

export async function setHomeworkDuration(
  assignmentId: number,
  estimatedMinutes: number,
  urgency?: number,
): Promise<AiScheduleItem> {
  if (isWeb()) {
    if (!estimatedMinutes || estimatedMinutes > 600)
      throw new Error("Ongeldige duur (1-600 minuten).");
    if (urgency !== undefined && !(urgency >= 1 && urgency <= 5))
      throw new Error("Urgency moet 1-5 zijn.");
    const items = await loadScheduleItems();
    const now = webNowIso();
    const found = items.find((i) => i.related_assignment_id === assignmentId);
    if (found) {
      const before: AiScheduleItem = { ...found };
      found.estimated_minutes = estimatedMinutes;
      found.duration_source = "user_entered";
      if (urgency !== undefined) found.urgency = urgency;
      found.updated_at = now;
      await webSaveAll(items);
      recordMutation("set_homework_duration", found.id, before, { ...found });
      return found;
    }
    // No existing item: placeholder AssignmentWork carrying the duration, so
    // the next Update picks it up via the duration map.
    const start = isoToWall(now) ?? wallNow();
    const fresh: AiScheduleItem = {
      id: `work-${assignmentId}-manual`,
      title: `Huiswerk ${assignmentId}`,
      description: "Duur ingesteld via UI",
      item_type: "assignment_work",
      start: fmtISO(start),
      end: fmtISO(start + estimatedMinutes * 60_000),
      status: "planned",
      urgency: urgency ?? 3,
      related_assignment_id: assignmentId,
      related_calendar_event_id: null,
      related_subject: null,
      estimated_minutes: estimatedMinutes,
      duration_source: "user_entered",
      source: "user",
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    items.push(fresh);
    recordMutation("set_homework_duration", fresh.id, null, fresh);
    await webSaveAll(items);
    return fresh;
  }
  return invoke("set_homework_duration", {
    assignmentId,
    estimatedMinutes,
    urgency: urgency ?? null,
  });
}

export function getWeekWindow(): { start: string; end: string } {
  const today = new Date();
  const day = today.getDay();
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  const sundayNext = new Date(monday);
  sundayNext.setDate(monday.getDate() + 13); // two weeks from monday
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return {
    start: fmt(new Date()), // today
    end: fmt(sundayNext),
  };
}

export function formatIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// === AI plan tools (Phase 7): web twins of the desktop schedule arms ======
// These run on web only (desktop executes them in Rust); the web tool loop
// calls them via web-ai-tools.ts arms, never the store directly.

export {
  findScheduleOverlap,
  validateScheduleItem,
} from "./web-ai-schedule-store.ts";

export interface PlanSettingsJson {
  bedtime: string;
  wake_time: string;
  blocked_times: Array<{ day: string; start: string; end: string }>;
  after_school_buffer_min: number;
  plan_in_school_gaps: boolean;
}

/** Read-only view of the AI-Planning settings (Phase 7 item 2). */
export function getPlanSettings(): PlanSettingsJson {
  const s = loadSettings().aiSchedule;
  return {
    bedtime: s.bedtime,
    wake_time: s.wakeTime,
    blocked_times: (s.blockedTimes ?? []).map((b) => ({
      day: b.day,
      start: b.start,
      end: b.end,
    })),
    after_school_buffer_min: s.afterSchoolBufferMin,
    plan_in_school_gaps: s.planInSchoolGaps,
  };
}

function toPlannerSettings(s: PlanSettingsJson): ScheduleSettings {
  return {
    bedtime: s.bedtime,
    wakeTime: s.wake_time,
    blockedTimes: s.blocked_times,
    afterSchoolBufferMin: s.after_school_buffer_min,
    planInSchoolGaps: s.plan_in_school_gaps,
  };
}

export interface FreeSlotJson {
  start: string;
  end: string;
  minutes: number;
  date: string;
}

function slotJson(slot: FreeSlot): FreeSlotJson {
  return {
    start: fmtISO(slot.start),
    end: fmtISO(slot.end),
    minutes: Math.max(0, Math.round((slot.end - slot.start) / 60000)),
    date: fmtYMD(slot.start),
  };
}

/** Map raw Magister afspraken to planner lessons (same as the Update flow). */
export function toPlanLessons(raw: unknown[]): PlanLesson[] {
  return ((raw ?? []) as Array<Record<string, unknown>>).map((ev) => ({
    id: (ev["Id"] as number) ?? 0,
    start: (ev["Start"] as string) ?? "",
    einde: (ev["Einde"] as string) ?? "",
    status: (ev["Status"] as number) ?? 0,
    info_type: (ev["InfoType"] as number) ?? 0,
    afgerond: (ev["Afgerond"] as boolean) ?? false,
    omschrijving: (ev["Omschrijving"] as string | null) ?? null,
    inhoud: (ev["Inhoud"] as string | null) ?? null,
    aantekening: (ev["Aantekening"] as string | null) ?? null,
    vakken: Array.isArray(ev["Vakken"])
      ? (ev["Vakken"] as Array<Record<string, unknown>>).map((v) => ({
          naam: (v["Naam"] as string | undefined) ?? null,
        }))
      : null,
  }));
}

/** Locked items for an ms range (web twin of Rust locked_items_in_window). */
function lockedInRange(
  items: AiScheduleItem[],
  startMs: number,
  endMs: number,
): PlanItem[] {
  return items
    .filter((item) => {
      const s = isoToWall(item.start);
      const e = isoToWall(item.end);
      if (s == null || e == null) return false;
      if (e < startMs || s > endMs) return false;
      if (item.item_type === "free_time" || item.item_type === "sleep")
        return false;
      if (item.status === "completed" || item.status === "dismissed")
        return true;
      if (item.status === "in_progress") return true;
      if (item.source === "user") return true;
      return false;
    })
    .map(toPlanItem);
}

function lessonLabel(l: PlanLesson): string {
  const oms = (l.omschrijving ?? "").trim();
  if (oms) return oms;
  const vak = l.vakken?.find((v) => v.naam)?.naam;
  if (vak) return vak;
  return `les ${l.id}`;
}

function lessonOverlap(
  lessons: PlanLesson[],
  start: string,
  end: string,
): string | null {
  for (const l of lessons) {
    if (l.status === 4 || l.status === 5) continue;
    if (intervalsOverlapStr(start, end, l.start, l.einde))
      return lessonLabel(l);
  }
  return null;
}

/** Guardrail rejection carrying retry suggestions (Phase 7 item 3). */
export class PlanGuardrailError extends Error {
  suggestions: FreeSlotJson[];
  conflictWith: { type: string; id: string };
  lessonsChecked: boolean;
  constructor(
    reason: string,
    conflictWith: { type: string; id: string },
    suggestions: FreeSlotJson[],
    lessonsChecked: boolean,
  ) {
    super(reason);
    this.name = "PlanGuardrailError";
    this.conflictWith = conflictWith;
    this.suggestions = suggestions;
    this.lessonsChecked = lessonsChecked;
  }
}

async function suggestSlots(
  dayMs: number,
  lessons: PlanLesson[],
  minMinutes: number,
  count: number,
): Promise<FreeSlotJson[]> {
  const settings = toPlannerSettings(getPlanSettings());
  const items = await loadScheduleItems();
  const day = dayKey(dayMs);
  const locked = lockedInRange(
    items,
    day * 86_400_000,
    day * 86_400_000 + 86_400_000 - 1,
  );
  return computeFreeSlots(day, day, lessons, locked, settings)
    .filter((s) => s.end - s.start >= minMinutes * 60000)
    .slice(0, count)
    .map(slotJson);
}

/** Fetch one item by id (facade-level, for update/move arms). */
export async function getAiScheduleItem(id: string): Promise<AiScheduleItem> {
  const items = await loadScheduleItems();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`Item '${id}' niet gevonden.`);
  return { ...item };
}

async function guardrail(
  items: AiScheduleItem[],
  start: string,
  end: string,
  ignoreId: string | null,
  lessons: PlanLesson[],
  lessonsChecked: boolean,
): Promise<void> {
  const aiConflict = findScheduleOverlap(items, start, end, ignoreId);
  const lessonConflict = lessonOverlap(lessons, start, end);
  if (!aiConflict && !lessonConflict) return;
  const kind = aiConflict ? "ai_item" : "les";
  const what = aiConflict ?? lessonConflict ?? "";
  const dayMs = isoToWall(start.slice(0, 10) + "T12:00:00") ?? wallNow();
  const suggestions = await suggestSlots(dayMs, lessons, 0, 3);
  throw new PlanGuardrailError(
    `Overlap met ${kind} '${what}'.`,
    { type: kind, id: what },
    suggestions,
    lessonsChecked,
  );
}

/** AI-guarded create (web twin of the desktop arm). */
export async function aiCreatePlanItem(
  fields: {
    title: string;
    description?: string;
    item_type: AiScheduleItem["item_type"];
    start: string;
    end: string;
    urgency?: number;
    related_assignment_id?: number;
    related_subject?: string;
    estimated_minutes?: number;
  },
  lessons: PlanLesson[],
  lessonsChecked: boolean,
): Promise<AiScheduleItem> {
  const now = webNowIso();
  const fresh: AiScheduleItem = {
    id: "",
    title: fields.title,
    description: fields.description ?? null,
    item_type: fields.item_type,
    start: fields.start,
    end: fields.end,
    status: "planned",
    urgency: fields.urgency ?? 3,
    related_assignment_id: fields.related_assignment_id ?? null,
    related_calendar_event_id: null,
    related_subject: fields.related_subject ?? null,
    estimated_minutes: fields.estimated_minutes ?? null,
    duration_source: fields.estimated_minutes != null ? "ai_estimated" : null,
    source: "ai_chat",
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  validateScheduleItem(fresh);
  const s = isoToWall(fresh.start);
  const e = isoToWall(fresh.end);
  if (s == null || e == null || e <= s)
    throw new Error("Eind moet na start liggen.");
  const exempt = fresh.item_type === "free_time" || fresh.item_type === "sleep";
  if (!exempt) {
    const items = await loadScheduleItems();
    await guardrail(
      items,
      fresh.start,
      fresh.end,
      null,
      lessons,
      lessonsChecked,
    );
  } else if (lessons.length > 0) {
    const lessonConflict = lessonOverlap(lessons, fresh.start, fresh.end);
    if (lessonConflict) {
      const dayMs =
        isoToWall(fresh.start.slice(0, 10) + "T12:00:00") ?? wallNow();
      throw new PlanGuardrailError(
        `Overlap met les '${lessonConflict}'.`,
        { type: "les", id: lessonConflict },
        await suggestSlots(dayMs, lessons, 0, 3),
        lessonsChecked,
      );
    }
  }
  return webCreateItem(fresh);
}

/** AI-guarded full update (web twin of the desktop arm). */
export async function aiUpdatePlanItem(
  item: AiScheduleItem,
  lessons: PlanLesson[],
  lessonsChecked: boolean,
): Promise<AiScheduleItem> {
  validateScheduleItem(item);
  const s = isoToWall(item.start);
  const e = isoToWall(item.end);
  if (s == null || e == null || e <= s)
    throw new Error("Eind moet na start liggen.");
  const current = await getAiScheduleItem(item.id);
  const timeChanged =
    item.start !== current.start ||
    item.end !== current.end ||
    item.item_type !== current.item_type;
  const plannable =
    item.item_type !== "free_time" &&
    item.item_type !== "sleep" &&
    item.status !== "completed" &&
    item.status !== "dismissed";
  if (timeChanged && plannable) {
    const items = await loadScheduleItems();
    await guardrail(
      items,
      item.start,
      item.end,
      item.id,
      lessons,
      lessonsChecked,
    );
  }
  return updateAiScheduleItem({ ...item, updated_at: webNowIso() });
}

/**
 * Move an item to a new start (duration kept), with the overlap guardrail.
 * Web only — desktop runs the Rust arm.
 */
export async function moveAiScheduleItem(
  id: string,
  newStart: string,
  lessons: PlanLesson[],
  lessonsChecked: boolean,
): Promise<AiScheduleItem> {
  if (!isWeb())
    throw new Error("moveAiScheduleItem is alleen beschikbaar op web.");
  const items = await loadScheduleItems();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`Item '${id}' niet gevonden.`);
  const before: AiScheduleItem = { ...item };
  const oldStart = isoToWall(item.start);
  const oldEnd = isoToWall(item.end);
  const ns = isoToWall(newStart);
  if (oldStart == null || oldEnd == null) {
    throw new Error("Item heeft een ongeldige start/eind datum.");
  }
  if (ns == null) throw new Error("Ongeldige new_start (verwacht ISO 8601).");
  const duration = oldEnd - oldStart;
  if (duration <= 0) throw new Error("Item heeft geen positieve duur.");
  const ne = ns + duration;
  const newStartStr = fmtISO(ns);
  const newEndStr = fmtISO(ne);
  const aiConflict = findScheduleOverlap(items, newStartStr, newEndStr, id);
  const lessonConflict = lessonOverlap(lessons, newStartStr, newEndStr);
  if (aiConflict || lessonConflict) {
    const kind = aiConflict ? "ai_item" : "les";
    const what = aiConflict ?? lessonConflict ?? "";
    const suggestions = await suggestSlots(ns, lessons, 0, 3);
    throw new PlanGuardrailError(
      `Overlap met ${kind} '${what}'.`,
      { type: kind, id: what },
      suggestions,
      lessonsChecked,
    );
  }
  item.start = newStartStr;
  item.end = newEndStr;
  item.updated_at = webNowIso();
  await webSaveAll(items);
  recordMutation("move_ai_schedule_item", id, before, { ...item });
  return { ...item };
}

/**
 * Free slots for a date or range (Phase 7 item 2). Web only.
 * `lessonsChecked` mirrors the desktop best-effort flag.
 */
export async function getFreeSlots(
  dateStr: string,
  endStr: string | null,
  minMinutes: number,
  lessons: PlanLesson[],
  lessonsChecked: boolean,
): Promise<{
  slots: FreeSlotJson[];
  count: number;
  total: number;
  truncated: boolean;
  lessons_checked: boolean;
}> {
  if (!isWeb()) throw new Error("getFreeSlots is alleen beschikbaar op web.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Ongeldige datum '${dateStr}' (verwacht yyyy-MM-dd).`);
  }
  const end = endStr || dateStr;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error(`Ongeldige einddatum '${end}' (verwacht yyyy-MM-dd).`);
  }
  if (end < dateStr)
    throw new Error("Einddatum ligt voor startdatum. Wissel ze om.");
  const startMs = isoToWall(`${dateStr}T00:00:00`);
  const endMs = isoToWall(`${end}T23:59:59`);
  if (startMs == null || endMs == null) throw new Error("Ongeldige datum.");
  const settings = toPlannerSettings(getPlanSettings());
  const items = await loadScheduleItems();
  const locked = lockedInRange(items, startMs, endMs);
  const all = computeFreeSlots(
    dayKey(startMs),
    dayKey(endMs),
    lessons,
    locked,
    settings,
  )
    .filter((s) => s.end - s.start >= Math.max(0, minMinutes) * 60000)
    .map(slotJson);
  const shown = all.slice(0, 60);
  return {
    slots: shown,
    count: shown.length,
    total: all.length,
    truncated: all.length > shown.length,
    lessons_checked: lessonsChecked,
  };
}

/** Undo the last plan mutation (Phase 7 item 5). Web only. */
export async function undoLastAiPlanChange(): Promise<{
  undone: { op: string; item_id: string };
  item: AiScheduleItem | null;
}> {
  if (!isWeb())
    throw new Error("undoLastAiPlanChange is alleen beschikbaar op web.");
  const entry = undoLog.pop();
  if (!entry) throw new Error("Niets om ongedaan te maken.");
  const items = await loadScheduleItems();
  if (!entry.before && entry.after) {
    await webSaveAll(items.filter((i) => i.id !== entry.itemId));
  } else if (entry.before) {
    const idx = items.findIndex((i) => i.id === entry.itemId);
    if (idx >= 0) items[idx] = entry.before;
    else items.push(entry.before);
    await webSaveAll(items);
  }
  return {
    undone: { op: entry.op, item_id: entry.itemId },
    item: entry.before,
  };
}
