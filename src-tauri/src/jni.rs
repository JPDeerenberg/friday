#[cfg(target_os = "android")]
use jni::{
    objects::{JClass, JString},
    sys::{jint, jstring},
    JNIEnv,
};
#[cfg(target_os = "android")]
use tokio::runtime::Runtime;
use crate::client::MagisterClient;
use chrono::Utc;

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_SyncWorker_runSync<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    data_dir: JString<'local>,
) -> jstring {
    let dir_path: String = match env.get_string(&data_dir) {
        Ok(s) => s.into(),
        Err(_) => "/data/user/0/com.joris.friday/files".to_string(),
    };

    let rt = Runtime::new().unwrap();
    let sync_result = rt.block_on(async {
        do_sync(&dir_path).await
    });

    match env.new_string(sync_result) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_SyncService_runSync<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    data_dir: JString<'local>,
) -> jstring {
    Java_com_joris_friday_SyncWorker_runSync(env, _class, data_dir)
}

// JNI function for showing notifications with type
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_SyncWorker_showNotificationWithType<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    context: jni::objects::JObject<'local>,
    notification_type: jint,
    title: JString<'local>,
    message: JString<'local>,
    extra: JString<'local>,
) {
    let title_str: String = match env.get_string(&title) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    
    let message_str: String = match env.get_string(&message) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    
    let extra_str: Option<String> = match env.get_string(&extra) {
        Ok(s) => {
            let inner: String = s.into();
            if inner.is_empty() { None } else { Some(inner) }
        },
        Err(_) => None,
    };
    
    // Call the Kotlin NotificationHelper via JNI
    let class = match env.find_class("com/joris/friday/NotificationHelper") {
        Ok(c) => c,
        Err(_) => {
            let _ = env.exception_clear();
            eprintln!("JNI ERROR: Failed to find NotificationHelper");
            return;
        }
    };
    
    // Build the method signature for: showNotification(Context, int, String, String, String)
    let method_sig = "(Landroid/content/Context;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V";
    
    let jni_title = match env.new_string(&title_str) {
        Ok(s) => s,
        Err(_) => return,
    };
    
    let jni_message = match env.new_string(&message_str) {
        Ok(s) => s,
        Err(_) => return,
    };
    
    let jni_extra = match extra_str {
        Some(s) => env.new_string(&s).ok(),
        None => env.new_string("").ok(),
    };
    
    if let Some(extra_jni) = jni_extra {
        let _ = env.call_static_method(
            &class,
            "showNotification",
            method_sig,
            &[
                jni::objects::JValue::from(&context),
                jni::objects::JValue::Int(notification_type),
                jni::objects::JValue::from(&jni_title),
                jni::objects::JValue::from(&jni_message),
                jni::objects::JValue::from(&extra_jni),
            ],
        );
        
        // Clear any possible exception from the call
        if let Ok(true) = env.exception_check() {
            let _ = env.exception_clear();
        }
    }
}

// JNI function to sync notification preferences
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_SyncStateManager_syncPreferencesFromFrontend<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    context: jni::objects::JObject<'local>,
    notify_messages: jni::sys::jboolean,
    notify_grades: jni::sys::jboolean,
    notify_deadlines: jni::sys::jboolean,
    notify_calendar: jni::sys::jboolean,
) {
    let prefs = match env.call_method(
        &context,
        "getSharedPreferences",
        "(Ljava/lang/String;I)Landroid/content/SharedPreferences;",
        &[
            jni::objects::JValue::from(&env.new_string("friday_prefs").unwrap_or_default()),
            jni::objects::JValue::Int(0),
        ],
    ) {
        Ok(p) => match p.l() {
            Ok(obj) => obj,
            Err(_) => {
                let _ = env.exception_clear();
                return;
            }
        },
        Err(_) => {
            let _ = env.exception_clear();
            return;
        }
    };
    
    let editor = match env.call_method(
        &prefs,
        "edit",
        "()Landroid/content/SharedPreferences$Editor;",
        &[],
    ) {
        Ok(e) => match e.l() {
            Ok(obj) => obj,
            Err(_) => {
                let _ = env.exception_clear();
                return;
            }
        },
        Err(_) => {
            let _ = env.exception_clear();
            return;
        }
    };
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyMessages").expect("Failed to create JString")),
            jni::objects::JValue::Bool(if notify_messages != 0 { 1u8 } else { 0u8 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyGrades").expect("Failed to create JString")),
            jni::objects::JValue::Bool(if notify_grades != 0 { 1u8 } else { 0u8 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyDeadlines").expect("Failed to create JString")),
            jni::objects::JValue::Bool(if notify_deadlines != 0 { 1u8 } else { 0u8 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyCalendar").expect("Failed to create JString")),
            jni::objects::JValue::Bool(if notify_calendar != 0 { 1u8 } else { 0u8 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("initialized").expect("Failed to create JString")),
            jni::objects::JValue::Bool(1u8),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "apply",
        "()V",
        &[],
    );
    
    // Clear any possible exceptions at the end
    if let Ok(true) = env.exception_check() {
        let _ = env.exception_clear();
    }
}

#[cfg(target_os = "android")]
async fn do_sync(data_dir: &str) -> String {
    use crate::client::TokenSet;
    use std::path::{Path, PathBuf};

    let dir = PathBuf::from(data_dir);
    eprintln!("FridaySync (Rust): do_sync started for dir: {:?}", dir);
    
    // Token search paths - ordered by likelihood:
    // Path 1: app_data_dir/tokens.json (Tauri 2 default — caller should pass this)
    // Path 2: app_data_dir/files/tokens.json (if caller passes filesDir by mistake)
    // Path 3: parent of caller dir + tokens.json (extra fallback)
    let paths = vec![
        dir.join("tokens.json"),
        dir.join("files/tokens.json"),
        dir.join("com.joris.friday/tokens.json"),
        dir.parent().unwrap_or(Path::new("/")).join("tokens.json"),
    ];

    let mut token_data = None;
    let mut successful_path = None;
    for path in &paths {
        eprintln!("FridaySync (Rust): Checking for tokens at {:?}", path);
        if let Ok(data) = std::fs::read_to_string(path) {
            eprintln!("FridaySync (Rust): Found tokens at {:?}", path);
            token_data = Some(data);
            successful_path = Some(path.clone());
            break;
        }
    }

    let token_content = match token_data {
        Some(data) => data,
        None => {
            eprintln!("FridaySyncWorker (Rust): Could not find tokens.json in any location: {:?}", paths);
            return "ERROR: NO_TOKENS".to_string()
        },
    };

    let token_set: TokenSet = match serde_json::from_str(&token_content) {
        Ok(ts) => ts,
        Err(e) => {
            eprintln!("FridaySyncWorker (Rust): Failed to parse tokens: {}", e);
            return "ERROR: INVALID_TOKENS".to_string()
        },
    };

    let mut client = MagisterClient::new();
    client.token_set = Some(token_set.clone());

    if let Err(e) = client.ensure_valid_token().await {
        return format!("AUTH_ERROR: {}", e);
    }

    // Save refreshed token if needed
    if let (Some(path), Ok(new_data)) = (successful_path, serde_json::to_string_pretty(&client.token_set)) {
        let _ = std::fs::write(path, new_data);
    }

    let person_id = match client.token_set.as_ref().unwrap().person_id {
        Some(id) => id,
        None => return "ERROR: NO_PERSON_ID".to_string(),
    };

    // Fetch all data (return early on critical API errors)
    let messages_result = match fetch_messages(&mut client).await {
        Ok(v) => v,
        Err(e) => return format!("ERROR: FETCH_MESSAGES: {}", e),
    };
    let grades_result = match fetch_recent_grades(&mut client, person_id).await {
        Ok(v) => v,
        Err(e) => return format!("ERROR: FETCH_GRADES: {}", e),
    };
    let assignments_result = match fetch_assignments(&mut client, person_id).await {
        Ok(v) => v,
        Err(e) => return format!("ERROR: FETCH_ASSIGNMENTS: {}", e),
    };
    let calendar_result = match fetch_calendar(&mut client, person_id, &today_string(), &tomorrow_string()).await {
        Ok(v) => v,
        Err(e) => return format!("ERROR: FETCH_CALENDAR: {}", e),
    };

    // Build JSON result with all data for change detection
    let sync_data = serde_json::json!({
        "messages": messages_result,
        "grades": grades_result,
        "assignments": assignments_result,
        "calendar": calendar_result,
        "syncTimestamp": chrono::Utc::now().timestamp()
    });

    serde_json::to_string(&sync_data).unwrap_or_else(|_| "SYNC_SUCCESS".to_string())
}

fn today_string() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

fn tomorrow_string() -> String {
    (Utc::now() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
}

async fn fetch_messages(client: &mut MagisterClient) -> Result<serde_json::Value, String> {
    match client.get("berichten/mappen/1/berichten?top=10&skip=0").await {
        Ok(data) => {
            if let Some(items) = data.get("items").filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}

async fn fetch_recent_grades(client: &mut MagisterClient, person_id: i64) -> Result<serde_json::Value, String> {
    let url = format!("personen/{}/cijfers/laatste?top=50&skip=0", person_id);
    match client.get(&url).await {
        Ok(data) => {
            // Extract items from the response
            if let Some(items) = data.get("items").filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}

async fn fetch_assignments(client: &mut MagisterClient, person_id: i64) -> Result<serde_json::Value, String> {
    // Get assignments for next 14 days
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let two_weeks = (Utc::now() + chrono::Duration::days(14)).format("%Y-%m-%d").to_string();
    let url = format!("personen/{}/opdrachten?einddatum={}&startdatum={}&top=50", person_id, two_weeks, today);
    match client.get(&url).await {
        Ok(data) => {
            if let Some(items) = data.get("items").filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}

async fn fetch_calendar(client: &mut MagisterClient, person_id: i64, from: &str, to: &str) -> Result<serde_json::Value, String> {
    let url = format!("personen/{}/afspraken?van={}&tot={}", person_id, from, to);
    match client.get(&url).await {
        Ok(data) => {
            if let Some(items) = data.get("items").filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}
