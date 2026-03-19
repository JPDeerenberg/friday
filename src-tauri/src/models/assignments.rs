use serde::{Deserialize, Serialize};

use super::calendar::Docent;

/// Assignment from the Magister API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assignment {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Links")]
    pub links: Vec<AssignmentLink>,
    #[serde(rename = "Titel")]
    pub titel: String,
    #[serde(rename = "Vak")]
    pub vak: Option<String>,
    #[serde(rename = "InleverenVoor")]
    pub inleveren_voor: String,
    #[serde(rename = "IngeleverdOp")]
    pub ingeleverd_op: Option<String>,
    #[serde(rename = "StatusLaatsteOpdrachtVersie")]
    pub status_laatste_opdracht_versie: i32,
    #[serde(rename = "LaatsteOpdrachtVersienummer")]
    pub laatste_opdracht_versienummer: i32,
    #[serde(rename = "Docenten")]
    pub docenten: Option<Vec<Docent>>,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: Option<String>,
    #[serde(rename = "Beoordeling")]
    pub beoordeling: Option<String>,
    #[serde(rename = "BeoordeeldOp")]
    pub beoordeeld_op: Option<String>,
    #[serde(rename = "OpnieuwInleveren")]
    pub opnieuw_inleveren: bool,
    #[serde(rename = "Afgesloten")]
    pub afgesloten: bool,
    #[serde(rename = "MagInleveren")]
    pub mag_inleveren: bool,
    #[serde(rename = "Bijlagen")]
    pub bijlagen: Option<Vec<serde_json::Value>>,
    #[serde(rename = "VersieNavigatieItems")]
    pub versie_navigatie_items: Option<Vec<AssignmentVersion>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignmentLink {
    #[serde(rename = "Rel")]
    pub rel: String,
    #[serde(rename = "Href")]
    pub href: String,
}

impl Assignment {
    #[allow(dead_code)]
    pub fn self_url(&self) -> Option<String> {
        self.links
            .iter()
            .find(|l| l.rel == "Self")
            .map(|l| l.href.replace("/api/", ""))
    }

    /// Determine the assignment status.
    #[allow(dead_code)]
    pub fn status(&self) -> AssignmentStatus {
        if self.afgesloten {
            return AssignmentStatus::Closed;
        }
        if self.beoordeeld_op.is_some() {
            return AssignmentStatus::Graded;
        }
        if self.ingeleverd_op.is_some() {
            return AssignmentStatus::Submitted;
        }
        // status 4 = geen (not started)
        if self.status_laatste_opdracht_versie == 4 && self.mag_inleveren {
            return AssignmentStatus::ToBeSubmitted;
        }
        AssignmentStatus::NotStarted
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignmentVersion {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Vak")]
    pub vak: Option<String>,
    #[serde(rename = "Status")]
    pub status: Option<i32>,
    #[serde(rename = "OpdrachtId")]
    pub opdracht_id: Option<i64>,
    #[serde(rename = "LeerlingOpmerking")]
    pub leerling_opmerking: Option<String>,
    #[serde(rename = "DocentOpmerking")]
    pub docent_opmerking: Option<String>,
    #[serde(rename = "InleverenVoor")]
    pub inleveren_voor: Option<String>,
    #[serde(rename = "IngeleverdOp")]
    pub ingeleverd_op: Option<String>,
    #[serde(rename = "GestartOp")]
    pub gestart_op: Option<String>,
    #[serde(rename = "Beoordeling")]
    pub beoordeling: Option<String>,
    #[serde(rename = "BeoordeeldOp")]
    pub beoordeeld_op: Option<String>,
    #[serde(rename = "VersieNummer")]
    pub versie_nummer: Option<i32>,
    #[serde(rename = "IsTeLaat")]
    pub is_te_laat: Option<bool>,
    #[serde(rename = "Omschrijving")]
    pub omschrijving: Option<String>,
    #[serde(rename = "Links")]
    pub links: Option<Vec<AssignmentLink>>,
    #[serde(rename = "LeerlingBijlagen")]
    pub leerling_bijlagen: Option<Vec<serde_json::Value>>,
    #[serde(rename = "FeedbackBijlagen")]
    pub feedback_bijlagen: Option<Vec<serde_json::Value>>,
}

/// Wrapper for the assignments response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignmentsResponse {
    #[serde(rename = "Items")]
    pub items: Vec<Assignment>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AssignmentStatus {
    NotStarted,
    ToBeSubmitted,
    Submitted,
    Graded,
    Closed,
}

impl AssignmentStatus {
    #[allow(dead_code)]
    pub fn label(&self) -> &'static str {
        match self {
            Self::NotStarted => "Niet begonnen",
            Self::ToBeSubmitted => "In te leveren",
            Self::Submitted => "Ingeleverd",
            Self::Graded => "Beoordeeld",
            Self::Closed => "Afgesloten",
        }
    }
}

/// VersieStatus values:
/// 0=alle, 1=ingeleverd, 2=openstaand, 3=beoordeeld, 4=geen, 5=afgesloten
#[allow(dead_code)]
pub fn versie_status_name(status: i32) -> &'static str {
    match status {
        0 => "Alle",
        1 => "Ingeleverd",
        2 => "Openstaand",
        3 => "Beoordeeld",
        4 => "Geen",
        5 => "Afgesloten",
        _ => "Onbekend",
    }
}
