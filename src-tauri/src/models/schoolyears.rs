use serde::{Deserialize, Serialize};

/// Schoolyear from the Magister API.
/// Uses #[serde(alias)] for all PascalCase API fields, keeping the Rust field
/// name (snake_case / lowercase) for frontend serialization compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schoolyear {
    #[serde(alias = "Id")]
    pub id: Option<i64>,
    #[serde(alias = "Studie")]
    pub studie: SchoolyearGroep,
    #[serde(alias = "Groep")]
    pub groep: Option<SchoolyearGroep>,
    #[serde(alias = "Lesperiode")]
    pub lesperiode: Lesperiode,
    #[serde(alias = "Profielen")]
    pub profielen: Vec<SchoolyearGroep>,
    #[serde(alias = "persoonlijkeMentor")]
    pub persoonlijke_mentor: Option<PersoonlijkeMentor>,
    #[serde(alias = "Begin")]
    pub begin: String,
    #[serde(alias = "Einde")]
    pub einde: String,
    #[serde(alias = "isZittenBlijver")]
    pub is_zitten_blijver: Option<bool>,
    #[serde(alias = "Indicatie")]
    pub indicatie: Option<String>,
    #[serde(alias = "opleidingCode")]
    pub opleiding_code: Option<OpleidingCode>,
    #[serde(alias = "isHoofdAanmelding")]
    pub is_hoofd_aanmelding: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchoolyearGroep {
    #[serde(alias = "Id")]
    pub id: Option<i64>,
    #[serde(alias = "Code")]
    pub code: String,
    #[serde(alias = "Omschrijving")]
    pub omschrijving: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lesperiode {
    #[serde(alias = "Code")]
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpleidingCode {
    #[serde(alias = "Code")]
    pub code: i32,
    #[serde(alias = "Omschrijving")]
    pub omschrijving: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersoonlijkeMentor {
    #[serde(alias = "Voorletters")]
    pub voorletters: String,
    #[serde(alias = "Tussenvoegsel")]
    pub tussenvoegsel: Option<String>,
    #[serde(alias = "Achternaam")]
    pub achternaam: String,
}

/// Wrapper for the schoolyears response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchoolyearsResponse {
    #[serde(rename = "Items", alias = "items")]
    pub items: Vec<Schoolyear>,
}
