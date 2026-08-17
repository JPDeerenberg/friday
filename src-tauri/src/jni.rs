#[cfg(target_os = "android")]
use jni::{
    objects::{JClass, JString},
    sys::{jint, jstring},
    JNIEnv,
};
#[cfg(target_os = "android")]
use tokio::runtime::{Builder, Runtime};
use crate::client::{get_with_context, MagisterClient, RequestContext};
use chrono::Utc;
use std::sync::{Mutex, OnceLock};

// A single, process-wide Tokio runtime shared across every JNI sync call instead of
// building a fresh multi-threaded runtime per invocation. `current_thread` matches the
// I/O-bound, mostly-sequential nature of `do_sync`, and the Mutex serializes sync
// execution so a `block_on` is never driven from two threads at once.
#[cfg(target_os = "android")]
static SYNC_RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

#[cfg(target_os = "android")]
fn sync_runtime() -> &'static Mutex<Runtime> {
    SYNC_RUNTIME.get_or_init(|| {
        Mutex::new(
            Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build tokio runtime"),
        )
    })
}

#[cfg(target_os = "android")]
fn ensure_ndk_context<'local>(
    env: &mut JNIEnv<'local>,
    context: jni::objects::JObject<'local>,
) {
    use std::ffi::c_void;

    let already_initialized = std::panic::catch_unwind(|| {
        let _ = ndk_context::android_context();
    })
    .is_ok();
    if already_initialized {
        return;
    }

    let vm = env.get_java_vm().ok();
    let Some(vm) = vm else { return };
    if let Ok(ref_) = env.new_global_ref(&context) {
        unsafe {
            ndk_context::initialize_android_context(
                vm.get_java_vm_pointer() as *mut c_void,
                ref_.as_obj().as_raw() as *mut c_void,
            );
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_SyncWorker_initNdkContext<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    context: jni::objects::JObject<'local>,
) {
    // Initialize the Android ndk-context so the keyring store can find the app
    // context. tao normally does this when the Activity is created, but the
    // WorkManager sync can run in a fresh process with no Activity ever created
    // (e.g. after reboot), so initialize it here if it isn't already set.
    ensure_ndk_context(&mut env, context);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_MainActivity_initNdkContext<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    context: jni::objects::JObject<'local>,
) {
    // Belt-and-suspenders for the UI process: tao's glue usually initializes
    // ndk-context on Activity creation, but behavior differs across versions, so
    // ensure it explicitly (guarded — safe to call repeatedly).
    ensure_ndk_context(&mut env, context);
}

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

    let rt = sync_runtime();
    let guard = rt.lock().unwrap_or_else(|e| e.into_inner());
    let sync_result = guard.block_on(async {
        do_sync(&dir_path).await
    });
    drop(guard);

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
        Err(_) => {
            let _ = env.exception_clear();
            log::error!("JNI ERROR: Failed to find NotificationHelper");
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

// Open/share a downloaded file on Android via the app's FileProvider so the user
// is shown a chooser instead of the file sitting in an app-private cache path.
// Called from the `download_file` Tauri command; reuses the same JNI pattern as the
// rest of this module (attach the current thread, then call into a Kotlin helper).
// The JavaVM comes from ndk-context, which the Tauri/tao Android runtime initializes
// before main.
pub fn share_downloaded_file(file_path: &std::path::Path) -> Result<(), String> {
    use jni::objects::JValue;
    use jni::JavaVM;

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }
        .map_err(|e| format!("Failed to get JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach current thread to JVM: {}", e))?;

    let class = env
        .find_class("com/joris/friday/ShareHelper")
        .map_err(|e| format!("Failed to find ShareHelper: {}", e))?;
    let context = unsafe { jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject) };
    let mime = mime_guess::from_path(file_path).first_or_octet_stream().to_string();
    let j_path = env
        .new_string(file_path.to_string_lossy().as_ref())
        .map_err(|e| e.to_string())?;
    let j_mime = env.new_string(&mime).map_err(|e| e.to_string())?;

    env.call_static_method(
        &class,
        "shareFile",
        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::from(&context),
            JValue::from(&j_path),
            JValue::from(&j_mime),
        ],
    )
    .map_err(|e| e.to_string())?;

    if let Ok(true) = env.exception_check() {
        let _ = env.exception_clear();
        return Err("Android share call threw an exception".to_string());
    }

    Ok(())
}

#[cfg(target_os = "android")]
async fn do_sync(data_dir: &str) -> String {
    use crate::client::{TokenSetPersistence, migrate_legacy_tokens};
    use std::path::PathBuf;

    let dir = PathBuf::from(data_dir);
    log::debug!("=== FridaySync (Rust): do_sync started ===");
    log::debug!("FridaySync (Rust): app_data_dir: {:?}", dir);

    // Load tokens from secure storage (keyring), migrating any legacy plaintext
    // tokens.json left over from before this feature.
    let token_set = TokenSetPersistence::load(&dir)
        .or_else(|| migrate_legacy_tokens(&dir))
        .map(|ts| {
            log::debug!("FridaySync (Rust): ✓ Tokens loaded from secure storage");
            ts
        });

    let token_set = match token_set {
        Some(ts) => ts,
        None => {
            log::error!("FridaySyncWorker (Rust): ERROR: Could not load tokens from secure storage (checked data_dir {:?})", dir);
            return "ERROR: NO_TOKENS".to_string()
        },
    };

    let mut client = MagisterClient::new();
    client.token_set = Some(token_set.clone());

    log::debug!("FridaySync (Rust): Ensuring valid token...");
    if let Err(e) = client.ensure_valid_token().await {
        log::error!("FridaySync (Rust): ERROR: Token validation failed: {}", e);
        return format!("AUTH_ERROR: {}", e);
    }
    log::debug!("FridaySync (Rust): ✓ Token is valid");

    // Save refreshed token if needed
    if let Some(ts) = &client.token_set {
        TokenSetPersistence::save(&dir, ts);
        log::debug!("FridaySync (Rust): Token refreshed and saved");
    }

    let person_id = match client.token_set.as_ref().unwrap().person_id {
        Some(id) => {
            log::debug!("FridaySync (Rust): Person ID: {}", id);
            id
        },
        None => {
            log::error!("FridaySync (Rust): ERROR: No person_id in token");
            return "ERROR: NO_PERSON_ID".to_string()
        }
    };

    log::debug!("FridaySync (Rust): Fetching data from Magister...");
    // Take a cheap snapshot of the client (http + token) so the four fetches can run
    // concurrently without holding the client's mutable state.
    let ctx = match client.request_context().await {
        Ok(ctx) => ctx,
        Err(e) => {
            log::error!("FridaySync (Rust): ERROR: Failed to build request context: {}", e);
            return format!("AUTH_ERROR: {}", e);
        }
    };

    // Fetch all data concurrently (don't return early to allow partial syncs).
    // Each fetch takes ~max(request latency) instead of the sum of all four.
    let today = today_string();
    let tomorrow = tomorrow_string();
    let (messages_result, grades_result, assignments_result, calendar_result) = tokio::join!(
        fetch_messages(&ctx),
        fetch_recent_grades(&ctx, person_id),
        fetch_assignments(&ctx, person_id),
        fetch_calendar(&ctx, person_id, &today, &tomorrow),
    );
    let messages_result = messages_result.unwrap_or_else(|e| {
        log::warn!("FridaySync (Rust): fetch_messages failed: {}", e);
        serde_json::json!([])
    });
    let grades_result = grades_result.unwrap_or_else(|e| {
        log::warn!("FridaySync (Rust): fetch_recent_grades failed: {}", e);
        serde_json::json!([])
    });
    let assignments_result = assignments_result.unwrap_or_else(|e| {
        log::warn!("FridaySync (Rust): fetch_assignments failed: {}", e);
        serde_json::json!([])
    });
    let calendar_result = calendar_result.unwrap_or_else(|e| {
        log::warn!("FridaySync (Rust): fetch_calendar failed: {}", e);
        serde_json::json!([])
    });

    let msg_count = messages_result.as_array().map(|a| a.len()).unwrap_or(0);
    let grades_count = grades_result.as_array().map(|a| a.len()).unwrap_or(0);
    let assignments_count = assignments_result.as_array().map(|a| a.len()).unwrap_or(0);
    let calendar_count = calendar_result.as_array().map(|a| a.len()).unwrap_or(0);

    log::debug!("FridaySync (Rust): Data fetched - messages: {}, grades: {}, assignments: {}, calendar: {}", 
        msg_count, grades_count, assignments_count, calendar_count);

    // Build JSON result with all data for change detection
    let sync_data = serde_json::json!({
        "messages": messages_result,
        "grades": grades_result,
        "assignments": assignments_result,
        "calendar": calendar_result,
        "syncTimestamp": chrono::Utc::now().timestamp()
    });

    log::debug!("FridaySync (Rust): ✓ Sync completed successfully");
    serde_json::to_string(&sync_data).unwrap_or_else(|_| "SYNC_SUCCESS".to_string())
}

fn today_string() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

fn tomorrow_string() -> String {
    (Utc::now() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
}

async fn fetch_messages(ctx: &RequestContext) -> Result<serde_json::Value, String> {
    match get_with_context(ctx, "berichten/mappen/1/berichten?top=50&skip=0").await {
        Ok(data) => {
            if let Some(items) = data.get("items").or(data.get("Items")).filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}

async fn fetch_recent_grades(ctx: &RequestContext, person_id: i64) -> Result<serde_json::Value, String> {
    let url = format!("personen/{}/cijfers/laatste?top=50&skip=0", person_id);
    match get_with_context(ctx, &url).await {
        Ok(data) => {
            // Extract items from the response
            if let Some(items) = data.get("items").or(data.get("Items")).filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}

async fn fetch_assignments(ctx: &RequestContext, person_id: i64) -> Result<serde_json::Value, String> {
    // Get assignments for next 14 days
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let two_weeks = (Utc::now() + chrono::Duration::days(14)).format("%Y-%m-%d").to_string();
    let url = format!("personen/{}/opdrachten?einddatum={}&startdatum={}&top=50", person_id, two_weeks, today);
    match get_with_context(ctx, &url).await {
        Ok(data) => {
            if let Some(items) = data.get("items").or(data.get("Items")).filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}

async fn fetch_calendar(ctx: &RequestContext, person_id: i64, from: &str, to: &str) -> Result<serde_json::Value, String> {
    let url = format!("personen/{}/afspraken?van={}&tot={}", person_id, from, to);
    match get_with_context(ctx, &url).await {
        Ok(data) => {
            if let Some(items) = data.get("items").or(data.get("Items")).filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e.to_string())
    }
}
