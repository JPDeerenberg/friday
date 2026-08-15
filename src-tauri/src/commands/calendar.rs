use tauri::State;

use crate::client::SharedClient;
use crate::models::calendar::{
    AbsencesResponse, CalendarEvent, CalendarEventsResponse, CreateCalendarEvent,
};

/// Get calendar events for a date range. Merges events with absences.
#[tauri::command]
pub async fn get_calendar_events(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: String, // yyyy-MM-dd
    end: String,   // yyyy-MM-dd
) -> Result<Vec<CalendarEvent>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };

    // Fetch events and absences concurrently
    let start_date = if start.len() >= 10 { &start[0..10] } else { &start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { &end };

    let events_url = format!("personen/{person_id}/afspraken?tot={end_date}&van={start_date}");
    let absences_url = format!("personen/{person_id}/absenties?tot={end_date}&van={start_date}");

    let (events_data, absences_data) = tokio::try_join!(
        crate::client::get_with_context(&ctx, &events_url),
        crate::client::get_with_context(&ctx, &absences_url)
    ).map_err(|e| e.to_string())?;

    let events_resp: CalendarEventsResponse =
        serde_json::from_value(events_data).map_err(|e| e.to_string())?;
    let absences_resp: AbsencesResponse =
        serde_json::from_value(absences_data).map_err(|e| e.to_string())?;

    // Merge absences into events
    let mut events = events_resp.items;
    for absence in &absences_resp.items {
        if let Some(afspraak) = &absence.afspraak {
            if let Some(event) = events.iter_mut().find(|e| e.id == afspraak.id) {
                event.merged_absence = Some(absence.clone());
            }
        }
    }

    // Extract self URLs from links
    for event in &mut events {
        if let Some(ref links) = event.links {
            event.self_url = links
                .iter()
                .find(|l| l.rel == "Self")
                .map(|l| l.href.replace("/api/", ""));
        }
    }

    Ok(events)
}

/// Get a single calendar event by ID with full details.
#[tauri::command]
pub async fn get_calendar_event(
    client: State<'_, SharedClient>,
    person_id: i64,
    event_id: i64,
) -> Result<CalendarEvent, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let data = crate::client::get_with_context(&ctx, &format!("personen/{person_id}/afspraken/{event_id}"))
        .await
        .map_err(|e| e.to_string())?;

    let mut event: CalendarEvent = serde_json::from_value(data).map_err(|e| e.to_string())?;
    event.self_url = Some(format!("personen/{person_id}/afspraken/{event_id}"));
    Ok(event)
}

/// Create a new personal calendar event.
#[tauri::command]
pub async fn create_calendar_event(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: String,
    einde: String,
    duurt_hele_dag: bool,
    omschrijving: String,
    lokatie: Option<String>,
    inhoud: Option<String>,
    event_type: Option<i32>, // 1 = personal (default), 16 = schedule
) -> Result<(), String> {
    let mut c = client.lock().await;

    let body = serde_json::to_value(CreateCalendarEvent {
        start,
        einde,
        duurt_hele_dag,
        omschrijving,
        lokatie,
        inhoud,
        event_type: event_type.unwrap_or(1),
        status: 2, // manually scheduled
        info_type: 0,
    })
    .map_err(|e| e.to_string())?;

    c.post(&format!("personen/{person_id}/afspraken"), &body)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update an existing calendar event (e.g. mark homework done, change content).
#[tauri::command]
pub async fn update_calendar_event(
    client: State<'_, SharedClient>,
    self_url: String,
    event_json: String,
) -> Result<(), String> {
    let mut c = client.lock().await;
    let body: serde_json::Value = serde_json::from_str(&event_json).map_err(|e| e.to_string())?;

    c.put(&self_url, &body).await.map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete a personal calendar event.
#[tauri::command]
pub async fn delete_calendar_event(
    client: State<'_, SharedClient>,
    self_url: String,
) -> Result<(), String> {
    let mut c = client.lock().await;
    c.delete(&self_url).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_absences(
    client: State<'_, SharedClient>,
    person_id: i64,
    van: String,
    tot: String,
) -> Result<Vec<crate::models::calendar::Absence>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };

    let start_date = if van.len() >= 10 { &van[0..10] } else { &van };
    let end_date = if tot.len() >= 10 { &tot[0..10] } else { &tot };

    let url = format!("personen/{}/absenties?van={}&tot={}", person_id, start_date, end_date);
    println!("Fetching absences from: {}", url);
    let response = crate::client::get_with_context(&ctx, &url).await.map_err(|e| e.to_string())?;

    let res: crate::models::calendar::AbsencesResponse = serde_json::from_value(response.clone())
        .map_err(|e| {
        println!("Failed to parse absences. Response: {:?}", response);
        format!("Failed to parse absences: {}", e)
    })?;
    Ok(res.items)
}

/// Download an attachment to disk. Magister's `Self`/`Contents`/`download`
/// links are *indirection* links, not the file bytes — resolve them to a real,
/// short-lived content URL first (same two-call sequence as
/// `get_leermiddel_launch_url`), then fetch the bytes from that URL.
#[tauri::command]
pub async fn download_file(
    client: State<'_, SharedClient>,
    app: tauri::AppHandle,
    url: String,
    filename: String,
    download_dir: Option<String>,
) -> Result<String, String> {
    use std::io::Write;
    let mut c = client.lock().await;

    #[cfg(desktop)]
    let _ = &app;
    #[cfg(mobile)]
    let _ = &download_dir;

    // Resolve the indirection link to the real content URL before fetching bytes.
    let url = url.replace("/api/", "");
    let resolved = c
        .get_redirect_location(&url)
        .await
        .map_err(|e: crate::client::ClientError| format!("Failed to resolve download link: {}", e))?;

    let bytes = c
        .get_bytes(&resolved)
        .await
        .map_err(|e: crate::client::ClientError| e.to_string())?
        .ok_or_else(|| "File not found".to_string())?;

    // On mobile there is no user-facing Downloads folder (Android scoped storage) —
    // write to an app-private cache path instead; the file is handed to the OS below.
    #[cfg(mobile)]
    let save_dir = {
        use tauri::Manager;
        app.path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("downloads")
    };

    // Desktop keeps the current behaviour: user-selected dir or system Downloads.
    #[cfg(desktop)]
    let save_dir = {
        if let Some(ref dir) = download_dir {
            if !dir.is_empty() {
                std::path::PathBuf::from(dir)
            } else {
                dirs::download_dir()
                    .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
                    .ok_or_else(|| "Could not find downloads directory".to_string())?
            }
        } else {
            dirs::download_dir()
                .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
                .ok_or_else(|| "Could not find downloads directory".to_string())?
        }
    };

    if !save_dir.exists() {
        std::fs::create_dir_all(&save_dir).map_err(|e| e.to_string())?;
    }

    let save_path = save_dir.join(&filename);
    let mut file = std::fs::File::create(&save_path).map_err(|e: std::io::Error| e.to_string())?;
    file.write_all(&bytes).map_err(|e: std::io::Error| e.to_string())?;

    // Hand the file to the OS via the FileProvider so the user sees a share/open
    // sheet instead of it landing in an invisible location.
    #[cfg(target_os = "android")]
    crate::jni::share_downloaded_file(&save_path)
        .map_err(|e| format!("Failed to share downloaded file: {}", e))?;

    Ok(save_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use crate::client::{MagisterClient, TokenSet};
    use chrono::{Duration, Utc};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn token_set(endpoint: &str) -> TokenSet {
        TokenSet {
            access_token: "mock_access_token".to_string(),
            id_token: "mock_id_token".to_string(),
            refresh_token: "mock_refresh_token".to_string(),
            expires_at: Utc::now() + Duration::seconds(3600),
            api_endpoint: endpoint.to_string(),
            person_id: Some(123),
            account_uuid: None,
        }
    }

    /// `download_file` resolves Magister's indirection link to a real content URL
    /// before fetching bytes (same two-call sequence as `get_leermiddel_launch_url`).
    /// Without this resolve step, `get_bytes` on the raw `Self`/`download` link
    /// returns the small JSON `{"location": "..."}` wrapper instead of the file.
    #[tokio::test]
    async fn test_download_resolve_then_fetch() {
        let mock_server = MockServer::start().await;

        // Step 1: the attachment's Self/download link answers with a JSON location.
        Mock::given(method("GET"))
            .and(path("/afspraken/1/bijlagen/2"))
            .and(header("Authorization", "Bearer mock_access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "location": format!("{}/contents/file", mock_server.uri()),
            })))
            .mount(&mock_server)
            .await;

        // Step 2: the resolved content URL returns the real file bytes.
        Mock::given(method("GET"))
            .and(path("/contents/file"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"%PDF-1.4 real content".to_vec()))
            .mount(&mock_server)
            .await;

        let mut client = MagisterClient::new();
        client.token_set = Some(token_set(&mock_server.uri()));

        // The attachment's Self/download link (absolute, no `/api/` prefix — the
        // command's `.replace("/api/", "")` normalization is a no-op here).
        let url = format!("{}/afspraken/1/bijlagen/2", mock_server.uri());

        let resolved = client
            .get_redirect_location(&url)
            .await
            .expect("should resolve the indirection link");
        assert_eq!(resolved, format!("{}/contents/file", mock_server.uri()));

        let bytes = client
            .get_bytes(&resolved)
            .await
            .expect("should fetch bytes from the resolved URL")
            .expect("bytes should be present");
        assert_eq!(bytes, b"%PDF-1.4 real content".to_vec());
    }
}

