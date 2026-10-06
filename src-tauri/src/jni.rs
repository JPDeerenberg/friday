#[cfg(target_os = "android")]
use jni::{
    objects::{JClass, JString},
    sys::{jint, jlong, jstring},
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
    trigger: JString<'local>,
    next_alarm_at_ms: jlong,
) -> jstring {
    let dir_path: String = match env.get_string(&data_dir) {
        Ok(s) => s.into(),
        Err(_) => "/data/user/0/com.joris.friday/files".to_string(),
    };
    // Who kicked off this run: "alarm" (exact-alarm chain), "periodic"
    // (WorkManager backstop) or "manual". Old Kotlin passes no trigger —
    // default to manual rather than failing the whole sync.
    let trigger_str: String = env
        .get_string(&trigger)
        .map(|s| s.into())
        .unwrap_or_else(|_| "manual".to_string());

    ensure_sync_logging(&dir_path);

    let rt = sync_runtime();
    let guard = rt.lock().unwrap_or_else(|e| e.into_inner());
    let sync_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        guard.block_on(async { do_sync(&dir_path, &trigger_str, next_alarm_at_ms as i64).await })
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
async fn do_sync(data_dir: &str, trigger: &str, next_alarm_at_ms: i64) -> String {
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

    let sync_started_at = std::time::Instant::now();
    let sync_started_ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    log::debug!("FridaySync (Rust): Fetching data from Magister...");
    // Take a cheap snapshot of the client (http + token) so the fetches can run
    // without holding the client's mutable state.
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

    // Sequential, polite fetching in priority order (calendar first — DND
    // depends on it). The old `tokio::join!` fired 4 simultaneous requests
    // that all hit the Magister rate limit together and then retried in
    // lockstep; a 300-800 ms jittered pause between sections keeps us under
    // the limit. Latency does not matter in the background.
    let today = today_string();
    let tomorrow = tomorrow_string();
    let order = ["calendar", "grades", "messages", "assignments"];
    // (section, result); sections never attempted after a rate-limit stop are
    // recorded separately as cascaded failures below.
    let mut results: Vec<(&str, Result<serde_json::Value, ClientError>)> = Vec::with_capacity(4);
    let mut rate_limited_stop = false;
    for (i, section) in order.into_iter().enumerate() {
        if i > 0 {
            polite_inter_section_delay().await;
        }
        let r = fetch_section(section, &ctx, person_id, &today, &tomorrow).await;
        if matches!(r, Err(ClientError::RateLimited)) {
            log::warn!(
                "FridaySync (Rust): section '{}' rate-limited — stopping, remaining sections marked failed (they would be limited too)",
                section
            );
            results.push((section, r));
            rate_limited_stop = true;
            break;
        }
        results.push((section, r));
    }
    let attempted: Vec<&str> = results.iter().map(|(s, _)| *s).collect();
    let skipped: Vec<&str> = order
        .into_iter()
        .filter(|s| !attempted.contains(s))
        .collect();
    if rate_limited_stop {
        log::warn!("FridaySync (Rust): skipped after rate-limit stop: {:?}", skipped);
    }

    // The snapshot above can go stale if the server expires the token
    // mid-sync (same race as the UI parallel reads): force one refresh and
    // retry just the failed fetches once instead of banking empty data.
    // Only sections that were actually attempted are retried — skipped
    // (rate-limit cascade) sections stay failed.
    let stale = results
        .iter()
        .any(|(_, r)| matches!(r, Err(ClientError::TokenExpiredRetryable(_))));
    if stale {
        log::info!("FridaySync (Rust): stale token mid-sync, forcing refresh and retrying failed fetches once");
        if let Some(ts) = client.token_set.as_mut() {
            ts.expires_at = Utc::now();
        }
        match client.ensure_valid_token().await {
            Ok(_) => match client.request_context().await {
                Ok(new_ctx) => {
                    for (section, r) in results.iter_mut() {
                        if matches!(r, Err(ClientError::TokenExpiredRetryable(_))) {
                            *r = fetch_section(*section, &new_ctx, person_id, &today, &tomorrow).await;
                        }
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

    for (section, r) in results.iter() {
        if let Err(e) = r {
            log::warn!("FridaySync (Rust): fetch_{} failed: {}", section, e);
        }
    }

    // A failed section is OMITTED from the payload (never `[]`): the Kotlin
    // side keeps the previous baseline for a missing section instead of
    // wiping it, which used to cause duplicate notification bursts and a
    // silently dropped DND schedule.
    let mut sections: Vec<(&str, Option<serde_json::Value>)> = Vec::with_capacity(4);
    for name in order {
        let value = results
            .iter()
            .find(|(s, _)| *s == name)
            .and_then(|(_, r)| r.as_ref().ok().cloned());
        sections.push((name, value));
    }
    let statuses: Vec<(&str, String)> = order
        .iter()
        .map(|name| {
            let status = match results.iter().find(|(s, _)| *s == *name) {
                Some((_, r)) => section_status(r),
                None => "failed(RateLimited-cascade)".to_string(),
            };
            (*name, status)
        })
        .collect();
    let status_of = |name: &str| {
        statuses
            .iter()
            .find(|(s, _)| *s == name)
            .map(|(_, st)| st.as_str())
            .unwrap_or("failed(unknown)")
    };

    let sync_data = build_sync_payload(&sections, chrono::Utc::now().timestamp());

    // One info-level line per run so cadence problems are diagnosable from
    // friday-sync.log (debug lines never land there).
    let next_alarm = if next_alarm_at_ms > 0 {
        chrono::DateTime::from_timestamp_millis(next_alarm_at_ms)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .unwrap_or_else(|| "unknown".to_string())
    } else {
        "unknown".to_string()
    };
    log::info!(
        "sync run trigger={} started={} elapsed_ms={} calendar={} grades={} messages={} assignments={} next_alarm={}",
        trigger,
        sync_started_ts,
        sync_started_at.elapsed().as_millis(),
        status_of("calendar"),
        status_of("grades"),
        status_of("messages"),
        status_of("assignments"),
        next_alarm,
    );

    log::debug!("FridaySync (Rust): ✓ Sync completed successfully");
    serde_json::to_string(&sync_data).unwrap_or_else(|_| "SYNC_SUCCESS".to_string())
}

/// Short stable label for a section outcome, used in the info-level run line.
fn section_status(result: &Result<serde_json::Value, ClientError>) -> String {
    match result {
        Ok(v) => format!("ok({})", v.as_array().map(|a| a.len()).unwrap_or(0)),
        Err(e) => format!("failed({})", short_error_label(e)),
    }
}

fn short_error_label(e: &ClientError) -> &'static str {
    match e {
        ClientError::RateLimited => "RateLimited",
        ClientError::RequestFailed(_) => "Network",
        ClientError::TokenExpiredRetryable(_) => "TokenExpired",
        ClientError::Unauthorized(_) => "Unauthorized",
        ClientError::TokenRefreshRejected(_) => "RefreshRejected",
        ClientError::TokenRefreshFailed(_) => "RefreshFailed",
        ClientError::NotAuthenticated => "NotAuthenticated",
        ClientError::ParseFailed(_) => "ParseFailed",
        ClientError::ApiError(_, _) => "ApiError",
    }
}

/// Build the sync-result JSON: successful sections as arrays, failed sections
/// OMITTED (not `[]`), plus a `"failed"` list naming them. The Kotlin side
/// treats a missing section as "keep previous baseline, no notifications".
fn build_sync_payload(
    sections: &[(&str, Option<serde_json::Value>)],
    timestamp: i64,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    let mut failed = Vec::new();
    for (name, value) in sections {
        match value {
            Some(v) => {
                map.insert(name.to_string(), v.clone());
            }
            None => failed.push(serde_json::Value::String(name.to_string())),
        }
    }
    map.insert(
        "failed".to_string(),
        serde_json::Value::Array(failed),
    );
    map.insert(
        "syncTimestamp".to_string(),
        serde_json::Value::from(timestamp),
    );
    serde_json::Value::Object(map)
}

/// 300-800 ms jittered pause between background fetches (Task B: no lockstep).
async fn polite_inter_section_delay() {
    use rand::RngExt;
    let ms: u64 = rand::rng().random_range(300..=800);
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// Fetch one sync section with background-appropriate patience:
/// one extra attempt after a short delay on a transient network error
/// (`error sending request`), and — via the shared Task A helper — one
/// background 429 wait of up to ~30 s plus a single retry before giving up.
/// A still-rate-limited section is returned as `RateLimited` so the caller
/// can stop the remaining sections (they would be limited too).
async fn fetch_section(
    section: &str,
    ctx: &RequestContext,
    person_id: i64,
    today: &str,
    tomorrow: &str,
) -> Result<serde_json::Value, ClientError> {
    let mut result = fetch_section_once(section, ctx, person_id, today, tomorrow).await;

    if matches!(result, Err(ClientError::RequestFailed(_))) {
        log::info!(
            "FridaySync (Rust): section '{}' hit a transient network error, one extra attempt after a short delay",
            section
        );
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        result = fetch_section_once(section, ctx, person_id, today, tomorrow).await;
    }

    if matches!(result, Err(ClientError::RateLimited)) {
        // The fetch already retried internally (foreground cap ~10 s); in the
        // background we can afford one longer wait before the final attempt.
        let wait = crate::client::rate_limit_delay(4, None, None, 30);
        log::info!(
            "FridaySync (Rust): section '{}' rate-limited, waiting {} s before one background retry",
            section,
            wait.as_secs()
        );
        tokio::time::sleep(wait).await;
        result = fetch_section_once(section, ctx, person_id, today, tomorrow).await;
    }

    result
}

async fn fetch_section_once(
    section: &str,
    ctx: &RequestContext,
    person_id: i64,
    today: &str,
    tomorrow: &str,
) -> Result<serde_json::Value, ClientError> {
    match section {
        "calendar" => fetch_calendar(ctx, person_id, today, tomorrow).await,
        "grades" => fetch_recent_grades(ctx, person_id).await,
        "messages" => fetch_messages(ctx).await,
        "assignments" => fetch_assignments(ctx, person_id).await,
        _ => fetch_messages(ctx).await,
    }
}

/// Sync day boundaries in Europe/Amsterdam (not UTC): between 00:00-02:00
/// Dutch time UTC `now()` belongs to the previous day.
fn today_string() -> String {
    crate::ai::time::today_amsterdam()
}

fn tomorrow_string() -> String {
    crate::ai::time::add_days(&today_string(), 1)
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
    // Get assignments for next 14 days (Amsterdam dates, like the calendar window)
    let today = crate::ai::time::today_amsterdam();
    let two_weeks = crate::ai::time::add_days(&today, 14);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn arr(n: usize) -> serde_json::Value {
        serde_json::Value::Array((0..n).map(|i| serde_json::json!({"Id": i})).collect())
    }

    #[test]
    fn all_sections_ok_has_no_failed_entries() {
        let sections = [
            ("calendar", Some(arr(12))),
            ("grades", Some(arr(3))),
            ("messages", Some(arr(5))),
            ("assignments", Some(arr(2))),
        ];
        let payload = build_sync_payload(&sections, 1_700_000_000);
        assert_eq!(payload["calendar"].as_array().unwrap().len(), 12);
        assert_eq!(payload["grades"].as_array().unwrap().len(), 3);
        assert_eq!(payload["messages"].as_array().unwrap().len(), 5);
        assert_eq!(payload["assignments"].as_array().unwrap().len(), 2);
        assert_eq!(payload["failed"].as_array().unwrap().len(), 0);
        assert_eq!(payload["syncTimestamp"], 1_700_000_000);
    }

    #[test]
    fn failed_section_is_omitted_not_empty() {
        // Regression test for the duplicate-notification burst: a failed
        // fetch must NOT appear as `[]` (which the Kotlin side used to treat
        // as "everything is gone / everything is new").
        let sections = [
            ("calendar", None),
            ("grades", Some(arr(3))),
            ("messages", Some(arr(0))),
            ("assignments", Some(arr(2))),
        ];
        let payload = build_sync_payload(&sections, 1_700_000_000);
        assert!(payload.get("calendar").is_none(), "failed section must be omitted");
        assert_eq!(payload["failed"], serde_json::json!(["calendar"]));
        // An empty-but-successful section stays present as `[]`.
        assert_eq!(payload["messages"], serde_json::json!([]));
        assert_eq!(payload["grades"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn all_sections_failed_keeps_only_failed_and_timestamp() {
        let sections: [(&str, Option<serde_json::Value>); 4] = [
            ("calendar", None),
            ("grades", None),
            ("messages", None),
            ("assignments", None),
        ];
        let payload = build_sync_payload(&sections, 1_700_000_000);
        assert!(payload.get("calendar").is_none());
        assert!(payload.get("grades").is_none());
        assert!(payload.get("messages").is_none());
        assert!(payload.get("assignments").is_none());
        let failed = payload["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 4);
        assert!(failed.contains(&serde_json::json!("calendar")));
        assert_eq!(payload["syncTimestamp"], 1_700_000_000);
    }

    #[test]
    fn section_status_labels_counts_and_error_kinds() {
        assert_eq!(section_status(&Ok(arr(12))), "ok(12)");
        assert_eq!(section_status(&Ok(arr(0))), "ok(0)");
        assert_eq!(
            section_status(&Err(ClientError::RateLimited)),
            "failed(RateLimited)"
        );
        assert_eq!(
            section_status(&Err(ClientError::RequestFailed("error sending request".into()))),
            "failed(Network)"
        );
        assert_eq!(
            section_status(&Err(ClientError::TokenExpiredRetryable("expired".into()))),
            "failed(TokenExpired)"
        );
    }
}
