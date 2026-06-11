//! Unified AI client that delegates to the appropriate provider.
//! Supports OpenAI, Anthropic, Gemini, and OpenAI-compatible providers.

use crate::ai::providers::get_provider;

/// Re-export for backwards compatibility with existing code.
pub use crate::ai::providers::AiConfig;
pub use crate::ai::providers::AiMessage;

/// Send a chat message and return just the text response.
/// This is the version WITHOUT Magister data access — no tools are passed to the AI.
pub async fn send_chat(
    config: &AiConfig,
    messages: &[AiMessage],
) -> Result<String, String> {
    validate_config(config)?;

    let provider = get_provider(&config.provider);

    // Do NOT pass tools — this function can't execute them (no MagisterClient).
    // If we pass tools the AI will try to call them and we'd return empty responses.
    let result = provider.chat(config, messages, &[]).await?;

    // Return whatever text the AI replied with.
    // If the AI somehow still returns empty content (shouldn't happen with no tools),
    // return a fallback.
    if result.content.trim().is_empty() {
        Ok("Ik kan je vraag niet beantwoorden zonder toegang tot je schoolgegevens. Schakel 'Schoolgegevens toegang' in in de AI-instellingen voor gepersonaliseerde antwoorden.".to_string())
    } else {
        Ok(result.content)
    }
}

/// Validate the API key against the configured provider.
pub async fn validate_api_key(config: &AiConfig) -> Result<bool, String> {
    validate_config(config)?;
    let provider = get_provider(&config.provider);
    provider.validate_key(config).await
}

/// List available models for the configured provider.
pub async fn list_models(config: &AiConfig) -> Result<Vec<String>, String> {
    validate_config(config)?;
    let provider = get_provider(&config.provider);
    provider.list_models(config).await
}

/// Build the system prompt with school context.
/// When `tools_enabled` is true, include tool descriptions for data access.
pub fn build_school_context_system_prompt(page_context: Option<&str>, tools_enabled: bool) -> String {
    let base = "Je bent Friday AI, een behulpzame assistent voor scholieren in het Nederlandse middelbaar onderwijs. \
                Je helpt met schoolgerelateerde vragen, planning, studieadvies en uitleg. \
                Je spreekt altijd Nederlands en reageert bondig en helder. \
                Gebruik waar mogelijk opsommingen en concrete voorbeelden. \
                Wees aanmoedigend maar realistisch. \
                Als je iets niet weet, zeg dat dan eerlijk.".to_string();

    let tools_prompt = "\n\nJe hebt toegang tot de volgende tools om schoolgegevens op te vragen:\n\
             - get_calendar_events: Lesrooster en afspraken voor een datumbereik\n\
             - get_grades: Recente cijfers\n\
             - get_full_grade_overview: Volledig cijferoverzicht met gemiddelden per vak (gebruik eerst get_schoolyears)\n\
             - get_schoolyears: Beschikbare schooljaren\n\
             - get_assignments: Huiswerk en opdrachten\n\
             - get_messages: Berichtenoverzicht uit een map\n\
             - get_message_content: Volledige inhoud van een specifiek bericht\n\
             - get_absences: Absentie en verzuim\n\
             - get_studiewijzers: Studiewijzers per vak\n\
             - get_activities: Activiteiten\n\
             - get_bronnen: Digitale leermaterialen en bronnen\n\
             - get_leermiddelen: Digitale leermiddelen en boeken\n\
             - get_today_summary: Compleet dagoverzicht (rooster, cijfers, opdrachten, berichten, absenties)\n\
             - get_profile_info: Uitgebreide profielinformatie (naam, klas, adres, opleiding)\n\n\
             Gebruik deze tools wanneer de gebruiker vraagt naar specifieke schoolinformatie.\n\
             Bij vragen over gemiddelden per vak: gebruik eerst get_schoolyears, dan get_full_grade_overview.\n\
             Bij vragen over berichtinhoud: gebruik eerst get_messages, dan get_message_content.\n\
             Geef antwoord op basis van de opgehaalde data. Gebruik bullet points en houd het beknopt.";

    let no_tools_prompt = "\n\nJe hebt geen directe toegang tot de schoolgegevens van de gebruiker. \
             Geef algemeen studieadvies, beantwoord vragen over schoolvakken, \
             help met plannen en organiseren, of geef uitleg over onderwerpen. \
             Als de gebruiker vraagt naar specifieke data zoals cijfers of rooster, \
           leg dan uit dat ze 'Schoolgegevens toegang' moeten inschakelen in de AI-instellingen.";

    if let Some(context) = page_context {
        if tools_enabled {
            format!("{}\n\nHuidige context van de app:\n{}{}", base, context, tools_prompt)
        } else {
            format!("{}\n\nHuidige context van de app:\n{}{}", base, context, no_tools_prompt)
        }
    } else {
        if tools_enabled {
            format!("{}{}", base, tools_prompt)
        } else {
            format!("{}{}", base, no_tools_prompt)
        }
    }
}

fn validate_config(config: &AiConfig) -> Result<(), String> {
    if !config.enabled || config.api_key.is_empty() {
        return Err("AI is niet geconfigureerd. Ga naar Instellingen > AI om een API-sleutel in te stellen.".to_string());
    }
    Ok(())
}