use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Definition of a tool that the AI can call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value, // JSON Schema for parameters
}

impl ToolDef {
    /// OpenAI-compatible tool definition format.
    pub fn to_openai_tool(&self) -> Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        })
    }

    /// Anthropic-compatible tool definition format.
    pub fn to_anthropic_tool(&self) -> Value {
        serde_json::json!({
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters,
        })
    }
}

/// All available tools the AI can use.
pub fn get_all_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "get_calendar_events".to_string(),
            description: "Haal agenda-items/lessen op voor een datumbereik (bijv. vandaag of deze week).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "start": {
                        "type": "string",
                        "description": "Startdatum in yyyy-MM-dd formaat"
                    },
                    "end": {
                        "type": "string",
                        "description": "Einddatum in yyyy-MM-dd formaat"
                    }
                },
                "required": ["start", "end"]
            }),
        },
        ToolDef {
            name: "get_grades".to_string(),
            description: "Haal recente cijfers op.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "top": {
                        "type": "integer",
                        "description": "Aantal cijfers om op te halen (max 20)",
                        "default": 10
                    }
                },
                "required": []
            }),
        },
        ToolDef {
            name: "get_full_grade_overview".to_string(),
            description: "Haal het volledige cijferoverzicht op met gemiddelden per vak. Gebruik dit als de gebruiker vraagt hoe hij/zij ervoor staat per vak, of om gemiddelden te bekijken. Eerst moet je get_schoolyears ophalen voor de juiste IDs.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "schoolyear_id": {
                        "type": "integer",
                        "description": "ID van het schooljaar (uit get_schoolyears)"
                    },
                    "einde": {
                        "type": "string",
                        "description": "Peildatum in yyyy-MM-dd formaat (gebruik vandaag of einde schooljaar)"
                    }
                },
                "required": ["schoolyear_id", "einde"]
            }),
        },
        ToolDef {
            name: "get_schoolyears".to_string(),
            description: "Haal schooljaren op voor deze leerling. Nodig voor get_full_grade_overview.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        ToolDef {
            name: "get_assignments".to_string(),
            description: "Haal huiswerk/opdrachten op voor een datumbereik.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "start": {
                        "type": "string",
                        "description": "Startdatum in yyyy-MM-dd formaat"
                    },
                    "end": {
                        "type": "string",
                        "description": "Einddatum in yyyy-MM-dd formaat"
                    }
                },
                "required": ["start", "end"]
            }),
        },
        ToolDef {
            name: "get_assignment_detail".to_string(),
            description: "Haal de volledige details van een specifieke opdracht op, inclusief bijlagen (bestanden).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "assignment_id": { "type": "integer", "description": "ID van de opdracht" }
                },
                "required": ["assignment_id"]
            }),
        },
        ToolDef {
            name: "get_messages".to_string(),
            description: "Haal berichten op uit een map (Postvak IN, Verzonden, Prullenbak, etc.).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "Map naam: 'Inbox', 'Sent', 'Trash'",
                        "default": "Inbox"
                    },
                    "top": {
                        "type": "integer",
                        "description": "Aantal berichten om op te halen",
                        "default": 10
                    }
                },
                "required": []
            }),
        },
        ToolDef {
            name: "get_message_content".to_string(),
            description: "Haal de inhoud van een specifiek bericht op. Gebruik dit als de gebruiker wil weten wat er in een bericht staat.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "message_id": {
                        "type": "integer",
                        "description": "ID van het bericht om op te halen"
                    }
                },
                "required": ["message_id"]
            }),
        },
        ToolDef {
            name: "send_message".to_string(),
            description: "Stuur een bericht via Magister. Gebruik dit om een bericht te verzenden naar een medeleerling, docent of klas.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "subject": { "type": "string", "description": "Onderwerp van het bericht" },
                    "body": { "type": "string", "description": "Inhoud van het bericht" },
                    "recipients": {
                        "type": "array",
                        "description": "Lijst van ontvangers, elk met id en type (leerling/docent/klas).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "integer" },
                                "type": { "type": "string", "enum": ["leerling", "docent", "klas"], "default": "leerling" }
                            },
                            "required": ["id"]
                        }
                    }
                },
                "required": ["subject", "body", "recipients"]
            }),
        },
        ToolDef {
            name: "mark_messages_read".to_string(),
            description: "Markeer een of meerdere berichten als gelezen. Geef de bericht-ID's op.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "message_ids": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "description": "Lijst van bericht-ID's om als gelezen te markeren."
                    }
                },
                "required": ["message_ids"]
            }),
        },
        ToolDef {
            name: "get_absences".to_string(),
            description: "Haal absentie/verzuim op voor een datumbereik.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "start": {
                        "type": "string",
                        "description": "Startdatum in yyyy-MM-dd formaat"
                    },
                    "end": {
                        "type": "string",
                        "description": "Einddatum in yyyy-MM-dd formaat"
                    }
                },
                "required": ["start", "end"]
            }),
        },
        ToolDef {
            name: "get_studiewijzers".to_string(),
            description: "Haal studiewijzers op (studiehandleidingen per vak).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        ToolDef {
            name: "get_activities".to_string(),
            description: "Haal buitenschoolse activiteiten op.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        ToolDef {
            name: "get_bronnen".to_string(),
            description: "Haal digitale leermaterialen en bronnen op (bijv. lesmateriaal links, websites).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        ToolDef {
            name: "get_leermiddelen".to_string(),
            description: "Haal digitale leermiddelen op (lesmateriaal, digitale boeken).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        ToolDef {
            name: "get_profile_info".to_string(),
            description: "Haal uitgebreide profielinformatie op: naam, klas, adres, opleidingsgegevens, mentor.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        ToolDef {
            name: "get_today_summary".to_string(),
            description: "Krijg een compleet overzicht van vandaag: rooster, cijfers, opdrachten, berichten, alle data in één keer.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        ToolDef {
            name: "read_attachment_text".to_string(),
            description: "Lees de tekstinhoud van een bijlage (PDF, Word .docx of tekstbestand). Gebruik dit als een opdracht een bijlage heeft en de gebruiker hulp wil met de inhoud, of als je de inhoud van een document moet kennen om te kunnen antwoorden. Geeft de ruwe tekst terug; afbeeldingen/diagrammen worden niet beschreven (best-effort, alleen tekst).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "URL van de bijlage (uit get_assignment_detail of get_message_content)" },
                    "filename": { "type": "string", "description": "Bestandsnaam van de bijlage; helpt bij het bepalen van het bestandstype" }
                },
                "required": ["url"]
            }),
        },
        ToolDef {
            name: "calculate_grade_scenario".to_string(),
            description: "Bereken cijfer-scenario's voor een vak: benodigd cijfer voor de volgende toets om een streefcijfer te halen, voorspeld gemiddelde na een hypothetisch cijfer, minimum cijfer om te slagen, en het effect op je totale gemiddelde. Geef de huidige cijfers mee (grades: lijst van {value, weight}) óf een schoolyear_id + subject zodat de tool ze zelf ophaalt. Gebruik dit voor 'wat heb ik nodig'-vragen over cijfers.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "schoolyear_id": { "type": "integer", "description": "ID van het schooljaar (uit get_schoolyears). Nodig als je geen grades meegeeft." },
                    "subject": { "type": "string", "description": "Naam of afkorting van het vak (bv. 'Wiskunde'). Nodig als je geen grades meegeeft." },
                    "grades": {
                        "type": "array",
                        "description": "Optioneel: lijst van huidige cijfers, elk met value (cijfer) en weight (weging) — of cijfer/weging zoals get_full_grade_overview ze teruggeeft. Als dit gegeven is, worden schoolyear_id/subject genegeerd.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "value": { "type": "number", "description": "Het cijfer, bv. 7.5 (ook 'cijfer' geaccepteerd)" },
                                "cijfer": { "type": "number", "description": "Het cijfer, bv. 7.5 (alias voor value)" },
                                "weight": { "type": "number", "description": "Weging (default 1)" },
                                "weging": { "type": "number", "description": "Weging (alias voor weight)" }
                            },
                            "required": []
                        }
                    },
                    "peildatum": { "type": "string", "description": "Peildatum yyyy-MM-dd (default: vandaag)" },
                    "target_average": { "type": "number", "description": "Streefcijfer (bv. 6.0) om te berekenen welk cijfer je voor de volgende toets nodig hebt." },
                    "next_grade": { "type": "number", "description": "Hypothetisch cijfer voor de volgende toets, om het voorspelde gemiddelde te berekenen." },
                    "next_grade_weight": { "type": "number", "description": "Weging van de volgende toets (default 1)" },
                    "remaining_tests": { "type": "integer", "description": "Aantal nog komende toetsen, om een eindgemiddelde-projectie te berekenen." },
                    "threshold": { "type": "number", "description": "Voldoende-grens (default 5.5) voor het minimum-cijfer-om-te-slagen." },
                    "simulation_grades": {
                        "type": "array",
                        "description": "Optioneel: extra cijfers om mee te simuleren (zoals in de app-rekenmachine).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "value": { "type": "number" },
                                "weight": { "type": "number", "default": 1 }
                            },
                            "required": ["value"]
                        }
                    },
                    "include_simulation": { "type": "boolean", "description": "Of simulatiecijfers meetellen in voorspellingen (default true)" },
                    "decimal_points": { "type": "integer", "description": "Aantal decimalen (default 2)" }
                },
                "required": []
            }),
        },
        ToolDef {
            name: "create_calendar_event".to_string(),
            description: "Maak een persoonlijke agenda-afspraak/herinnering aan (bijv. een studiemoment of deadline-reminder). Deze actie wordt pas uitgevoerd nadat de gebruiker deze bevestigt.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "start": { "type": "string", "description": "Startdatum/tijd in ISO-formaat (yyyy-MM-ddTHH:mm:ss)" },
                    "einde": { "type": "string", "description": "Einddatum/tijd in ISO-formaat (yyyy-MM-ddTHH:mm:ss)" },
                    "omschrijving": { "type": "string", "description": "Titel/korte omschrijving van de afspraak" },
                    "duurt_hele_dag": { "type": "boolean", "description": "Hele dag (default false)", "default": false },
                    "lokatie": { "type": "string", "description": "Locatie (optioneel)" },
                    "inhoud": { "type": "string", "description": "Volledige omschrijving (optioneel)" }
                },
                "required": ["start", "einde", "omschrijving"]
            }),
        },
        ToolDef {
            name: "download_file".to_string(),
            description: "Download een bestand van een opgegeven URL (uit de Magister API). Geeft de bestandsgrootte en het MIME-type terug. Gebruik read_attachment_text als je de inhoud van een PDF/Word/tekstbestand wilt lezen.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Volledige URL of relatief pad naar het bestand (zoals opgehaald uit assignment attachments of message attachments)." }
                },
                "required": ["url"]
            }),
        },
    ]
}

/// Result of executing a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool: String,
    pub success: bool,
    pub data: Value,
    pub error: Option<String>,
}

/// A side-effecting action the AI wants to perform, staged until the user
/// explicitly confirms it via `confirm_pending_action`. Write tools never
/// execute directly — they store a `PendingAction` and return a
/// "pending_user_confirmation" payload through the normal tool-result channel.
#[derive(Debug, Clone)]
pub struct PendingAction {
    /// Tool name that staged the action ("send_message", "mark_messages_read", ...).
    pub action_type: String,
    /// Original tool arguments, replayed verbatim when the action is confirmed.
    pub args: Value,
    /// Unix timestamp (seconds) of when the action was staged, for expiry.
    pub created_at: u64,
}

/// In-memory store of pending actions awaiting user confirmation.
pub type PendingActionStore = Mutex<HashMap<String, PendingAction>>;

/// How long a pending action stays confirmable before it expires. A stale
/// "confirm" button from an old conversation can never fire after this window.
pub const PENDING_ACTION_TTL_SECS: u64 = 15 * 60;

/// Generate a unique id for a pending action.
pub fn generate_action_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let random: u64 = rand::rng().random();
    format!("act-{:016x}-{:016x}", nanos, random)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Compute (totalPoints, totalWeight, gradeCount) from a vak node of the
/// `cijferoverzichtvooraanmelding` response, using the same filter rules as
/// `getSubjects()` in `src/routes/grades/Grades.svelte`: only grades with a
/// CijferStr, that count (`TeltMee`), with a parseable value.
fn subject_totals_from_overview(vak: &Value) -> (f64, f64, usize) {
    let mut tp = 0.0;
    let mut tw = 0.0;
    let mut count = 0usize;
    if let Some(cijfers) = vak.get("Cijfers").and_then(|c| c.as_array()) {
        for c in cijfers {
            let str = c.get("CijferStr").and_then(|v| v.as_str()).unwrap_or("");
            if str.is_empty() {
                continue;
            }
            let telt_mee = c.get("TeltMee").and_then(|v| v.as_bool()).unwrap_or(true);
            if !telt_mee {
                continue;
            }
            let Some(val) = crate::ai::grade_calc::parse_dutch_grade(str) else {
                continue;
            };
            let w = c.get("Weging").and_then(|v| v.as_f64()).unwrap_or(1.0);
            tp += val * w;
            tw += w;
            count += 1;
        }
    }
    (tp, tw, count)
}

/// Resolve a subject's current grade totals for `calculate_grade_scenario`:
/// either from an explicit `grades` array in `args`, or by fetching the grade
/// overview for a schoolyear and matching the subject name/abbreviation.
/// Returns (total_points, total_weight, grade_count, subject_name,
/// all_subjects_averages).
async fn resolve_scenario_grades(
    client: &mut crate::client::MagisterClient,
    args: &Value,
    person_id: i64,
    peildatum: &str,
) -> Result<(f64, f64, usize, String, Vec<(String, f64)>), String> {
    use crate::ai::grade_calc::{weighted_sum, GradePoint};

    let mut subject_name = args
        .get("subject")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if let Some(grades_arr) = args.get("grades").and_then(|v| v.as_array()) {
        let points: Vec<GradePoint> = grades_arr
            .iter()
            .filter_map(|g| {
                // Accept both {value, weight} and the shape get_full_grade_overview
                // returns ({cijfer, weging}) so the model can pass data through as-is.
                let value = g
                    .get("value")
                    .and_then(|v| v.as_f64())
                    .or_else(|| g.get("cijfer").and_then(|v| v.as_f64()))
                    .or_else(|| {
                        g.get("cijfer")
                            .and_then(|v| v.as_str())
                            .and_then(crate::ai::grade_calc::parse_dutch_grade)
                    })?;
                let weight = g
                    .get("weight")
                    .and_then(|v| v.as_f64())
                    .or_else(|| g.get("weging").and_then(|v| v.as_f64()))
                    .unwrap_or(1.0);
                Some(GradePoint { value, weight })
            })
            .collect();
        let (tp, tw) = weighted_sum(&points);
        return Ok((tp, tw, points.len(), subject_name, Vec::new()));
    }

    let schoolyear_id = args.get("schoolyear_id").and_then(|v| v.as_i64()).unwrap_or(0);
    let subject_query = subject_name.trim().to_lowercase();
    if schoolyear_id == 0 || subject_query.is_empty() {
        return Err(
            "Geef `grades` (lijst van {value, weight}) óf `schoolyear_id` + `subject` op."
                .to_string(),
        );
    }

    let path = format!(
        "personen/{}/aanmeldingen/{}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum={}",
        person_id, schoolyear_id, peildatum
    );

    let data = client.get(&path).await.map_err(|e| e.to_string())?;

    let vakken = data
        .get("CijferVakken")
        .or_else(|| data.get("CijferOverzicht").and_then(|co| co.get("CijferVakken")))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let found = vakken.iter().find(|vak| {
        let name = vak
            .get("Vak")
            .and_then(|v| v.get("Omschrijving"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let abbr = vak
            .get("Vak")
            .and_then(|v| v.get("Afkorting"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        name == subject_query
            || abbr == subject_query
            || (!name.is_empty() && name.contains(&subject_query))
            || (!subject_query.is_empty() && subject_query.contains(&name))
    });

    // Collect all subject averages for the overall-average effect.
    let mut all_subjects: Vec<(String, f64)> = Vec::new();
    for vak in &vakken {
        let name = vak
            .get("Vak")
            .and_then(|v| v.get("Omschrijving"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let (tp, tw, _) = subject_totals_from_overview(vak);
        if tw > 0.0 {
            all_subjects.push((name, tp / tw));
        }
    }

    let vak = found.ok_or_else(|| {
        let known: Vec<&str> = vakken
            .iter()
            .filter_map(|v| v.get("Vak").and_then(|v| v.get("Omschrijving")).and_then(|v| v.as_str()))
            .collect();
        format!(
            "Vak '{}' niet gevonden in het cijferoverzicht. Bekende vakken: {}",
            subject_query,
            known.join(", ")
        )
    })?;

    subject_name = vak
        .get("Vak")
        .and_then(|v| v.get("Omschrijving"))
        .and_then(|v| v.as_str())
        .unwrap_or(&subject_name)
        .to_string();
    let (tp, tw, count) = subject_totals_from_overview(vak);

    Ok((tp, tw, count, subject_name, all_subjects))
}

/// Execute an AI tool call and return the result.
/// `client` must be locked before calling.
/// Write tools (send_message, mark_messages_read, ...) do NOT perform their
/// side effect here — they stage a [`PendingAction`] in `pending_actions` and
/// return a "pending_user_confirmation" payload that the user must confirm
/// before anything is actually sent. Read-only tools execute immediately.
pub async fn execute_tool(
    client: &mut crate::client::MagisterClient,
    tool_name: &str,
    args: &Value,
    person_id: i64,
    pending_actions: &PendingActionStore,
) -> ToolResult {
    match tool_name {
        "get_calendar_events" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            match client
                .get(&format!(
                    "personen/{}/afspraken?tot={}&van={}",
                    person_id, end, start
                ))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|item| {
                                    serde_json::json!({
                                        "id": item.get("Id"),
                                        "start": item.get("Start"),
                                        "einde": item.get("Einde"),
                                        "vak": item.get("Vakken").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.get("Naam")),
                                        "docent": item.get("Docenten").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.get("Naam")),
                                        "lokaal": item.get("Lokalen").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.get("Naam")),
                                        "lesuur": item.get("LesuurVan"),
                                        "omschrijving": item.get("Omschrijving"),
                                        "inhoud": item.get("Inhoud"),
                                        "afgerond": item.get("Afgerond"),
                                        "type": item.get("Type"),
                                        "status": item.get("Status"),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_grades" => {
            let top = args.get("top").and_then(|v| v.as_i64()).unwrap_or(10).min(20) as usize;
            match client
                .get(&format!("personen/{}/cijfers/laatste?top={}&skip=0", person_id, top))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|item| {
                                    serde_json::json!({
                                        "id": item.get("Id"),
                                        "vak": item.get("Vak").and_then(|v| v.get("Omschrijving")),
                                        "cijfer": item.get("CijferStr"),
                                        "datum": item.get("DatumIngevoerd"),
                                        "weging": item.get("CijferKolom").and_then(|c| c.get("Weging")),
                                        "docent": item.get("Docent").and_then(|d| d.get("Naam")),
                                        "titel": item.get("CijferKolom").and_then(|c| c.get("Titel")),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_full_grade_overview" => {
            let schoolyear_id = args.get("schoolyear_id").and_then(|v| v.as_i64()).unwrap_or(0);
            let einde = args.get("einde").and_then(|v| v.as_str()).unwrap_or("");
            let peildatum = if einde.len() > 10 { &einde[0..10] } else { einde };

            let path = format!(
                "personen/{}/aanmeldingen/{}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum={}",
                person_id, schoolyear_id, peildatum
            );

            match client.get(&path).await {
                Ok(data) => {
                    let vakken = data
                        .get("CijferVakken")
                        .or_else(|| data.get("CijferOverzicht").and_then(|co| co.get("CijferVakken")))
                        .and_then(|v| v.as_array());

                    let simplified: Vec<Value> = vakken
                        .map(|vakken| {
                            vakken.iter().map(|vak| {
                                let cijfers: Vec<Value> = vak.get("Cijfers")
                                    .and_then(|c| c.as_array())
                                    .map(|arr| {
                                        arr.iter().map(|c| {
                                            serde_json::json!({
                                                "cijfer": c.get("CijferStr"),
                                                "datum": c.get("DatumIngevoerd"),
                                                "weging": c.get("Weging"),
                                                "titel": c.get("CijferKolom").and_then(|k| k.get("Titel")),
                                            })
                                        }).collect()
                                    })
                                    .unwrap_or_default();

                                serde_json::json!({
                                    "vak": vak.get("Vak").and_then(|v| v.get("Omschrijving")).or_else(|| vak.get("Vak").and_then(|v| v.get("Afkorting"))),
                                    "gemiddelde": vak.get("Gemiddelde"),
                                    "cijfers": cijfers,
                                })
                            }).collect()
                        })
                        .unwrap_or_default();

                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "vakken": simplified, "count": simplified.len(), "peildatum": peildatum }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_schoolyears" => {
            match client
                .get(&format!("leerlingen/{}/aanmeldingen", person_id))
                .await
            {
                Ok(data) => {
                    let items: Vec<Value> = data["Items"]
                        .as_array()
                        .or_else(|| data["items"].as_array())
                        .or_else(|| data.as_array())
                        .map(|arr| {
                            arr.iter().map(|item| {
                                serde_json::json!({
                                    "id": item.get("Id"),
                                    "naam": item.get("Naam"),
                                    "van": item.get("Van"),
                                    "tot": item.get("Tot"),
                                    "is_actief": item.get("IsActief"),
                                })
                            }).collect()
                        })
                        .unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": items, "count": items.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_assignments" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            match client
                .get(&format!(
                    "personen/{}/opdrachten?van={}&tot={}",
                    person_id, start, end
                ))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|item| {
                                    serde_json::json!({
                                        "id": item.get("Id"),
                                        "titel": item.get("Titel"),
                                        "vak": item.get("Vak"),
                                        "inleveren_voor": item.get("InleverenVoor"),
                                        "ingeleverd_op": item.get("IngeleverdOp"),
                                        "afgesloten": item.get("Afgesloten"),
                                        "omschrijving": item.get("Omschrijving"),
                                        "type": item.get("Type"),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_messages" => {
            let folder = args.get("folder").and_then(|v| v.as_str()).unwrap_or("Inbox");
            let top = args.get("top").and_then(|v| v.as_i64()).unwrap_or(10);
            match client.get("berichten/mappen").await {
                Ok(folders_data) => {
                    let folders = folders_data.get("Items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let folder_item = folders.iter().find(|f| {
                        f.get("Naam").and_then(|v| v.as_str()).map(|n| n == folder).unwrap_or(false)
                    });
                    if let Some(f) = folder_item {
                        let link = f.get("Links").and_then(|l| l.as_array()).and_then(|arr| arr.first())
                            .and_then(|l| l.get("Href")).and_then(|h| h.as_str()).unwrap_or("");
                        match client.get(&format!("{}/berichten?top={}", link, top)).await {
                            Ok(msgs) => {
                                let items = msgs.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                                let simplified: Vec<Value> = items.as_array().map(|arr| {
                                    arr.iter().map(|item| {
                                        serde_json::json!({
                                            "id": item.get("Id"),
                                            "onderwerp": item.get("Onderwerp"),
                                            "afzender": item.get("Afzender").and_then(|a| a.get("Naam")),
                                            "datum": item.get("DatumVerzonden"),
                                            "gelezen": item.get("IsGelezen"),
                                            "prioriteit": item.get("Prioriteit"),
                                        })
                                    }).collect()
                                }).unwrap_or_default();
                                ToolResult {
                                    tool: tool_name.to_string(),
                                    success: true,
                                    data: serde_json::json!({ "items": simplified, "count": simplified.len(), "folder": folder }),
                                    error: None,
                                }
                            }
                            Err(e) => ToolResult {
                                tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                            },
                        }
                    } else {
                        ToolResult {
                            tool: tool_name.to_string(), success: false, data: Value::Null,
                            error: Some(format!("Map '{}' niet gevonden", folder)),
                        }
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_message_content" => {
            let message_id = args.get("message_id").and_then(|v| v.as_i64()).unwrap_or(0);
            match client.get(&format!("berichten/{}", message_id)).await {
                Ok(data) => {
                    let simplified = serde_json::json!({
                        "id": data.get("Id"),
                        "onderwerp": data.get("Onderwerp"),
                        "afzender": data.get("Afzender").and_then(|a| a.get("Naam")),
                        "datum": data.get("DatumVerzonden"),
                        "inhoud": data.get("Inhoud"),
                        "bijlagen": data.get("Bijlagen"),
                        "is_gelezen": data.get("IsGelezen"),
                    });
                    ToolResult {
                        tool: tool_name.to_string(), success: true, data: simplified, error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_absences" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            match client
                .get(&format!("personen/{}/absenties?tot={}&van={}", person_id, end, start))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": items, "count": items.as_array().map(|a| a.len()).unwrap_or(0) }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_studiewijzers" => {
            match client.get(&format!("personen/{}/studiewijzers", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "naam": item.get("Naam"),
                                "vak": item.get("VakNaam"),
                                "geldig_vanaf": item.get("GeldigVanaf"), "geldig_tot": item.get("GeldigTot"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_activities" => {
            match client.get(&format!("personen/{}/activiteiten", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "naam": item.get("Naam"),
                                "categorie": item.get("Categorie"),
                                "begin": item.get("Begin"), "einde": item.get("Einde"),
                                "status": item.get("Status"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_bronnen" => {
            match client.get(&format!("personen/{}/bronnen?soort=0", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "naam": item.get("Naam"),
                                "bron_soort": item.get("BronSoort"),
                                "url": item.get("Url"),
                                "is_favoriet": item.get("IsFavoriet"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_leermiddelen" => {
            match client.get(&format!("personen/{}/lesmateriaal", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "titel": item.get("Titel"),
                                "vak": item.get("VakNaam"),
                                "uitgever": item.get("Uitgever"),
                                "type": item.get("Type"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_profile_info" => {
            let mut results = serde_json::Map::new();

            if let Ok(account) = client.get("account").await {
                results.insert("account".to_string(), account);
            }

            if let Ok(profile) = client.get(&format!("personen/{}", person_id)).await {
                let simplified = serde_json::json!({
                    "roepnaam": profile.get("Roepnaam"),
                    "voorletter": profile.get("Voorletter"),
                    "achternaam": profile.get("Achternaam"),
                    "geboortedatum": profile.get("Geboortedatum"),
                    "klas": profile.get("Groep"),
                });
                results.insert("persoon".to_string(), simplified);
            }

            if let Ok(addr_data) = client.get(&format!("personen/{}/adressen", person_id)).await {
                let items = addr_data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                results.insert("adressen".to_string(), Value::Array(items.as_array().cloned().unwrap_or_default()));
            }

            if let Ok(career) = client.get(&format!("personen/{}/opleidinggegevensprofiel", person_id)).await {
                results.insert("opleiding".to_string(), career);
            }

            ToolResult {
                tool: tool_name.to_string(), success: true,
                data: serde_json::Value::Object(results),
                error: None,
            }
        }
        "get_today_summary" => {
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let next_week = (chrono::Utc::now() + chrono::Duration::days(7)).format("%Y-%m-%d").to_string();

            let mut summary = serde_json::Map::new();

            if let Ok(events) = client
                .get(&format!("personen/{}/afspraken?tot={}&van={}", person_id, today, today))
                .await
            {
                let items = events.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("vandaag_lessen".to_string(), items);
            }

            if let Ok(grades) = client
                .get(&format!("personen/{}/cijfers/laatste?top=5&skip=0", person_id))
                .await
            {
                let items = grades.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("recente_cijfers".to_string(), items);
            }

            if let Ok(assignments) = client
                .get(&format!("personen/{}/opdrachten?van={}&tot={}", person_id, today, next_week))
                .await
            {
                let items = assignments.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("aankomende_opdrachten".to_string(), items);
            }

            if let Ok(folders) = client.get("berichten/mappen").await {
                let unread = folders.get("Items").and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|f| f.get("aantalOngelezen").and_then(|v| v.as_i64())).sum::<i64>())
                    .unwrap_or(0);
                summary.insert("ongelezen_berichten".to_string(), Value::Number(unread.into()));
            }

            if let Ok(absences) = client
                .get(&format!("personen/{}/absenties?tot={}&van={}", person_id, today, today))
                .await
            {
                let items = absences.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("vandaag_absenties".to_string(), items);
            }

            ToolResult {
                tool: tool_name.to_string(), success: true,
                data: serde_json::Value::Object(summary),
                error: None,
            }
        }

        // Write tool: never send directly. Stage the message for explicit user
        // confirmation; the real POST only happens via confirm_pending_action.
        "send_message" => {
            let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let recipients: Vec<Value> = args.get("recipients").and_then(|v| v.as_array()).cloned().unwrap_or_default();

            if subject.trim().is_empty() || body.trim().is_empty() || recipients.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Bericht ontbreekt: onderwerp, inhoud en minstens één ontvanger zijn verplicht.".to_string()),
                };
            }

            let action_id = generate_action_id();
            let action = PendingAction {
                action_type: "send_message".to_string(),
                args: args.clone(),
                created_at: now_secs(),
            };
            if let Ok(mut store) = pending_actions.lock() {
                store.insert(action_id.clone(), action);
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "status": "pending_user_confirmation",
                    "action_id": action_id,
                    "action_type": "send_message",
                    "recipients": recipients,
                    "subject": subject,
                    "body": body,
                    "message": format!(
                        "Het bericht '{}' is klaargezet en wacht op bevestiging door de gebruiker. Er is nog NIETS verzonden. Vertel de gebruiker dat het bericht klaarstaat en dat hij/zij het expliciet moet bevestigen voordat het daadwerkelijk wordt verstuurd.",
                        subject
                    )
                }),
                error: None,
            }
        }

        // Write tool: never mark directly. Stage the action for explicit user
        // confirmation; the real PUT only happens via confirm_pending_action.
        "mark_messages_read" => {
            let message_ids = args.get("message_ids")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect::<Vec<i64>>())
                .unwrap_or_default();

            if message_ids.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Geen geldige bericht-ID's opgegeven.".to_string()),
                };
            }

            let action_id = generate_action_id();
            let action = PendingAction {
                action_type: "mark_messages_read".to_string(),
                args: args.clone(),
                created_at: now_secs(),
            };
            if let Ok(mut store) = pending_actions.lock() {
                store.insert(action_id.clone(), action);
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "status": "pending_user_confirmation",
                    "action_id": action_id,
                    "action_type": "mark_messages_read",
                    "message_ids": message_ids,
                    "message": "De berichten zijn klaargezet om als gelezen te markeren en wachten op bevestiging door de gebruiker. Er is nog NIETS gemarkeerd. Vertel de gebruiker dat er bevestiging nodig is."
                }),
                error: None,
            }
        }

        "get_assignment_detail" => {
            let assignment_id = args.get("assignment_id").and_then(|v| v.as_i64()).unwrap_or(0);

            match client.get(&format!("personen/{}/opdrachten/{}", person_id, assignment_id)).await {
                Ok(data) => {
                    let simplified = serde_json::json!({
                        "id": data.get("Id"),
                        "titel": data.get("Titel"),
                        "vak": data.get("Vak"),
                        "inleveren_voor": data.get("InleverenVoor"),
                        "ingeleverd_op": data.get("IngeleverdOp"),
                        "omschrijving": data.get("Omschrijving"),
                        "bijlagen": data.get("Bijlagen").and_then(|b| b.as_array()).map(|arr| {
                            arr.iter().map(|a| serde_json::json!({
                                "id": a.get("Id"),
                                "naam": a.get("Naam"),
                                "url": a.get("Url"),
                                "grootte": a.get("Grootte"),
                                "content_type": a.get("ContentType"),
                            })).collect::<Vec<_>>()
                        }),
                        "docenten": data.get("Docenten"),
                        "beoordeling": data.get("Beoordeling"),
                        "beoordeeld_op": data.get("BeoordeeldOp"),
                        "status_laatste_opdracht_versie": data.get("StatusLaatsteOpdrachtVersie"),
                    });
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: simplified,
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }

        "read_attachment_text" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let filename = args
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("bijlage")
                .to_string();

            if url.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Geen URL opgegeven.".to_string()),
                };
            }

            // Magister's download/Self links are indirection links — resolve to the
            // real content URL first (same two-call sequence as download_file).
            let path = url.trim_start_matches("/api/");
            let resolved = match client.get_redirect_location(path).await {
                Ok(resolved) => resolved,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(format!("Kon download-link niet resolven: {}", e)),
                    };
                }
            };

            match client.get_bytes_with_content_type(&resolved).await {
                Ok((bytes, content_type)) => {
                    match crate::ai::attachment_reader::extract_text(&bytes, &filename, &content_type) {
                        Ok(raw) => {
                            let truncated = raw.chars().count()
                                > crate::ai::attachment_reader::MAX_TEXT_CHARS;
                            let text: String = raw
                                .chars()
                                .take(crate::ai::attachment_reader::MAX_TEXT_CHARS)
                                .collect();
                            ToolResult {
                                tool: tool_name.to_string(),
                                success: true,
                                data: serde_json::json!({
                                    "filename": filename,
                                    "content_type": content_type,
                                    "size_bytes": bytes.len(),
                                    "text": text,
                                    "char_count": text.chars().count(),
                                    "truncated": truncated,
                                    "message": if truncated {
                                        "De tekst is afgekapt tot 8000 tekens om ruimte te besparen."
                                    } else {
                                        "De volledige tekst van de bijlage staat hierboven."
                                    }
                                }),
                                error: None,
                            }
                        }
                        Err(e) => ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(e),
                        },
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }

        "calculate_grade_scenario" => {
            use crate::ai::grade_calc::{
                average_for_grade, min_grade_for_pass, new_overall_average, predicted_average,
                predicted_end, required_grade, GradePoint, MinGradeForPass,
            };

            let decimal_points = args
                .get("decimal_points")
                .and_then(|v| v.as_i64())
                .unwrap_or(2)
                .max(0) as usize;

            let peildatum = args.get("peildatum").and_then(|v| v.as_str()).unwrap_or("");
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            let peil = if peildatum.len() >= 10 { &peildatum[0..10] } else { &today };

            // 1. Resolve the subject's current grades: explicit `grades` array,
            //    or fetched internally from the grade overview via schoolyear_id+subject.
            let (total_points, total_weight, grade_count, subject_name, all_subjects) =
                match resolve_scenario_grades(client, args, person_id, peil).await {
                    Ok(v) => v,
                    Err(e) => {
                        return ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(e),
                        };
                    }
                };

            // 2. Compute the requested scenario(s) with the same rules as the
            //    in-app calculator (grade_calc.rs is a port of predictor.ts).
            let target_average = args.get("target_average").and_then(|v| v.as_f64());
            let next_grade = args.get("next_grade").and_then(|v| v.as_f64());
            let next_grade_weight = args
                .get("next_grade_weight")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0);
            let remaining_tests = args.get("remaining_tests").and_then(|v| v.as_i64());
            let threshold = args.get("threshold").and_then(|v| v.as_f64());
            let simulation: Vec<GradePoint> = args
                .get("simulation_grades")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|g| {
                            let value = g
                                .get("value")
                                .and_then(|v| v.as_f64())
                                .or_else(|| g.get("cijfer").and_then(|v| v.as_f64()))
                                .or_else(|| {
                                    g.get("cijfer")
                                        .and_then(|v| v.as_str())
                                        .and_then(crate::ai::grade_calc::parse_dutch_grade)
                                })?;
                            let weight = g
                                .get("weight")
                                .and_then(|v| v.as_f64())
                                .or_else(|| g.get("weging").and_then(|v| v.as_f64()))
                                .unwrap_or(1.0);
                            Some(GradePoint { value, weight })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let include_simulation = args
                .get("include_simulation")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            let current_avg = if total_weight > 0.0 {
                total_points / total_weight
            } else {
                0.0
            };
            let num = |v: f64| -> Value {
                serde_json::Number::from_f64(v)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            };

            let mut result = serde_json::Map::new();
            result.insert("subject".to_string(), Value::String(subject_name.clone()));
            result.insert(
                "current_average".to_string(),
                Value::String(format!("{:.*}", decimal_points, current_avg)),
            );
            result.insert("current_average_numeric".to_string(), num(current_avg));
            result.insert("total_points".to_string(), num(total_points));
            result.insert("total_weight".to_string(), num(total_weight));
            result.insert("grade_count".to_string(), Value::Number(grade_count.into()));
            result.insert("peildatum".to_string(), Value::String(peil.to_string()));

            if let Some(target) = target_average {
                let req = required_grade(
                    total_points,
                    total_weight,
                    target,
                    next_grade_weight,
                    &simulation,
                    decimal_points,
                );
                result.insert("required_grade".to_string(), Value::String(req.clone()));
                if let Some(n) = req.parse::<f64>().ok() {
                    result.insert("required_grade_numeric".to_string(), num(n));
                }
                result.insert("target_average".to_string(), num(target));
                result.insert("required_grade_grade_weight".to_string(), num(next_grade_weight));
            }

            if let Some(ng) = next_grade {
                let mut sim_with_next = simulation.clone();
                sim_with_next.push(GradePoint { value: ng, weight: next_grade_weight });
                let pa = predicted_average(
                    total_points,
                    total_weight,
                    &sim_with_next,
                    include_simulation,
                    decimal_points,
                );
                result.insert("predicted_average".to_string(), Value::String(pa.clone()));
                if let Some(n) = pa.parse::<f64>().ok() {
                    result.insert("predicted_average_numeric".to_string(), num(n));
                }
                result.insert(
                    "average_for_grade".to_string(),
                    Value::String(average_for_grade(
                        total_points,
                        total_weight,
                        ng,
                        next_grade_weight,
                        decimal_points,
                    )),
                );
                result.insert("next_grade".to_string(), num(ng));
                result.insert("next_grade_weight".to_string(), num(next_grade_weight));

                if let Some(rt) = remaining_tests {
                    let rt_u = rt.max(0) as usize;
                    let pe = predicted_end(total_points, total_weight, rt_u, ng);
                    result.insert(
                        "predicted_end".to_string(),
                        Value::String(format!("{:.*}", decimal_points, pe)),
                    );
                    result.insert(
                        "predicted_end_remaining_tests".to_string(),
                        Value::Number(rt.into()),
                    );
                }

                if !all_subjects.is_empty() {
                    let replacement = pa.parse::<f64>().unwrap_or(current_avg);
                    let na = new_overall_average(
                        &all_subjects,
                        &subject_name,
                        replacement,
                        decimal_points,
                    );
                    result.insert("new_overall_average".to_string(), Value::String(na));
                }
            }

            if let Some(thr) = threshold {
                result.insert("threshold".to_string(), num(thr));
                let pass = min_grade_for_pass(total_points, total_weight, thr);
                let label = match pass {
                    MinGradeForPass::Needed(v) => v,
                    MinGradeForPass::AlreadyPassing => "already_passing".to_string(),
                    MinGradeForPass::Impossible => "impossible".to_string(),
                };
                result.insert("min_grade_for_pass".to_string(), Value::String(label));
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: Value::Object(result),
                error: None,
            }
        }

        // Write tool: never create directly. Stage the action for explicit user
        // confirmation; the real POST only happens via confirm_pending_action.
        "create_calendar_event" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let einde = args.get("einde").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let omschrijving = args
                .get("omschrijving")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if start.is_empty() || einde.is_empty() || omschrijving.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Start, einde en omschrijving zijn verplicht.".to_string()),
                };
            }

            let action_id = generate_action_id();
            let action = PendingAction {
                action_type: "create_calendar_event".to_string(),
                args: args.clone(),
                created_at: now_secs(),
            };
            if let Ok(mut store) = pending_actions.lock() {
                store.insert(action_id.clone(), action);
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "status": "pending_user_confirmation",
                    "action_id": action_id,
                    "action_type": "create_calendar_event",
                    "start": start,
                    "einde": einde,
                    "omschrijving": omschrijving,
                    "message": "De agenda-afspraak is klaargezet en wacht op bevestiging door de gebruiker. Er is nog NIETS aangemaakt. Vertel de gebruiker dat er bevestiging nodig is."
                }),
                error: None,
            }
        }

        "download_file" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");

            if url.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Geen URL opgegeven.".to_string()),
                };
            }

            // Magister's download/Self links are indirection links — resolve to the
            // real content URL first (same two-call sequence as download_file).
            let path = url.trim_start_matches("/api/");
            let resolved = match client.get_redirect_location(path).await {
                Ok(resolved) => resolved,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(format!("Kon download-link niet resolven: {}", e)),
                    };
                }
            };

            match client.get_bytes_with_content_type(&resolved).await {
                Ok((bytes, content_type)) => {
                    let size = bytes.len();
                    let data = serde_json::json!({
                        "url": url,
                        "size_bytes": size,
                        "size_mb": (size as f64) / 1_048_576.0,
                        "mime_type": content_type,
                        "message": "Het bestand is gedownload. De AI kan de inhoud niet lezen, maar je kunt het openen via de link."
                    });
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data,
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }

        _ => ToolResult {
            tool: tool_name.to_string(), success: false, data: Value::Null,
            error: Some(format!("Onbekende tool: {}", tool_name)),
        },
    }
}

/// Execute a previously-staged action after the user confirmed it.
///
/// This is the ONLY path that performs real write operations on the user's
/// behalf (e.g. the Magister send-message endpoint). `execute_tool` only
/// stages actions; nothing with a real side effect ever runs without the user
/// tapping confirm on a pending action.
pub async fn execute_pending_action(
    client: &mut crate::client::MagisterClient,
    action: &PendingAction,
) -> Result<Value, String> {
    match action.action_type.as_str() {
        "send_message" => {
            let subject = action.args.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let body = action.args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let recipients = action.args.get("recipients").and_then(|v| v.as_array()).cloned().unwrap_or_default();

            let ontvangers: Vec<serde_json::Value> = recipients.iter().map(|r| {
                serde_json::json!({
                    "id": r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                    "type": r.get("type").and_then(|v| v.as_str()).unwrap_or("leerling")
                })
            }).collect();

            let req_body = serde_json::json!({
                "ontvangers": ontvangers,
                "kopieOntvangers": [],
                "blindeKopieOntvangers": [],
                "heeftPrioriteit": false,
                "inhoud": body,
                "onderwerp": subject,
                "verzendOptie": "standaard",
                "bijlagen": []
            });

            client.post("berichten/verzenden", &req_body).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "status": "verzonden", "subject": subject }))
        }
        "mark_messages_read" => {
            let message_ids = action.args.get("message_ids")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect::<Vec<i64>>())
                .unwrap_or_default();

            let body = serde_json::json!({"BerichtIds": message_ids});
            client.put("berichten/gelezen", &body).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "status": "gemarkeerd", "aantal": message_ids.len() }))
        }
        "create_calendar_event" => {
            let person_id = client
                .token_set
                .as_ref()
                .and_then(|t| t.person_id)
                .ok_or_else(|| "Niet geauthenticeerd.".to_string())?;

            let start = action.args.get("start").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let einde = action.args.get("einde").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let duurt_hele_dag = action.args.get("duurt_hele_dag").and_then(|v| v.as_bool()).unwrap_or(false);
            let omschrijving = action.args.get("omschrijving").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let lokatie = action.args
                .get("lokatie")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let inhoud = action.args
                .get("inhoud")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let info_type = if inhoud.is_some() { 1 } else { 0 };

            let body = serde_json::json!({
                "Start": start,
                "Einde": einde,
                "DuurtHeleDag": duurt_hele_dag,
                "Omschrijving": omschrijving,
                "Lokatie": lokatie,
                "Inhoud": inhoud,
                "Type": 1,
                "Status": 2,
                "InfoType": info_type
            });

            client.post(&format!("personen/{}/afspraken", person_id), &body)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "status": "aangemaakt", "omschrijving": omschrijving }))
        }
        _ => Err(format!("Onbekende actie: {}", action.action_type)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::MagisterClient;
    use chrono::Utc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn mock_token_set(endpoint: &str) -> crate::client::TokenSet {
        crate::client::TokenSet {
            access_token: "mock_access_token".to_string(),
            id_token: "mock_id_token".to_string(),
            refresh_token: "mock_refresh_token".to_string(),
            expires_at: Utc::now() + chrono::Duration::seconds(3600),
            api_endpoint: endpoint.to_string(),
            person_id: Some(123),
            account_uuid: None,
        }
    }

    fn client_with_token(endpoint: &str) -> MagisterClient {
        let mut client = MagisterClient::new();
        client.token_set = Some(mock_token_set(endpoint));
        client
    }

    fn send_message_args() -> Value {
        serde_json::json!({
            "subject": "Vraag over huiswerk",
            "body": "Hallo! Wanneer moet het verslag ingeleverd worden?",
            "recipients": [
                { "id": 456, "type": "docent" }
            ]
        })
    }

    #[tokio::test]
    async fn send_message_stages_pending_action_without_sending() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        // No network configured at all — if execute_tool tried to POST, it
        // would fail (no token set), so success proves nothing was sent.
        let mut client = MagisterClient::new();

        let result = execute_tool(&mut client, "send_message", &send_message_args(), 123, &store).await;

        assert!(result.success, "expected pending result, got error: {:?}", result.error);
        assert_eq!(result.data["status"], "pending_user_confirmation");
        assert_eq!(result.data["action_type"], "send_message");
        assert_eq!(result.data["subject"], "Vraag over huiswerk");
        assert_eq!(result.data["body"], "Hallo! Wanneer moet het verslag ingeleverd worden?");

        // The staged action must be stored so confirm_pending_action can run it.
        let action_id = result.data["action_id"].as_str().expect("action_id present");
        let stored = store.lock().unwrap();
        let action = stored.get(action_id).expect("pending action stored");
        assert_eq!(action.action_type, "send_message");
    }

    #[tokio::test]
    async fn mark_messages_read_stages_pending_action_without_marking() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();

        let args = serde_json::json!({ "message_ids": [10, 11] });
        let result = execute_tool(&mut client, "mark_messages_read", &args, 123, &store).await;

        assert!(result.success, "expected pending result, got error: {:?}", result.error);
        assert_eq!(result.data["status"], "pending_user_confirmation");
        assert_eq!(result.data["action_type"], "mark_messages_read");

        let action_id = result.data["action_id"].as_str().expect("action_id present");
        assert!(store.lock().unwrap().contains_key(action_id));
    }

    #[tokio::test]
    async fn confirm_send_message_posts_to_magister() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/berichten/verzenden"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        // Stage the action exactly like execute_tool would.
        let result = execute_tool(&mut client, "send_message", &send_message_args(), 123, &store).await;
        assert!(result.success);
        let action_id = result.data["action_id"].as_str().unwrap().to_string();

        let action = store.lock().unwrap().remove(&action_id).unwrap();
        let outcome = execute_pending_action(&mut client, &action).await.expect("send succeeds");
        assert_eq!(outcome["status"], "verzonden");
        assert_eq!(outcome["subject"], "Vraag over huiswerk");
    }

    #[tokio::test]
    async fn unknown_action_is_rejected() {
        let mut client = MagisterClient::new();
        let action = PendingAction {
            action_type: "nope".to_string(),
            args: serde_json::json!({}),
            created_at: now_secs(),
        };
        let outcome = execute_pending_action(&mut client, &action).await;
        assert!(outcome.is_err());
    }

    #[tokio::test]
    async fn read_attachment_text_returns_plain_text() {
        let mock_server = MockServer::start().await;
        let content_url = format!("{}/contents/opdracht", mock_server.uri());

        // Step 1: the attachment's indirection link resolves to the content URL.
        Mock::given(method("GET"))
            .and(path("/opdrachten/1/bijlagen/2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "location": content_url,
            })))
            .mount(&mock_server)
            .await;

        // Step 2: the resolved URL returns the file bytes.
        Mock::given(method("GET"))
            .and(path("/contents/opdracht"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(
                        "De opdracht is om een verslag te schrijven over de Tweede Wereldoorlog.",
                    )
                    .insert_header("Content-Type", "text/plain"),
            )
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        let args = serde_json::json!({
            "url": format!("{}/opdrachten/1/bijlagen/2", mock_server.uri()),
            "filename": "opdracht.txt"
        });
        let result = execute_tool(&mut client, "read_attachment_text", &args, 123, &store).await;

        assert!(result.success, "got error: {:?}", result.error);
        assert!(result.data["text"]
            .as_str()
            .unwrap()
            .contains("Tweede Wereldoorlog"));
    }

    #[tokio::test]
    async fn calculate_grade_scenario_with_explicit_grades() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();

        let args = serde_json::json!({
            "grades": [
                { "value": 6.0, "weight": 1.0 },
                { "value": 7.0, "weight": 2.0 },
                { "value": 5.0, "weight": 1.0 }
            ],
            "target_average": 6.0,
            "next_grade": 8.0,
            "next_grade_weight": 1.0,
            "threshold": 5.5,
            "decimal_points": 2
        });
        let result = execute_tool(&mut client, "calculate_grade_scenario", &args, 123, &store).await;

        assert!(result.success, "got error: {:?}", result.error);
        // 6*1 + 7*2 + 5*1 = 25 points over weight 4 → avg 6.25
        assert_eq!(result.data["total_points"], 25.0);
        assert_eq!(result.data["total_weight"], 4.0);
        assert_eq!(result.data["current_average"], "6.25");
        // required for target 6.0 (next weight 1): (6.0*5 - 25)/1 = 5.00
        assert_eq!(result.data["required_grade"], "5.00");
        // predicted avg with next 8.0: (25 + 8)/5 = 6.60
        assert_eq!(result.data["predicted_average"], "6.60");
        // min grade to pass (threshold 5.5): (5.5*5 - 25)/1 = 2.5
        assert_eq!(result.data["min_grade_for_pass"], "2.5");
    }

    #[tokio::test]
    async fn calculate_grade_scenario_requires_grades_or_schoolyear() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();
        let args = serde_json::json!({ "target_average": 6.0 });
        let result = execute_tool(&mut client, "calculate_grade_scenario", &args, 123, &store).await;
        assert!(!result.success);
        assert!(result.error.as_deref().unwrap().contains("grades"));
    }

    #[tokio::test]
    async fn create_calendar_event_stages_pending_action() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();

        let args = serde_json::json!({
            "start": "2026-09-01T15:00:00",
            "einde": "2026-09-01T16:00:00",
            "omschrijving": "Werken aan verslag",
            "inhoud": "Hoofdstuk 3 afmaken"
        });
        let result = execute_tool(&mut client, "create_calendar_event", &args, 123, &store).await;

        assert!(result.success, "expected pending result, got error: {:?}", result.error);
        assert_eq!(result.data["status"], "pending_user_confirmation");
        assert_eq!(result.data["action_type"], "create_calendar_event");
        assert_eq!(result.data["omschrijving"], "Werken aan verslag");

        let action_id = result.data["action_id"].as_str().expect("action_id present");
        let stored = store.lock().unwrap();
        assert!(stored.contains_key(action_id));
    }

    #[tokio::test]
    async fn confirm_create_calendar_event_posts_to_magister() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/personen/123/afspraken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        let args = serde_json::json!({
            "start": "2026-09-01T15:00:00",
            "einde": "2026-09-01T16:00:00",
            "omschrijving": "Werken aan verslag"
        });
        let result = execute_tool(&mut client, "create_calendar_event", &args, 123, &store).await;
        assert!(result.success);

        let action_id = result.data["action_id"].as_str().unwrap().to_string();
        let action = store.lock().unwrap().remove(&action_id).unwrap();
        let outcome = execute_pending_action(&mut client, &action).await.expect("create succeeds");
        assert_eq!(outcome["status"], "aangemaakt");
        assert_eq!(outcome["omschrijving"], "Werken aan verslag");
    }
}

