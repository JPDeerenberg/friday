use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use crate::client::SharedClient;
use tauri::State;
use chrono::{Local, Datelike};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub success: bool,
    pub files: Vec<String>,
    pub error: Option<String>,
}

/// Collect and export all data to JSON files in the selected directory.
#[tauri::command]
pub async fn export_all_data(
    app: AppHandle,
    client: State<'_, SharedClient>,
) -> Result<ExportResult, String> {
    #[cfg(not(desktop))]
    let _ = &app;

    let person_id = {
        let client = client.lock().await;
        client.token_set.as_ref()
            .and_then(|t| t.person_id)
            .ok_or_else(|| "Niet ingelogd. Log eerst in.".to_string())?
    };

    // Ask user to pick a directory (blocking variant since we're on a background thread)
    let dir_path: PathBuf = {
        #[cfg(desktop)]
        {
            use tauri_plugin_dialog::DialogExt;
            let dir = app.dialog()
                .file()
                .blocking_pick_folder()
                .ok_or_else(|| "Geen map geselecteerd.".to_string())?;
            dir.as_path()
                .ok_or_else(|| "Kan mappad niet bepalen.".to_string())?
                .to_path_buf()
        }
        #[cfg(mobile)]
        {
            let path = std::env::temp_dir().join("friday-export");
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("Kan export map niet maken: {}", e))?;
            path
        }
    };

    let today = Local::now();
    let start = format!("{}-01-01", today.year());
    let end = format!("{}-12-31", today.year());

    let mut exported_files: Vec<String> = Vec::new();
    let mut had_errors: Vec<String> = Vec::new();

    // Helper to save JSON to file
    let save_json = |dir: &PathBuf, filename: &str, data: &serde_json::Value| -> Result<String, String> {
        let path = dir.join(filename);
        let json = serde_json::to_string_pretty(data).map_err(|e| format!("JSON serialisatie fout: {}", e))?;
        std::fs::write(&path, &json).map_err(|e| format!("Schrijffout: {}", e))?;
        Ok(filename.to_string())
    };

    // --- Export Calendar Events ---
    {
        let mut client = client.lock().await;
        match client.get(&format!("personen/{}/afspraken?van={}&tot={}", person_id, start, end)).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "lessen.json", &data) {
                    exported_files.push(filename);
                }
            }
            Err(e) => had_errors.push(format!("lessen: {}", e)),
        }
    }

    // --- Export Grades ---
    {
        let mut client = client.lock().await;

        // Get schoolyears — uses `leerlingen/{id}/aanmeldingen?begin=...&einde=...` (see grades.rs)
        let schoolyears_path = format!(
            "leerlingen/{}/aanmeldingen?begin={}-01-01&einde={}-12-31",
            person_id, today.year() - 4, today.year()
        );
        match client.get(&schoolyears_path).await {
            Ok(ref schoolyears) => {
                // Extract items from response (handles {"Items": [...]}, {"items": [...]}, and bare array)
                let items = schoolyears["Items"].as_array()
                    .or_else(|| schoolyears["items"].as_array())
                    .or_else(|| schoolyears.as_array());
                if let Some(items) = items {
                    if let Some(first) = items.first() {
                        if let Some(schoolyear_id) = first["Id"].as_i64() {
                            // Use schoolyear's einde as peildatum (matching frontend behaviour)
                            let peildatum = match first["Einde"].as_str() {
                                Some(e) => {
                                    let d = if e.len() >= 10 { &e[0..10] } else { e };
                                    d.to_string()
                                }
                                None => {
                                    format!("{}-08-01", today.year() + 1)
                                }
                            };
                            match client.get(&format!(
                                "personen/{}/aanmeldingen/{}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum={}",
                                person_id, schoolyear_id, peildatum
                            )).await {
                            Ok(data) => {
                                if let Ok(filename) = save_json(&dir_path, "cijfers.json", &data) {
                                    exported_files.push(filename);
                                }
                            }
                            Err(e) => had_errors.push(format!("cijfers: {}", e)),
                        }
                        } else {
                            had_errors.push("cijfers: geen Id in schooljaar".to_string());
                        }
                    } else {
                        had_errors.push("cijfers: geen schooljaren gevonden".to_string());
                    }
                } else {
                    had_errors.push("cijfers: onverwacht response-formaat voor schooljaren".to_string());
                }
            }
            Err(e) => had_errors.push(format!("schooljaren: {}", e)),
        }
    }

    // --- Export Assignments ---
    {
        let mut client = client.lock().await;
        match client.get(&format!("personen/{}/opdrachten?van={}&tot={}", person_id, start, end)).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "opdrachten.json", &data) {
                    exported_files.push(filename);
                }
            }
            Err(e) => had_errors.push(format!("opdrachten: {}", e)),
        }
    }

    // --- Export Messages ---
    {
        let mut client = client.lock().await;
        let folders_result = client.get("berichten/mappen/alle").await;
        match folders_result {
            Ok(folders) => {
                // Try to find the inbox folder ID — handles {"Items": [...]}, {"items": [...]}, and bare array
                let inbox_id = folders["Items"].as_array()
                    .and_then(|items| items.first())
                    .and_then(|f| f["Id"].as_i64())
                    .or_else(|| {
                        folders["items"].as_array()
                            .and_then(|items| items.first())
                            .and_then(|f| f["Id"].as_i64())
                    })
                    .or_else(|| {
                        folders.as_array()
                            .and_then(|items| items.first())
                            .and_then(|f| f["Id"].as_i64())
                    });
                match inbox_id {
                    Some(id) => {
                        match client.get(&format!("berichten/mappen/{}/berichten?top=200&skip=0", id)).await {
                            Ok(data) => {
                                if let Ok(filename) = save_json(&dir_path, "berichten.json", &data) {
                                    exported_files.push(filename);
                                }
                            }
                            Err(e) => had_errors.push(format!("berichten: {}", e)),
                        }
                    }
                    None => had_errors.push("berichten: geen inbox-map gevonden".to_string()),
                }
            }
            Err(e) => had_errors.push(format!("berichten-mappen: {}", e)),
        }
    }

    // --- Export Absences ---
    {
        let mut client = client.lock().await;
        match client.get(&format!("personen/{}/absenties?van={}&tot={}", person_id, start, end)).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "afwezigheid.json", &data) {
                    exported_files.push(filename);
                }
            }
            Err(e) => had_errors.push(format!("afwezigheid: {}", e)),
        }
    }

    // --- Export Studiewijzers (incl. projecten) ---
    {
        let mut client = client.lock().await;
        let peildatum = today.format("%Y-%m-%d").to_string();
        let mut all_items: Vec<serde_json::Value> = Vec::new();

        // Studiewijzers: `leerlingen/{id}/studiewijzers?peildatum=...` (see studiewijzers.rs)
        match client.get(&format!("leerlingen/{}/studiewijzers?peildatum={}", person_id, peildatum)).await {
            Ok(data) => {
                if let Some(items) = data["Items"].as_array().or_else(|| data["items"].as_array()) {
                    all_items.extend(items.clone());
                }
            }
            Err(e) => had_errors.push(format!("studiewijzers: {}", e)),
        }

        // Projecten: `leerlingen/{id}/projecten?peildatum=...` (see studiewijzers.rs)
        match client.get(&format!("leerlingen/{}/projecten?peildatum={}", person_id, peildatum)).await {
            Ok(data) => {
                if let Some(items) = data["Items"].as_array().or_else(|| data["items"].as_array()) {
                    all_items.extend(items.clone());
                }
            }
            Err(e) => had_errors.push(format!("projecten: {}", e)),
        }

        let combined = serde_json::json!({ "Items": all_items });
        if let Ok(filename) = save_json(&dir_path, "studiewijzers.json", &combined) {
            exported_files.push(filename);
        }
    }

    // --- Export Leermiddelen — `personen/{id}/lesmateriaal` (see leermiddelen.rs) ---
    {
        let mut client = client.lock().await;
        match client.get(&format!("personen/{}/lesmateriaal", person_id)).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "leermiddelen.json", &data) {
                    exported_files.push(filename);
                }
            }
            Err(e) => had_errors.push(format!("leermiddelen: {}", e)),
        }
    }

    // --- Export Bronnen — `personen/{id}/bronnen?soort=0` (see bronnen.rs) ---
    {
        let mut client = client.lock().await;
        match client.get(&format!("personen/{}/bronnen?soort=0", person_id)).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "bronnen.json", &data) {
                    exported_files.push(filename);
                }
            }
            Err(e) => had_errors.push(format!("bronnen: {}", e)),
        }
    }

    // --- Export Activities ---
    {
        let mut client = client.lock().await;
        match client.get(&format!("personen/{}/activiteiten", person_id)).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "activiteiten.json", &data) {
                    exported_files.push(filename);
                }
            }
            Err(e) => had_errors.push(format!("activiteiten: {}", e)),
        }
    }

    Ok(ExportResult {
        success: true,
        files: exported_files,
        error: if had_errors.is_empty() {
            None
        } else {
            Some(format!("Waarschuwingen bij: {}", had_errors.join("; ")))
        },
    })
}
