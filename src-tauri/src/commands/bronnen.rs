use crate::client::SharedClient;
use crate::models::bronnen::{
    Bron, BronnenResponse, ExternalBronSource, ExternalBronSourcesResponse,
};
use tauri::State;

#[tauri::command]
pub async fn get_bronnen(
    client: State<'_, SharedClient>,
    path: String,
) -> Result<Vec<Bron>, String> {
    let mut client = client.lock().await;
    // path should be something like "personen/{id}/bronnen?soort=0" or a link from a folder
    let response = client.get(&path).await.map_err(|e| e.to_string())?;
    let bronnen: BronnenResponse =
        serde_json::from_value(response).map_err(|e| format!("Failed to parse bronnen: {}", e))?;
    Ok(bronnen.items)
}

#[tauri::command]
pub async fn get_external_bron_sources(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<ExternalBronSource>, String> {
    let mut client = client.lock().await;
    let url = format!("personen/{}/bronnen?soort=0", person_id);
    let response = client.get(&url).await.map_err(|e| e.to_string())?;
    let sources: ExternalBronSourcesResponse = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse external bron sources: {}", e))?;
    Ok(sources.items)
}
