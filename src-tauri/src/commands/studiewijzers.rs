use crate::client::SharedClient;
use crate::models::studiewijzers::{
    Studiewijzer, StudiewijzerDetail, StudiewijzerOnderdeelDetail, StudiewijzersResponse,
};
use tauri::State;

#[tauri::command]
pub async fn get_studiewijzers(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<Studiewijzer>, String> {
    let mut client = client.lock().await;
    let now = chrono::Local::now().format("%Y-%m-%d").to_string();
    let sw_url = format!("leerlingen/{}/studiewijzers?peildatum={}", person_id, now);
    let proj_url = format!("leerlingen/{}/projecten?peildatum={}", person_id, now);

    println!("Fetching studiewijzers from: {}", sw_url);
    println!("Fetching projecten from: {}", proj_url);

    let mut all_items = Vec::new();

    // Try fetching normal studiewijzers
    match client.get(&sw_url).await {
        Ok(sw_response) => match serde_json::from_value::<StudiewijzersResponse>(sw_response) {
            Ok(sws) => all_items.extend(sws.items),
            Err(e) => println!("Warning: Failed to parse studiewijzers: {}", e),
        },
        Err(e) => println!("Warning: Failed to fetch studiewijzers: {}", e),
    }

    // Try fetching projects
    match client.get(&proj_url).await {
        Ok(proj_response) => match serde_json::from_value::<StudiewijzersResponse>(proj_response) {
            Ok(projs) => all_items.extend(projs.items),
            Err(e) => println!("Warning: Failed to parse projects: {}", e),
        },
        Err(e) => println!("Warning: Failed to fetch projects: {}", e),
    }

    Ok(all_items)
}

#[tauri::command]
pub async fn get_studiewijzer_detail(
    client: State<'_, SharedClient>,
    person_id: i64,
    id: i64,
    is_project: bool,
) -> Result<StudiewijzerDetail, String> {
    let mut client = client.lock().await;
    let base = if is_project {
        "projecten"
    } else {
        "studiewijzers"
    };
    let url = format!("leerlingen/{}/{}/{}", person_id, base, id);
    let response = client.get(&url).await.map_err(|e| e.to_string())?;
    let detail: StudiewijzerDetail = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse studiewijzer detail: {}", e))?;
    Ok(detail)
}

#[tauri::command]
pub async fn get_studiewijzer_onderdeel_detail(
    client: State<'_, SharedClient>,
    person_id: i64,
    sw_id: i64,
    onderdeel_id: i64,
    is_project: bool,
) -> Result<StudiewijzerOnderdeelDetail, String> {
    let mut client = client.lock().await;
    let base = if is_project {
        "projecten"
    } else {
        "studiewijzers"
    };
    let url = format!(
        "leerlingen/{}/{}/{}/onderdelen/{}?gebruikMappenStructuur=true",
        person_id, base, sw_id, onderdeel_id
    );
    let response = client.get(&url).await.map_err(|e| e.to_string())?;
    let detail: StudiewijzerOnderdeelDetail = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse onderdeel detail: {}", e))?;
    Ok(detail)
}
