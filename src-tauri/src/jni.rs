#[cfg(target_os = "android")]
use jni::{
    objects::{JClass, JString},
    sys::{jint, jstring},
    JNIEnv,
};
#[cfg(target_os = "android")]
use tokio::runtime::{Builder, Runtime};
use crate::client::{get_with_context, ClientError, MagisterClient, RequestContext};
use chrono::Utc;
use std::sync::{Mutex, OnceLock};

// A single, process-wide Tokio runtime shared across every JNI sync call instead of
// building a fresh multi-threaded runtime per invocation. `current_thread` matches the
// I/O-bound, mostly-sequential nature of `do_sync`, and the Mutex serializes sync
// execution so a `block_on` is never driven from two threads at once.
#[cfg(target_os = "android")]
static SYNC_RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

#[cfg(target_os = "android")]
static SYNC_LOGGING_INITIALIZED: OnceLock<()> = OnceLock::new();

/// Minimal `log::Log` impl for the `:sync` process. See the "background
/// sync process has been invisible" writeup in
/// FRIDAY_AUTH_LOGOUT_DIAGNOSIS_V3.md for why this is needed: the
/// `tauri_plugin_log` logger `lib.rs::run()` installs only exists in the
/// main app process, which `:sync` never runs.
#[cfg(target_os = "android")]
struct SyncFileLogger {
    file: Mutex<std::fs::File>,
}

#[cfg(target_os = "android")]
impl log::Log for SyncFileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if let Ok(mut f) = self.file.lock() {
            use std::io::Write;
            let _ = writeln!(f, "[{}] {}", record.target(), record.args());
        }
    }
    fn flush(&self) {
        if let Ok(mut f) = self.file.lock() {
            let _ = std::io::Write::flush(&mut *f);
        }
    }
}

/// Installs the logger above (writing into the SAME app_log_dir directory
/// `export_debug_log` already zips wholesale — as a separate
/// `friday-sync.log` file, so no changes needed there) and a panic hook
/// that logs through it. Idempotent per-process: WorkManager can invoke
/// `runSync` more than once on a warm `:sync` process.
#[cfg(target_os = "android")]
fn ensure_sync_logging(data_dir: &str) {
    SYNC_LOGGING_INITIALIZED.get_or_init(|| {
        let log_dir = std::path::PathBuf::from(data_dir).join("logs");
        if std::fs::create_dir_all(&log_dir).is_err() {
            return;
        }
        let path = log_dir.join("friday-sync.log");
        let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
            return;
        };
        if log::set_boxed_logger(Box::new(SyncFileLogger { file: Mutex::new(file) })).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
        // A panic anywhere in do_sync()'s call graph currently aborts this
        // process outright (unwinding across runSync's FFI boundary,
        // caught below). Without this hook, an abort leaves no trace
        // anywhere. This is what makes the *cause* visible instead of
        // just "sync silently stopped happening".
        std::panic::set_hook(Box::new(|info| {
            log::error!("FridaySync (Rust): PANIC: {}", info);
        }));
    });
}

#[cfg(target_os = "android")]
static NDK_CONTEXT_INITIALIZED: OnceLock<()> = OnceLock::new();

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

/// True if `ndk-context` currently has a context installed (by Tao or by us).
///
/// `ndk_context::android_context()` has no non-panicking accessor — it's a bare
/// `.expect()` — so this is the one place in the codebase allowed to deliberately
/// trigger and catch that panic. Every other caller (this module, `secure_store.rs`)
/// must go through this function or `wait_for_ndk_context` below instead of
/// re-implementing the same probe.
#[cfg(target_os = "android")]
pub(crate) fn ndk_context_is_ready() -> bool {
    std::panic::catch_unwind(|| {
        let _ = ndk_context::android_context();
    })
    .is_ok()
}

/// Block the calling thread until `ndk-context` is ready, or give up.
///
/// Tao initializes `ndk-context` asynchronously during app startup, so anything
/// that needs it — keyring access, file sharing — has to tolerate a short window
/// where it isn't ready yet. This polls instead of guessing a fixed delay: it
/// returns as soon as the context is ready, and gives up only after `attempts`
/// tries, so callers get a real yes/no instead of a lucky/unlucky guess.
#[cfg(target_os = "android")]
pub(crate) fn wait_for_ndk_context(attempts: usize, delay: std::time::Duration) -> bool {
    for attempt in 0..attempts {
        if ndk_context_is_ready() {
            return true;
        }
        if attempt + 1 < attempts {
            std::thread::sleep(delay);
        }
    }
    false
}

/// Best-effort eager init of `ndk-context`, called from MainActivity/SyncWorker's
/// onCreate. This is an optimization, not the correctness guarantee — callers that
/// actually need the context (keyring, file sharing) are responsible for waiting
/// via `wait_for_ndk_context` themselves, since Tao may still win the race and
/// initialize it asynchronously after this returns. This function exists so the
/// common case (this call wins) avoids that wait entirely.
///
/// `ndk-context` 0.1.1 only allows a single init (a second call asserts), so we
/// probe first and only initialize when missing.
#[cfg(target_os = "android")]
fn ensure_ndk_context<'local>(env: &mut JNIEnv<'local>, context: jni::objects::JObject<'local>) {
    use std::ffi::c_void;

    if ndk_context_is_ready() {
        let _ = NDK_CONTEXT_INITIALIZED.set(());
        return;
    }

    NDK_CONTEXT_INITIALIZED.get_or_init(|| {
        // Tao may have won the race between the probe above and this block.
        if ndk_context_is_ready() {
            return;
        }

        let Ok(vm) = env.get_java_vm() else { return };
        let Ok(ref_) = env.new_global_ref(&context) else {
            return;
        };
        let context_ptr = ref_.as_obj().as_raw() as *mut c_void;

        // Double-check immediately before the assert-on-duplicate init.
        if ndk_context_is_ready() {
            return;
        }

        let init_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            ndk_context::initialize_android_context(
                vm.get_java_vm_pointer() as *mut c_void,
                context_ptr,
            );
        }));

        match init_result {
            Ok(()) => {
                // ndk-context stores the raw JNI reference for the process lifetime.
                std::mem::forget(ref_);
            }
            Err(_) => {
                // Tao initialized between our last probe and initialize — drop GlobalRef.
                log::debug!("ndk-context already initialized by runtime; skipping our init");
            }
        }
    });
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_SyncWorker_initNdkContext<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    context: jni::objects::JObject<'local>,
) {
    // WorkManager can run in a fresh process with no Activity; initialize here.
    ensure_ndk_context(&mut env, context);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_joris_friday_MainActivity_initNdkContext<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    context: jni::objects::JObject<'local>,
) {
    // UI process: init early so restore_session/keyring never race Tao's async setup.
    // Race-safe with Tao (probe + catch_unwind around initialize).
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

    ensure_sync_logging(&dir_path);

    let rt = sync_runtime();
    let guard = rt.lock().unwrap_or_else(|e| e.into_inner());
    let sync_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        guard.block_on(async { do_sync(&dir_path).await })
    }))
    .unwrap_or_else(|_| {
        log::error!("FridaySync (Rust): do_sync panicked — recovered, returning an error instead of aborting the process");
        "ERROR: PANIC".to_string()
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
// In practice this runs well after startup (the user has to be logged in and browsing
// to trigger a download), so the race is unlikely — but "unlikely" isn't a guarantee,
// so it waits the same way every other ndk-context consumer does.
pub fn share_downloaded_file(file_path: &std::path::Path) -> Result<(), String> {
    use jni::objects::JValue;
    use jni::JavaVM;

    if !wait_for_ndk_context(20, std::time::Duration::from_millis(50)) {
        return Err("Android context not ready yet — try again in a moment".to_string());
    }

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }
        .map_err(|e| format!("Failed to get JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach current thread to JVM: {}", e))?;

    let context = unsafe { jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject) };

    // Resolve through the context's own ClassLoader, NOT `find_class`: this runs
    // on a Tauri worker thread attached via `attach_current_thread` (no Java
    // frames), where `find_class` uses the system classloader and can never see
    // app classes — it always throws ClassNotFoundException, even when R8 kept
    // the class (the ProGuard `-keep` in proguard-rules.pro is still required,
    // just not sufficient on its own). Same JNI thread isolation already
    // handled by `find_app_class` for test notifications.
    let class = match crate::commands::notifications::find_app_class(
        &mut env,
        &context,
        "com.joris.friday.ShareHelper",
    ) {
        Ok(c) => c,
        Err(e) => {
            // A failed load leaves a pending exception on this thread — clear it
            // so the failure surfaces as a normal Tauri error string instead of
            // escalating to a FATAL EXCEPTION that kills the process.
            let _ = env.exception_clear();
            return Err(format!("Failed to find ShareHelper: {}", e));
        }
    };
    let mime = mime_guess::from_path(file_path).first_or_octet_stream().to_string();
    let j_path = match env.new_string(file_path.to_string_lossy().as_ref()) {
        Ok(s) => s,
        Err(e) => {
            let _ = env.exception_clear();
            return Err(e.to_string());
        }
    };
    let j_mime = match env.new_string(&mime) {
        Ok(s) => s,
        Err(e) => {
            let _ = env.exception_clear();
            return Err(e.to_string());
        }
    };

    if let Err(e) = env.call_static_method(
        &class,
        "shareFile",
        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::from(&context),
            JValue::from(&j_path),
            JValue::from(&j_mime),
        ],
    ) {
        // A Java-side throw also leaves a pending exception behind — clear it
        // for the same reason as above: never let it kill the process.
        let _ = env.exception_clear();
        return Err(e.to_string());
    }

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
    // tokens.json left over from before this feature. A transient store
    // failure (keyring/ndk hiccup) is retriable; a definitive "nothing
    // stored" (logged out) or a dead refresh token is not — the Kotlin
    // side only retries transient failures.
    let token_set = match TokenSetPersistence::load_detailed(&dir) {
        Ok(Some(ts)) => {
            log::debug!("FridaySync (Rust): ✓ Tokens loaded from secure storage");
            ts
        }
        Ok(None) => match migrate_legacy_tokens(&dir) {
            Some(ts) => {
                log::debug!("FridaySync (Rust): ✓ Legacy tokens migrated");
                ts
            }
            None => {
                log::error!("FridaySyncWorker (Rust): ERROR: Could not load tokens from secure storage (checked data_dir {:?})", dir);
                return "ERROR: NO_TOKENS".to_string();
            }
        },
        Err(e) => {
            log::warn!("FridaySyncWorker (Rust): token store unreadable ({}), will retry later", e);
            return "ERROR: STORE_UNAVAILABLE".to_string();
        }
    };

    let mut client = MagisterClient::new();
    client.token_set = Some(token_set.clone());
    client.set_data_dir(dir.clone());

    log::debug!("FridaySync (Rust): Ensuring valid token...");
    if let Err(e) = client.ensure_valid_token().await {
        log::error!("FridaySync (Rust): ERROR: Token validation failed: {}", e);
        // A rejected refresh (invalid_grant — logged out elsewhere) will
        // never succeed on retry; only transient failures should retry.
        if e.is_rejected() {
            return format!("AUTH_REJECTED: {}", e);
        }
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
            if e.is_rejected() {
                return format!("AUTH_REJECTED: {}", e);
            }
            return format!("AUTH_ERROR: {}", e);
        }
    };

    // Fetch all data concurrently (don't return early to allow partial syncs).
    // Each fetch takes ~max(request latency) instead of the sum of all four.
    let today = today_string();
    let tomorrow = tomorrow_string();
    let (mut messages_result, mut grades_result, mut assignments_result, mut calendar_result) = tokio::join!(
        fetch_messages(&ctx),
        fetch_recent_grades(&ctx, person_id),
        fetch_assignments(&ctx, person_id),
        fetch_calendar(&ctx, person_id, &today, &tomorrow),
    );

    // The snapshot above can go stale if the server expires the token
    // mid-sync (same race as the UI parallel reads): force one refresh and
    // retry just the failed fetches once instead of banking empty data.
    let stale = [&messages_result, &grades_result, &assignments_result, &calendar_result]
        .iter()
        .any(|r| matches!(r, Err(ClientError::TokenExpiredRetryable(_))));
    if stale {
        log::info!("FridaySync (Rust): stale token mid-sync, forcing refresh and retrying failed fetches once");
        if let Some(ts) = client.token_set.as_mut() {
            ts.expires_at = Utc::now();
        }
        match client.ensure_valid_token().await {
            Ok(_) => match client.request_context().await {
                Ok(new_ctx) => {
                    if matches!(messages_result, Err(ClientError::TokenExpiredRetryable(_))) {
                        messages_result = fetch_messages(&new_ctx).await;
                    }
                    if matches!(grades_result, Err(ClientError::TokenExpiredRetryable(_))) {
                        grades_result = fetch_recent_grades(&new_ctx, person_id).await;
                    }
                    if matches!(assignments_result, Err(ClientError::TokenExpiredRetryable(_))) {
                        assignments_result = fetch_assignments(&new_ctx, person_id).await;
                    }
                    if matches!(calendar_result, Err(ClientError::TokenExpiredRetryable(_))) {
                        calendar_result = fetch_calendar(&new_ctx, person_id, &today, &tomorrow).await;
                    }
                }
                Err(e) => log::warn!("FridaySync (Rust): retry context failed: {}", e),
            },
            Err(e) => {
                log::error!("FridaySync (Rust): refresh during sync retry failed: {}", e);
                if e.is_rejected() {
                    return format!("AUTH_REJECTED: {}", e);
                }
            }
        }
    }
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

async fn fetch_messages(ctx: &RequestContext) -> Result<serde_json::Value, ClientError> {
    match get_with_context(ctx, "berichten/mappen/1/berichten?top=50&skip=0").await {
        Ok(data) => {
            if let Some(items) = data.get("items").or(data.get("Items")).filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e)
    }
}

async fn fetch_recent_grades(ctx: &RequestContext, person_id: i64) -> Result<serde_json::Value, ClientError> {
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
        Err(e) => Err(e)
    }
}

async fn fetch_assignments(ctx: &RequestContext, person_id: i64) -> Result<serde_json::Value, ClientError> {
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
        Err(e) => Err(e)
    }
}

async fn fetch_calendar(ctx: &RequestContext, person_id: i64, from: &str, to: &str) -> Result<serde_json::Value, ClientError> {
    let url = format!("personen/{}/afspraken?van={}&tot={}", person_id, from, to);
    match get_with_context(ctx, &url).await {
        Ok(data) => {
            if let Some(items) = data.get("items").or(data.get("Items")).filter(|v| v.is_array()) {
                Ok(items.clone())
            } else {
                Ok(data)
            }
        },
        Err(e) => Err(e)
    }
}
