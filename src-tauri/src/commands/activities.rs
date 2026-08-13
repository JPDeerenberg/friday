use crate::client::SharedClient;
use crate::models::activities::{
    ActivitiesResponse, Activity, ActivityElement, ActivityElementsResponse,
};
use tauri::State;

#[tauri::command]
pub async fn get_activities(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<Activity>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let url = format!("personen/{}/activiteiten", person_id);
    let response = crate::client::get_with_context(&ctx, &url).await.map_err(|e| e.to_string())?;
    let activities: ActivitiesResponse = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse activities: {}", e))?;
    Ok(activities.items)
}

#[tauri::command]
pub async fn get_activity_elements(
    client: State<'_, SharedClient>,
    person_id: i64,
    activity_id: i64,
) -> Result<Vec<ActivityElement>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    // The activity elements link looks like "personen/{personId}/activiteiten/{id}/onderdelen"
    let url = format!(
        "personen/{}/activiteiten/{}/onderdelen",
        person_id, activity_id
    );
    let response = crate::client::get_with_context(&ctx, &url).await.map_err(|e| e.to_string())?;
    let elements: ActivityElementsResponse = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse activity elements: {}", e))?;
    Ok(elements.items)
}
