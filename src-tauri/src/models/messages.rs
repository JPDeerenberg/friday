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
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadedAttachment {
    pub id: i64,
    pub naam: String,
    #[serde(rename = "type", default = "default_upload_type")]
    pub attachment_type: String,
    #[serde(rename = "storageId")]
    pub storage_id: Option<String>,
}

#[allow(dead_code)]
fn default_upload_type() -> String {
    "upload".to_string()
}

/// Responses
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoldersResponse {
    pub items: Vec<MessagesFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagesResponse {
    pub items: Option<Vec<Bericht>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactsResponse {
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
    #[serde(rename = "type")]
    pub ref_type: String,
}
