use super::bronnen::Bron;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Studiewijzer {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Van")]
    pub van: String,
    #[serde(rename = "TotEnMet")]
    pub tot_en_met: String,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "IsZichtbaar")]
    pub is_zichtbaar: bool,
    #[serde(rename = "InLeerlingArchief")]
    pub in_leerling_archief: bool,
    #[serde(rename = "Links")]
    pub links: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudiewijzerOnderdeel {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: Option<String>,
    #[serde(rename = "Van")]
    pub van: Option<String>,
    #[serde(rename = "TotEnMet")]
    pub tot_en_met: Option<String>,
    #[serde(rename = "IsZichtbaar")]
    pub is_zichtbaar: bool,
    #[serde(rename = "Kleur")]
    pub kleur: i32,
    #[serde(rename = "Volgnummer")]
    pub volgnummer: i32,
    #[serde(rename = "Links")]
    pub links: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudiewijzerDetail {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: Option<String>,
    #[serde(rename = "Onderdelen")]
    pub onderdelen: StudiewijzerOnderdelenResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudiewijzerOnderdeelDetail {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: Option<String>,
    #[serde(rename = "Bronnen")]
    pub bronnen: Vec<Bron>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudiewijzersResponse {
    #[serde(rename = "Items")]
    pub items: Vec<Studiewijzer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudiewijzerOnderdelenResponse {
    #[serde(rename = "Items")]
    pub items: Vec<StudiewijzerOnderdeel>,
}
