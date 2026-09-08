import { invoke } from "@tauri-apps/api/core";
import type { AiScheduleItem, MergedSchedule } from "$lib/ai-schedule-types";

// === AI Schedule ===

export async function getAiSchedule(start: string, end: string): Promise<AiScheduleItem[]> {
  return invoke("get_ai_schedule", { start, end });
}

export async function createAiScheduleItem(item: AiScheduleItem): Promise<AiScheduleItem> {
  return invoke("create_ai_schedule_item", { item });
}

export async function updateAiScheduleItem(item: AiScheduleItem): Promise<AiScheduleItem> {
  return invoke("update_ai_schedule_item", { item });
}

export async function deleteAiScheduleItem(id: string): Promise<void> {
  return invoke("delete_ai_schedule_item", { id });
}

export async function completeAiScheduleItem(id: string): Promise<void> {
  return invoke("complete_ai_schedule_item", { id });
}

export async function dismissAiScheduleItem(id: string): Promise<void> {
  return invoke("dismiss_ai_schedule_item", { id });
}

export async function getMergedSchedule(start: string, end: string, personId: number): Promise<MergedSchedule> {
  return invoke("get_merged_schedule", { start, end, personId });
}

export interface AiScheduleSettingsInput {
  bedtime: string;
  wakeTime: string;
  blockedTimes: { day: string; start: string; end: string }[];
}

export async function updateAiSchedule(settings?: AiScheduleSettingsInput): Promise<AiScheduleItem[]> {
  return invoke("update_ai_schedule", {
    bedtime: settings?.bedtime ?? null,
    wakeTime: settings?.wakeTime ?? null,
    blockedTimes: settings?.blockedTimes ?? null,
  });
}

export async function setHomeworkDuration(
  assignmentId: number,
  estimatedMinutes: number,
  urgency?: number,
): Promise<AiScheduleItem> {
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
