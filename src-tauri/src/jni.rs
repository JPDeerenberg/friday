#[cfg(target_os = "android")]
use jni::{
    objects::{JClass, JString},
    sys::jstring,
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

    // 1. Fetch appointments for today and tomorrow
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let tomorrow = (Utc::now() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let url = format!("personen/{}/afspraken?van={}&tot={}", person_id, today, tomorrow);
    
    match client.get(&url).await {
        Ok(_) => "SYNC_SUCCESS".to_string(),
        Err(e) => format!("API_ERROR: {}", e),
    }
}
