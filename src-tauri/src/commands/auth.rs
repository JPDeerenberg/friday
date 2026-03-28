use crate::auth::AuthFlow;
use crate::client::{MagisterClient, SharedClient, TokenSet};
use crate::models::account::ApiAccount;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry};

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

    // Exchange code for tokens
    let token_resp = auth
        .exchange_code(&redirect_url)
        .await
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

    // Save tokens to disk
    save_tokens_to_disk(&c, &app);

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
    let mut c = client.lock().await;
    let data = c
        .get("account?noCache=0")
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
    let mut client = client.lock().await;
    let url = format!("personen/{}/profiel", person_id);
    println!("Fetching profile info: {}", url);
    let response = client.get(&url).await.map_err(|e| {
        println!("Error fetching profile info: {}", e);
        e.to_string()
    })?;
    println!("Profile Info response: {}", response);
    let info: crate::models::account::ProfileInfo = serde_json::from_value(response.clone())
        .map_err(|e| {
            println!("Failed to parse profile info: {}", e);
            format!("Failed to parse profile info: {}", e)
        })?;
    Ok(info)
}

#[tauri::command]
pub async fn get_profile_addresses(
    client: State<'_, SharedClient>,
    person_id: i64,
) -> Result<Vec<crate::models::account::ProfileAddress>, String> {
    let mut client = client.lock().await;
    let url = format!("personen/{}/adressen", person_id);
    println!("Fetching profile addresses: {}", url);
    let response = client.get(&url).await.map_err(|e| {
        println!("Error fetching addresses: {}", e);
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
    let mut client = client.lock().await;
    let url = format!("personen/{}/opleidinggegevensprofiel", person_id);
    println!("Fetching career info: {}", url);
    let response = client.get(&url).await.map_err(|e| {
        println!("Error fetching career info: {}", e);
        e.to_string()
    })?;
    println!("Career Info response: {}", response);
    let career: crate::models::account::ProfileCareer = serde_json::from_value(response.clone())
        .map_err(|e| {
            println!("Failed to parse career info: {}", e);
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
    let mut c = client.lock().await;
    let url = format!("leerlingen/{person_id}/foto");
    println!("Fetching profile picture: {}", url);
    match c.get_bytes(&url).await {
        Ok(Some(bytes)) => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            println!("Got profile picture bytes: {}", bytes.len());
            Ok(Some(STANDARD.encode(bytes)))
        }
        Ok(None) => {
            println!("No profile picture found");
            Ok(None)
        }
        Err(e) => {
            println!("Warning: Failed to fetch profile picture: {}", e);
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

    // Remove token file
    use tauri::Manager;
    if let Ok(path) = app.path().app_data_dir() {
        let token_path = path.join("tokens.json");
        std::fs::remove_file(token_path).ok();
    }

    Ok(())
}

/// Try to restore session from saved tokens.
#[tauri::command]
pub async fn restore_session(
    client: State<'_, SharedClient>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let mut c = client.lock().await;

    use tauri::Manager;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let token_path = path.join("tokens.json");

    if token_path.exists() {
        let data = std::fs::read_to_string(&token_path).map_err(|e| e.to_string())?;
        let token_set: TokenSet = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        c.token_set = Some(token_set);

        // Try refreshing if expired
        if let Err(_) = c.ensure_valid_token().await {
            c.token_set = None;
            std::fs::remove_file(token_path).ok();
            return Ok(false);
        }

        // Save refreshed tokens
        save_tokens_to_disk(&c, &app);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn save_tokens_to_disk(client: &MagisterClient, app: &tauri::AppHandle) {
    if let Some(ref token_set) = client.token_set {
        use tauri::Manager;
        if let Ok(path) = app.path().app_data_dir() {
            std::fs::create_dir_all(&path).ok();
            let token_path = path.join("tokens.json");
            if let Ok(data) = serde_json::to_string_pretty(token_set) {
                std::fs::write(token_path, data).ok();
            }
        }
    }
}
