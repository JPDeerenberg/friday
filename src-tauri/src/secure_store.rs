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
        keyring::use_android_native_store(&HashMap::new()).map_err(|e| e.to_string())
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
    #[cfg(target_os = "android")]
    let entry = keyring_core::Entry::new(SERVICE, username).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let entry = keyring::Entry::new(SERVICE, username).map_err(|e| e.to_string())?.inner;
    Ok(entry)
}

/// Store a secret, returning an error string on failure.
pub fn set_secret(username: &str, value: &str) -> Result<(), String> {
    entry(username)?
        .set_password(value)
        .map_err(|e| e.to_string())
}

/// Read a secret. `Ok(None)` when no entry exists.
pub fn get_secret(username: &str) -> Result<Option<String>, String> {
    match entry(username)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret. Missing entries are treated as success.
pub fn delete_secret(username: &str) -> Result<(), String> {
    match entry(username)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
