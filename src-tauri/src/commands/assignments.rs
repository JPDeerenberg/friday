use tauri::State;

use crate::client::SharedClient;
use crate::models::assignments::{Assignment, AssignmentsResponse, UploadedFile};

/// Page size for the assignments list (the same `top` the background sync uses).
const ASSIGNMENTS_PAGE: usize = 50;
/// Safety net against a server that never runs out of pages.
const ASSIGNMENTS_MAX_PAGES: usize = 40;

/// The `opdrachten` request for one page.
///
/// Magister's assignments endpoint takes `startdatum`/`einddatum` (that is what
/// Discipulus and the background sync in `jni.rs` send). The calendar-style
/// `van`/`tot` used here before are not understood by it: the server then answers
/// with its own default window, so only recent assignments ever came back and the
/// school-year picker had nothing to show for older years.
pub fn assignments_path(person_id: i64, start: &str, end: &str, skip: usize) -> String {
    let day = |s: &str| if s.len() >= 10 { s[0..10].to_string() } else { s.to_string() };
    format!(
        "personen/{person_id}/opdrachten?startdatum={}&einddatum={}&top={ASSIGNMENTS_PAGE}&skip={skip}",
        day(start),
        day(end)
    )
}

/// Every assignment in the date range as raw JSON, fetched page by page.
/// Stops at a short page, or when a page brings nothing new (a server that
/// ignores `skip` would otherwise repeat the first page forever).
pub async fn fetch_assignment_items(
    client: &SharedClient,
    person_id: i64,
    start: &str,
    end: &str,
) -> Result<Vec<serde_json::Value>, crate::client::ClientError> {
    let mut all: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for page in 0..ASSIGNMENTS_MAX_PAGES {
        let path = assignments_path(person_id, start, end, page * ASSIGNMENTS_PAGE);
        let data = crate::client::get_with_shared(client, &path).await?;
        let items = data["Items"]
            .as_array()
            .or_else(|| data["items"].as_array())
            .ok_or_else(|| {
                crate::client::ClientError::ParseFailed(
                    "onverwacht antwoord voor opdrachten".to_string(),
                )
            })?;
        let page_len = items.len();
        let mut added = 0;
        for item in items {
            let id = item["Id"].as_i64().or_else(|| item["id"].as_i64());
            // Items without an id cannot be de-duplicated; keep them.
            if id.map(|i| seen.insert(i)).unwrap_or(true) {
                all.push(item.clone());
                added += 1;
            }
        }
        log::debug!(
            "Assignments page {}: {} items ({} new), {} total",
            page,
            page_len,
            added,
            all.len()
        );
        if page_len < ASSIGNMENTS_PAGE || added == 0 {
            break;
        }
    }
    Ok(all)
}

/// Get assignments for a date range.
#[tauri::command]
pub async fn get_assignments(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: String, // yyyy-MM-dd
    end: String,   // yyyy-MM-dd
) -> Result<Vec<Assignment>, String> {
    let items = fetch_assignment_items(&client, person_id, &start, &end)
        .await
        .map_err(|e| e.to_string())?;
    log::debug!("Got {} assignments", items.len());

    items
        .into_iter()
        .map(|v| serde_json::from_value::<Assignment>(v).map_err(|e| e.to_string()))
        .collect()
}

/// Get full assignment details (attachments, versions).
#[tauri::command]
pub async fn get_assignment_detail(
    client: State<'_, SharedClient>,
    self_url: String,
) -> Result<Assignment, String> {
    let url = self_url.replace("/api/", "");
    let data = crate::client::get_with_shared(&client, &url).await.map_err(|e| e.to_string())?;
    serde_json::from_value(data).map_err(|e| e.to_string())
}

/// Get one assignment version as Magister sends it (own comment, attachments,
/// teacher feedback, grade). The assignment's `VersieNavigatieItems` only carry a
/// link per version; the content lives behind that link.
///
/// Returned as raw JSON on purpose: handing a version in posts the whole record
/// back, so fields we don't model must survive the round trip.
#[tauri::command]
pub async fn get_assignment_version(
    client: State<'_, SharedClient>,
    self_url: String,
) -> Result<serde_json::Value, String> {
    let url = self_url.replace("/api/", "");
    crate::client::get_with_shared(&client, &url)
        .await
        .map_err(|e| e.to_string())
}

/// Hand in an assignment version.
#[tauri::command]
pub async fn hand_in_assignment(
    client: State<'_, SharedClient>,
    self_url: String,
    opdracht_id: i64,
    version_json: String,
) -> Result<(), String> {
    let mut c = client.lock().await;
    let url = self_url.replace("/api/", "");

    let body: serde_json::Value = serde_json::from_str(&version_json).map_err(|e| e.to_string())?;

    c.post(&format!("{url}?opdrachtId={opdracht_id}"), &body)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// The 3-step Magister upload: request a slot, preflight, PUT the bytes to the
/// blob storage. Returns (id, storage_id) for use in `LeerlingBijlagen`/messages.
async fn upload_blob(
    c: &mut crate::client::MagisterClient,
    file_name: &str,
    mime_type: &str,
    file_bytes: Vec<u8>,
) -> Result<(i64, String), String> {
    // Step 1: Request upload slot
    let upload_info_data = c
        .post(
            "bestanden/upload",
            &serde_json::json!({
                "name": file_name
            }),
        )
        .await
        .map_err(|e| e.to_string())?;

    let upload_info: UploadedFile =
        serde_json::from_value(upload_info_data).map_err(|e| e.to_string())?;

    // Step 2: Perform OPTIONS request (as seen in Discipulus, though might be optional)
    // We use reqwest directly here as we have the URI and it might need special headers
    let api_host = {
        let ts = c.token_set.as_ref().ok_or("Not authenticated")?;
        let url = url::Url::parse(&ts.api_endpoint).map_err(|e| e.to_string())?;
        url.host_str().unwrap_or_default().to_string()
    };

    let _options_resp = c
        .http
        .request(reqwest::Method::OPTIONS, &upload_info.uri)
        .header("Origin", &api_host)
        .header("Referer", &api_host)
        .header("Access-Control-Request-Method", "PUT")
        .header(
            "Access-Control-Request-Headers",
            "x-ms-blob-content-type,x-ms-blob-type",
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // Step 3: PUT the file content
    let put_resp = c
        .http
        .put(&upload_info.uri)
        .header("x-ms-blob-content-type", mime_type)
        .header("x-ms-blob-type", "BlockBlob")
        .body(file_bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !put_resp.status().is_success() {
        return Err(format!("Upload failed with status: {}", put_resp.status()));
    }

    Ok((upload_info.id, upload_info.storage_id))
}

/// Upload an attachment to Magister for an assignment, from a file path.
/// Returns (id, storage_id)
#[tauri::command]
pub async fn upload_assignment_attachment(
    client: State<'_, SharedClient>,
    file_path: String,
) -> Result<(i64, String), String> {
    use mime_guess::from_path;
    use std::path::Path;

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid filename")?;

    let mime_type = from_path(path).first_or_octet_stream().to_string();
    let file_bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    let mut c = client.lock().await;
    upload_blob(&mut c, file_name, &mime_type, file_bytes).await
}

/// Upload an attachment whose bytes the frontend already has.
///
/// A path is no use on Android: the file picker hands back a `content://` URI
/// that `std::fs` cannot open, so every upload failed there. The webview can
/// read the picked file itself, so it sends the bytes as the raw request body
/// (`invoke(cmd, bytes, { headers })`) and the name/type as headers:
/// `x-file-name` (URI-encoded) and optionally `x-content-type`.
#[tauri::command]
pub async fn upload_assignment_attachment_bytes(
    client: State<'_, SharedClient>,
    request: tauri::ipc::Request<'_>,
) -> Result<(i64, String), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Verwachtte de bestandsinhoud als ruwe bytes.".to_string());
    };
    let (file_name, mime_type) = upload_meta(
        request.headers().get("x-file-name").and_then(|v| v.to_str().ok()),
        request.headers().get("x-content-type").and_then(|v| v.to_str().ok()),
    )?;

    let mut c = client.lock().await;
    upload_blob(&mut c, &file_name, &mime_type, bytes.clone()).await
}

/// File name and MIME type for an upload from the `x-file-name` /
/// `x-content-type` headers. The name is URI-encoded by the frontend because
/// header values must be ASCII; it is cleaned like every other file name.
fn upload_meta(
    raw_name: Option<&str>,
    raw_type: Option<&str>,
) -> Result<(String, String), String> {
    let decoded = raw_name
        .map(percent_decode)
        .ok_or_else(|| "Bestandsnaam ontbreekt.".to_string())?;
    let name = crate::commands::files::safe_file_name(&decoded, "bijlage");
    let mime = match raw_type.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => mime_guess::from_path(&name).first_or_octet_stream().to_string(),
    };
    Ok((name, mime))
}

/// Minimal percent-decoder for a header value (`encodeURIComponent` on the
/// frontend). Invalid escapes are kept as typed.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignments_path_uses_the_parameter_names_magister_understands() {
        assert_eq!(
            assignments_path(7, "2013-01-01T00:00:00Z", "2026-11-03", 50),
            "personen/7/opdrachten?startdatum=2013-01-01&einddatum=2026-11-03&top=50&skip=50"
        );
        // The calendar-style names were ignored by the server.
        let p = assignments_path(7, "2013-01-01", "2026-11-03", 0);
        assert!(!p.contains("van=") && !p.contains("tot="));
    }

    fn page(ids: std::ops::Range<i64>) -> serde_json::Value {
        serde_json::json!({ "Items": ids.map(|i| serde_json::json!({ "Id": i })).collect::<Vec<_>>() })
    }

    async fn shared(server: &wiremock::MockServer) -> SharedClient {
        use crate::client::TokenSet;
        let mut c = crate::client::MagisterClient::new();
        c.token_set = Some(TokenSet {
            access_token: "mock_access_token".to_string(),
            id_token: "mock_id_token".to_string(),
            refresh_token: "mock_refresh_token".to_string(),
            expires_at: chrono::Utc::now() + chrono::Duration::seconds(3600),
            api_endpoint: server.uri(),
            person_id: Some(123),
            account_uuid: None,
        });
        std::sync::Arc::new(tokio::sync::Mutex::new(c))
    }

    #[tokio::test]
    async fn fetches_every_page_until_a_short_one() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        for (skip, ids) in [("0", 0..50), ("50", 50..100), ("100", 100..120)] {
            Mock::given(method("GET"))
                .and(path("/personen/7/opdrachten"))
                .and(query_param("startdatum", "2013-01-01"))
                .and(query_param("einddatum", "2026-12-31"))
                .and(query_param("top", "50"))
                .and(query_param("skip", skip))
                .respond_with(ResponseTemplate::new(200).set_body_json(page(ids)))
                .expect(1)
                .mount(&server)
                .await;
        }
        let client = shared(&server).await;
        let items = fetch_assignment_items(&client, 7, "2013-01-01", "2026-12-31").await.unwrap();
        assert_eq!(items.len(), 120);
        assert_eq!(items[0]["Id"], 0);
        assert_eq!(items[119]["Id"], 119);
    }

    #[tokio::test]
    async fn a_server_that_ignores_skip_does_not_loop_forever() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        // Always the same full page, whatever `skip` says.
        Mock::given(method("GET"))
            .and(path("/personen/7/opdrachten"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(0..50)))
            .expect(2)
            .mount(&server)
            .await;
        let client = shared(&server).await;
        let items = fetch_assignment_items(&client, 7, "2013-01-01", "2026-12-31").await.unwrap();
        assert_eq!(items.len(), 50, "duplicates are dropped");
    }

    #[tokio::test]
    async fn rejects_an_answer_without_items() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/personen/7/opdrachten"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "oops": 1 })))
            .mount(&server)
            .await;
        let client = shared(&server).await;
        assert!(fetch_assignment_items(&client, 7, "2013-01-01", "2026-12-31").await.is_err());
    }

    #[test]
    fn percent_decode_handles_encoded_names() {
        assert_eq!(percent_decode("verslag%20NL%20%282%29.pdf"), "verslag NL (2).pdf");
        assert_eq!(percent_decode("caf%C3%A9.docx"), "café.docx");
        assert_eq!(percent_decode("plain.txt"), "plain.txt");
    }

    #[test]
    fn percent_decode_keeps_broken_escapes() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("%41"), "A");
    }

    #[test]
    fn upload_meta_cleans_the_name_and_guesses_the_type() {
        let (name, mime) = upload_meta(Some("..%2Fverslag%201.pdf"), None).unwrap();
        assert_eq!(name, "_verslag 1.pdf");
        assert_eq!(mime, "application/pdf");
    }

    #[test]
    fn upload_meta_prefers_the_given_type() {
        let (_, mime) = upload_meta(Some("a.bin"), Some(" image/png ")).unwrap();
        assert_eq!(mime, "image/png");
        let (_, mime) = upload_meta(Some("a.bin"), Some("")).unwrap();
        assert_eq!(mime, "application/octet-stream");
    }

    #[test]
    fn upload_meta_requires_a_name() {
        assert!(upload_meta(None, Some("image/png")).is_err());
    }
}
