use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Leermiddel {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "MateriaalType")]
    pub materiaal_type: i32,
    #[serde(rename = "Links")]
    pub links: Vec<Link>,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "Uitgeverij")]
    pub uitgeverij: Option<String>,
    #[serde(rename = "Status")]
    pub status: i32,
    #[serde(rename = "Start")]
    pub start: String,
    #[serde(rename = "Eind")]
    pub eind: String,
    #[serde(rename = "EAN")]
    pub ean: String,
    #[serde(rename = "PreviewImageUrl")]
    pub preview_image_url: Option<String>,
    #[serde(rename = "Vak")]
    pub vak: Vak,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    #[serde(rename = "Rel")]
    pub rel: String,
    #[serde(rename = "Href")]
    pub href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vak {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Afkorting")]
    pub afkorting: Option<String>,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: String,
    #[serde(rename = "Volgnr")]
    pub volgnr: i32,
    #[serde(rename = "LicentieUrl")]
    pub licentie_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeermiddelenResponse {
    #[serde(rename = "Items")]
    pub items: Vec<Leermiddel>,
}
