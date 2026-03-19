use serde::{Deserialize, Serialize};

/// Grade from the Magister API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grade {
    #[serde(rename = "CijferId")]
    pub id: i64,
    #[serde(rename = "CijferStr")]
    pub cijfer_str: Option<String>,
    #[serde(rename = "IsVoldoende")]
    pub is_voldoende: bool,
    #[serde(rename = "IngevoerdDoor")]
    pub ingevoerd_door: Option<String>,
    #[serde(rename = "DatumIngevoerd")]
    pub datum_ingevoerd: Option<String>,
    #[serde(rename = "Weging")]
    pub weging: Option<f64>,
    #[serde(rename = "Inhalen")]
    pub inhalen: bool,
    #[serde(rename = "Vrijstelling")]
    pub vrijstelling: bool,
    #[serde(rename = "TeltMee")]
    pub telt_mee: bool,
    #[serde(rename = "CijferKolom")]
    pub cijfer_kolom: CijferKolom,
    #[serde(rename = "CijferKolomIdEloOpdracht")]
    pub cijfer_kolom_id_elo_opdracht: Option<i64>,
    #[serde(rename = "Docent")]
    pub docent: Option<String>,
    #[serde(rename = "VakOntheffing")]
    pub vak_ontheffing: bool,
    #[serde(rename = "VakVrijstelling")]
    pub vak_vrijstelling: bool,
    #[serde(rename = "CijferPeriode")]
    pub cijfer_periode: Option<GradePeriod>,
    #[serde(rename = "Vak")]
    pub vak: Option<GradeSubject>,

    // Extra info filled later (from extracijferkolominfo endpoint)
    #[serde(skip_deserializing, default)]
    pub description: Option<String>,
    #[serde(skip_deserializing, default)]
    pub test_date: Option<String>,
    #[serde(skip_deserializing, default)]
    pub extra_weight: Option<f64>,
}

impl Grade {
    #[allow(dead_code)]
    /// Parse the grade string to a numeric value.
    pub fn numeric_grade(&self) -> Option<f64> {
        self.cijfer_str
            .as_ref()
            .and_then(|s| s.replace(',', ".").parse::<f64>().ok())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CijferKolom {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "KolomNaam")]
    pub kolom_naam: Option<String>,
    #[serde(rename = "KolomNummer")]
    pub kolom_nummer: Option<String>,
    #[serde(rename = "KolomVolgNummer")]
    pub kolom_volg_nummer: Option<String>,
    #[serde(rename = "KolomKop")]
    pub kolom_kop: Option<String>,
    #[serde(rename = "KolomOmschrijving")]
    pub kolom_omschrijving: Option<String>,
    #[serde(rename = "KolomSoort")]
    pub kolom_soort: i32, // 1 = grade, 2 = average
    #[serde(rename = "IsHerkansingKolom")]
    pub is_herkansing_kolom: bool,
    #[serde(rename = "IsDocentKolom")]
    pub is_docent_kolom: bool,
    #[serde(rename = "HeeftOnderliggendeKolommen")]
    pub heeft_onderliggende_kolommen: bool,
    #[serde(rename = "IsPTAKolom")]
    pub is_pta_kolom: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradePeriod {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Naam")]
    pub naam: String,
    #[serde(rename = "VolgNummer")]
    pub volg_nummer: i32,
    #[serde(rename = "Start")]
    pub start: Option<String>,
    #[serde(rename = "Einde")]
    pub einde: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradeSubject {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Afkorting")]
    pub afkorting: String,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: String,
    #[serde(rename = "Volgnr")]
    pub volgnr: i32,
}

/// Wrapper for the grades response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradesResponse {
    #[serde(rename = "Items")]
    pub items: Vec<Grade>,
}

/// Extra grade column info response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradeExtraInfo {
    #[serde(rename = "Weging")]
    pub weging: Option<f64>,
    #[serde(rename = "WerkInformatieOmschrijving")]
    pub werk_informatie_omschrijving: Option<String>,
    #[serde(rename = "KolomOmschrijving")]
    pub kolom_omschrijving: Option<String>,
    #[serde(rename = "WerkinformatieDatumIngevoerd")]
    pub werk_informatie_datum_ingevoerd: Option<String>,
}
