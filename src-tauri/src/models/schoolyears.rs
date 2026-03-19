use serde::{Deserialize, Serialize};

/// Schoolyear from the Magister API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schoolyear {
    pub id: Option<i64>,
    pub studie: SchoolyearGroep,
    pub groep: SchoolyearGroep,
    pub lesperiode: Lesperiode,
    pub profielen: Vec<SchoolyearGroep>,
    #[serde(rename = "persoonlijkeMentor")]
    pub persoonlijke_mentor: Option<PersoonlijkeMentor>,
    pub begin: String,
    pub einde: String,
    #[serde(rename = "isZittenBlijver")]
    pub is_zitten_blijver: Option<bool>,
    pub indicatie: Option<String>,
    #[serde(rename = "opleidingCode")]
    pub opleiding_code: Option<OpleidingCode>,
    #[serde(rename = "isHoofdAanmelding")]
    pub is_hoofd_aanmelding: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchoolyearGroep {
    pub id: Option<i64>,
    pub code: String,
    pub omschrijving: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lesperiode {
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpleidingCode {
    pub code: i32,
    pub omschrijving: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersoonlijkeMentor {
    pub voorletters: String,
    pub tussenvoegsel: Option<String>,
    pub achternaam: String,
}

/// Wrapper for the schoolyears response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchoolyearsResponse {
    pub items: Vec<Schoolyear>,
}
