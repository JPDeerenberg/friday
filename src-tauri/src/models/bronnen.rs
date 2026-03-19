use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bron {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Naam")]
    pub naam: String,
    #[serde(rename = "ContentType")]
    pub content_type: String,
    #[serde(rename = "Status")]
    pub status: Option<i32>,
    #[serde(rename = "Datum")]
    pub datum: Option<String>,
    #[serde(rename = "Grootte")]
    pub grootte: i64,
    #[serde(rename = "BronSoort")]
    pub bron_soort: i32, // 0 = folder, 1 = file, 3 = link
    #[serde(rename = "ParentId")]
    pub parent_id: i64,
    #[serde(rename = "Links")]
    pub links: Vec<BronLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BronLink {
    #[serde(rename = "Rel")]
    pub rel: String,
    #[serde(rename = "Href")]
    pub href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalBronSource {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Naam")]
    pub naam: String,
    #[serde(rename = "Type")]
    pub source_type: i32,
    #[serde(rename = "Links")]
    pub links: Vec<BronLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BronnenResponse {
    #[serde(rename = "Items")]
    pub items: Vec<Bron>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalBronSourcesResponse {
    #[serde(rename = "Items")]
    pub items: Vec<ExternalBronSource>,
}
