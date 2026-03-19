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
    let resp: SchoolyearsResponse =
        serde_json::from_value(data).map_err(|e| e.to_string())?;

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
    let resp: GradesResponse =
        serde_json::from_value(data).map_err(|e| e.to_string())?;

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

    let mut c = client.lock().await;
    
    // Limits the number of concurrent requests to avoid triggering rate limits too easily
    // although join_all is concurrent, Magister is sensitive.
    // For now, let's just do them all together as requested.
    
    let mut futures_vec = Vec::new();
    for id in &kolom_ids {
        let path = format!(
            "personen/{person_id}/aanmeldingen/{schoolyear_id}/\
             cijfers/extracijferkolominfo/{id}"
        );
        futures_vec.push(c.get(&path));
    }

    let results = join_all(futures_vec).await;
    let mut map = std::collections::HashMap::new();

    for (i, res) in results.into_iter().enumerate() {
        let id = kolom_ids[i];
        if let Ok(data) = res {
            if let Ok(info) = serde_json::from_value::<GradeExtraInfo>(data) {
                map.insert(id, info);
            }
        }
    }
    
    Ok(map) 
}
