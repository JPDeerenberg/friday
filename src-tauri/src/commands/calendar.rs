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
    let mut c = client.lock().await;

    // Fetch events and absences concurrently
    let start_date = if start.len() >= 10 { &start[0..10] } else { &start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { &end };

    let events_data = c
        .get(&format!(
            "personen/{person_id}/afspraken?tot={end_date}&van={start_date}"
        ))
        .await
        .map_err(|e| e.to_string())?;

    let absences_data = c
        .get(&format!(
            "personen/{person_id}/absenties?tot={end_date}&van={start_date}"
        ))
        .await
        .map_err(|e| e.to_string())?;

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
    let mut c = client.lock().await;
    let data = c
        .get(&format!("personen/{person_id}/afspraken/{event_id}"))
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
    let mut client = client.lock().await;

    let start_date = if van.len() >= 10 { &van[0..10] } else { &van };
    let end_date = if tot.len() >= 10 { &tot[0..10] } else { &tot };

    let url = format!("personen/{}/absenties?van={}&tot={}", person_id, start_date, end_date);
    println!("Fetching absences from: {}", url);
    let response = client.get(&url).await.map_err(|e| e.to_string())?;

    let res: crate::models::calendar::AbsencesResponse = serde_json::from_value(response.clone())
        .map_err(|e| {
        println!("Failed to parse absences. Response: {:?}", response);
        format!("Failed to parse absences: {}", e)
    })?;
    Ok(res.items)
}
