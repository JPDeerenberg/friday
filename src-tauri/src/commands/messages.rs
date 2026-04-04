use tauri::State;

use crate::client::SharedClient;
use crate::models::messages::{
    AttachmentRef, Bericht, Contact, ContactRef, ContactsResponse, FoldersResponse, MessagesFolder,
    MessagesResponse, SendMessageRequest,
};

/// Get all message folders.
#[tauri::command]
pub async fn get_message_folders(
    client: State<'_, SharedClient>,
) -> Result<Vec<MessagesFolder>, String> {
    let mut c = client.lock().await;

    let data = c
        .get("berichten/mappen/alle")
        .await
        .map_err(|e| e.to_string())?;

    let resp: FoldersResponse = serde_json::from_value(data).map_err(|e| e.to_string())?;

    Ok(resp.items)
}

/// Get messages from a folder.
#[tauri::command]
pub async fn get_messages(
    client: State<'_, SharedClient>,
    berichten_link: String, // e.g. "berichten/mappen/1/berichten"
    top: Option<i32>,
    skip: Option<i32>,
    query: Option<String>,
) -> Result<Vec<Bericht>, String> {
    let mut c = client.lock().await;

    let link = berichten_link.replace("/api/", "");
    let mut params = vec![];
    params.push(format!("top={}", top.unwrap_or(15)));
    params.push(format!("skip={}", skip.unwrap_or(0)));
    if let Some(q) = &query {
        let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
        params.push(format!("trefwoorden={}", encoded));
    }

    let path = format!("{}?{}", link, params.join("&"));
    let data = c.get(&path).await.map_err(|e| e.to_string())?;

    let resp: MessagesResponse = serde_json::from_value(data).map_err(|e| e.to_string())?;

    Ok(resp.items.unwrap_or_default())
}

/// Get full message details (content, recipients, attachments).
#[tauri::command]
pub async fn get_message_detail(
    client: State<'_, SharedClient>,
    self_link: String,
) -> Result<Bericht, String> {
    let mut c = client.lock().await;
    let link = self_link.replace("/api/", "");
    let data = c.get(&link).await.map_err(|e| e.to_string())?;
    serde_json::from_value(data).map_err(|e| e.to_string())
}

/// Send a new message.
#[tauri::command]
pub async fn send_message(
    client: State<'_, SharedClient>,
    recipients: Vec<i64>,
    copy_recipients: Vec<i64>,
    blind_copy_recipients: Vec<i64>,
    subject: String,
    html_content: String,
    has_priority: bool,
    is_concept: bool,
    send_option: Option<String>, // "standaard", "beantwoord", "doorgestuurd"
    related_message_id: Option<i64>,
    attachment_ids: Vec<i64>,
) -> Result<(), String> {
    let mut c = client.lock().await;

    let to_refs = |ids: Vec<i64>| -> Vec<ContactRef> {
        ids.into_iter()
            .map(|id| ContactRef {
                id,
                ref_type: "persoon".to_string(),
            })
            .collect()
    };

    let body = SendMessageRequest {
        ontvangers: to_refs(recipients),
        kopie_ontvangers: to_refs(copy_recipients),
        blinde_kopie_ontvangers: to_refs(blind_copy_recipients),
        heeft_prioriteit: has_priority,
        inhoud: html_content,
        onderwerp: subject,
        verzend_optie: send_option.unwrap_or("standaard".to_string()),
        gerelateerd_bericht_id: related_message_id,
        bijlagen: attachment_ids
            .into_iter()
            .map(|id| AttachmentRef {
                id,
                ref_type: "upload".to_string(),
            })
            .collect(),
    };

    let endpoint = if is_concept {
        "berichten/concepten"
    } else {
        "berichten/berichten"
    };

    let body_value = serde_json::to_value(&body).map_err(|e| e.to_string())?;

    c.post(endpoint, &body_value)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Mark messages as read/unread.
#[tauri::command]
pub async fn mark_messages_as_read(
    client: State<'_, SharedClient>,
    message_ids: Vec<i64>,
    read: bool,
) -> Result<(), String> {
    let mut c = client.lock().await;

    let body = serde_json::json!({
        "berichten": message_ids.iter().map(|id| {
            serde_json::json!({
                "berichtId": id,
                "operations": [{
                    "op": "replace",
                    "path": "/IsGelezen",
                    "value": read
                }]
            })
        }).collect::<Vec<_>>()
    });

    c.patch("berichten/berichten", &body)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Move messages to a folder.
#[tauri::command]
pub async fn move_messages_to_folder(
    client: State<'_, SharedClient>,
    message_ids: Vec<i64>,
    folder_id: i64,
) -> Result<(), String> {
    let mut c = client.lock().await;

    let body = serde_json::json!({
        "berichten": message_ids.iter().map(|id| {
            serde_json::json!({
                "berichtId": id,
                "operations": [{
                    "op": "replace",
                    "path": "/MapId",
                    "value": folder_id
                }]
            })
        }).collect::<Vec<_>>()
    });

    c.patch("berichten/berichten", &body)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete messages permanently.
#[tauri::command]
pub async fn delete_messages(
    client: State<'_, SharedClient>,
    message_ids: Vec<i64>,
    are_concepts: bool,
) -> Result<(), String> {
    let mut c = client.lock().await;

    if are_concepts {
        let body: serde_json::Value = message_ids
            .iter()
            .map(|id| serde_json::json!({"conceptId": id}))
            .collect::<Vec<_>>()
            .into();

        c.delete_with_body("berichten/concepten", &body)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        let body: serde_json::Value = message_ids
            .iter()
            .map(|id| serde_json::json!({"berichtId": id}))
            .collect::<Vec<_>>()
            .into();

        c.delete_with_body("berichten/berichten", &body)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Search for contacts.
#[tauri::command]
pub async fn search_contacts(
    client: State<'_, SharedClient>,
    query: String,
    max_results: Option<i32>,
) -> Result<Vec<Contact>, String> {
    let mut c = client.lock().await;
    let max = max_results.unwrap_or(250);

    let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    let data = c
        .get(&format!("contacten/personen?q={encoded}&top={max}&type=alle"))
        .await
        .map_err(|e| e.to_string())?;

    let resp: ContactsResponse = serde_json::from_value(data).map_err(|e| e.to_string())?;

    Ok(resp.items)
}
