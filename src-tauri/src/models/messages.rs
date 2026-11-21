use serde::{Deserialize, Serialize};

/// Message (Bericht) from the Magister API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bericht {
    pub id: i64,
    pub onderwerp: Option<String>,
    #[serde(rename = "mapId")]
    pub map_id: Option<i64>,
    pub afzender: Option<Afzender>,
    #[serde(rename = "heeftPrioriteit")]
    pub heeft_prioriteit: bool,
    #[serde(rename = "heeftBijlagen")]
    pub heeft_bijlagen: bool,
    #[serde(rename = "isGelezen")]
    pub is_gelezen: Option<bool>,
    #[serde(rename = "verzondenOp", alias = "laatsteWijzigingDatumTijd")]
    pub verzonden_op: Option<String>,
    #[serde(rename = "doorgestuurdOp")]
    pub doorgestuurd_op: Option<String>,
    #[serde(rename = "beantwoordOp")]
    pub beantwoord_op: Option<String>,
    pub links: Option<BerichtLinks>,
    pub inhoud: Option<String>,
    pub ontvangers: Option<Vec<Ontvanger>>,
    #[serde(rename = "kopieOntvangers")]
    pub kopie_ontvangers: Option<Vec<Ontvanger>>,
    #[serde(rename = "blindeKopieOntvangers")]
    pub blinde_kopie_ontvangers: Option<Vec<Ontvanger>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Afzender {
    pub id: i64,
    pub naam: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BerichtLinks {
    #[serde(rename = "self")]
    pub self_link: Option<LinkHref>,
    pub map: Option<LinkHref>,
    pub bijlagen: Option<LinkHref>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkHref {
    pub href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ontvanger {
    pub id: i64,
    pub weergavenaam: Option<String>,
    #[serde(rename = "type")]
    pub ontvanger_type: Option<String>,
    #[serde(rename = "mailGroep")]
    pub mail_groep: Option<String>,
}

/// Message folder from the Magister API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagesFolder {
    #[serde(rename = "aantalOngelezen")]
    pub aantal_ongelezen: i64,
    pub id: i64,
    #[serde(rename = "bovenliggendeId")]
    pub bovenliggend_id: i64,
    pub naam: String,
    pub links: Option<FolderLinks>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderLinks {
    pub berichten: Option<LinkHref>,
}

impl MessagesFolder {
    #[allow(dead_code)]
    pub fn berichten_link(&self) -> String {
        self.links
            .as_ref()
            .and_then(|l| l.berichten.as_ref())
            .map(|l| l.href.replace("/api/", ""))
            .unwrap_or_default()
    }
}

/// Contact from the contact search endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    pub id: i64,
    pub voorletters: Option<String>,
    pub roepnaam: Option<String>,
    pub tussenvoegsel: Option<String>,
    pub achternaam: String,
    pub code: Option<String>,
    pub klas: Option<String>,
    #[serde(rename = "type")]
    pub contact_type: Option<String>,
}

impl Contact {
    #[allow(dead_code)]
    pub fn full_name(&self) -> String {
        let first = self
            .roepnaam
            .as_deref()
            .or(self.voorletters.as_deref())
            .unwrap_or("");
        format!("{} {}", first, self.achternaam).trim().to_string()
    }
}

/// Uploaded attachment info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadedAttachment {
    #[serde(alias = "Id")]
    pub id: i64,
    #[serde(alias = "Naam", default)]
    pub naam: String,
    #[serde(rename = "type", alias = "Type", default = "default_upload_type")]
    pub attachment_type: String,
    #[serde(rename = "storageId", alias = "StorageId")]
    pub storage_id: Option<String>,
}

/// One attachment of a message, as returned by its `links.bijlagen` endpoint.
///
/// Magister answers that endpoint with `{ "items": [...] }` where every item is
/// a "bron": PascalCase metadata and a lowercase `links.download.href` object
/// (some responses use a PascalCase `Links` array instead). Both shapes are
/// normalized here so the frontend gets one stable record with `downloadUrl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageAttachment {
    pub id: i64,
    pub naam: String,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    pub grootte: Option<i64>,
    pub datum: Option<String>,
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
    #[serde(rename = "bronSoort")]
    pub bron_soort: i64,
}

fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    })
}

fn json_i64(value: &serde_json::Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
        })
    })
}

/// The actual file URL out of a bron's links. Prefers `download`, then
/// `contents`/`content`, and only then `self` (also an indirection link that
/// `download_file` can resolve).
fn attachment_download_href(links: &serde_json::Value) -> Option<String> {
    if let Some(array) = links.as_array() {
        for wanted in ["download", "contents", "content", "self"] {
            let found = array.iter().find_map(|link| {
                let rel = json_string(link, &["Rel", "rel"])?.to_ascii_lowercase();
                if rel == wanted {
                    json_string(link, &["Href", "href"])
                } else {
                    None
                }
            });
            if found.is_some() {
                return found;
            }
        }
        return None;
    }

    if let Some(download) = links.get("download") {
        if let Some(href) = download.as_str() {
            return Some(href.to_string());
        }
        if let Some(href) = json_string(download, &["href", "Href"]) {
            return Some(href);
        }
    }

    json_string(links, &["downloadUrl", "DownloadUrl"])
}

impl MessageAttachment {
    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        let id = json_i64(value, &["Id", "id"])?;
        let naam = json_string(value, &["Naam", "naam"]).unwrap_or_else(|| format!("bijlage-{id}"));
        let links = value.get("links").or_else(|| value.get("Links"));
        let download_url = links
            .and_then(attachment_download_href)
            .or_else(|| json_string(value, &["Url", "url"]));

        Some(Self {
            id,
            naam,
            content_type: json_string(value, &["ContentType", "contentType"]),
            grootte: json_i64(value, &["Grootte", "grootte"]),
            datum: json_string(value, &["Datum", "datum", "aangemaaktOp"]),
            download_url,
            bron_soort: json_i64(value, &["BronSoort", "bronSoort"]).unwrap_or(1),
        })
    }
}

/// Normalize the `links.bijlagen` answer (`Items`/`items` with bron records).
pub fn parse_message_attachments(data: &serde_json::Value) -> Vec<MessageAttachment> {
    data.get("Items")
        .or_else(|| data.get("items"))
        .and_then(|items| items.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(MessageAttachment::from_json)
                .collect()
        })
        .unwrap_or_default()
}

#[allow(dead_code)]
fn default_upload_type() -> String {
    "upload".to_string()
}

/// Responses
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoldersResponse {
    #[serde(rename = "Items", alias = "items")]
    pub items: Vec<MessagesFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagesResponse {
    #[serde(rename = "Items", alias = "items")]
    pub items: Option<Vec<Bericht>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactsResponse {
    #[serde(rename = "Items", alias = "items")]
    pub items: Vec<Contact>,
}

/// Send message request body
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageRequest {
    pub ontvangers: Vec<ContactRef>,
    #[serde(rename = "kopieOntvangers")]
    pub kopie_ontvangers: Vec<ContactRef>,
    #[serde(rename = "blindeKopieOntvangers")]
    pub blinde_kopie_ontvangers: Vec<ContactRef>,
    #[serde(rename = "heeftPrioriteit")]
    pub heeft_prioriteit: bool,
    pub inhoud: String,
    pub onderwerp: String,
    #[serde(rename = "verzendOptie")]
    pub verzend_optie: String, // "standaard", "beantwoord", "doorgestuurd"
    #[serde(
        rename = "gerelateerdBerichtId",
        skip_serializing_if = "Option::is_none"
    )]
    pub gerelateerd_bericht_id: Option<i64>,
    pub bijlagen: Vec<AttachmentRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactRef {
    pub id: i64,
    #[serde(rename = "type")]
    pub ref_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentRef {
    pub id: i64,
    /// Shown on the sent message. Magister's own client sends it too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub naam: Option<String>,
    #[serde(rename = "type")]
    pub ref_type: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_message_attachments_from_lowercase_links() {
        let data = serde_json::json!({
            "items": [
                {
                    "Id": 7,
                    "Naam": "brief.pdf",
                    "ContentType": "application/pdf",
                    "Grootte": 2048,
                    "Datum": "2026-01-01T10:00:00",
                    "BronSoort": 1,
                    "links": { "download": { "href": "/api/berichten/1/bijlagen/7/contents" } }
                },
                { "Naam": "zonder id" }
            ]
        });
        let parsed = parse_message_attachments(&data);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, 7);
        assert_eq!(parsed[0].naam, "brief.pdf");
        assert_eq!(
            parsed[0].download_url.as_deref(),
            Some("/api/berichten/1/bijlagen/7/contents")
        );
        assert_eq!(parsed[0].bron_soort, 1);
    }

    #[test]
    fn parses_pascal_case_links_and_prefers_download() {
        let data = serde_json::json!({
            "Items": [{
                "Id": 8,
                "Naam": "x",
                "Links": [
                    { "Rel": "Self", "Href": "/self" },
                    { "Rel": "download", "Href": "/download" }
                ]
            }]
        });
        let parsed = parse_message_attachments(&data);
        assert_eq!(parsed[0].download_url.as_deref(), Some("/download"));
    }
}
