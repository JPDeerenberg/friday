use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogExportResult {
    pub success: bool,
    pub file_name: String,
    pub error: Option<String>,
}

/// Zip up everything in the app's log directory (populated by the
/// `tauri_plugin_log` `LogDir` target configured in `lib.rs`) and hand it to
/// the user — via the OS share sheet on Android, or a folder picker on
/// desktop. This exists specifically so intermittent bugs (like the
/// token-refresh issue) that can't be caught live with `adb logcat` still
/// leave a log trail the user can grab after the fact, straight from
/// Settings, without needing a computer or USB debugging.
#[tauri::command]
pub async fn export_debug_log(app: AppHandle) -> Result<LogExportResult, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Kan logmap niet vinden: {}", e))?;

    if !log_dir.exists() {
        return Ok(LogExportResult {
            success: false,
            file_name: String::new(),
            error: Some("Nog geen logbestanden aanwezig.".to_string()),
        });
    }

    let mut log_files: Vec<PathBuf> = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Kan logmap niet lezen: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| p.is_file())
        .collect();
    log_files.sort();

    if log_files.is_empty() {
        return Ok(LogExportResult {
            success: false,
            file_name: String::new(),
            error: Some("Nog geen logbestanden aanwezig.".to_string()),
        });
    }

    let today = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let zip_name = format!("friday-log-{}.zip", today);

    // Destination directory: on mobile this has to be somewhere the
    // Android FileProvider config (file_paths.xml) actually exposes — the
    // app-wide cache dir, same as export_all_data() already relies on. On
    // desktop the user picks where it goes.
    let dest_dir: PathBuf = {
        #[cfg(desktop)]
        {
            use tauri_plugin_dialog::DialogExt;
            match app.dialog().file().blocking_pick_folder() {
                Some(dir) => match dir.as_path() {
                    Some(p) => p.to_path_buf(),
                    None => return Err("Kan mappad niet bepalen.".to_string()),
                },
                None => {
                    return Ok(LogExportResult {
                        success: false,
                        file_name: String::new(),
                        error: None, // user cancelled the picker, not an error
                    });
                }
            }
        }
        #[cfg(mobile)]
        {
            let path = std::env::temp_dir().join("friday-logs");
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("Kan exportmap niet maken: {}", e))?;
            path
        }
    };

    let zip_path = dest_dir.join(&zip_name);
    let file = std::fs::File::create(&zip_path)
        .map_err(|e| format!("Kan zip-bestand niet aanmaken: {}", e))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // Small header with app version / platform, useful context alongside
    // the raw log lines when diagnosing a report.
    {
        use std::io::Write;
        let info = format!(
            "friday version: {}\nplatform: {}\nexported_at: {}\n",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            chrono::Local::now().to_rfc3339(),
        );
        zip.start_file("info.txt", options)
            .map_err(|e| format!("zip: info.txt: {}", e))?;
        zip.write_all(info.as_bytes())
            .map_err(|e| format!("zip: info.txt: {}", e))?;
    }

    for path in &log_files {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let contents = std::fs::read(path)
            .map_err(|e| format!("Kan {} niet lezen: {}", name, e))?;
        zip.start_file(name, options)
            .map_err(|e| format!("zip: {}: {}", name, e))?;
        use std::io::Write;
        zip.write_all(&contents)
            .map_err(|e| format!("zip: {}: {}", name, e))?;
    }

    zip.finish()
        .map_err(|e| format!("Kan zip niet finaliseren: {}", e))?;

    #[cfg(target_os = "android")]
    crate::jni::share_downloaded_file(&zip_path)
        .map_err(|e| format!("Kan logbestand niet delen: {}", e))?;

    Ok(LogExportResult {
        success: true,
        file_name: zip_name,
        error: None,
    })
}
