//! OS-level secure storage for secrets (Magister tokens, AI API key).
//!
//! Wraps the [`keyring`] crate so secrets live in the OS credential store
//! (Keychain / Credential Manager / Secret Service on desktop, Keystore-backed
//! SharedPreferences on Android) instead of plaintext JSON files.
//!
//! Desktop uses keyring's `v1` feature, which auto-selects the platform store.
//! Android uses the Keystore-backed store, which requires ndk-context to be
//! initialized first (see `jni.rs` / `MainActivity.kt`).

#[cfg(target_os = "android")]
use std::sync::OnceLock;

/// Service name used for all Friday keyring entries.
pub const SERVICE: &str = "com.joris.friday";

// Usernames (entry keys) inside the service.
pub const USER_ACCESS_TOKEN: &str = "magister_access_token";
pub const USER_ID_TOKEN: &str = "magister_id_token";
pub const USER_REFRESH_TOKEN: &str = "magister_refresh_token";
pub const USER_AI_API_KEY: &str = "ai_api_key";

/// Ensure the platform credential store is ready before use.
/// On Android this must be called after ndk-context is initialized.
#[cfg(target_os = "android")]
pub fn ensure_store() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| {
        use std::collections::HashMap;
        use std::thread;
        use std::time::Duration;

        const ATTEMPTS: usize = 20;
        const RETRY_DELAY: Duration = Duration::from_millis(50);

        let mut last_error = None;
        for attempt in 0..ATTEMPTS {
            if !crate::jni::ndk_context_is_ready() {
                last_error = Some("android context was not initialized".to_string());
                if attempt + 1 < ATTEMPTS {
                    thread::sleep(RETRY_DELAY);
                }
                continue;
            }

            // use_android_native_store / vault lookup can panic if ndk-context
            // races or if a prior panic poisoned the vault list mutex. Never let
            // that unwind into a Tauri command (infinite loading spinner).
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                keyring::use_android_native_store(&HashMap::new())
            }));

            match result {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(error)) => {
                    last_error = Some(error.to_string());
                }
                Err(_) => {
                    last_error = Some(
                        "Android keyring panicked (ndk-context missing or vault lock poisoned)"
                            .to_string(),
                    );
                }
            }

            if attempt + 1 < ATTEMPTS {
                thread::sleep(RETRY_DELAY);
            }
        }

        Err(last_error.unwrap_or_else(|| "Android keyring initialization failed".to_string()))
    })
    .clone()
}

/// Ensure the platform credential store is ready before use.
/// On desktop the `v1` store is selected lazily by keyring itself, so nothing to do.
#[cfg(not(target_os = "android"))]
pub fn ensure_store() -> Result<(), String> {
    Ok(())
}

/// File name of the default `android-native-keyring-store` vault
/// (`StoreConfig::default().filename` — we create the store with an empty
/// configuration in `ensure_store`).
#[cfg(target_os = "android")]
const ANDROID_VAULT_FILE: &str = "keyring-default";

/// Make this process re-read the keyring's SharedPreferences file if another
/// process changed it.
///
/// The app runs in two processes (UI + `:sync`) that share one rotating
/// refresh token. Android caches a `SharedPreferences` file in memory per
/// process and, for `MODE_PRIVATE`, never notices writes made by another
/// process. Without this, one process keeps reading a refresh token the
/// other process already rotated, gets `invalid_grant` from Magister and
/// wipes the session — i.e. a random logout — and its own writes can also
/// overwrite the other process's newer tokens with stale ones.
///
/// Requesting the *same* (cached) file once with `MODE_MULTI_PROCESS` makes
/// the framework call `startReloadIfChangedUnexpectedly()`; later reads then
/// block until the reload finished. Best-effort: any failure is ignored and
/// leaves the old behaviour.
#[cfg(target_os = "android")]
fn reload_shared_prefs() {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    const MODE_PRIVATE_MULTI_PROCESS: i32 = 0 | 4; // MODE_PRIVATE | MODE_MULTI_PROCESS

    if !crate::jni::ndk_context_is_ready() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        let ctx = ndk_context::android_context();
        let Ok(vm) = (unsafe { JavaVM::from_raw(ctx.vm().cast()) }) else {
            return;
        };
        let Ok(mut env) = vm.attach_current_thread() else {
            return;
        };
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let Ok(name) = env.new_string(ANDROID_VAULT_FILE) else {
            return;
        };
        let _ = env.call_method(
            &context,
            "getSharedPreferences",
            "(Ljava/lang/String;I)Landroid/content/SharedPreferences;",
            &[JValue::from(&name), JValue::Int(MODE_PRIVATE_MULTI_PROCESS)],
        );
        if let Ok(true) = env.exception_check() {
            let _ = env.exception_clear();
        }
    });
}

/// Create a keyring entry for the given username.
fn entry(username: &str) -> Result<keyring_core::Entry, String> {
    ensure_store()?;
    // Every secret operation (get/set/delete) starts here, so a cross-process
    // change is always picked up before we read or modify the vault.
    #[cfg(target_os = "android")]
    reload_shared_prefs();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        #[cfg(target_os = "android")]
        {
            keyring_core::Entry::new(SERVICE, username).map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            keyring::Entry::new(SERVICE, username)
                .map(|e| e.inner)
                .map_err(|e| e.to_string())
        }
    }));
    match result {
        Ok(inner) => inner,
        Err(_) => Err("keyring Entry::new panicked".to_string()),
    }
}

/// Store a secret, returning an error string on failure.
pub fn set_secret(username: &str, value: &str) -> Result<(), String> {
    let entry = entry(username)?;
    let value = value.to_string();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        entry.set_password(&value).map_err(|e| e.to_string())
    }))
    .unwrap_or_else(|_| Err("keyring set_password panicked".to_string()))
}

/// Read a secret. `Ok(None)` when no entry exists.
pub fn get_secret(username: &str) -> Result<Option<String>, String> {
    let entry = entry(username)?;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| entry.get_password()));
    match result {
        Ok(Ok(v)) => Ok(Some(v)),
        Ok(Err(keyring_core::Error::NoEntry)) => Ok(None),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("keyring get_password panicked".to_string()),
    }
}

/// Delete a secret. Missing entries are treated as success.
pub fn delete_secret(username: &str) -> Result<(), String> {
    let entry = entry(username)?;
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| entry.delete_credential()));
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(keyring_core::Error::NoEntry)) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("keyring delete_credential panicked".to_string()),
    }
}
