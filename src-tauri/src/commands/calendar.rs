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
    // Fetch events and absences concurrently
    let start_date = if start.len() >= 10 { &start[0..10] } else { &start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { &end };

    let events_url = format!("personen/{person_id}/afspraken?tot={end_date}&van={start_date}");
    let absences_url = format!("personen/{person_id}/absenties?tot={end_date}&van={start_date}");

    // Each fetch snapshots its own context (short lock) and refreshes +
    // retries once on a stale-token 401, so the two stay parallel without
    // sharing one potentially-stale token.
    let (events_data, absences_data) = tokio::try_join!(
        crate::client::get_with_shared(&client, &events_url),
        crate::client::get_with_shared(&client, &absences_url)
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
    let data = crate::client::get_with_shared(&client, &format!("personen/{person_id}/afspraken/{event_id}"))
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

    // Magister validates Inhoud ↔ InfoType coherence: InfoType 0 (Geen) is
    // invalid when Inhoud is non-empty (400 "ongeldig infotype"). Live-probed
    // 2026-09: for a Type 1 (personal) appointment with Inhoud, ONLY InfoType
    // 6 (Informatie) is accepted — 1-5, 7 (Notitie) and even 0 all 400.
    // Without Inhoud, 0. This also keeps personal appointments out of the
    // homework flows (they key off InfoType 1).
    let inhoud = inhoud.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let lokatie = lokatie.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let info_type = if inhoud.is_some() { 6 } else { 0 };

    let body = serde_json::to_value(CreateCalendarEvent {
        start,
        einde,
        duurt_hele_dag,
        omschrijving: omschrijving.trim().to_string(),
        lokatie,
        inhoud,
        event_type: event_type.unwrap_or(1),
        status: 2, // manually scheduled
        info_type,
    })
    .map_err(|e| e.to_string())?;
    log::debug!("Creating calendar event: {}", body);

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
    let start_date = if van.len() >= 10 { &van[0..10] } else { &van };
    let end_date = if tot.len() >= 10 { &tot[0..10] } else { &tot };

    let url = format!("personen/{}/absenties?van={}&tot={}", person_id, start_date, end_date);
    log::debug!("Fetching absences from: {}", url);
    let response = crate::client::get_with_shared(&client, &url).await.map_err(|e| e.to_string())?;

    let res: crate::models::calendar::AbsencesResponse = serde_json::from_value(response.clone())
        .map_err(|e| {
        log::error!("Failed to parse absences. Response: {:?}", response);
        format!("Failed to parse absences: {}", e)
    })?;
    Ok(res.items)
}

/// What `download_file` tells the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadResult {
    /// Where the file was written by this command (desktop: the final file; Android:
    /// the private staging copy, which is moved to a user-reachable place afterwards).
    pub path: String,
    /// Human-readable place the user can find the file, e.g. `Download/Friday`.
    pub location: String,
    /// An app/chooser to view the file was launched (Android).
    pub opened: bool,
}

/// Download an attachment to disk. Magister's `Self`/`Contents`/`download`
/// links are *indirection* links, not the file bytes — resolve them to a real,
/// short-lived content URL first (same two-call sequence as
/// `get_leermiddel_launch_url`), then fetch the bytes from that URL.
///
/// Desktop: saved in the chosen download folder (or the system Downloads).
/// Android: saved in the folder picked under Settings > Downloadmap (or
/// `Download/Friday`) and offered to the user in an "Open bestand" chooser.
#[tauri::command]
pub async fn download_file(
    client: State<'_, SharedClient>,
    app: tauri::AppHandle,
    url: String,
    filename: String,
    download_dir: Option<String>,
) -> Result<DownloadResult, String> {
    use std::io::Write;
    let mut c = client.lock().await;

    #[cfg(desktop)]
    let _ = &app;

    // Attachment names come from the server: never trust them as a path.
    let filename = crate::commands::files::safe_file_name(&filename, "bijlage");

    // Resolve the indirection link to the real content URL before fetching bytes.
    let url = url.replace("/api/", "");
    let resolved = c
        .get_redirect_location(&url)
        .await
        .map_err(|e: crate::client::ClientError| format!("Failed to resolve download link: {}", e))?;

    // The resolved URL is usually a pre-signed storage URL: no bearer token there
    // (see `get_resolved_bytes`).
    let bytes = c
        .get_resolved_bytes(&resolved)
        .await
        .map_err(|e: crate::client::ClientError| format!("Download mislukt: {}", e))?;

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
    drop(file);

    // Hand the file to the OS: save it where the user can find it (the folder from
    // Settings, or Download/Friday) and show an "Open bestand" chooser. A failure here
    // is reported instead of swallowed — before, the user just saw nothing happen.
    #[cfg(target_os = "android")]
    {
        let tree = crate::commands::files::android_tree_uri(download_dir.as_deref());
        let outcome = crate::jni::share_downloaded_file(&save_path, tree)
            .map_err(|e| format!("Kon het bestand niet opslaan of openen: {}", e))?;
        return Ok(DownloadResult {
            path: save_path.to_string_lossy().to_string(),
            location: outcome.location,
            opened: outcome.opened,
        });
    }

    #[cfg(not(target_os = "android"))]
    {
        let path = save_path.to_string_lossy().to_string();
        Ok(DownloadResult {
            location: path.clone(),
            path,
            opened: false,
        })
    }
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
            .get_resolved_bytes(&resolved)
            .await
            .expect("should fetch bytes from the resolved URL");
        assert_eq!(bytes, b"%PDF-1.4 real content".to_vec());
    }

    /// Regression: the resolved URL is normally a pre-signed Azure Blob URL. Sending
    /// the Magister bearer token there made Azure answer
    /// `401 InvalidAuthenticationInfo: Signature key not found`. On a foreign host the
    /// file must be fetched with no Authorization header at all.
    #[tokio::test]
    async fn test_resolved_download_sends_no_token_to_a_foreign_host() {
        use wiremock::matchers::header_exists;
        let storage = MockServer::start().await;

        // Any request carrying an Authorization header is rejected like Azure does...
        Mock::given(method("GET"))
            .and(path("/blob/file.pdf"))
            .and(header_exists("Authorization"))
            .respond_with(ResponseTemplate::new(401).set_body_string(
                "<Error><Code>InvalidAuthenticationInfo</Code></Error>",
            ))
            .with_priority(1)
            .mount(&storage)
            .await;
        // ...and one without it gets the file.
        Mock::given(method("GET"))
            .and(path("/blob/file.pdf"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"%PDF real".to_vec()))
            .with_priority(5)
            .mount(&storage)
            .await;

        let mut client = MagisterClient::new();
        // The Magister API lives elsewhere than the storage server.
        client.token_set = Some(token_set("https://school.magister.net/api"));

        let bytes = client
            .get_resolved_bytes(&format!("{}/blob/file.pdf?sig=abc", storage.uri()))
            .await
            .expect("foreign host must be fetched without a bearer token");
        assert_eq!(bytes, b"%PDF real".to_vec());
    }

    /// When Magister itself serves the file, the token is still sent.
    #[tokio::test]
    async fn test_resolved_download_keeps_the_token_on_the_magister_host() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/contents/file"))
            .and(header("Authorization", "Bearer mock_access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"own host".to_vec()))
            .mount(&server)
            .await;

        let mut client = MagisterClient::new();
        client.token_set = Some(token_set(&server.uri()));
        let bytes = client
            .get_resolved_bytes(&format!("{}/contents/file", server.uri()))
            .await
            .expect("same-host download keeps the bearer token");
        assert_eq!(bytes, b"own host".to_vec());
    }

    #[tokio::test]
    async fn test_resolved_download_reports_http_errors() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gone"))
            .respond_with(ResponseTemplate::new(404).set_body_string("nope"))
            .mount(&server)
            .await;
        let mut client = MagisterClient::new();
        client.token_set = Some(token_set(&server.uri()));
        let err = client
            .get_resolved_bytes(&format!("{}/gone", server.uri()))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("404"), "got: {err}");
    }
}

