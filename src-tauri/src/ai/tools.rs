use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// Execute an AI tool call and return the result.
/// `client` must be locked before calling.
pub async fn execute_tool(
    client: &mut crate::client::MagisterClient,
    tool_name: &str,
    args: &Value,
    person_id: i64,
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
                    // Extract grades from CijferVakken structure
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

            // Get account info
            if let Ok(account) = client.get("account").await {
                results.insert("account".to_string(), account);
            }

            // Get profile
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

            // Get addresses
            if let Ok(addr_data) = client.get(&format!("personen/{}/adressen", person_id)).await {
                let items = addr_data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                results.insert("adressen".to_string(), Value::Array(items.as_array().cloned().unwrap_or_default()));
            }

            // Get career/education info
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

            // Calendar events today
            if let Ok(events) = client
                .get(&format!("personen/{}/afspraken?tot={}&van={}", person_id, today, today))
                .await
            {
                let items = events.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("vandaag_lessen".to_string(), items);
            }

            // Recent grades
            if let Ok(grades) = client
                .get(&format!("personen/{}/cijfers/laatste?top=5&skip=0", person_id))
                .await
            {
                let items = grades.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("recente_cijfers".to_string(), items);
            }

            // Assignments
            if let Ok(assignments) = client
                .get(&format!("personen/{}/opdrachten?van={}&tot={}", person_id, today, next_week))
                .await
            {
                let items = assignments.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("aankomende_opdrachten".to_string(), items);
            }

            // Unread messages
            if let Ok(folders) = client.get("berichten/mappen").await {
                let unread = folders.get("Items").and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|f| f.get("aantalOngelezen").and_then(|v| v.as_i64())).sum::<i64>())
                    .unwrap_or(0);
                summary.insert("ongelezen_berichten".to_string(), Value::Number(unread.into()));
            }

            // Absences today
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
        _ => ToolResult {
            tool: tool_name.to_string(), success: false, data: Value::Null,
            error: Some(format!("Onbekende tool: {}", tool_name)),
        },
    }
}