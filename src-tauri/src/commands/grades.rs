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
    let mut c = client.lock().await;

    let path = if let (Some(start), Some(end)) = (&start, &end) {
        format!("leerlingen/{person_id}/aanmeldingen?begin={start}&einde={end}")
    } else {
        format!("leerlingen/{person_id}/aanmeldingen/")
    };

    let data = c.get(&path).await.map_err(|e| e.to_string())?;
    let resp: SchoolyearsResponse = serde_json::from_value(data).map_err(|e| e.to_string())?;

    Ok(resp.items)
}

/// Get all grades for a specific schoolyear enrollment.
#[tauri::command]
pub async fn get_grades(
    client: State<'_, SharedClient>,
    person_id: i64,
    schoolyear_id: i64,
    einde: String, // ISO 8601 date for peildatum
) -> Result<Vec<Grade>, String> {
    let mut c = client.lock().await;

    let path = format!(
        "personen/{person_id}/aanmeldingen/{schoolyear_id}/cijfers/\
         cijferoverzichtvooraanmelding?\
         actievePerioden=false\
         &alleenBerekendeKolommen=false\
         &alleenPTAKolommen=false\
         &peildatum={einde}"
    );

    let data = c.get(&path).await.map_err(|e| e.to_string())?;
    let resp: GradesResponse = serde_json::from_value(data).map_err(|e| e.to_string())?;

    Ok(resp.items)
}

/// Get extra grade column info (weight, description, test date).
#[tauri::command]
pub async fn get_grade_extra_info(
    client: State<'_, SharedClient>,
    person_id: i64,
    schoolyear_id: i64,
    kolom_id: i64,
) -> Result<GradeExtraInfo, String> {
    let mut c = client.lock().await;

    let path = format!(
        "personen/{person_id}/aanmeldingen/{schoolyear_id}/\
         cijfers/extracijferkolominfo/{kolom_id}"
    );

    let data = c.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_value(data).map_err(|e| e.to_string())
}

/// Get extra info for multiple grade columns in parallel.
#[tauri::command]
pub async fn get_bulk_grade_extra_info(
    client: State<'_, SharedClient>,
    person_id: i64,
    schoolyear_id: i64,
    kolom_ids: Vec<i64>,
) -> Result<std::collections::HashMap<i64, GradeExtraInfo>, String> {
    use futures::future::join_all;

    // We clone the components needed for requests to avoid holding the lock
    // on the Mutex during the network calls, which allows true parallelism.
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

    let mut futures_vec = Vec::new();
    for id in &kolom_ids {
        let http = http.clone();
        let api_endpoint = api_endpoint.clone();
        let access_token = access_token.clone();
        let url = format!(
            "{}/personen/{person_id}/aanmeldingen/{schoolyear_id}/\
             cijfers/extracijferkolominfo/{id}",
            api_endpoint.trim_end_matches('/')
        );

        futures_vec.push(async move {
            let res = http
                .get(&url)
                .header("Authorization", format!("Bearer {}", access_token))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|e| e.to_string());

            match res {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        return Err(format!("API error ({})", resp.status()));
                    }
                    resp.json::<GradeExtraInfo>()
                        .await
                        .map_err(|e| e.to_string())
                }
                Err(e) => Err(e),
            }
        });
    }

    let results = join_all(futures_vec).await;
    let mut map = std::collections::HashMap::new();

    for (i, res) in results.into_iter().enumerate() {
        let id = kolom_ids[i];
        if let Ok(info) = res {
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
    let mut c = client.lock().await;
    let limit = top.unwrap_or(5);
    let path = format!("personen/{person_id}/cijfers/laatste?top={limit}&skip=0");

    println!("Fetching recent grades: {}", path);
    let data = c.get(&path).await.map_err(|e| {
        println!("Error fetching recent grades: {}", e);
        e.to_string()
    })?;

    let resp: GradesResponse = serde_json::from_value(data).map_err(|e| {
        println!("Failed to parse recent grades: {}", e);
        e.to_string()
    })?;

    Ok(resp.items)
}
