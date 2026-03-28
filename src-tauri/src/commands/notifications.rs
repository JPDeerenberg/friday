use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

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
                    
                    // Call global static method
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
