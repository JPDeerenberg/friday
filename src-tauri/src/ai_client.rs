//! Unified AI client that delegates to the appropriate provider.
//! Supports OpenAI, Anthropic, Gemini, and OpenAI-compatible providers.

use chrono::Datelike;

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
    let result = provider.chat(config, messages, &[]).await?;

    // Return whatever text the AI replied with.
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
    let now = chrono::Local::now();
    let date_context = format!(
        "Vandaag is {}, {} ({} uur, tijdzone Europe/Amsterdam). \
         Gebruik altijd deze datum als 'vandaag' bij het bepalen van datumbereiken voor tools zoals \
         get_calendar_events, get_assignments en get_full_grade_overview — verzin nooit zelf een datum.",
        dutch_weekday(now.weekday()),
        now.format("%Y-%m-%d"),
        now.format("%H:%M"),
    );

    let base = format!("{}\n\n{}", date_context, "Je bent Friday AI, een behulpzame assistent voor scholieren in het Nederlandse middelbaar onderwijs. \
                Je helpt met schoolgerelateerde vragen, planning, studieadvies en uitleg. \
                Je spreekt altijd Nederlands en reageert bondig en helder. \
                Gebruik waar mogelijk opsommingen en concrete voorbeelden. \
                Wees aanmoedigend maar realistisch. \
                Als je iets niet weet, zeg dat dan eerlijk. \
                Formateer je antwoorden met Markdown waar dat helpt: gebruik ## kopjes, **vet**, *cursief*, opsommingen (- of 1.), tabellen voor cijfers/rooster, `inline code` en ```codeblokken``` voor voorbeelden, en [links](url) waar relevant. Houd het beknopt."
    );

    let tools_prompt = "\n\nJe hebt toegang tot de volgende tools om schoolgegevens op te vragen en acties uit te voeren:\n\
             - get_calendar_events: Lesrooster en afspraken voor een datumbereik\n\
             - get_grades: Recente cijfers\n\
             - get_full_grade_overview: Volledig cijferoverzicht met gemiddelden per vak (eerst get_schoolyears)\n\
             - get_schoolyears: Beschikbare schooljaren\n\
             - get_assignments: Huiswerk en opdrachten voor een datumbereik\n\
             - get_assignment_detail: Gedetailleerde opdrachtinfo inclusief bijlagen\n\
             - read_attachment_text: Lees de tekstinhoud van een bijlage (PDF/Word/tekstbestand)\n\
             - calculate_grade_scenario: Bereken wat de gebruiker nodig heeft (benodigd cijfer, voorspeld gemiddelde, minimaal cijfer om te slagen)\n\
             - get_messages: Berichtenoverzicht uit een map\n\
             - get_message_content: Volledige inhoud van een specifiek bericht\n\
             - send_message: Stuur een bericht naar een andere gebruiker (na bevestiging)\n\
             - mark_messages_read: Markeer berichten als gelezen (na bevestiging)\n\
             - create_calendar_event: Maak een persoonlijke agenda-afspraak/herinnering (na bevestiging)\n\
             - get_absences: Absentie en verzuim\n\
             - get_studiewijzers: Studiewijzers per vak\n\
             - get_activities: Activiteiten\n\
             - get_bronnen: Digitale leermaterialen en bronnen\n\
             - get_leermiddelen: Digitale leermiddelen en boeken\n\
             - get_today_summary: Compleet dagoverzicht (rooster, cijfers, opdrachten, berichten, absenties)\n\
             - get_profile_info: Uitgebreide profielinformatie (naam, klas, adres, opleiding)\n\
             - download_file: Download een bestand (bijlage) en toon grootte en type\n\n\
             Gebruik deze tools wanneer de gebruiker vraagt naar specifieke schoolinformatie of acties wil uitvoeren (zoals berichten sturen, opdrachten bekijken, bestanden downloaden).\n\
             Bij vragen over gemiddelden per vak: gebruik eerst get_schoolyears, dan get_full_grade_overview.\n\
             Bij 'wat heb ik nodig'-vragen over cijfers (bv. 'welk cijfer moet ik halen om te slagen'): gebruik get_schoolyears, get_full_grade_overview, en daarna calculate_grade_scenario om het daadwerkelijk te berekenen — geef niet alleen ruwe cijfers terug.\n\
             Bij een opdracht met een bijlage (uit get_assignment_detail) waarvan de gebruiker hulp wil met de inhoud: gebruik read_attachment_text om de bijlage te lezen voordat je antwoord geeft.\n\
             Bij vragen over berichtinhoud: gebruik eerst get_messages, dan get_message_content, of stuur een bericht met send_message.\n\
             Bij acties met een echte bijwerking (send_message, mark_messages_read, create_calendar_event): de tool zet de actie klaar en de gebruiker bevestigt deze in de app voordat er iets gebeurt. Vertel de gebruiker wat er klaarstaat.\n\
              Geef antwoord op basis van de opgehaalde data. Gebruik Markdown (kopjes, lijsten, tabellen) en houd het beknopt.";

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

fn dutch_weekday(weekday: chrono::Weekday) -> &'static str {
    match weekday {
        chrono::Weekday::Mon => "maandag",
        chrono::Weekday::Tue => "dinsdag",
        chrono::Weekday::Wed => "woensdag",
        chrono::Weekday::Thu => "donderdag",
        chrono::Weekday::Fri => "vrijdag",
        chrono::Weekday::Sat => "zaterdag",
        chrono::Weekday::Sun => "zondag",
    }
}

fn validate_config(config: &AiConfig) -> Result<(), String> {
    if !config.enabled || config.api_key.is_empty() {
        return Err("AI is niet geconfigureerd. Ga naar Instellingen > AI om een API-sleutel in te stellen.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dutch_weekday_name(d: chrono::NaiveDate) -> &'static str {
        dutch_weekday(d.weekday())
    }

    #[test]
    fn system_prompt_includes_real_today_date() {
        let prompt = build_school_context_system_prompt(None, true);
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let weekday = dutch_weekday_name(chrono::Local::now().date_naive());

        assert!(prompt.contains("Vandaag is"), "moet de actuele datum bevatten");
        assert!(
            prompt.contains(&format!("{}", today)),
            "moet de echte datum {} bevatten, kreeg: {}",
            today,
            prompt.lines().next().unwrap_or("")
        );
        assert!(
            prompt.contains(weekday),
            "moet de weekdag {} bevatten",
            weekday
        );
        assert!(
            prompt.contains("Gebruik altijd deze datum als 'vandaag'"),
            "moet de instructie bevatten om deze datum als vandaag te gebruiken"
        );
    }

    #[test]
    fn system_prompt_date_context_present_for_all_modes() {
        for tools_enabled in [true, false] {
            let with_page = build_school_context_system_prompt(Some("Testpagina"), tools_enabled);
            let without_page = build_school_context_system_prompt(None, tools_enabled);
            assert!(with_page.contains("Vandaag is"));
            assert!(without_page.contains("Vandaag is"));
        }
    }
}
