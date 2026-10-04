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
/// `tools` carries the settings-filtered defs offered to the provider
/// (None = no-tools prompt); the same list is rendered, so offered and
/// listed tools can never diverge.
/// `notes` injects the AI-Geheugen block (None when disabled/unavailable).
///
/// Single source of truth: `shared/ai-spec/prompt.nl.md`, rendered with the
/// same section order as the web twin (`src/lib/ai.ts`).
pub fn build_school_context_system_prompt(
    page_context: Option<&str>,
    tools: Option<&[crate::ai::tools::ToolDef]>,
    notes: Option<&crate::commands::ai_notes::NotesPrompt>,
) -> String {
    use crate::ai::spec;
    let sections = spec::prompt_sections();
    let now = crate::ai::time::format_now_block();
    let notes_block = notes.map(|n| {
        crate::commands::ai_notes::format_notes_block(
            &n.content,
            n.revision,
            &n.updated_by,
            n.writable,
        )
    });
    let tool_list;
    let tool_list_ref = match tools {
        Some(defs) => {
            let pairs: Vec<(&str, &str)> = defs
                .iter()
                .map(|t| (t.name.as_str(), t.description.as_str()))
                .collect();
            tool_list = spec::render_tool_list(&pairs);
            Some(tool_list.as_str())
        }
        None => None,
    };
    spec::render_prompt(
        sections,
        &spec::PromptInput {
            now: &now,
            notes: notes_block.as_deref(),
            context: page_context,
            tool_list: tool_list_ref,
        },
    )
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
    use crate::ai::time::today_amsterdam;

    #[test]
    fn system_prompt_includes_real_today_date() {
        let prompt = build_school_context_system_prompt(None, Some(&crate::ai::tools::get_all_tool_defs()), None);
        let today = today_amsterdam();

        assert!(prompt.contains("NU:"), "moet het NU-blok bevatten");
        assert!(
            prompt.contains(&today),
            "moet de echte Amsterdamse datum {} bevatten, kreeg: {}",
            today,
            prompt.lines().next().unwrap_or("")
        );
        assert!(
            prompt.contains("Gebruik altijd deze datum als 'vandaag'"),
            "moet de instructie bevatten om deze datum als vandaag te gebruiken"
        );
        assert!(
            prompt.contains("get_current_time"),
            "moet naar de get_current_time tool verwijzen"
        );
    }

    #[test]
    fn system_prompt_date_context_present_for_all_modes() {
        for tools in [Some(crate::ai::tools::get_all_tool_defs()), None] {
            let with_page = build_school_context_system_prompt(Some("Testpagina"), tools.as_deref(), None);
            let without_page = build_school_context_system_prompt(None, tools.as_deref(), None);
            assert!(with_page.contains("NU:"));
            assert!(without_page.contains("NU:"));
        }
    }
}
