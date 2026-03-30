#[cfg(target_os = "android")]
use jni::{
    objects::{JClass, JString},
    sys::{jint, jstring},
    JNIEnv,
};
#[cfg(target_os = "android")]
use tokio::runtime::Runtime;

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
        Err(_) => return,
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
    }
}

// JNI function to sync notification preferences
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_SyncStateManager_syncPreferencesFromFrontend<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    context: jni::objects::JObject<'local>,
    notify_messages: bool,
    notify_grades: bool,
    notify_deadlines: bool,
    notify_calendar: bool,
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
        Ok(p) => p.l().unwrap_or_default(),
        Err(_) => return,
    };
    
    let editor = match env.call_method(
        &prefs,
        "edit",
        "()Landroid/content/SharedPreferences$Editor;",
        &[],
    ) {
        Ok(e) => e.l().unwrap_or_default(),
        Err(_) => return,
    };
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyMessages").unwrap_or_default()),
            jni::objects::JValue::Bool(if notify_messages { 1 } else { 0 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyGrades").unwrap_or_default()),
            jni::objects::JValue::Bool(if notify_grades { 1 } else { 0 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyDeadlines").unwrap_or_default()),
            jni::objects::JValue::Bool(if notify_deadlines { 1 } else { 0 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("notifyCalendar").unwrap_or_default()),
            jni::objects::JValue::Bool(if notify_calendar { 1 } else { 0 }),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[
            jni::objects::JValue::from(&env.new_string("initialized").unwrap_or_default()),
            jni::objects::JValue::Bool(1),
        ],
    );
    
    let _ = env.call_method(
        &editor,
        "apply",
        "()V",
        &[],
    );
}

#[cfg(target_os = "android")]
async fn do_sync(data_dir: &str) -> String {
    use crate::client::{MagisterClient, TokenSet};
    use chrono::Utc;
    use std::path::PathBuf;

    let dir = PathBuf::from(data_dir);
    let token_path = dir.join("tokens.json");

    let token_data = match std::fs::read_to_string(&token_path) {
        Ok(data) => data,
        Err(_) => return "NO_TOKENS".to_string(),
    };

    let token_set: TokenSet = match serde_json::from_str(&token_data) {
        Ok(ts) => ts,
        Err(_) => return "INVALID_TOKENS".to_string(),
    };

    let mut client = MagisterClient::new();
    client.token_set = Some(token_set.clone());

    if let Err(e) = client.ensure_valid_token().await {
        return format!("AUTH_ERROR: {}", e);
    }

    // Save refreshed token if needed
    if let Ok(new_data) = serde_json::to_string_pretty(&client.token_set) {
        let _ = std::fs::write(&token_path, new_data);
    }

    let person_id = match client.token_set.as_ref().unwrap().person_id {
        Some(id) => id,
        None => return "NO_PERSON_ID".to_string(),
    };

    // Fetch all data in parallel
    let (messages_result, grades_result, assignments_result, calendar_result) = tokio::join!(
        fetch_messages(&client),
        fetch_recent_grades(&client),
        fetch_assignments(&client),
        fetch_calendar(&client, person_id, &today_string(), &tomorrow_string())
    );

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

async fn fetch_messages(client: &MagisterClient) -> serde_json::Value {
    match client.get("berichten/mappen/1/berichten?top=10&skip=0").await {
        Ok(data) => data,
        Err(_) => serde_json::json!([])
    }
}

async fn fetch_recent_grades(client: &MagisterClient) -> serde_json::Value {
    // Try to get grades from the last 30 days
    let thirty_days_ago = (Utc::now() - chrono::Duration::days(30)).format("%Y-%m-%d").to_string();
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let url = format!("resultaten?van={}&tot={}&top=50", thirty_days_ago, today);
    match client.get(&url).await {
        Ok(data) => {
            // Extract items from the response
            if let Some(items) = data.get("items") {
                items.clone()
            } else {
                data
            }
        },
        Err(_) => serde_json::json!([])
    }
}

async fn fetch_assignments(client: &MagisterClient) -> serde_json::Value {
    // Get assignments for next 14 days
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let two_weeks = (Utc::now() + chrono::Duration::days(14)).format("%Y-%m-%d").to_string();
    let url = format!("opdrachten?van={}&tot={}&top=50", today, two_weeks);
    match client.get(&url).await {
        Ok(data) => {
            if let Some(items) = data.get("items") {
                items.clone()
            } else {
                data
            }
        },
        Err(_) => serde_json::json!([])
    }
}

async fn fetch_calendar(client: &MagisterClient, person_id: i64, from: &str, to: &str) -> serde_json::Value {
    let url = format!("personen/{}/afspraken?van={}&tot={}", person_id, from, to);
    match client.get(&url).await {
        Ok(data) => {
            if let Some(items) = data.get("items") {
                items.clone()
            } else {
                data
            }
        },
        Err(_) => serde_json::json!([])
    }
}
