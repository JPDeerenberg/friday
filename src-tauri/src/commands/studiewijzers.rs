use crate::client::SharedClient;
use crate::models::studiewijzers::{Studiewijzer, StudiewijzersResponse, StudiewijzerDetail, StudiewijzerOnderdeelDetail};
use tauri::State;

#[tauri::command]
pub async fn get_studiewijzers(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<Studiewijzer>, String> {
    let mut client = client.lock().await;
    let now = chrono::Local::now().format("%Y-%m-%d").to_string();
    let sw_url = format!("leerlingen/{}/studiewijzers?peildatum={}", person_id, now);
    let proj_url = format!("leerlingen/{}/projecten?peildatum={}", person_id, now);
    
    let sw_response = client.get(&sw_url).await.map_err(|e| e.to_string())?;
    let proj_response = client.get(&proj_url).await.map_err(|e| e.to_string())?;
    
    let mut all_items = Vec::new();
    
    if let Ok(sws) = serde_json::from_value::<StudiewijzersResponse>(sw_response) {
        all_items.extend(sws.items);
    }
    
    if let Ok(projs) = serde_json::from_value::<StudiewijzersResponse>(proj_response) {
        all_items.extend(projs.items);
    }
    
    Ok(all_items)
}

#[tauri::command]
pub async fn get_studiewijzer_detail(
    client: State<'_, SharedClient>,
    person_id: i64,
    id: i64,
    is_project: bool,
) -> Result<StudiewijzerDetail, String> {
    let mut client = client.lock().await;
    let base = if is_project { "projecten" } else { "studiewijzers" };
    let url = format!("leerlingen/{}/{}/{}", person_id, base, id);
    let response = client.get(&url).await.map_err(|e| e.to_string())?;
    let detail: StudiewijzerDetail = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse studiewijzer detail: {}", e))?;
    Ok(detail)
}

#[tauri::command]
pub async fn get_studiewijzer_onderdeel_detail(
    client: State<'_, SharedClient>,
    person_id: i64,
    sw_id: i64,
    onderdeel_id: i64,
    is_project: bool,
) -> Result<StudiewijzerOnderdeelDetail, String> {
    let mut client = client.lock().await;
    let base = if is_project { "projecten" } else { "studiewijzers" };
    let url = format!("leerlingen/{}/{}/{}/onderdelen/{}?gebruikMappenStructuur=true", person_id, base, sw_id, onderdeel_id);
    let response = client.get(&url).await.map_err(|e| e.to_string())?;
    let detail: StudiewijzerOnderdeelDetail = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse onderdeel detail: {}", e))?;
    Ok(detail)
}
