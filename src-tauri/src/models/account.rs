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
    #[serde(rename = "Id", alias = "id", default)]
    pub id: Option<i64>,
    #[serde(rename = "EmailAdres", alias = "emailAdres", default)]
    pub email: Option<String>,
    #[serde(rename = "EmailAdresPrive", alias = "emailAdresPrive", default)]
    pub email_prive: Option<String>,
    #[serde(rename = "Mobiel", alias = "mobiel", default)]
    pub mobiel: Option<String>,
    #[serde(
        rename = "EloBerichtenDoorsturen",
        alias = "eloBerichtenDoorsturen",
        default,
        deserialize_with = "deserialize_bool_lenient"
    )]
    pub elo_berichten_doorsturen: bool,
}

/// Magister mixes strings, numbers and nulls across profile responses. These
/// deserializers keep one odd field from blanking the whole section.
fn deserialize_string_lenient<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        _ => String::new(),
    })
}

fn deserialize_bool_lenient<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Bool(b) => b,
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        serde_json::Value::String(s) => {
            matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "ja")
        }
        _ => false,
    })
}

fn deserialize_i64_lenient<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
        serde_json::Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    })
}

fn deserialize_i32_lenient<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) as i32,
        serde_json::Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    })
}

/// Missing or null means Magister's documented default (18).
fn deserialize_age_lenient<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(18) as i32,
        serde_json::Value::String(s) => s.parse().unwrap_or(18),
        _ => 18,
    })
}

/// `/personen/{id}/adressen` returns lowercase keys (`straat`, `plaats`, ...),
/// while other profile endpoints use PascalCase. Accept both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileAddress {
    #[serde(
        rename = "Id",
        alias = "id",
        default,
        deserialize_with = "deserialize_i64_lenient"
    )]
    pub id: i64,
    #[serde(
        rename = "Straat",
        alias = "straat",
        default,
        deserialize_with = "deserialize_string_lenient"
    )]
    pub straat: String,
    #[serde(
        rename = "Huisnummer",
        alias = "huisnummer",
        default,
        deserialize_with = "deserialize_string_lenient"
    )]
    pub huisnummer: String,
    #[serde(rename = "Toevoeging", alias = "toevoeging", default)]
    pub toevoeging: Option<String>,
    #[serde(
        rename = "Postcode",
        alias = "postcode",
        default,
        deserialize_with = "deserialize_string_lenient"
    )]
    pub postcode: String,
    #[serde(
        rename = "Woonplaats",
        alias = "Plaats",
        alias = "plaats",
        alias = "woonplaats",
        default,
        deserialize_with = "deserialize_string_lenient"
    )]
    pub plaats: String,
    #[serde(rename = "Land", alias = "land", default)]
    pub land: Option<String>,
    #[serde(
        rename = "Type",
        alias = "type",
        default,
        deserialize_with = "deserialize_string_lenient"
    )]
    pub address_type: String,
    #[serde(
        rename = "IsGeheim",
        alias = "isGeheim",
        default,
        deserialize_with = "deserialize_bool_lenient"
    )]
    pub is_geheim: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileCareer {
    #[serde(rename = "Id", alias = "id", default)]
    pub id: Option<i64>,
    #[serde(rename = "StamNr", alias = "stamNr", default)]
    pub stamnummer: Option<String>,
    #[serde(rename = "Studie", alias = "studie", default)]
    pub opleiding: Option<String>,
    #[serde(rename = "Klas", alias = "klas", default)]
    pub groep: Option<String>,
    #[serde(rename = "ExamenNr", alias = "examenNr", default)]
    pub examen_nummer: Option<String>,
    #[serde(rename = "Profielen", alias = "profielen", default)]
    pub profielen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileAddressResponse {
    #[serde(rename = "Items", alias = "items", default)]
    pub items: Vec<ProfileAddress>,
}

fn default_meerder_jarige_leeftijd() -> i32 {
    18
}

/// `/leerlingen/{id}/autorisatie` — parental access settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileAuthorization {
    #[serde(
        rename = "OudersMogenGegevensZien",
        alias = "oudersMogenGegevensZien",
        default,
        deserialize_with = "deserialize_bool_lenient"
    )]
    pub ouders_mogen_gegevens_zien: bool,
    #[serde(
        rename = "MagInzageOudersInstellen",
        alias = "magInzageOudersInstellen",
        default,
        deserialize_with = "deserialize_bool_lenient"
    )]
    pub mag_inzage_ouders_instellen: bool,
    #[serde(
        rename = "MeerderJarigeLeeftijd",
        alias = "meerderJarigeLeeftijd",
        default = "default_meerder_jarige_leeftijd",
        deserialize_with = "deserialize_age_lenient"
    )]
    pub meerder_jarige_leeftijd: i32,
}

/// One answered consent question from
/// `/toestemmingen/personen/{id}/antwoorden`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAnswer {
    #[serde(default, deserialize_with = "deserialize_i32_lenient")]
    pub vraag_id: i32,
    #[serde(default, deserialize_with = "deserialize_string_lenient")]
    pub code: String,
    #[serde(default, deserialize_with = "deserialize_string_lenient")]
    pub omschrijving: String,
    #[serde(default, deserialize_with = "deserialize_string_lenient")]
    pub uitleg: String,
    #[serde(default, deserialize_with = "deserialize_i32_lenient")]
    pub volgnummer: i32,
    #[serde(default)]
    pub datum_aangepast: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_lenient")]
    pub toestemming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileAnswerResponse {
    #[serde(rename = "Items", alias = "items", default)]
    pub items: Vec<ProfileAnswer>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_info_reads_private_email_and_elo_flag() {
        let info: ProfileInfo = serde_json::from_str(
            r#"{"Mobiel":"06-12345678","EmailAdres":"leerling@school.nl","EmailAdresPrive":"prive@example.com","EloBerichtenDoorsturen":true}"#,
        )
        .unwrap();

        assert_eq!(info.email.as_deref(), Some("leerling@school.nl"));
        assert_eq!(info.email_prive.as_deref(), Some("prive@example.com"));
        assert_eq!(info.mobiel.as_deref(), Some("06-12345678"));
        assert!(info.elo_berichten_doorsturen);
        assert_eq!(info.id, None);
    }

    #[test]
    fn profile_address_reads_lowercase_response() {
        let response: ProfileAddressResponse = serde_json::from_str(
            r#"{"items":[{"id":42,"straat":"Hoofdstraat","huisnummer":"1","toevoeging":"A","postcode":"1234 AB","plaats":"Hoofddorp","land":"Nederland","type":"Woon","isGeheim":true}]}"#,
        )
        .unwrap();

        let address = &response.items[0];
        assert_eq!(address.id, 42);
        assert_eq!(address.straat, "Hoofdstraat");
        assert_eq!(address.huisnummer, "1");
        assert_eq!(address.toevoeging.as_deref(), Some("A"));
        assert_eq!(address.postcode, "1234 AB");
        assert_eq!(address.plaats, "Hoofddorp");
        assert_eq!(address.land.as_deref(), Some("Nederland"));
        assert_eq!(address.address_type, "Woon");
        assert!(address.is_geheim);
    }

    #[test]
    fn profile_address_still_reads_pascal_case_and_numeric_type() {
        let response: ProfileAddressResponse = serde_json::from_str(
            r#"{"Items":[{"Id":7,"Straat":"Kerkweg","Huisnummer":"9","Toevoeging":null,"Postcode":"5678 CD","Woonplaats":"Haarlem","Land":"Nederland","Type":1}]}"#,
        )
        .unwrap();

        let address = &response.items[0];
        assert_eq!(address.plaats, "Haarlem");
        assert_eq!(address.address_type, "1");
        assert!(!address.is_geheim);
    }

    #[test]
    fn profile_career_reads_exam_number_and_profiles() {
        let career: ProfileCareer = serde_json::from_str(
            r#"{"Studie":"B VWO 4 TTO","Klas":"BV4b vwo","StamNr":"410319","ExamenNr":"123456","Profielen":"Natuur & Techniek"}"#,
        )
        .unwrap();

        assert_eq!(career.stamnummer.as_deref(), Some("410319"));
        assert_eq!(career.examen_nummer.as_deref(), Some("123456"));
        assert_eq!(career.profielen.as_deref(), Some("Natuur & Techniek"));
    }

    #[test]
    fn profile_authorization_defaults_to_minor_settings() {
        let auth: ProfileAuthorization = serde_json::from_str("{}").unwrap();
        assert!(!auth.ouders_mogen_gegevens_zien);
        assert!(!auth.mag_inzage_ouders_instellen);
        assert_eq!(auth.meerder_jarige_leeftijd, 18);

        let auth: ProfileAuthorization = serde_json::from_str(
            r#"{"oudersMogenGegevensZien":true,"magInzageOudersInstellen":true,"meerderJarigeLeeftijd":16}"#,
        )
        .unwrap();
        assert!(auth.ouders_mogen_gegevens_zien);
        assert!(auth.mag_inzage_ouders_instellen);
        assert_eq!(auth.meerder_jarige_leeftijd, 16);
    }

    #[test]
    fn profile_answers_read_camel_case_items() {
        let response: ProfileAnswerResponse = serde_json::from_str(
            r#"{"items":[{"vraagId":3,"code":"FOTO","omschrijving":"Foto publiceren","uitleg":"De school mag je foto gebruiken.","volgnummer":1,"datumAangepast":"2026-11-01T12:30:00","toestemming":true}]}"#,
        )
        .unwrap();

        let answer = &response.items[0];
        assert_eq!(answer.vraag_id, 3);
        assert_eq!(answer.code, "FOTO");
        assert_eq!(answer.omschrijving, "Foto publiceren");
        assert_eq!(answer.volgnummer, 1);
        assert_eq!(
            answer.datum_aangepast.as_deref(),
            Some("2026-11-01T12:30:00")
        );
        assert!(answer.toestemming);
    }

    #[test]
    fn profile_fields_tolerate_nulls() {
        let info: ProfileInfo = serde_json::from_str(
            r#"{"Mobiel":null,"EmailAdres":null,"EmailAdresPrive":null,"EloBerichtenDoorsturen":null}"#,
        )
        .unwrap();
        assert!(!info.elo_berichten_doorsturen);

        let response: ProfileAddressResponse = serde_json::from_str(
            r#"{"items":[{"id":null,"straat":null,"huisnummer":null,"postcode":null,"plaats":null,"land":null,"type":null,"isGeheim":null}]}"#,
        )
        .unwrap();
        let address = &response.items[0];
        assert_eq!(address.id, 0);
        assert_eq!(address.straat, "");
        assert_eq!(address.huisnummer, "");
        assert_eq!(address.postcode, "");
        assert_eq!(address.plaats, "");
        assert_eq!(address.land, None);
        assert_eq!(address.address_type, "");
        assert!(!address.is_geheim);

        let auth: ProfileAuthorization = serde_json::from_str(
            r#"{"oudersMogenGegevensZien":null,"magInzageOudersInstellen":null,"meerderJarigeLeeftijd":null}"#,
        )
        .unwrap();
        assert!(!auth.ouders_mogen_gegevens_zien);
        assert!(!auth.mag_inzage_ouders_instellen);
        assert_eq!(auth.meerder_jarige_leeftijd, 18);

        let response: ProfileAnswerResponse = serde_json::from_str(
            r#"{"items":[{"vraagId":null,"code":null,"omschrijving":null,"uitleg":null,"volgnummer":null,"toestemming":null}]}"#,
        )
        .unwrap();
        let answer = &response.items[0];
        assert_eq!(answer.vraag_id, 0);
        assert_eq!(answer.code, "");
        assert_eq!(answer.omschrijving, "");
        assert_eq!(answer.uitleg, "");
        assert_eq!(answer.volgnummer, 0);
        assert!(!answer.toestemming);
    }
}
