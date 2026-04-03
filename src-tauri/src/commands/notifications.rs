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
