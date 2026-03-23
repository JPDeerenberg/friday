use super::calendar::Link;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "Details")]
    pub details: Option<String>,
    #[serde(rename = "ZichtbaarVanaf")]
    pub zichtbaar_vanaf: String,
    #[serde(rename = "ZichtbaarTotEnMet")]
    pub zichtbaar_tot_en_met: String,
    #[serde(rename = "MaximumAantalInschrijvingenPerActiviteit")]
    pub max_inschrijvingen: i32,
    #[serde(rename = "MinimumAantalInschrijvingenPerActiviteit")]
    pub min_inschrijvingen: i32,
    #[serde(rename = "Status")]
    pub status: i32,
    #[serde(rename = "StartInschrijfdatum")]
    pub start_inschrijfdatum: String,
    #[serde(rename = "EindeInschrijfdatum")]
    pub einde_inschrijfdatum: String,
    #[serde(rename = "Toegangstype")]
    pub toegangstype: i32,
    #[serde(rename = "AantalInschrijvingen")]
    pub aantal_inschrijvingen: i32,
    #[serde(rename = "Links")]
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityElement {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "StartInschrijfdatum")]
    pub start_inschrijfdatum: String,
    #[serde(rename = "EindeInschrijfdatum")]
    pub einde_inschrijfdatum: String,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "Volgnummer")]
    pub volgnummer: i32,
    #[serde(rename = "Details")]
    pub details: Option<String>,
    #[serde(rename = "ActiviteitId")]
    pub activiteit_id: i64,
    #[serde(rename = "MaxAantalDeelnemers")]
    pub max_deelnemers: i32,
    #[serde(rename = "MinAantalDeelnemers")]
    pub min_deelnemers: i32,
    #[serde(rename = "Kleurstelling")]
    pub kleurstelling: i32,
    #[serde(rename = "IsIngeschreven")]
    pub is_ingeschreven: bool,
    #[serde(rename = "IsVerplichtIngeschreven")]
    pub is_verplicht_ingeschreven: bool,
    #[serde(rename = "AantalPlaatsenBeschikbaar")]
    pub aantal_plaatsen_beschikbaar: i32,
    #[serde(rename = "IsOpInTeSchrijven")]
    pub is_op_in_te_schrijven: bool,
    #[serde(rename = "Links")]
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitiesResponse {
    #[serde(rename = "Items")]
    pub items: Vec<Activity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityElementsResponse {
    #[serde(rename = "Items")]
    pub items: Vec<ActivityElement>,
}
