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
  planningWindow,
  wallNow,
  type AssignmentInput,
  type PlanItem,
  type PlanLesson,
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

export async function getAiSchedule(start: string, end: string): Promise<AiScheduleItem[]> {
  if (isWeb()) {
    const s = isoToWall(start);
    const e = isoToWall(end);
    if (s == null || e == null) throw new Error("Ongeldige datum");
    return (await loadScheduleItems()).filter((item) => inRange(item, s, e));
  }
  return invoke("get_ai_schedule", { start, end });
}

export async function createAiScheduleItem(item: AiScheduleItem): Promise<AiScheduleItem> {
  if (isWeb()) return webCreateItem(item);
  return invoke("create_ai_schedule_item", { item });
}

async function webSaveAll(items: AiScheduleItem[]): Promise<void> {
  await saveScheduleItems(items);
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
    completed_at: item.status === "completed" ? (item.completed_at ?? now) : item.completed_at,
  };
  validateScheduleItem(fresh);
  const items = await loadScheduleItems();
  // Idempotent: same id exists -> return existing (double-click safe).
  const existing = items.find((i) => i.id === fresh.id);
  if (existing) return existing;
  // Same assignment/event link at overlapping time -> return it.
  if (fresh.related_assignment_id != null || fresh.related_calendar_event_id != null) {
    for (const it of items) {
      const sameAssign =
        fresh.related_assignment_id != null && it.related_assignment_id === fresh.related_assignment_id;
      const sameCal =
        fresh.related_calendar_event_id != null &&
        it.related_calendar_event_id === fresh.related_calendar_event_id;
      if ((sameAssign || sameCal) && it.status !== "dismissed") {
        if (intervalsOverlapStr(fresh.start, fresh.end, it.start, it.end)) return it;
      }
    }
  }
  const conflict = findScheduleOverlap(items, fresh.start, fresh.end, null);
  if (conflict) {
    throw new Error(`Overlap: er staat al '${conflict}' gepland op dit tijdstip. Kies een ander tijdstip.`);
  }
  items.push(fresh);
  await webSaveAll(items);
  return fresh;
}

export async function updateAiScheduleItem(item: AiScheduleItem): Promise<AiScheduleItem> {
  if (isWeb()) {
    validateScheduleItem(item);
    const items = await loadScheduleItems();
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx < 0) throw new Error(`Item '${item.id}' niet gevonden.`);
    const conflict = findScheduleOverlap(items, item.start, item.end, item.id);
    if (conflict) {
      throw new Error(`Overlap: er staat al '${conflict}' gepland op dit tijdstip. Kies een ander tijdstip.`);
    }
    const updated: AiScheduleItem = { ...item, updated_at: webNowIso() };
    if (updated.status === "completed" && !updated.completed_at) updated.completed_at = updated.updated_at;
    if (updated.status !== "completed") updated.completed_at = null;
    // Manual edits promote AiChat -> User: the next Update treats the item
    // as a fixed constraint instead of silently rearranging it.
    if (updated.source === "ai_chat") updated.source = "user";
    items[idx] = updated;
    await webSaveAll(items);
    return updated;
  }
  return invoke("update_ai_schedule_item", { item });
}

export async function deleteAiScheduleItem(id: string): Promise<void> {
  if (isWeb()) {
    const items = await loadScheduleItems();
    if (!items.some((i) => i.id === id)) throw new Error(`Item '${id}' niet gevonden.`);
    await webSaveAll(items.filter((i) => i.id !== id));
    return;
  }
  return invoke("delete_ai_schedule_item", { id });
}

export async function completeAiScheduleItem(id: string): Promise<void> {
  if (isWeb()) {
    const items = await loadScheduleItems();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`Item '${id}' niet gevonden.`);
    item.status = "completed";
    const now = webNowIso();
    item.completed_at = now;
    item.updated_at = now;
    await webSaveAll(items);
    return;
  }
  return invoke("complete_ai_schedule_item", { id });
}

export async function dismissAiScheduleItem(id: string): Promise<void> {
  if (isWeb()) {
    const items = await loadScheduleItems();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`Item '${id}' niet gevonden.`);
    item.status = "dismissed";
    item.updated_at = webNowIso();
    await webSaveAll(items);
    return;
  }
  return invoke("dismiss_ai_schedule_item", { id });
}

export async function getMergedSchedule(start: string, end: string, personId: number): Promise<MergedSchedule> {
  if (isWeb()) {
    const s = isoToWall(start);
    const e = isoToWall(end);
    if (s == null || e == null) throw new Error("Ongeldige datum");
    const ai_items = (await loadScheduleItems()).filter((item) => inRange(item, s, e));
    // Magister events best-effort: never fail the whole merged view.
    let magister_events: MergedSchedule["magister_events"] = [];
    try {
      const tokens = await loadWebSession();
      if (tokens) {
        const data = await sessionTierA().magister<{ Items?: unknown[]; items?: unknown[] }>(
          tokens,
          "GET",
          `personen/${personId}/afspraken?tot=${end.slice(0, 10)}&van=${start.slice(0, 10)}`,
        );
        magister_events = (data.Items ?? data.items ?? []) as MergedSchedule["magister_events"];
      }
    } catch (err) {
      console.warn("getMergedSchedule: Magister fetch failed, showing AI items only", err);
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

export async function updateAiSchedule(settings?: AiScheduleSettingsInput): Promise<AiScheduleItem[]> {
  if (isWeb()) return webPerformUpdate(settings);
  return invoke("update_ai_schedule", {
    bedtime: settings?.bedtime ?? null,
    wakeTime: settings?.wakeTime ?? null,
    blockedTimes: settings?.blockedTimes ?? null,
    afterSchoolBufferMin: settings?.afterSchoolBufferMin ?? null,
    planInSchoolGaps: settings?.planInSchoolGaps ?? null,
  });
}

async function webPerformUpdate(settings?: AiScheduleSettingsInput): Promise<AiScheduleItem[]> {
  const stored = loadSettings().aiSchedule;
  const planSettings = {
    bedtime: settings?.bedtime ?? stored.bedtime,
    wakeTime: settings?.wakeTime ?? stored.wakeTime,
    blockedTimes: settings?.blockedTimes ?? stored.blockedTimes,
    afterSchoolBufferMin: settings?.afterSchoolBufferMin ?? stored.afterSchoolBufferMin,
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
  const windowEndStr = fmtYMD(windowEndDay * 86_400_000);

  const existingItems = await loadScheduleItems();
  const be = sessionTierA();

  // Lessons in window; assignments broad (2013 → +365d) then filtered
  // locally — a narrow query misses assignments created outside the window
  // whose deadline falls inside it.
  let lessons: PlanLesson[] = [];
  try {
    const data = await be.magister<{ Items?: unknown[]; items?: unknown[] }>(
      tokens,
      "GET",
      `personen/${personId}/afspraken?tot=${windowEndStr}&van=${windowStartStr}`,
    );
    lessons = ((data.Items ?? data.items ?? []) as Array<Record<string, unknown>>).map((ev) => ({
      id: (ev["Id"] as number) ?? 0,
      start: (ev["Start"] as string) ?? "",
      einde: (ev["Einde"] as string) ?? "",
      status: (ev["Status"] as number) ?? 0,
      info_type: (ev["InfoType"] as number) ?? 0,
      afgerond: (ev["Afgerond"] as boolean) ?? false,
      omschrijving: (ev["Omschrijving"] as string | null) ?? null,
      inhoud: (ev["Inhoud"] as string | null) ?? null,
      vakken: Array.isArray(ev["Vakken"])
        ? (ev["Vakken"] as Array<Record<string, unknown>>).map((v) => ({ naam: (v["Naam"] as string | undefined) ?? null }))
        : null,
    }));
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
      if (item.item_type === "free_time" || item.item_type === "sleep") return false;
      if (item.status === "completed" || item.status === "dismissed") return true;
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
        durationMap.set(item.related_assignment_id, { minutes: item.estimated_minutes, source: src });
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
    const inleveren = (r["InleverenVoor"] ?? r["inleveren_voor"] ?? "") as string;
    if (!inleveren) continue;
    const afgesloten = (r["Afgesloten"] ?? r["afgesloten"] ?? false) as boolean;
    if (afgesloten) continue;
    const titelRaw = r["Titel"] ?? r["titel"] ?? r["title"];
    assignmentInputs.push({
      id,
      titel: typeof titelRaw === "string" && titelRaw ? titelRaw : "Opdracht",
      vak: ((r["Vak"] ?? r["vak"]) as string | undefined) ?? null,
      inleveren_voor: inleveren,
      omschrijving: ((r["Omschrijving"] ?? r["omschrijving"]) as string | undefined) ?? null,
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
    const inWindow = s != null && e != null && dayKey(e) >= windowStartDay && dayKey(s) <= windowEndDay;
    if (!inWindow) return true;
    if (lockedIds.has(item.id)) return true;
    if (item.item_type === "free_time" || item.item_type === "sleep") return false;
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
      const sameAssign = p.related_assignment_id != null && i.related_assignment_id === p.related_assignment_id;
      const sameCal =
        p.related_calendar_event_id != null && i.related_calendar_event_id === p.related_calendar_event_id;
      return (
        (sameAssign || sameCal) && intervalsOverlapStr(p.start, p.end, i.start, i.end)
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
    return s != null && e != null && dayKey(e) >= windowStartDay && dayKey(s) <= windowEndDay;
  });
}

export async function setHomeworkDuration(
  assignmentId: number,
  estimatedMinutes: number,
  urgency?: number,
): Promise<AiScheduleItem> {
  if (isWeb()) {
    if (!estimatedMinutes || estimatedMinutes > 600) throw new Error("Ongeldige duur (1-600 minuten).");
    if (urgency !== undefined && !(urgency >= 1 && urgency <= 5)) throw new Error("Urgency moet 1-5 zijn.");
    const items = await loadScheduleItems();
    const now = webNowIso();
    const found = items.find((i) => i.related_assignment_id === assignmentId);
    if (found) {
      found.estimated_minutes = estimatedMinutes;
      found.duration_source = "user_entered";
      if (urgency !== undefined) found.urgency = urgency;
      found.updated_at = now;
      await webSaveAll(items);
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
