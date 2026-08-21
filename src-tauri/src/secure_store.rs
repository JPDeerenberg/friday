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

/// True when `ndk-context` has been initialized (Tao or our JNI helper).
/// Never panics — `android_context()` itself panics if unset.
#[cfg(target_os = "android")]
fn ndk_context_ready() -> bool {
    std::panic::catch_unwind(|| {
        let _ = ndk_context::android_context();
    })
    .is_ok()
}

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
            if !ndk_context_ready() {
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

/// Create a keyring entry for the given username.
fn entry(username: &str) -> Result<keyring_core::Entry, String> {
    ensure_store()?;
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
