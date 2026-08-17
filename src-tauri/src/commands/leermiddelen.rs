use crate::client::SharedClient;
use crate::models::leermiddelen::{Leermiddel, LeermiddelenResponse};
use tauri::State;

#[tauri::command]
pub async fn get_leermiddelen(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<Leermiddel>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let url = format!("personen/{}/lesmateriaal", person_id);
    log::debug!("Fetching leermiddelen from: {}", url);

    let response = crate::client::get_with_context(&ctx, &url).await.map_err(|e| e.to_string())?;
    let leermiddelen: LeermiddelenResponse = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse leermiddelen: {}", e))?;

    log::debug!("Found {} leermiddelen", leermiddelen.items.len());
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

    log::debug!("Fetching launch URL for material. Path: {}", path);

    let location = client.get_redirect_location(&path).await.map_err(|e| {
        let err_msg = format!("Failed to fetch launch URL from Magister: {}", e);
        log::error!("{}", err_msg);
        err_msg
    })?;

    log::debug!("Successfully obtained launch URL: {}", location);
    Ok(location)
}
