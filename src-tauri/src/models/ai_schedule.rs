use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiScheduleItemType {
    AssignmentWork,
    StudyBlock,
    HomeworkReview,
    Custom,
    Break,
    FreeTime,
    Sleep,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiScheduleStatus {
    Planned,
    InProgress,
    Completed,
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiScheduleSource {
    AiChat,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DurationSource {
    UserEntered,
    AiEstimated,
    SubjectAverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiScheduleItem {
    pub id: String, // uuid
    pub title: String,
    pub description: Option<String>,
    #[serde(rename = "item_type")]
    pub item_type: AiScheduleItemType,
    pub start: String, // ISO 8601, Europe/Amsterdam
    pub end: String,   // ISO 8601
    pub status: AiScheduleStatus,
    pub urgency: u8, // 1-5
    pub related_assignment_id: Option<i64>,
    pub related_calendar_event_id: Option<i64>,
    pub related_subject: Option<String>,
    pub estimated_minutes: Option<u32>,
    pub duration_source: Option<DurationSource>,
    pub source: AiScheduleSource,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergedSchedule {
    pub magister_events: Vec<crate::models::calendar::CalendarEvent>,
    pub ai_items: Vec<AiScheduleItem>,
}
