use tauri::State;

use crate::client::SharedClient;
use crate::models::grades::{Grade, GradeExtraInfo, GradesResponse};
use crate::models::schoolyears::{Schoolyear, SchoolyearsResponse};

/// Get all schoolyears for a student.
#[tauri::command]
pub async fn get_schoolyears(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: Option<String>, // yyyy-01-01
    end: Option<String>,   // yyyy-01-01
) -> Result<Vec<Schoolyear>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };

    let path = if let (Some(start), Some(end)) = (&start, &end) {
        let start_date = if start.len() >= 10 { &start[0..10] } else { start };
        let end_date = if end.len() >= 10 { &end[0..10] } else { end };
        format!("leerlingen/{person_id}/aanmeldingen?begin={start_date}&einde={end_date}")
    } else {
        format!("leerlingen/{person_id}/aanmeldingen/")
    };

    let data = crate::client::get_with_context(&ctx, &path).await.map_err(|e| e.to_string())?;

    // Handle multiple possible response formats:
    // 1. {"Items": [...]} / {"items": [...]} — paginated wrapper
    // 2. [...] — bare array
    let items: Vec<Schoolyear> = data["Items"].as_array()
        .or_else(|| data["items"].as_array())
        .map(|items| serde_json::from_value(serde_json::to_value(items).unwrap()))
        .or_else(|| data.as_array().map(|arr| {
            serde_json::from_value(serde_json::to_value(arr).unwrap())
        }))
        .unwrap_or_else(|| {
            serde_json::from_value::<SchoolyearsResponse>(data.clone()).map(|r| r.items)
        })
        .map_err(|e| {
            log::error!("Failed to parse schoolyears. Raw data keys: {:?}", data.as_object().map(|o| o.keys().collect::<Vec<_>>()));
            format!("Failed to parse schoolyears: {}", e)
        })?;

    Ok(items)
}

/// Get all grades for a specific schoolyear enrollment.
#[tauri::command]
pub async fn get_grades(
    client: State<'_, SharedClient>,
    person_id: i64,
    schoolyear_id: i64,
    einde: String, // peildatum
) -> Result<Vec<Grade>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };

    // Magister requires YYYY-MM-DD for peildatum. 
    // Passing full ISO string (with T and Z) often causes 500 errors.
    let peildatum = if einde.len() > 10 {
        &einde[0..10]
    } else {
        &einde
    };

    let path = format!(
        "personen/{person_id}/aanmeldingen/{schoolyear_id}/cijfers/\
         cijferoverzichtvooraanmelding?\
         actievePerioden=false\
         &alleenBerekendeKolommen=false\
         &alleenPTAKolommen=false\
         &peildatum={peildatum}"
    );

    let data = crate::client::get_with_context(&ctx, &path).await.map_err(|e| e.to_string())?;

    // Handle multiple possible response formats:
    // 1. {"Items": [...]} / {"items": [...]} — paginated wrapper
    // 2. [...] — bare array
    // 3. {"CijferVakken": [...]} — flat CijferOverzicht structure
    // 4. {"CijferOverzicht": {"CijferVakken": [...]}} — nested CijferOverzicht
    // 5. Other — fallback via GradesResponse struct
    let items: Vec<Grade> = data["Items"].as_array()
        .or_else(|| data["items"].as_array())
        .map(|items| serde_json::from_value(serde_json::to_value(items).unwrap()).map_err(|e: serde_json::Error| e.to_string()))
        .or_else(|| data.as_array().map(|arr| {
            serde_json::from_value(serde_json::to_value(arr).unwrap()).map_err(|e: serde_json::Error| e.to_string())
        }))
        .or_else(|| {
            // CijferOverzicht format: extract grades from CijferVakken[*].Cijfers
            extract_grades_from_vakken(data["CijferVakken"].as_array())
        })
        .or_else(|| {
            // Nested CijferOverzicht: {"CijferOverzicht": {"CijferVakken": [...]}}
            extract_grades_from_vakken(data["CijferOverzicht"]["CijferVakken"].as_array())
        })
        .unwrap_or_else(|| {
            // Final fallback: try full struct deserialization
            serde_json::from_value::<GradesResponse>(data.clone())
                .map(|r| r.items)
                .map_err(|e| e.to_string())
        })?;

    Ok(items)
}

/// Helper: extract grades from an optional array of CijferVak objects.
fn extract_grades_from_vakken(vakken: Option<&Vec<serde_json::Value>>) -> Option<Result<Vec<Grade>, String>> {
    vakken.map(|vakken| {
        let all_grades: Vec<Grade> = vakken.iter()
            .filter_map(|vak| vak["Cijfers"].as_array())
            .flat_map(|cijfers| {
                cijfers.iter().filter_map(|c| serde_json::from_value(c.clone()).ok())
            })
            .collect();
        Ok(all_grades)
    })
}

/// Get extra grade column info (weight, description, test date).
#[tauri::command]
pub async fn get_grade_extra_info(
    client: State<'_, SharedClient>,
    person_id: i64,
    schoolyear_id: i64,
    kolom_id: i64,
) -> Result<GradeExtraInfo, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };

    let path = format!(
        "personen/{person_id}/aanmeldingen/{schoolyear_id}/\
         cijfers/extracijferkolominfo/{kolom_id}"
    );

    let data = crate::client::get_with_context(&ctx, &path).await.map_err(|e| e.to_string())?;
    serde_json::from_value(data).map_err(|e| e.to_string())
}

/// Get extra info for multiple grade columns - limited concurrency to avoid 500s.
#[tauri::command]
pub async fn get_bulk_grade_extra_info(
    client: State<'_, SharedClient>,
    person_id: i64,
    schoolyear_id: i64,
    kolom_ids: Vec<i64>,
) -> Result<std::collections::HashMap<i64, GradeExtraInfo>, String> {
    use futures::StreamExt;

    // Get auth once
    let (http, api_endpoint, access_token) = {
        let mut c = client.lock().await;
        c.ensure_valid_token().await.map_err(|e| e.to_string())?;
        let ts = c.token_set.as_ref().ok_or("Not authenticated")?;
        (
            c.http.clone(),
            ts.api_endpoint.clone(),
            ts.access_token.clone(),
        )
    };

    let api_base = api_endpoint.trim_end_matches('/').to_string();
    
    // Use a stream to process with limited concurrency (e.g., 5 at a time)
    // This prevents triggering rate limits or 500 errors on the server.
    let results = futures::stream::iter(kolom_ids.clone())
        .map(|id| {
            let http = http.clone();
            let access_token = access_token.clone();
            let url = format!(
                "{}/personen/{person_id}/aanmeldingen/{schoolyear_id}/cijfers/extracijferkolominfo/{id}",
                api_base
            );

            async move {
                let res = http
                    .get(&url)
                    .header("Authorization", format!("Bearer {}", access_token))
                    .header("Accept", "application/json")
                    .send()
                    .await;

                match res {
                    Ok(resp) if resp.status().is_success() => {
                        match resp.json::<GradeExtraInfo>().await {
                            Ok(info) => Ok((id, info)),
                            Err(e) => Err(e.to_string()),
                        }
                    }
                    Ok(resp) => Err(format!("API error ({})", resp.status())),
                    Err(e) => Err(e.to_string()),
                }
            }
        })
        .buffer_unordered(5) // Max 5 parallel requests
        .collect::<Vec<_>>()
        .await;

    let mut map = std::collections::HashMap::new();
    for res in results {
        if let Ok((id, info)) = res {
            map.insert(id, info);
        }
    }

    Ok(map)
}

/// Get the most recent grades across all subjects.
#[tauri::command]
pub async fn get_recent_grades(
    client: State<'_, SharedClient>,
    person_id: i64,
    top: Option<i32>,
) -> Result<Vec<Grade>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let limit = top.unwrap_or(5);
    let path = format!("personen/{person_id}/cijfers/laatste?top={limit}&skip=0");

    log::debug!("Fetching recent grades: {}", path);
    let data = crate::client::get_with_context(&ctx, &path).await.map_err(|e| {
        log::error!("Error fetching recent grades: {}", e);
        e.to_string()
    })?;

    // Handle multiple possible response formats:
    // 1. {"Items": [...]} / {"items": [...]} — paginated wrapper
    // 2. [...] — bare array
    // 3. {"CijferVakken": [...]} — flat CijferOverzicht structure
    // 4. {"CijferOverzicht": {"CijferVakken": [...]}} — nested CijferOverzicht
    let items: Vec<Grade> = data["Items"].as_array()
        .or_else(|| data["items"].as_array())
        .map(|items| serde_json::from_value(serde_json::to_value(items).unwrap()).map_err(|e: serde_json::Error| e.to_string()))
        .or_else(|| data.as_array().map(|arr| {
            serde_json::from_value(serde_json::to_value(arr).unwrap()).map_err(|e: serde_json::Error| e.to_string())
        }))
        .or_else(|| {
            extract_grades_from_vakken(data["CijferVakken"].as_array())
        })
        .or_else(|| {
            extract_grades_from_vakken(data["CijferOverzicht"]["CijferVakken"].as_array())
        })
        .unwrap_or_else(|| {
            serde_json::from_value::<GradesResponse>(data.clone())
                .map(|r| r.items)
                .map_err(|e| e.to_string())
        })?;

    Ok(items)
}
