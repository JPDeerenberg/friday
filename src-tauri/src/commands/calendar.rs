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

#[tauri::command]
pub async fn download_file(
    client: State<'_, SharedClient>,
    url: String,
    filename: String,
    download_dir: Option<String>,
) -> Result<String, String> {
    use std::io::Write;
    let mut c = client.lock().await;

    // Use provided download directory, or fall back to system default
    let download_dir = if let Some(ref dir) = download_dir {
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
    };

    if !download_dir.exists() {
        std::fs::create_dir_all(&download_dir).map_err(|e| e.to_string())?;
    }

    let save_path = download_dir.join(&filename);

    // Fetch the file
    let url = url.replace("/api/", "");
    let bytes = c.get_bytes(&url).await.map_err(|e: crate::client::ClientError| e.to_string())?
        .ok_or_else(|| "File not found".to_string())?;
    
    let mut file = std::fs::File::create(&save_path).map_err(|e: std::io::Error| e.to_string())?;
    file.write_all(&bytes).map_err(|e: std::io::Error| e.to_string())?;

    Ok(save_path.to_string_lossy().to_string())
}

