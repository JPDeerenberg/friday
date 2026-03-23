use serde::{Deserialize, Serialize};

/// Top-level account response from `GET /account?noCache=0`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiAccount {
    #[serde(rename = "UuId")]
    pub uuid: String,
    #[serde(rename = "Persoon")]
    pub persoon: ApiPersoon,
    #[serde(rename = "Groep")]
    pub groep: Vec<ApiGroep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiPersoon {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Roepnaam")]
    pub roepnaam: Option<String>,
    #[serde(rename = "Tussenvoegsel")]
    pub tussenvoegsel: Option<String>,
    #[serde(rename = "Achternaam")]
    pub achternaam: String,
    #[serde(rename = "OfficieleVoornamen")]
    pub officiele_voornamen: Option<String>,
    #[serde(rename = "Voorletters")]
    pub voorletters: String,
    #[serde(rename = "OfficieleTussenvoegsels")]
    pub officiele_tussenvoegsels: Option<String>,
    #[serde(rename = "OfficieleAchternaam")]
    pub officiele_achternaam: Option<String>,
    #[serde(rename = "Geboortedatum")]
    pub geboortedatum: String,
    #[serde(rename = "GeboorteAchternaam")]
    pub geboorte_achternaam: Option<String>,
    #[serde(rename = "GeboortenaamTussenvoegsel")]
    pub geboortenaam_tussenvoegsel: Option<String>,
    #[serde(rename = "GebruikGeboortenaam")]
    pub gebruik_geboortenaam: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiGroep {
    #[serde(rename = "Naam")]
    pub naam: String,
    #[serde(rename = "Privileges")]
    pub privileges: Vec<Permission>,
    #[serde(rename = "Links")]
    pub links: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Permission {
    #[serde(rename = "Naam")]
    pub naam: String,
    #[serde(rename = "AccessType")]
    pub access_type: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiChild {
    #[serde(rename = "Stamnummer")]
    pub stamnummer: i64,
    #[serde(rename = "ZichtbaarVoorOuder")]
    pub zichtbaar_voor_ouder: bool,
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Roepnaam")]
    pub roepnaam: String,
    #[serde(rename = "Tussenvoegsel")]
    pub tussenvoegsel: Option<String>,
    #[serde(rename = "Achternaam")]
    pub achternaam: String,
    #[serde(rename = "OfficieleVoornamen")]
    pub officiele_voornamen: String,
    #[serde(rename = "Voorletters")]
    pub voorletters: Option<String>,
    #[serde(rename = "OfficieleTussenvoegsels")]
    pub officiele_tussenvoegsels: Option<String>,
    #[serde(rename = "OfficieleAchternaam")]
    pub officiele_achternaam: String,
    #[serde(rename = "Geboortedatum")]
    pub geboortedatum: String,
    #[serde(rename = "GeboorteAchternaam")]
    pub geboorte_achternaam: Option<String>,
    #[serde(rename = "GeboortenaamTussenvoegsel")]
    pub geboortenaam_tussenvoegsel: Option<String>,
    #[serde(rename = "GebruikGeboortenaam")]
    pub gebruik_geboortenaam: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileInfo {
    #[serde(rename = "Id")]
    pub id: Option<i64>,
    #[serde(rename = "EmailAdres")]
    pub email: Option<String>,
    #[serde(rename = "Mobiel")]
    pub mobiel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileAddress {
    #[serde(rename = "Id")]
    pub id: i64,
    #[serde(rename = "Straat")]
    pub straat: String,
    #[serde(rename = "Huisnummer")]
    pub huisnummer: String,
    #[serde(rename = "Toevoeging")]
    pub toevoeging: Option<String>,
    #[serde(rename = "Postcode")]
    pub postcode: String,
    #[serde(rename = "Woonplaats")]
    pub woonplaats: String,
    #[serde(rename = "Land")]
    pub land: Option<String>,
    #[serde(rename = "Type")]
    pub address_type: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileCareer {
    #[serde(rename = "Id")]
    pub id: Option<i64>,
    #[serde(rename = "StamNr")]
    pub stamnummer: Option<String>,
    #[serde(rename = "Studie")]
    pub opleiding: Option<String>,
    #[serde(rename = "Klas")]
    pub groep: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileAddressResponse {
    #[serde(rename = "Items")]
    pub items: Vec<ProfileAddress>,
}
