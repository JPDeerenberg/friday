use serde::{Deserialize, Serialize};

/// Calendar event from the Magister API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Start")]
    pub start: String,
    #[serde(rename = "Einde")]
    pub einde: String,
    #[serde(rename = "LesuurVan")]
    pub lesuur_van: Option<i32>,
    #[serde(rename = "LesuurTotMet")]
    pub lesuur_tot_met: Option<i32>,
    #[serde(rename = "DuurtHeleDag")]
    pub duurt_hele_dag: bool,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: Option<String>,
    #[serde(rename = "Lokatie")]
    pub lokatie: Option<String>,
    #[serde(rename = "Status")]
    pub status: i32,
    #[serde(rename = "Type")]
    pub event_type: i32,
    #[serde(rename = "Subtype")]
    pub subtype: Option<i32>,
    #[serde(rename = "IsOnlineDeelname")]
    pub is_online_deelname: Option<bool>,
    #[serde(rename = "WeergaveType")]
    pub weergave_type: Option<i32>,
    #[serde(rename = "Inhoud")]
    pub inhoud: Option<String>,
    #[serde(rename = "InfoType")]
    pub info_type: i32,
    #[serde(rename = "Aantekening")]
    pub aantekening: Option<String>,
    #[serde(rename = "Afgerond")]
    pub afgerond: bool,
    #[serde(rename = "HerhaalStatus")]
    pub herhaal_status: Option<i32>,
    #[serde(rename = "Vakken")]
    pub vakken: Option<Vec<Vak>>,
    #[serde(rename = "Docenten")]
    pub docenten: Option<Vec<Docent>>,
    #[serde(rename = "Lokalen")]
    pub lokalen: Option<Vec<Lokaal>>,
    #[serde(rename = "OpdrachtId")]
    pub opdracht_id: Option<i64>,
    #[serde(rename = "HeeftBijlagen")]
    pub heeft_bijlagen: bool,
    #[serde(rename = "Bijlagen")]
    pub bijlagen: Option<Vec<serde_json::Value>>,
    #[serde(rename = "Links")]
    pub links: Option<Vec<Link>>,
    #[serde(rename = "Afwezigheid")]
    pub afwezigheid: Option<Absence>,

    // Computed fields (not from API)
    #[serde(skip_deserializing, default)]
    pub self_url: Option<String>,
    #[serde(skip_deserializing, default)]
    pub merged_absence: Option<Absence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vak {
    #[serde(rename = "Id")]
    pub id: Option<i64>,
    #[serde(rename = "Naam")]
    pub naam: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Docent {
    #[serde(rename = "Id")]
    pub id: Option<i64>,
    #[serde(rename = "Naam")]
    pub naam: Option<String>,
    #[serde(rename = "Docentcode")]
    pub docentcode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lokaal {
    #[serde(rename = "Naam")]
    pub naam: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    #[serde(rename = "Rel")]
    pub rel: String,
    #[serde(rename = "Href")]
    pub href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Absence {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Start")]
    pub start: Option<String>,
    #[serde(rename = "Eind")]
    pub eind: Option<String>,
    #[serde(rename = "Lesuur")]
    pub lesuur: Option<i32>,
    #[serde(rename = "Geoorloofd")]
    pub geoorloofd: bool,
    #[serde(rename = "AfspraakId")]
    pub afspraak_id: Option<i64>,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: Option<String>,
    #[serde(rename = "Verantwoordingtype")]
    pub verantwoording_type: Option<i32>,
    #[serde(rename = "Code")]
    pub code: Option<String>,
    #[serde(rename = "Afspraak")]
    pub afspraak: Option<Box<CalendarEvent>>,
}

/// Wrapper for the Items array returned by Magister
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEventsResponse {
    #[serde(rename = "Items")]
    pub items: Vec<CalendarEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbsencesResponse {
    #[serde(rename = "Items")]
    pub items: Vec<Absence>,
}

/// Create event request body
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCalendarEvent {
    #[serde(rename = "Start")]
    pub start: String,
    #[serde(rename = "Einde")]
    pub einde: String,
    #[serde(rename = "DuurtHeleDag")]
    pub duurt_hele_dag: bool,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: String,
    #[serde(rename = "Lokatie")]
    pub lokatie: Option<String>,
    #[serde(rename = "Inhoud")]
    pub inhoud: Option<String>,
    #[serde(rename = "Type")]
    pub event_type: i32, // 1 = personal, 16 = schedule
    #[serde(rename = "Status")]
    pub status: i32,
    #[serde(rename = "InfoType")]
    pub info_type: i32,
}

// --- Enum helpers ---

/// Status enum values (matching Magister int values)
/// 0=unknown, 1=auto_scheduled, 2=manual_scheduled, 3=changed,
/// 4=manual_canceled, 5=auto_canceled, 6=in_use, 7=finished, 8=used,
/// 9=moved, 10=changed_and_moved
#[allow(dead_code)]
pub fn status_name(status: i32) -> &'static str {
    match status {
        0 => "Onbekend",
        1 => "Automatisch ingeroosterd",
        2 => "Handmatig ingeroosterd",
        3 => "Veranderd",
        4 => "Handmatig uitgevallen",
        5 => "Automatisch uitgevallen",
        6 | 7 => "In gebruik",
        8 => "Gebruikt",
        9 => "Verplaatst",
        10 => "Veranderd en verplaatst",
        _ => "Onbekend",
    }
}

/// InfoType enum values
/// 0=none, 1=homework, 2=test, 3=exam, 4=written_exam,
/// 5=oral_exam, 6=information, 7=note
#[allow(dead_code)]
pub fn info_type_name(info_type: i32) -> &'static str {
    match info_type {
        0 => "Geen",
        1 => "Huiswerk",
        2 => "Proefwerk",
        3 => "Tentamen",
        4 => "Schriftelijke overhoring",
        5 => "Mondelinge overhoring",
        6 => "Informatie",
        7 => "Notitie",
        _ => "Geen",
    }
}

#[allow(dead_code)]
pub fn info_type_short(info_type: i32) -> &'static str {
    match info_type {
        0 => "N",
        1 => "HW",
        2 => "PW",
        3 => "TT",
        4 => "SO",
        5 => "MO",
        6 => "Inf",
        7 => "Not",
        _ => "N",
    }
}

/// CalendarType values
/// 0=none, 1=personal, 2=general, 3=school_wide, 4=internship,
/// 5=intake, 6=free, 7=kwt, 8=standby, 9=blocked, 10=other,
/// 11=blocked_classroom, 12=blocked_class, 13=class, 14=study_house,
/// 15=free_study, 16=schedule, 101=measures, 102=presentations,
/// 103=exam_schedule
#[allow(dead_code)]
pub fn calendar_type_name(t: i32) -> &'static str {
    match t {
        0 => "Geen",
        1 => "Persoonlijk",
        2 => "Algemeen",
        3 => "Schoolbreed",
        4 => "Stage",
        5 => "Intake",
        6 => "Vrij",
        7 => "KWT",
        8 => "Standby",
        9 => "Geblokkeerd",
        10 => "Anders",
        11 => "Geblokkeerd lokaal",
        12 => "Geblokkeerde klas",
        13 => "Les",
        14 => "Studiehuis",
        15 => "Vrij studeren",
        16 => "Rooster",
        101 => "Maatregelen",
        102 => "Presentaties",
        103 => "Toetsrooster",
        _ => "Onbekend",
    }
}

/// AbsenceType values
/// 0=unknown, 1=absent, 2=late, 3=sick, 4=discharged,
/// 6=exemption, 7=books, 8=homework
#[allow(dead_code)]
pub fn absence_type_name(t: i32) -> &'static str {
    match t {
        1 => "Afwezigheid",
        2 => "Te laat",
        3 => "Ziek",
        4 => "Verwijderd",
        6 => "Vrijstelling",
        7 => "Boeken vergeten",
        8 => "Huiswerk vergeten",
        _ => "Onbekend",
    }
}
