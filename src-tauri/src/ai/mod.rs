/// Module for AI-related functionality.
/// Provides tool definitions, provider abstraction, and notification scoring.

pub mod providers;
pub mod tools;

use std::collections::HashMap;
use std::sync::Mutex;

/// A simple in-memory store for notification history.
/// In a production app this would be persisted to disk.
static NOTIFICATION_HISTORY: once_cell::sync::Lazy<Mutex<HashMap<String, u32>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

/// Calculate a relevance score (0-100) for a notification.
///
/// # Arguments
/// * `notification_type` - Type of notification (0=test,1=message,2=calendar,3=grade,4=deadline)
/// * `_course_name` - Optional course/subject name
/// * `deadline_ms` - Milliseconds until deadline (only relevant for deadline type)
/// * `has_been_ignored_before` - Whether similar notifications have been ignored before
///
/// # Returns
/// A score between 0 and 100, where higher means more relevant.
#[allow(dead_code)]
pub fn calculate_relevance_score(
    notification_type: i32,
    _course_name: Option<&str>,
    deadline_ms: Option<i64>,
    has_been_ignored_before: bool,
) -> i32 {
    let mut score: i32 = 50; // base score

    // Adjust based on type
    match notification_type {
        1 => score += 10,  // messages: slightly more important
        3 => score += 20,  // grades: important
        4 => score += 30,  // deadlines: most important
        _ => {}            // test/calendar: keep base
    }

    // Adjust based on deadline proximity
    if let Some(ms) = deadline_ms {
        if ms <= 0 {
            // Past deadline: very important
            score += 40;
        } else if ms <= 3600_000 {
            // Within 1 hour: important
            score += 30;
        } else if ms <= 86400_000 {
            // Within 24 hours: moderately important
            score += 20;
        } else if ms <= 604800_000 {
            // Within 7 days: slightly important
            score += 10;
        }
    }

    // Penalize if similar notifications have been ignored before
    if has_been_ignored_before {
        score -= 20;
    }

    // Clamp to 0-100
    score.clamp(0, 100)
}

/// Record that a notification was ignored (not shown) for future scoring.
#[allow(dead_code)]
pub fn record_ignored_notification(key: &str) {
    if let Ok(mut history) = NOTIFICATION_HISTORY.lock() {
        let count = history.entry(key.to_string()).or_insert(0);
        *count += 1;
    }
}

/// Check if a notification type has been ignored more than a threshold number of times.
#[allow(dead_code)]
pub fn has_been_ignored_before(key: &str, threshold: u32) -> bool {
    if let Ok(history) = NOTIFICATION_HISTORY.lock() {
        if let Some(&count) = history.get(key) {
            return count >= threshold;
        }
    }
    false
}

/// Get the current notification history for debugging.
pub fn get_notification_history() -> HashMap<String, u32> {
    NOTIFICATION_HISTORY.lock()
        .map(|h| h.clone())
        .unwrap_or_default()
}

/// Clear the notification history.
#[allow(dead_code)]
pub fn clear_notification_history() {
    if let Ok(mut history) = NOTIFICATION_HISTORY.lock() {
        history.clear();
    }
}
