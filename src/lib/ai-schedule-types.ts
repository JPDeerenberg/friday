// TypeScript mirrors of `src-tauri/src/models/ai_schedule.rs`
// Field names match Rust serde `snake_case` serialization.

export type AiScheduleItemType =
  | "assignment_work"
  | "study_block"
  | "homework_review"
  | "custom"
  | "break"
  | "free_time"
  | "sleep";

export type AiScheduleStatus = "planned" | "in_progress" | "completed" | "dismissed";

export type AiScheduleSource = "ai_chat" | "user";

export type DurationSource = "user_entered" | "ai_estimated" | "subject_average";

export interface AiScheduleItem {
  id: string;
  title: string;
  description: string | null;
  item_type: AiScheduleItemType;
  start: string; // ISO 8601, Europe/Amsterdam
  end: string;
  status: AiScheduleStatus;
  urgency: number; // 1-5
  related_assignment_id: number | null;
  related_calendar_event_id: number | null;
  related_subject: string | null;
  estimated_minutes: number | null;
  duration_source: DurationSource | null;
  source: AiScheduleSource;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MergedSchedule {
  magister_events: import("./types").CalendarEvent[];
  ai_items: AiScheduleItem[];
}
