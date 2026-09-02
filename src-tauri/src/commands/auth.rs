use crate::auth::AuthFlow;
use crate::client::{MagisterClient, SharedClient, TokenSet};
use crate::models::account::ApiAccount;
use tauri::{AppHandle, State};
#[cfg(not(target_os = "android"))]
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

/// Start a new auth flow by opening a webview window.
#[tauri::command]
pub async fn start_login_flow(
    client: State<'_, SharedClient>,
    app: AppHandle,
    tenant: Option<String>,
    username: Option<String>,
) -> Result<(), String> {
    let mut c = client.lock().await;
    let auth = AuthFlow::new();
    let url = auth.generate_login_url(tenant.as_deref(), username.as_deref());
    c.auth_flow = Some(auth);

    #[cfg(target_os = "android")]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url.to_string(), None::<&str>)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        // Close existing login window if any
        if let Some(window) = Manager::<Wry>::get_webview_window(&app, "magister-login") {
            let _ = window.destroy();
        }

        let client_clone = client.inner().clone();
        let app_clone = app.clone();

        // Create a new webview window for login (works on desktop and Android/iOS)
        let builder = WebviewWindowBuilder::new(
            &app,
            "magister-login",
            WebviewUrl::External(url.parse().unwrap()),
        )
        .title("Magister Login")
        .inner_size(500.0, 700.0)
        .resizable(false)
        .center();

        // Intercept m6loapp:// redirects inside the webview
        builder
            .on_navigation(move |nav_url: &url::Url| {
                let url_str = nav_url.as_str();
                if url_str.starts_with("m6loapp://") {
                    let client_arc = client_clone.clone();
                    let app_handle = app_clone.clone();
                    let redirect_url = url_str.to_string();

                    // Spawn async task to handle the callback
                    tauri::async_runtime::spawn(async move {
                        match handle_auth_callback_internal(client_arc, app_handle.clone(), redirect_url).await
                        {
                            Ok(account) => {
                                app_handle.emit("auth-success", account).ok();
                            }
                            Err(e) => {
                                app_handle.emit("auth-error", e).ok();
                            }
                        }
                        // Close the login window
                        if let Some(window) = Manager::<Wry>::get_webview_window(&app_handle, "magister-login") {
                            let _ = window.destroy();
                        }
                    });
                    // Cancel navigation since we are intercepting it
                    return false;
                }
                true
            })
            .build()
            .map_err(|e| format!("Failed to build login window: {}", e))?;
        
        Ok(())
    }
}

/// Internal helper to handle the OAuth2 callback Exchange code for tokens.
async fn handle_auth_callback_internal(
    client_arc: SharedClient,
    app: AppHandle,
    redirect_url: String,
) -> Result<ApiAccount, String> {
    let mut c = client_arc.lock().await;

    let auth = c.auth_flow.take().ok_or("No auth flow in progress")?;

    // Verify the state parameter (CSRF protection) before exchanging the code.
    auth.verify_state(&redirect_url).map_err(|e| e.to_string())?;

    // Exchange code for tokens
    let token_resp = auth
        .exchange_code(&redirect_url)
        .await
        .map_err(|e| e.to_string())?;

    // Verify the id_token's nonce claim ties it to this login attempt.
    auth.verify_id_token_nonce(&token_resp.id_token)
        .map_err(|e| e.to_string())?;

    // Discover API endpoint
    let api_endpoint = AuthFlow::discover_api_endpoint(&token_resp.access_token)
        .await
        .map_err(|e| e.to_string())?;

    // Create and store token set
    let token_set = TokenSet::from_response(&token_resp, &api_endpoint);
    c.token_set = Some(token_set);

    // Fetch account info
    let account_data = c
        .get("account?noCache=0")
        .await
        .map_err(|e| e.to_string())?;
    let account: ApiAccount = serde_json::from_value(account_data).map_err(|e| e.to_string())?;

    // Store person ID and UUID
    if let Some(ref mut ts) = c.token_set {
        ts.person_id = Some(account.persoon.id);
        ts.account_uuid = Some(account.uuid.clone());
    }

    // Persist tokens without blocking the tokio worker on Android keyring JNI.
    // Mirrors the spawn_blocking pattern in restore_session / AiState::load_api_key_async.
    let token_set_for_save = c.token_set.clone();
    let app_for_save = app.clone();
    drop(c);
    if let Some(ts) = token_set_for_save {
        tokio::task::spawn_blocking(move || {
            use tauri::Manager;
            if let Ok(path) = app_for_save.path().app_data_dir() {
                crate::client::TokenSetPersistence::save(&path, &ts);
            }
        })
        .await
        .map_err(|e| format!("token save join error: {e}"))?;
    }

    Ok(account)
}

#[tauri::command]
pub async fn handle_auth_callback(
    client: State<'_, SharedClient>,
    app: tauri::AppHandle,
    redirect_url: String,
) -> Result<ApiAccount, String> {
    handle_auth_callback_internal(client.inner().clone(), app, redirect_url).await
}

/// Check if user is authenticated and tokens are available.
#[tauri::command]
pub async fn is_authenticated(client: State<'_, SharedClient>) -> Result<bool, String> {
    let c = client.lock().await;
    Ok(c.token_set.is_some())
}

/// Get current account info.
#[tauri::command]
pub async fn get_account(client: State<'_, SharedClient>) -> Result<ApiAccount, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let data = crate::client::get_with_context(&ctx, "account?noCache=0")
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(data).map_err(|e| e.to_string())
}

/// Get the stored person ID.
#[tauri::command]
pub async fn get_profile_info(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<crate::models::account::ProfileInfo, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let url = format!("personen/{}/profiel", person_id);
    log::debug!("Fetching profile info: {}", url);
    let response = crate::client::get_with_context(&ctx, &url).await.map_err(|e| {
        log::error!("Error fetching profile info: {}", e);
        e.to_string()
    })?;
    log::debug!("Profile Info response: {}", response);
    let info: crate::models::account::ProfileInfo = serde_json::from_value(response.clone())
        .map_err(|e| {
            log::error!("Failed to parse profile info: {}", e);
            format!("Failed to parse profile info: {}", e)
        })?;
    Ok(info)
}

#[tauri::command]
pub async fn get_profile_addresses(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<crate::models::account::ProfileAddress>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let url = format!("personen/{}/adressen", person_id);
    log::debug!("Fetching profile addresses: {}", url);
    let response = crate::client::get_with_context(&ctx, &url).await.map_err(|e| {
        log::error!("Error fetching addresses: {}", e);
        e.to_string()
    })?;
    let res: crate::models::account::ProfileAddressResponse = serde_json::from_value(response)
        .map_err(|e| format!("Failed to parse addresses: {}", e))?;
    Ok(res.items)
}

#[tauri::command]
pub async fn get_career_info(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<crate::models::account::ProfileCareer, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let url = format!("personen/{}/opleidinggegevensprofiel", person_id);
    log::debug!("Fetching career info: {}", url);
    let response = crate::client::get_with_context(&ctx, &url).await.map_err(|e| {
        log::error!("Error fetching career info: {}", e);
        e.to_string()
    })?;
    log::debug!("Career Info response: {}", response);
    let career: crate::models::account::ProfileCareer = serde_json::from_value(response.clone())
        .map_err(|e| {
            log::error!("Failed to parse career info: {}", e);
            format!("Failed to parse career info: {}", e)
        })?;
    Ok(career)
}

#[tauri::command]
pub async fn get_person_id(client: State<'_, SharedClient>) -> Result<i64, String> {
    let c = client.lock().await;
    c.token_set
        .as_ref()
        .and_then(|ts| ts.person_id)
        .ok_or("Not authenticated".to_string())
}

/// Get profile picture as base64 string.
#[tauri::command]
pub async fn get_profile_picture(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Option<String>, String> {
    let ctx = {
        let mut c = client.lock().await;
        c.request_context().await.map_err(|e| e.to_string())?
    };
    let url = format!("leerlingen/{person_id}/foto");
    log::debug!("Fetching profile picture: {}", url);
    match crate::client::get_bytes_with_context(&ctx, &url).await {
        Ok(Some(bytes)) => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            log::debug!("Got profile picture bytes: {}", bytes.len());
            Ok(Some(STANDARD.encode(bytes)))
        }
        Ok(None) => {
            log::debug!("No profile picture found");
            Ok(None)
        }
        Err(e) => {
            log::warn!("Failed to fetch profile picture: {}", e);
            Ok(None) // Return None instead of Err to avoid breaking Promise.all
        }
    }
}

/// Logout — clear tokens.
#[tauri::command]
pub async fn logout(client: State<'_, SharedClient>, app: tauri::AppHandle) -> Result<(), String> {
    let mut c = client.lock().await;
    c.token_set = None;
    c.auth_flow = None;

    // Remove all persisted token data (metadata file + keyring entries).
    c.clear_persisted_tokens(&app);

    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreSessionStatus {
    Restored,
    LoggedOut,
    Unavailable,
}

/// Try to restore session from saved tokens.
///
/// Distinguishes three outcomes:
/// - `restored` — session is valid (refreshed if needed)
/// - `logged_out` — no stored session, or server explicitly rejected the
///   refresh token (`invalid_grant`) — safe to wipe local tokens
/// - `unavailable` — transient failure (no network, timeout, 5xx, parse
///   failure) — tokens are kept on disk, frontend should NOT show the login
///   screen and should retry when connectivity returns.
#[tauri::command]
pub async fn restore_session(
    client: State<'_, SharedClient>,
    app: tauri::AppHandle,
) -> Result<RestoreSessionStatus, String> {
    use tauri::Manager;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // Android keyring does JNI; keep it off the async executor so we don't
    // block/panic a tokio worker during startup.
    let path_for_load = path.clone();
    let token_set = tokio::task::spawn_blocking(move || {
        crate::client::TokenSetPersistence::load(&path_for_load)
            .or_else(|| crate::client::migrate_legacy_tokens(&path_for_load))
    })
    .await
    .map_err(|e| format!("restore_session join error: {e}"))?;

    let token_set = match token_set {
        Some(ts) => ts,
        None => return Ok(RestoreSessionStatus::LoggedOut),
    };

    let mut c = client.lock().await;
    c.token_set = Some(token_set);

    match c.ensure_valid_token().await {
        Ok(_) => {
            save_tokens_to_disk(&c, &app);
            Ok(RestoreSessionStatus::Restored)
        }
        Err(e) if e.is_rejected() => {
            log::warn!("restore_session: refresh rejected ({}), clearing persisted tokens", e);
            c.token_set = None;
            c.clear_persisted_tokens(&app);
            Ok(RestoreSessionStatus::LoggedOut)
        }
        Err(e) => {
            // Transient or unexpected — keep the on-disk tokens intact so the
            // app recovers once connectivity returns, without forcing re-login.
            log::warn!("restore_session: transient/unavailable ({}), keeping tokens", e);
            Ok(RestoreSessionStatus::Unavailable)
        }
    }
}

fn save_tokens_to_disk(client: &MagisterClient, app: &tauri::AppHandle) {
    if let Some(ref token_set) = client.token_set {
        use tauri::Manager;
        if let Ok(path) = app.path().app_data_dir() {
            crate::client::TokenSetPersistence::save(&path, token_set);
        }
    }
}
