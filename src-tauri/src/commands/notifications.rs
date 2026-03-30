use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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

#[derive(Debug, Serialize, Deserialize)]
pub struct NotificationPayload {
    pub notification_type: NotificationType,
    pub title: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
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
        window.with_webview(|webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(|env, activity, _webview| {
                    // Find the SyncWorker class
                    let class = match env.find_class("com/joris/friday/SyncWorker") {
                        Ok(c) => c,
                        Err(_) => return,
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
                    
                    // Call the new native method that handles notification with proper intent
                    let res = env.call_static_method(
                        &class,
                        "showNotification",
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
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        
        // Try to get the main window to access JNI handle
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(|webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(|env, activity, _webview| {
                    // Find the SyncWorker class
                    let class = match env.find_class("com/joris/friday/SyncWorker") {
                        Ok(c) => c,
                        Err(_) => return,
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
                    
                    // Call the native method with type
                    let res = env.call_static_method(
                        &class,
                        "showNotificationWithType",
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
        use jni::objects::JValue;
        
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(|webview| {
            #[cfg(target_os = "android")]
            {
                // Call MainActivity.triggerManualSync() via JNI
                let _ = webview.jni_handle().exec(|env, activity, _webview| {
                    let class = match env.find_class("com/joris/friday/MainActivity") {
                        Ok(c) => c,
                        Err(_) => return,
                    };
                    
                    let _ = env.call_method(
                        &activity,
                        "triggerManualSync",
                        "()V",
                        &[],
                    );
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
) -> Result<(), String> {
    let _ = &app;
    #[cfg(target_os = "android")]
    {
        let window = app.get_webview_window("main")
            .or_else(|| app.webview_windows().values().next().cloned())
            .ok_or_else(|| "No active window found for JNI access".to_string())?;

        window.with_webview(|webview| {
            #[cfg(target_os = "android")]
            {
                let _ = webview.jni_handle().exec(|env, activity, _webview| {
                    let class = match env.find_class("com/joris/friday/SyncStateManager") {
                        Ok(c) => c,
                        Err(_) => return,
                    };
                    
                    // Call the static method that accepts context and four booleans
                    let _ = env.call_static_method(
                        &class,
                        "syncPreferencesFromFrontend",
                        "(Landroid/content/Context;ZZZZ)V",
                        &[
                            jni::objects::JValue::from(&activity),
                            jni::objects::JValue::Bool(if notify_messages { 1 } else { 0 }),
                            jni::objects::JValue::Bool(if notify_grades { 1 } else { 0 }),
                            jni::objects::JValue::Bool(if notify_deadlines { 1 } else { 0 }),
                            jni::objects::JValue::Bool(if notify_calendar { 1 } else { 0 }),
                        ],
                    );
                });
            }
        }).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}
