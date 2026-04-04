use tauri::State;

use crate::client::SharedClient;
use crate::models::assignments::{Assignment, AssignmentsResponse, UploadedFile};

/// Get assignments for a date range.
#[tauri::command]
pub async fn get_assignments(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: String, // yyyy-MM-dd
    end: String,   // yyyy-MM-dd
) -> Result<Vec<Assignment>, String> {
    let mut c = client.lock().await;

    let start_date = if start.len() >= 10 { &start[0..10] } else { &start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { &end };

    let url = format!("personen/{person_id}/opdrachten?van={start_date}&tot={end_date}");

    let data = c
        .get(&url)
        .await
        .map_err(|e| e.to_string())?;

    let resp: AssignmentsResponse = serde_json::from_value(data).map_err(|e| e.to_string())?;

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

    let body: serde_json::Value = serde_json::from_str(&version_json).map_err(|e| e.to_string())?;

    c.post(&format!("{url}?opdrachtId={opdracht_id}"), &body)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Upload an attachment to Magister for an assignment.
/// Returns (id, storage_id)
#[tauri::command]
pub async fn upload_assignment_attachment(
    client: State<'_, SharedClient>,
    file_path: String,
) -> Result<(i64, String), String> {
    use mime_guess::from_path;
    use std::path::Path;

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid filename")?;

    let mime_type = from_path(path).first_or_octet_stream().to_string();

    let mut c = client.lock().await;

    // Step 1: Request upload slot
    let upload_info_data = c
        .post(
            "bestanden/upload",
            &serde_json::json!({
                "name": file_name
            }),
        )
        .await
        .map_err(|e| e.to_string())?;

    let upload_info: UploadedFile =
        serde_json::from_value(upload_info_data).map_err(|e| e.to_string())?;

    // Step 2: Perform OPTIONS request (as seen in Discipulus, though might be optional)
    // We use reqwest directly here as we have the URI and it might need special headers
    let api_host = {
        let ts = c.token_set.as_ref().ok_or("Not authenticated")?;
        let url = url::Url::parse(&ts.api_endpoint).map_err(|e| e.to_string())?;
        url.host_str().unwrap_or_default().to_string()
    };

    let _options_resp = c
        .http
        .request(reqwest::Method::OPTIONS, &upload_info.uri)
        .header("Origin", &api_host)
        .header("Referer", &api_host)
        .header("Access-Control-Request-Method", "PUT")
        .header(
            "Access-Control-Request-Headers",
            "x-ms-blob-content-type,x-ms-blob-type",
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // Step 3: PUT the file content
    let file_bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    let put_resp = c
        .http
        .put(&upload_info.uri)
        .header("x-ms-blob-content-type", &mime_type)
        .header("x-ms-blob-type", "BlockBlob")
        .body(file_bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !put_resp.status().is_success() {
        return Err(format!("Upload failed with status: {}", put_resp.status()));
    }

    Ok((upload_info.id, upload_info.storage_id))
}
