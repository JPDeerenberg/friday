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
    let url = format!("personen/{}/activiteiten", person_id);
    let response = crate::client::get_with_shared(&client, &url).await.map_err(|e| e.to_string())?;
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
    // The activity elements link looks like "personen/{personId}/activiteiten/{id}/onderdelen"
    let url = format!(
        "personen/{}/activiteiten/{}/onderdelen",
        person_id, activity_id
    );
    let response = crate::client::get_with_shared(&client, &url).await.map_err(|e| e.to_string())?;
    let elements: ActivityElementsResponse = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse activity elements: {}", e))?;
    Ok(elements.items)
}

/// Magister gives absolute-from-root links ("/api/personen/…"); the client wants
/// the path after the API root.
fn api_relative(url: &str) -> String {
    url.trim().replace("/api/", "")
}

/// Body of a sign-up (same fields Discipulus sends).
fn subscribe_body(person_id: i64, activity_id: i64, element_id: i64) -> serde_json::Value {
    serde_json::json!({
        "persoonId": person_id,
        "activiteitId": activity_id,
        "onderdeelId": element_id,
    })
}

/// Sign up for one element of an activity. `subscriptions_url` is the element's
/// `Subscriptions` link.
#[tauri::command]
pub async fn subscribe_activity_element(
    client: State<'_, SharedClient>,
    person_id: i64,
    activity_id: i64,
    element_id: i64,
    subscriptions_url: String,
) -> Result<(), String> {
    let path = api_relative(&subscriptions_url);
    if path.is_empty() {
        return Err("Geen inschrijf-link gevonden voor dit onderdeel.".to_string());
    }
    let mut c = client.lock().await;
    c.post(&path, &subscribe_body(person_id, activity_id, element_id))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a sign-up: DELETE on the same `Subscriptions` link.
#[tauri::command]
pub async fn unsubscribe_activity_element(
    client: State<'_, SharedClient>,
    subscriptions_url: String,
) -> Result<(), String> {
    let path = api_relative(&subscriptions_url);
    if path.is_empty() {
        return Err("Geen inschrijf-link gevonden voor dit onderdeel.".to_string());
    }
    let mut c = client.lock().await;
    c.delete(&path).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_relative_strips_the_api_root() {
        assert_eq!(
            api_relative("/api/personen/1/activiteiten/2/onderdelen/3/inschrijvingen"),
            "personen/1/activiteiten/2/onderdelen/3/inschrijvingen"
        );
        assert_eq!(api_relative("  personen/1/x "), "personen/1/x");
        assert_eq!(api_relative(""), "");
    }

    #[test]
    fn subscribe_body_uses_the_field_names_magister_expects() {
        assert_eq!(
            subscribe_body(10, 20, 30),
            serde_json::json!({ "persoonId": 10, "activiteitId": 20, "onderdeelId": 30 })
        );
    }
}
