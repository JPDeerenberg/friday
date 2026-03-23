use crate::client::SharedClient;
use crate::models::leermiddelen::{Leermiddel, LeermiddelenResponse};
use tauri::State;

#[tauri::command]
pub async fn get_leermiddelen(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<Leermiddel>, String> {
    let mut client = client.lock().await;
    let url = format!("personen/{}/lesmateriaal", person_id);
    println!("Fetching leermiddelen from: {}", url);

    let response = client.get(&url).await.map_err(|e| e.to_string())?;
    let leermiddelen: LeermiddelenResponse = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse leermiddelen: {}", e))?;

    println!("Found {} leermiddelen", leermiddelen.items.len());
    Ok(leermiddelen.items)
}
