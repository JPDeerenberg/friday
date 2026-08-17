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

    // Helper to save JSON to file
    let save_json = |dir: &PathBuf, filename: &str, data: &serde_json::Value| -> Result<String, String> {
        let path = dir.join(filename);
        let json = serde_json::to_string_pretty(data).map_err(|e| format!("JSON serialisatie fout: {}", e))?;
        std::fs::write(&path, &json).map_err(|e| format!("Schrijffout: {}", e))?;
        Ok(filename.to_string())
    };

    // Acquire one request context up front. The independent fetches below all
    // share it and run concurrently WITHOUT holding the client lock, so the
    // network round-trips overlap instead of serializing. Only the cheap
    // token-validity check needs the lock.
    let ctx = {
        let mut client = client.lock().await;
        client.request_context().await.map_err(|e| e.to_string())?
    };

    // Pre-compute the path parameters (cheap, no I/O) so each fetch future can
    // run standalone without re-reading the shared `today`/`person_id`.
    let lessons_path = format!("personen/{}/afspraken?van={}&tot={}", person_id, start, end);
    let opdrachten_path = format!("personen/{}/opdrachten?van={}&tot={}", person_id, start, end);
    let absences_path = format!("personen/{}/absenties?van={}&tot={}", person_id, start, end);
    let studiewijzer_peildatum = today.format("%Y-%m-%d").to_string();
    let studiewijzers_path = format!("leerlingen/{}/studiewijzers?peildatum={}", person_id, studiewijzer_peildatum);
    let projecten_path = format!("leerlingen/{}/projecten?peildatum={}", person_id, studiewijzer_peildatum);
    let leermiddelen_path = format!("personen/{}/lesmateriaal", person_id);
    let bronnen_path = format!("personen/{}/bronnen?soort=0", person_id);
    let activities_path = format!("personen/{}/activiteiten", person_id);

    // Each category is an async block returning (files, errors). The genuinely
    // independent categories run concurrently via tokio::join!, while the two
    // internally-sequential chains (grades, messages) keep their 2-step
    // ordering inside their own block — which itself runs concurrently with
    // everything else. Error handling is unchanged: each category reports its
    // own specific error, and a single failure never aborts the other fetches.
    let calendar = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        match crate::client::get_with_context(&ctx, &lessons_path).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "lessen.json", &data) {
                    files.push(filename);
                }
            }
            Err(e) => errors.push(format!("lessen: {}", e)),
        }
        (files, errors)
    };

    // Grades: needs a schoolyear id first, so it's a 2-step chain.
    let grades = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        let schoolyears_path = format!(
            "leerlingen/{}/aanmeldingen?begin={}-01-01&einde={}-12-31",
            person_id, today.year() - 4, today.year()
        );
        match crate::client::get_with_context(&ctx, &schoolyears_path).await {
            Ok(schoolyears) => {
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
                                None => format!("{}-08-01", today.year() + 1),
                            };
                            let path = format!(
                                "personen/{}/aanmeldingen/{}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum={}",
                                person_id, schoolyear_id, peildatum
                            );
                            match crate::client::get_with_context(&ctx, &path).await {
                                Ok(data) => {
                                    if let Ok(filename) = save_json(&dir_path, "cijfers.json", &data) {
                                        files.push(filename);
                                    }
                                }
                                Err(e) => errors.push(format!("cijfers: {}", e)),
                            }
                        } else {
                            errors.push("cijfers: geen Id in schooljaar".to_string());
                        }
                    } else {
                        errors.push("cijfers: geen schooljaren gevonden".to_string());
                    }
                } else {
                    errors.push("cijfers: onverwacht response-formaat voor schooljaren".to_string());
                }
            }
            Err(e) => errors.push(format!("schooljaren: {}", e)),
        }
        (files, errors)
    };

    let assignments = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        match crate::client::get_with_context(&ctx, &opdrachten_path).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "opdrachten.json", &data) {
                    files.push(filename);
                }
            }
            Err(e) => errors.push(format!("opdrachten: {}", e)),
        }
        (files, errors)
    };

    // Messages: needs the inbox folder id first, so it's a 2-step chain.
    let messages = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        match crate::client::get_with_context(&ctx, "berichten/mappen/alle").await {
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
                        let path = format!("berichten/mappen/{}/berichten?top=200&skip=0", id);
                        match crate::client::get_with_context(&ctx, &path).await {
                            Ok(data) => {
                                if let Ok(filename) = save_json(&dir_path, "berichten.json", &data) {
                                    files.push(filename);
                                }
                            }
                            Err(e) => errors.push(format!("berichten: {}", e)),
                        }
                    }
                    None => errors.push("berichten: geen inbox-map gevonden".to_string()),
                }
            }
            Err(e) => errors.push(format!("berichten-mappen: {}", e)),
        }
        (files, errors)
    };

    let absences = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        match crate::client::get_with_context(&ctx, &absences_path).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "afwezigheid.json", &data) {
                    files.push(filename);
                }
            }
            Err(e) => errors.push(format!("afwezigheid: {}", e)),
        }
        (files, errors)
    };

    // Studiewijzers (incl. projecten): two independent requests combined into
    // one output file — kept sequential within its own block.
    let studiewijzers = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        let mut all_items: Vec<serde_json::Value> = Vec::new();

        match crate::client::get_with_context(&ctx, &studiewijzers_path).await {
            Ok(data) => {
                if let Some(items) = data["Items"].as_array().or_else(|| data["items"].as_array()) {
                    all_items.extend(items.clone());
                }
            }
            Err(e) => errors.push(format!("studiewijzers: {}", e)),
        }

        match crate::client::get_with_context(&ctx, &projecten_path).await {
            Ok(data) => {
                if let Some(items) = data["Items"].as_array().or_else(|| data["items"].as_array()) {
                    all_items.extend(items.clone());
                }
            }
            Err(e) => errors.push(format!("projecten: {}", e)),
        }

        let combined = serde_json::json!({ "Items": all_items });
        if let Ok(filename) = save_json(&dir_path, "studiewijzers.json", &combined) {
            files.push(filename);
        }
        (files, errors)
    };

    let leermiddelen = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        match crate::client::get_with_context(&ctx, &leermiddelen_path).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "leermiddelen.json", &data) {
                    files.push(filename);
                }
            }
            Err(e) => errors.push(format!("leermiddelen: {}", e)),
        }
        (files, errors)
    };

    let bronnen = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        match crate::client::get_with_context(&ctx, &bronnen_path).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "bronnen.json", &data) {
                    files.push(filename);
                }
            }
            Err(e) => errors.push(format!("bronnen: {}", e)),
        }
        (files, errors)
    };

    let activities = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        match crate::client::get_with_context(&ctx, &activities_path).await {
            Ok(data) => {
                if let Ok(filename) = save_json(&dir_path, "activiteiten.json", &data) {
                    files.push(filename);
                }
            }
            Err(e) => errors.push(format!("activiteiten: {}", e)),
        }
        (files, errors)
    };

    let (calendar, grades, assignments, messages, absences, studiewijzers, leermiddelen, bronnen, activities) =
        tokio::join!(
            calendar, grades, assignments, messages, absences, studiewijzers, leermiddelen, bronnen, activities
        );

    let mut exported_files: Vec<String> = Vec::new();
    let mut had_errors: Vec<String> = Vec::new();
    for (files, errors) in [
        calendar, grades, assignments, messages, absences, studiewijzers, leermiddelen, bronnen, activities,
    ] {
        exported_files.extend(files);
        had_errors.extend(errors);
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
