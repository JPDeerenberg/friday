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
    /// Where the export ended up when the OS picked/knows the place (Android),
    /// e.g. `Download/Friday`. `None` on desktop, where the user chose the folder.
    #[serde(default)]
    pub location: Option<String>,
}

/// Collect and export all data to JSON files in the selected directory.
#[tauri::command]
pub async fn export_all_data(
    app: AppHandle,
    client: State<'_, SharedClient>,
    download_dir: Option<String>,
) -> Result<ExportResult, String> {
    #[cfg(not(desktop))]
    let _ = &app;
    // Desktop asks for a folder every time; only Android uses the saved folder.
    #[cfg(not(target_os = "android"))]
    let _ = &download_dir;

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

    // Each fetch below snapshots its own request context (short lock) via
    // get_with_shared and runs concurrently WITHOUT holding the client
    // lock, so the network round-trips overlap instead of serializing.
    // Each fetch also refreshes + retries once on a stale-token 401, so a
    // token that expired mid-export fails only its own category instead of
    // aborting the whole export.

    // Pre-compute the path parameters (cheap, no I/O) so each fetch future can
    // run standalone without re-reading the shared `today`/`person_id`.
    let lessons_path = format!("personen/{}/afspraken?van={}&tot={}", person_id, start, end);
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
        match crate::client::get_with_shared(&client, &lessons_path).await {
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
        // Every school year the student has been enrolled in, like the Grades page.
        // (Before, only `items.first()` was exported: the oldest year of the last
        // four, which is usually the wrong one — and often empty.)
        let schoolyears_path = format!(
            "leerlingen/{}/aanmeldingen?begin=2013-01-01&einde={}-12-31",
            person_id,
            today.year()
        );
        match crate::client::get_with_shared(&client, &schoolyears_path).await {
            Ok(schoolyears) => {
                let (jobs, warnings) = plan_grade_exports(&schoolyears, today.year());
                errors.extend(warnings);
                for job in jobs {
                    let path = format!(
                        "personen/{}/aanmeldingen/{}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum={}",
                        person_id, job.schoolyear_id, job.peildatum
                    );
                    match crate::client::get_with_shared(&client, &path).await {
                        Ok(data) => match save_json(&dir_path, &job.file_name, &data) {
                            Ok(filename) => files.push(filename),
                            Err(e) => errors.push(format!("cijfers {}: {}", job.label, e)),
                        },
                        Err(e) => errors.push(format!("cijfers {}: {}", job.label, e)),
                    }
                }
            }
            Err(e) => errors.push(format!("schooljaren: {}", e)),
        }
        (files, errors)
    };

    let assignments = async {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        // Paged fetch with the date parameters Magister understands (see
        // `assignments_path`); the old single `van`/`tot` request only returned the
        // server's default window.
        match crate::commands::assignments::fetch_assignment_items(&client, person_id, &start, &end).await {
            Ok(items) => {
                let data = serde_json::json!({ "Items": items });
                match save_json(&dir_path, "opdrachten.json", &data) {
                    Ok(filename) => files.push(filename),
                    Err(e) => errors.push(format!("opdrachten: {}", e)),
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
        match crate::client::get_with_shared(&client, "berichten/mappen/alle").await {
            Ok(folders) => {
                let inbox_id = find_inbox_id(&folders);
                match inbox_id {
                    Some(id) => {
                        let path = format!("berichten/mappen/{}/berichten?top=200&skip=0", id);
                        match crate::client::get_with_shared(&client, &path).await {
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
        match crate::client::get_with_shared(&client, &absences_path).await {
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

        match crate::client::get_with_shared(&client, &studiewijzers_path).await {
            Ok(data) => {
                if let Some(items) = data["Items"].as_array().or_else(|| data["items"].as_array()) {
                    all_items.extend(items.clone());
                }
            }
            Err(e) => errors.push(format!("studiewijzers: {}", e)),
        }

        match crate::client::get_with_shared(&client, &projecten_path).await {
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
        match crate::client::get_with_shared(&client, &leermiddelen_path).await {
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
        match crate::client::get_with_shared(&client, &bronnen_path).await {
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
        match crate::client::get_with_shared(&client, &activities_path).await {
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

    #[allow(unused_mut)]
    let mut export_location: Option<String> = None;

    // On mobile the JSON files landed in an app-private temp dir the user can't
    // reach, so bundle them into a single archive and (on Android) hand that
    // archive to the OS via the FileProvider so the user gets a native share/
    // save sheet instead of silently-written invisible files.
    #[cfg(mobile)]
    {
        use std::io::Write;

        let zip_name = format!("friday-export-{}.zip", today.format("%Y-%m-%d"));
        let zip_path = dir_path.join(&zip_name);
        let file = std::fs::File::create(&zip_path)
            .map_err(|e| format!("Kan zip-bestand niet aanmaken: {}", e))?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
        for filename in &exported_files {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            match std::fs::read(dir_path.join(filename)) {
                Ok(contents) => {
                    if let Err(e) = zip.start_file(filename.clone(), options) {
                        had_errors.push(format!("zip: {}: {}", filename, e));
                        continue;
                    }
                    if let Err(e) = zip.write_all(&contents) {
                        had_errors.push(format!("zip: {}: {}", filename, e));
                    }
                }
                Err(e) => had_errors.push(format!("zip: {}: {}", filename, e)),
            }
        }
        zip.finish().map_err(|e| format!("Kan zip niet finaliseren: {}", e))?;

        #[cfg(target_os = "android")]
        {
            let tree = crate::commands::files::android_tree_uri(download_dir.as_deref());
            let outcome = crate::jni::share_downloaded_file(&zip_path, tree)
                .map_err(|e| format!("Kan zip-bestand niet opslaan of delen: {}", e))?;
            log::info!("Export saved to {}", outcome.location);
            export_location = Some(outcome.location);
        }

        // The user only sees the single shared archive, not the individual JSONs.
        exported_files = vec![zip_name];
    }

    Ok(ExportResult {
        success: true,
        files: exported_files,
        error: if had_errors.is_empty() {
            None
        } else {
            Some(format!("Waarschuwingen bij: {}", had_errors.join("; ")))
        },
        location: export_location,
    })
}

/// The id of the inbox ("Postvak IN") in the `berichten/mappen/alle` answer.
///
/// Magister answers with camelCase keys (`id`, `naam`) here — the same shape the
/// app's own `MessagesFolder` model reads. The export looked for `Id` and so never
/// found a folder ("berichten: geen inbox-map gevonden"). Both spellings are
/// accepted; the folder is picked by name, with the first folder as a fallback.
fn find_inbox_id(folders: &serde_json::Value) -> Option<i64> {
    let items = folders["Items"]
        .as_array()
        .or_else(|| folders["items"].as_array())
        .or_else(|| folders.as_array())?;
    let id_of = |f: &serde_json::Value| f["id"].as_i64().or_else(|| f["Id"].as_i64());
    let name_of = |f: &serde_json::Value| {
        f["naam"]
            .as_str()
            .or_else(|| f["Naam"].as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase()
    };
    items
        .iter()
        .find(|f| matches!(name_of(f).as_str(), "postvak in" | "inbox") && id_of(f).is_some())
        .or_else(|| items.iter().find(|f| id_of(f).is_some()))
        .and_then(id_of)
}

/// One grade overview to fetch: a school year ("aanmelding") plus the file it is saved in.
#[derive(Debug, Clone, PartialEq, Eq)]
struct GradeJob {
    schoolyear_id: i64,
    /// `2025-2026`, or `id<ID>` when the dates are missing. Unique per export.
    label: String,
    file_name: String,
    /// The school year's last day, like the Grades page uses.
    peildatum: String,
}

/// Turns the `aanmeldingen` answer into one job per school year (newest first)
/// plus warnings for entries that cannot be used. Accepts PascalCase and
/// lowercase keys, like the rest of the app.
fn plan_grade_exports(
    schoolyears: &serde_json::Value,
    fallback_year: i32,
) -> (Vec<GradeJob>, Vec<String>) {
    let mut warnings = Vec::new();
    let items = schoolyears["Items"]
        .as_array()
        .or_else(|| schoolyears["items"].as_array())
        .or_else(|| schoolyears.as_array());
    let Some(items) = items else {
        warnings.push("cijfers: onverwacht response-formaat voor schooljaren".to_string());
        return (Vec::new(), warnings);
    };
    if items.is_empty() {
        warnings.push("cijfers: geen schooljaren gevonden".to_string());
        return (Vec::new(), warnings);
    }

    fn text<'a>(item: &'a serde_json::Value, pascal: &str, lower: &str) -> Option<&'a str> {
        item[pascal].as_str().or_else(|| item[lower].as_str())
    }
    fn day(s: &str) -> &str {
        if s.len() >= 10 { &s[0..10] } else { s }
    }
    fn year_of(s: &str) -> Option<&str> {
        let y = s.get(0..4)?;
        y.chars().all(|c| c.is_ascii_digit()).then_some(y)
    }

    let mut ordered: Vec<&serde_json::Value> = items.iter().collect();
    // Newest first; ISO dates sort as text.
    ordered.sort_by(|a, b| {
        text(b, "Begin", "begin")
            .unwrap_or("")
            .cmp(text(a, "Begin", "begin").unwrap_or(""))
    });

    let mut jobs: Vec<GradeJob> = Vec::new();
    for item in ordered {
        let Some(id) = item["Id"].as_i64().or_else(|| item["id"].as_i64()) else {
            warnings.push("cijfers: schooljaar zonder Id overgeslagen".to_string());
            continue;
        };
        let begin = text(item, "Begin", "begin");
        let einde = text(item, "Einde", "einde");
        let mut label = match (begin.and_then(year_of), einde.and_then(year_of)) {
            (Some(b), Some(e)) => format!("{b}-{e}"),
            _ => format!("id{id}"),
        };
        if jobs.iter().any(|j| j.label == label) {
            // Two enrolments in the same school year (e.g. a class change).
            label = format!("{label}-{id}");
        }
        let peildatum = match einde {
            Some(e) => day(e).to_string(),
            None => format!("{}-08-01", fallback_year + 1),
        };
        jobs.push(GradeJob {
            schoolyear_id: id,
            file_name: format!("cijfers-{label}.json"),
            label,
            peildatum,
        });
    }
    (jobs, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jobs(v: serde_json::Value) -> (Vec<GradeJob>, Vec<String>) {
        plan_grade_exports(&v, 2026)
    }

    #[test]
    fn finds_the_inbox_in_the_camelcase_answer_magister_sends() {
        // The shape that made the export fail: keys are `id`/`naam`, not `Id`.
        let folders = json!({ "items": [
            { "id": 11, "naam": "Verzonden items", "bovenliggendeId": 0 },
            { "id": 10, "naam": "Postvak IN", "bovenliggendeId": 0 },
        ]});
        assert_eq!(find_inbox_id(&folders), Some(10));
    }

    #[test]
    fn finds_the_inbox_in_pascalcase_and_bare_arrays() {
        assert_eq!(find_inbox_id(&json!({ "Items": [ { "Id": 4, "Naam": "Postvak IN" } ] })), Some(4));
        assert_eq!(find_inbox_id(&json!([ { "id": 8, "naam": "inbox" } ])), Some(8));
    }

    #[test]
    fn falls_back_to_the_first_folder_without_a_matching_name() {
        let folders = json!({ "Items": [ { "id": 3, "naam": "Iets anders" }, { "id": 4, "naam": "Nog iets" } ] });
        assert_eq!(find_inbox_id(&folders), Some(3));
        // First folder without a usable id is skipped.
        let folders = json!({ "Items": [ { "naam": "kapot" }, { "id": 5, "naam": "x" } ] });
        assert_eq!(find_inbox_id(&folders), Some(5));
    }

    #[test]
    fn no_inbox_when_there_are_no_usable_folders() {
        assert_eq!(find_inbox_id(&json!({ "Items": [] })), None);
        assert_eq!(find_inbox_id(&json!({ "oops": true })), None);
        assert_eq!(find_inbox_id(&json!({ "Items": [ { "naam": "x" } ] })), None);
    }

    #[test]
    fn plans_one_job_per_school_year_newest_first() {
        // Magister lists the oldest year first; the old code exported only that one.
        let (jobs, warnings) = jobs(json!({ "Items": [
            { "Id": 11, "Begin": "2023-08-01T00:00:00.0000000Z", "Einde": "2024-07-31T00:00:00.0000000Z" },
            { "Id": 12, "Begin": "2024-08-01T00:00:00.0000000Z", "Einde": "2025-07-31T00:00:00.0000000Z" },
            { "Id": 13, "Begin": "2025-08-01T00:00:00.0000000Z", "Einde": "2026-07-31T00:00:00.0000000Z" },
        ]}));
        assert!(warnings.is_empty());
        assert_eq!(
            jobs.iter().map(|j| (j.schoolyear_id, j.file_name.as_str(), j.peildatum.as_str())).collect::<Vec<_>>(),
            vec![
                (13, "cijfers-2025-2026.json", "2026-07-31"),
                (12, "cijfers-2024-2025.json", "2025-07-31"),
                (11, "cijfers-2023-2024.json", "2024-07-31"),
            ]
        );
    }

    #[test]
    fn accepts_lowercase_keys_and_a_bare_array() {
        let (jobs, warnings) = jobs(json!([
            { "id": 5, "begin": "2025-08-01T00:00:00Z", "einde": "2026-07-31T00:00:00Z" }
        ]));
        assert!(warnings.is_empty());
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].schoolyear_id, 5);
        assert_eq!(jobs[0].peildatum, "2026-07-31");
    }

    #[test]
    fn falls_back_when_dates_are_missing() {
        let (jobs, _) = jobs(json!({ "Items": [ { "Id": 9 } ] }));
        assert_eq!(jobs[0].label, "id9");
        assert_eq!(jobs[0].file_name, "cijfers-id9.json");
        assert_eq!(jobs[0].peildatum, "2027-08-01");
    }

    #[test]
    fn two_enrolments_in_one_year_get_distinct_files() {
        let (jobs, _) = jobs(json!({ "Items": [
            { "Id": 1, "Begin": "2025-08-01T00:00:00Z", "Einde": "2026-01-31T00:00:00Z" },
            { "Id": 2, "Begin": "2025-08-01T00:00:00Z", "Einde": "2026-07-31T00:00:00Z" },
        ]}));
        assert_eq!(jobs.len(), 2);
        assert_ne!(jobs[0].file_name, jobs[1].file_name);
    }

    #[test]
    fn reports_unusable_answers_instead_of_failing_silently() {
        let (j, w) = jobs(json!({ "Items": [] }));
        assert!(j.is_empty());
        assert_eq!(w, vec!["cijfers: geen schooljaren gevonden".to_string()]);

        let (j, w) = jobs(json!({ "oops": true }));
        assert!(j.is_empty());
        assert!(w[0].contains("onverwacht response-formaat"));

        let (j, w) = jobs(json!({ "Items": [ { "Begin": "2025-08-01T00:00:00Z" }, { "Id": 3, "Begin": "2025-08-01T00:00:00Z", "Einde": "2026-07-31T00:00:00Z" } ]}));
        assert_eq!(j.len(), 1);
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("zonder Id"));
    }
}
