use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[repr(i32)]
pub enum NotificationType {
    Test = 0,
    Message = 1,
    CalendarChange = 2,
    NewGrade = 3,
    AssignmentDeadline = 4,
}

impl Default for NotificationType {
    fn default() -> Self {
        NotificationType::Test
    }
}



#[cfg(target_os = "android")]
fn find_app_class<'local>(
    env: &mut jni::JNIEnv<'local>,
    activity: &jni::objects::JObject<'_>,
    name: &str,
) -> Result<jni::objects::JClass<'local>, jni::errors::Error> {
    let class_loader = env.call_method(
        activity,
        "getClassLoader",
        "()Ljava/lang/ClassLoader;",
        &[],
    )?.l()?;
    let class_name = env.new_string(name)?;
    let class_obj = env.call_method(
        &class_loader,
        "loadClass",
        "(Ljava/lang/String;)Ljava/lang/Class;",
        &[jni::objects::JValue::from(&class_name)],
    )?.l()?;
    Ok(jni::objects::JClass::from(class_obj))
}

#[tauri::command]
pub fn trigger_test_notification(app: AppHandle) -> Result<(), String> {
    let _ = &app; // Ensure it's 'used' even if cfg(not(android))
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        
        // Try to get the main window to access JNI handle
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        // In Tauri 2, WebView has jni_handle()
        window.with_webview(move |webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(move |env, activity, _webview| {
                    // Find the NotificationHelper class via Activity's ClassLoader to prevent JNI thread isolation
                    let class = match find_app_class(env, &activity, "com.joris.friday.NotificationHelper") {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = env.exception_clear();
                            eprintln!("JNI ERROR: Failed to find NotificationHelper: {:?}", e);
                            return;
                        }
                    };
                    
                    // Create JStrings
                    let title = match env.new_string("Test Notificatie") {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    let message = match env.new_string("Dit is een test van het Friday meldingen systeem!") {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    
                    // Call showTestNotification static method
                    let res = env.call_static_method(
                        &class,
                        "showTestNotification",
                        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                        &[
                            JValue::from(&activity),
                            JValue::from(&title),
                            JValue::from(&message),
                        ],
                    );

                    if let Err(_) = res {
                        if let Ok(true) = env.exception_check() {
                            let _ = env.exception_clear();
                        }
                    }
                });
            }
        }).map_err(|e| e.to_string())?;
    }
    
    #[cfg(not(target_os = "android"))]
    {
        println!("Test notification triggered (Desktop)");
    }
    
    Ok(())
}

#[tauri::command]
pub fn show_notification(
    app: AppHandle,
    notification_type: NotificationType,
    title: String,
    message: String,
    extra: Option<String>,
) -> Result<(), String> {
    let _ = &app;
    let _ = &message;
    let _ = &extra;

    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        
        // Try to get the main window to access JNI handle
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(move |webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(move |env, activity, _webview| {
                    // Find the NotificationHelper class via Activity's ClassLoader
                    let class = match find_app_class(env, &activity, "com.joris.friday.NotificationHelper") {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = env.exception_clear();
                            eprintln!("JNI ERROR: Failed to find NotificationHelper: {:?}", e);
                            return;
                        }
                    };
                    
                    // Create JStrings
                    let jni_title = match env.new_string(&title) {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    let jni_message = match env.new_string(&message) {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    let jni_extra = match &extra {
                        Some(e) => env.new_string(e),
                        None => env.new_string(""),
                    };
                    let jni_extra = match jni_extra {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    
                    // Call the static method showNotification
                    let res = env.call_static_method(
                        &class,
                        "showNotification",
                        "(Landroid/content/Context;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                        &[
                            JValue::from(&activity),
                            JValue::Int(notification_type as i32),
                            JValue::from(&jni_title),
                            JValue::from(&jni_message),
                            JValue::from(&jni_extra),
                        ],
                    );

                    if let Err(_) = res {
                        if let Ok(true) = env.exception_check() {
                            let _ = env.exception_clear();
                        }
                    }
                });
            }
        }).map_err(|e| e.to_string())?;
    }
    
    #[cfg(not(target_os = "android"))]
    {
        println!("Notification triggered (Desktop): {:?} - {}", notification_type, title);
    }
    
    Ok(())
}

#[tauri::command]
pub fn trigger_sync(app: AppHandle) -> Result<(), String> {
    let _ = &app;
    #[cfg(target_os = "android")]
    {
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(move |webview| {
            #[cfg(target_os = "android")]
            {
                // Call MainActivity.triggerManualSync() via JNI
                let _ = webview.jni_handle().exec(move |env, activity, _webview| {
                    let res = env.call_method(
                        &activity,
                        "triggerManualSync",
                        "()V",
                        &[],
                    );
                    
                    if let Err(_) = res {
                        if let Ok(true) = env.exception_check() {
                            let _ = env.exception_clear();
                        }
                    }
                });
            }
        }).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

#[tauri::command]
pub fn sync_notification_preferences(
    app: AppHandle,
    notify_messages: bool,
    notify_grades: bool,
    notify_deadlines: bool,
    notify_calendar: bool,
    notify_auto_dnd: bool,
) -> Result<(), String> {
    let _ = &app;
    let _ = notify_messages;
    let _ = notify_grades;
    let _ = notify_deadlines;
    let _ = notify_calendar;
    let _ = notify_auto_dnd;

    #[cfg(target_os = "android")]
    {
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(move |webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(move |env, activity, _webview| {
                    let class = match find_app_class(env, &activity, "com.joris.friday.SyncStateManager") {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = env.exception_clear();
                            eprintln!("JNI ERROR: Failed to find SyncStateManager: {:?}", e);
                            return;
                        }
                    };
                    
                    // Call the static method that accepts context and five booleans
                    let res = env.call_static_method(
                        &class,
                        "syncPreferencesFromFrontend",
                        "(Landroid/content/Context;ZZZZZ)V",
                        &[
                            jni::objects::JValue::from(&activity),
                            jni::objects::JValue::Bool(if notify_messages { 1u8 } else { 0u8 }),
                            jni::objects::JValue::Bool(if notify_grades { 1u8 } else { 0u8 }),
                            jni::objects::JValue::Bool(if notify_deadlines { 1u8 } else { 0u8 }),
                            jni::objects::JValue::Bool(if notify_calendar { 1u8 } else { 0u8 }),
                            jni::objects::JValue::Bool(if notify_auto_dnd { 1u8 } else { 0u8 }),
                        ],
                    );
                    
                    if let Err(_) = res {
                        if let Ok(true) = env.exception_check() {
                            let _ = env.exception_clear();
                        }
                    }
                });
            }
        }).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

/// Delete the sync_state.json file so the next background sync creates a fresh baseline.
/// After calling this, the next sync will save current state as "previous" (no notifications),
/// and the sync AFTER that will detect newly arrived items and send notifications.
#[tauri::command]
pub fn clear_sync_state(app: AppHandle) -> Result<String, String> {
    let _ = &app;
    #[cfg(target_os = "android")]
    {
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(move |webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(move |env, activity, _webview| {
                    let class = match find_app_class(env, &activity, "com.joris.friday.SyncStateManager") {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = env.exception_clear();
                            eprintln!("JNI ERROR: Failed to find SyncStateManager: {:?}", e);
                            return;
                        }
                    };
                    // Call clearState(context) on the SyncStateManager singleton
                    let res = env.call_static_method(
                        &class,
                        "clearState",
                        "(Landroid/content/Context;)V",
                        &[jni::objects::JValue::from(&activity)],
                    );
                    if let Err(_) = res {
                        if let Ok(true) = env.exception_check() {
                            let _ = env.exception_clear();
                        }
                    }
                });
            }
        }).map_err(|e| e.to_string())?;
        
        return Ok("Sync state cleared — next sync will establish new baseline".to_string());
    }
    #[cfg(not(target_os = "android"))]
    Ok("clear_sync_state is only supported on Android".to_string())
}

/// Read and return the raw sync state file for debugging purposes.
/// SyncStateManager writes to context.filesDir = app_data_dir/files/sync_state.json
#[tauri::command]
pub fn get_sync_state_debug(app: AppHandle) -> Result<String, String> {
    let _ = &app;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        // SyncStateManager (Kotlin) writes to context.filesDir which is app_data_dir/files/
        let candidates = vec![
            data_dir.join("files").join("sync_state.json"),  // correct: filesDir
            data_dir.join("sync_state.json"),                // fallback: app_data_dir root
        ];
        for state_file in &candidates {
            if state_file.exists() {
                let content = std::fs::read_to_string(state_file).map_err(|e| e.to_string())?;
                let preview = if content.len() > 2000 {
                    format!("{}...[truncated]", &content[..2000])
                } else {
                    content
                };
                return Ok(format!("// Path: {}\n{}", state_file.display(), preview));
            }
        }
        Ok(format!("STATE_FILE_NOT_FOUND\nChecked:\n{}",
            candidates.iter().map(|p| format!("  - {}", p.display())).collect::<Vec<_>>().join("\n")
        ))
    }
    #[cfg(not(target_os = "android"))]
    Ok("get_sync_state_debug is only supported on Android".to_string())
}

#[tauri::command]
pub fn open_notification_policy_settings(app: AppHandle) -> Result<(), String> {
    let _ = &app;
    #[cfg(target_os = "android")]
    {
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(move |webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(move |env, activity, _webview| {
                    use jni::objects::JValue;
                    
                    // Intent intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
                    let settings_class = match env.find_class("android/provider/Settings") {
                        Ok(c) => c,
                        Err(_) => return,
                    };
                    
                    let action = match env.get_static_field(settings_class, "ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS", "Ljava/lang/String;") {
                        Ok(f) => match f.l() {
                            Ok(l) => l,
                            Err(_) => return,
                        },
                        Err(_) => return,
                    };
                    
                    let intent_class = match env.find_class("android/content/Intent") {
                        Ok(c) => c,
                        Err(_) => return,
                    };
                    
                    let intent = match env.new_object(
                        intent_class,
                        "(Ljava/lang/String;)V",
                        &[JValue::from(&action)],
                    ) {
                        Ok(o) => o,
                        Err(_) => return,
                    };
                    
                    // activity.startActivity(intent);
                    let _ = env.call_method(
                        &activity,
                        "startActivity",
                        "(Landroid/content/Intent;)V",
                        &[JValue::from(&intent)],
                    );
                });
            }
        }).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

/// Returns a JSON string with debug information about the sync service state.
#[tauri::command]
pub fn get_debug_info(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    use serde_json::json;
    use std::time::SystemTime;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let token_path = data_dir.join("tokens.json");
    let files_dir = data_dir.join("files");
    let state_path = files_dir.join("sync_state.json");

    // Check token file
    let token_exists = token_path.exists();
    let (token_size, token_modified) = token_path.metadata()
        .map(|m| (m.len(), m.modified().ok()))
        .unwrap_or((0, None));

    // Check state file
    let state_exists = state_path.exists();
    let (state_summary, state_modified) = if state_exists {
        match std::fs::read_to_string(&state_path) {
            Ok(content) => {
                // Parse state JSON to get diagnostic info
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(state_obj) => {
                        let msg_count = state_obj.get("messages")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.len())
                            .unwrap_or(0);
                        let grades_count = state_obj.get("grades")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.len())
                            .unwrap_or(0);
                        let assignments_count = state_obj.get("assignments")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.len())
                            .unwrap_or(0);
                        let calendar_count = state_obj.get("calendar")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.len())
                            .unwrap_or(0);
                        let _last_sync = state_obj.get("lastSync")
                            .and_then(|v| v.as_i64())
                            .map(|ts| format!("{}", ts))
                            .unwrap_or_else(|| "unknown".to_string());
                        
                        (
                            format!("messages: {}, grades: {}, assignments: {}, calendar: {}", 
                                msg_count, grades_count, assignments_count, calendar_count),
                            state_path.metadata().ok().and_then(|m| m.modified().ok())
                        )
                    },
                    Err(e) => (format!("parse error: {}", e), None),
                }
            }
            Err(e) => (format!("read error: {}", e), None),
        }
    } else {
        // Also check directly in app_data_dir (alternative path)
        let alt_state = data_dir.join("sync_state.json");
        if alt_state.exists() {
            (
                "exists (at app_data_dir, not files/)".to_string(),
                alt_state.metadata().ok().and_then(|m| m.modified().ok())
            )
        } else {
            ("not found".to_string(), None)
        }
    };

    // Format timestamps
    let format_time = |time: Option<SystemTime>| -> String {
        match time {
            Some(t) => match t.duration_since(SystemTime::UNIX_EPOCH) {
                Ok(duration) => {
                    let secs = duration.as_secs();
                    let days_ago = (SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() - secs) / 86400;
                    if days_ago == 0 {
                        "today".to_string()
                    } else if days_ago == 1 {
                        "yesterday".to_string()
                    } else {
                        format!("{} days ago", days_ago)
                    }
                }
                Err(_) => "unknown".to_string(),
            },
            None => "not available".to_string(),
        }
    };

    let info = json!({
        "diagnostic": "Background Sync Status",
        "dataDir": data_dir.to_string_lossy(),
        "tokenFile": {
            "exists": token_exists,
            "sizeBytes": token_size,
            "modified": format_time(token_modified),
            "path": token_path.to_string_lossy()
        },
        "stateFile": {
            "exists": state_exists,
            "summary": state_summary,
            "modified": format_time(state_modified),
            "path": state_path.to_string_lossy()
        },
        "platform": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
        "status": if token_exists && state_exists {
            "✓ Ready (tokens found, state synchronized)"
        } else if token_exists {
            "⚠ First sync pending (tokens found, no local state yet)"
        } else {
            "✗ Not ready (no tokens - authentication required)"
        }
    });

    Ok(serde_json::to_string_pretty(&info).unwrap_or_else(|_| "{}".to_string()))
}

/// Set the background sync interval in seconds. Calls SyncService.setSyncIntervalSeconds via JNI (Android only).
#[tauri::command]
pub fn set_sync_interval(app: AppHandle, seconds: i64) -> Result<String, String> {
    let _ = &app;
    #[cfg(target_os = "android")]
    {
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found".to_string())?;

        window.with_webview(move |webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(move |env, activity, _webview| {
                    // Call MainActivity.setSyncInterval(seconds)
                    let res = env.call_method(
                        &activity,
                        "setSyncInterval",
                        "(J)V",
                        &[jni::objects::JValue::Long(seconds)],
                    );
                    if let Err(_) = res {
                        if let Ok(true) = env.exception_check() {
                            let _ = env.exception_clear();
                        }
                    }
                });
            }
        }).map_err(|e| e.to_string())?;

        return Ok(format!("Sync interval set to {} seconds", seconds));
    }
    #[cfg(not(target_os = "android"))]
    Ok(format!("set_sync_interval({}) is only supported on Android", seconds))
}
