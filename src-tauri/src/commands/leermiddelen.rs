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

#[tauri::command]
pub async fn get_leermiddel_launch_url(
    client: State<'_, SharedClient>,
    href: String,
) -> Result<String, String> {
    let mut client = client.lock().await;

    // Ensure path is relative to API root (client.get handles leading slash now)
    let path = if href.starts_with("http") {
        href.clone()
    } else {
        href.trim_start_matches("/api/").to_string()
    };

    println!("Fetching launch URL for material. Path: {}", path);

    let location = client.get_redirect_location(&path).await.map_err(|e| {
        let err_msg = format!("Failed to fetch launch URL from Magister: {}", e);
        println!("{}", err_msg);
        err_msg
    })?;

    println!("Successfully obtained launch URL: {}", location);
    Ok(location)
}
