use tauri::State;

use crate::client::SharedClient;
use crate::models::assignments::{Assignment, AssignmentsResponse};

/// Get assignments for a date range.
#[tauri::command]
pub async fn get_assignments(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: String, // yyyy-MM-dd
    end: String,   // yyyy-MM-dd
) -> Result<Vec<Assignment>, String> {
    let mut c = client.lock().await;

    let data = c
        .get(&format!(
            "personen/{person_id}/opdrachten?einddatum={end}&startdatum={start}"
        ))
        .await
        .map_err(|e| e.to_string())?;

    let resp: AssignmentsResponse =
        serde_json::from_value(data).map_err(|e| e.to_string())?;

    Ok(resp.items)
}

/// Get full assignment details (attachments, versions).
#[tauri::command]
pub async fn get_assignment_detail(
    client: State<'_, SharedClient>,
    self_url: String,
) -> Result<Assignment, String> {
    let mut c = client.lock().await;
    let url = self_url.replace("/api/", "");
    let data = c.get(&url).await.map_err(|e| e.to_string())?;
    serde_json::from_value(data).map_err(|e| e.to_string())
}

/// Hand in an assignment version.
#[tauri::command]
pub async fn hand_in_assignment(
    client: State<'_, SharedClient>,
    self_url: String,
    opdracht_id: i64,
    version_json: String,
) -> Result<(), String> {
    let mut c = client.lock().await;
    let url = self_url.replace("/api/", "");

    let body: serde_json::Value =
        serde_json::from_str(&version_json).map_err(|e| e.to_string())?;

    c.post(&format!("{url}?opdrachtId={opdracht_id}"), &body)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
