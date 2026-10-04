//! Shared AI spec: single source of truth for tools + system prompt.
//!
//! `shared/ai-spec/tools.json` holds every tool definition;
//! `shared/ai-spec/prompt.nl.md` holds the Dutch system prompt as sections
//! with `{{NOW}}`, `{{NOTES}}`, `{{CONTEXT}}` and `{{TOOL_LIST}}`
//! placeholders. The web build consumes the same files
//! (`src/lib/ai-spec.ts`); the parity test fails CI on drift.
//!
//! Because definitions render straight from the spec, the desktop side
//! cannot drift by construction.

use std::collections::HashMap;
use std::sync::OnceLock;

static TOOLS_JSON: &str = include_str!("../../../shared/ai-spec/tools.json");
static PROMPT_MD: &str = include_str!("../../../shared/ai-spec/prompt.nl.md");

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Default)]
pub struct PromptSections {
    pub head: String,
    pub notes: String,
    pub context: String,
    pub tools: String,
    pub no_tools: String,
    pub tail_tools: String,
    pub tail_shared: String,
}

fn tool_specs_static() -> &'static Vec<ToolSpec> {
    static SPECS: OnceLock<Vec<ToolSpec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        let parsed: serde_json::Value =
            serde_json::from_str(TOOLS_JSON).expect("shared/ai-spec/tools.json must parse");
        parsed
            .get("tools")
            .and_then(|t| t.as_array())
            .expect("tools.json must hold a tools array")
            .iter()
            .map(|t| ToolSpec {
                name: t
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                description: t
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                parameters: t
                    .get("parameters")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            })
            .collect()
    })
}

/// All tool definitions, in spec order. Panics only if the checked-in spec
/// itself is malformed (covered by tests, never by user input).
pub fn tool_specs() -> &'static [ToolSpec] {
    tool_specs_static()
}

/// Section marker lines: `<!-- SECTION:NAME -->`.
fn parse_sections(md: &str) -> HashMap<String, String> {
    let mut parts: HashMap<String, Vec<String>> = HashMap::new();
    let mut current: Option<String> = None;
    for raw_line in md.split('\n') {
        let line = raw_line.trim();
        if line.starts_with("<!-- SECTION:") && line.ends_with("-->") {
            let name = line
                .trim_start_matches("<!-- SECTION:")
                .trim_end_matches("-->")
                .trim()
                .to_string();
            if name.chars().all(|c| c.is_ascii_uppercase() || c == '_') && !name.is_empty() {
                current = Some(name.clone());
                parts.entry(name).or_default();
                continue;
            }
        }
        if let Some(ref key) = current {
            if let Some(v) = parts.get_mut(key) {
                v.push(raw_line.to_string());
            }
        }
    }
    parts
        .into_iter()
        .map(|(k, lines)| (k, lines.join("\n").trim().to_string()))
        .collect()
}

fn prompt_sections_static() -> &'static PromptSections {
    static SECTIONS: OnceLock<PromptSections> = OnceLock::new();
    SECTIONS.get_or_init(|| {
        let parts = parse_sections(PROMPT_MD);
        let get = |name: &str| -> String { parts.get(name).cloned().unwrap_or_default() };
        PromptSections {
            head: get("HEAD"),
            notes: get("NOTES"),
            context: get("CONTEXT"),
            tools: get("TOOLS"),
            no_tools: get("NO_TOOLS"),
            tail_tools: get("TAIL_TOOLS"),
            tail_shared: get("TAIL_SHARED"),
        }
    })
}

pub fn prompt_sections() -> &'static PromptSections {
    prompt_sections_static()
}

/// First sentence of a description (tool-list rendering, both platforms).
pub fn first_sentence(description: &str) -> &str {
    description.split('.').next().unwrap_or(description)
}

/// `- name: first sentence` lines, given order. Callers pass their
/// settings-filtered defs so listed tools always match offered tools.
pub fn render_tool_list(tools: &[(&str, &str)]) -> String {
    tools
        .iter()
        .map(|(name, description)| format!("- {}: {}", name, first_sentence(description)))
        .collect::<Vec<_>>()
        .join("\n")
}

pub struct PromptInput<'a> {
    pub now: &'a str,
    /// Formatted notes block, or None when disabled/unavailable.
    pub notes: Option<&'a str>,
    /// Page context text, or None when absent.
    pub context: Option<&'a str>,
    /// Rendered tool list, or None for the no-tools prompt.
    pub tool_list: Option<&'a str>,
}

/// Assemble the system prompt from template + inputs.
pub fn render_prompt(sections: &PromptSections, input: &PromptInput) -> String {
    let fill = |template: &str| -> String {
        template
            .replacen("{{NOW}}", input.now, 1)
            .replacen("{{NOTES}}", input.notes.unwrap_or(""), 1)
            .replacen("{{CONTEXT}}", input.context.unwrap_or(""), 1)
            .replacen("{{TOOL_LIST}}", input.tool_list.unwrap_or(""), 1)
    };
    let mut parts: Vec<String> = vec![fill(&sections.head)];
    if input.notes.is_some() {
        parts.push(fill(&sections.notes));
    }
    if input.context.is_some() {
        parts.push(fill(&sections.context));
    }
    if let Some(list) = input.tool_list {
        let _ = list;
        parts.push(fill(&sections.tools));
        parts.push(sections.tail_tools.clone());
    } else {
        parts.push(sections.no_tools.clone());
    }
    parts.push(sections.tail_shared.clone());
    parts
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_holds_forty_tools() {
        let specs = tool_specs();
        assert_eq!(specs.len(), 40);
        for t in specs {
            assert!(!t.name.is_empty());
            assert!(!t.description.is_empty());
            assert!(t.parameters.is_object());
        }
    }

    #[test]
    fn sections_parse_all_present() {
        let s = prompt_sections();
        for (name, body) in [
            ("HEAD", &s.head),
            ("NOTES", &s.notes),
            ("CONTEXT", &s.context),
            ("TOOLS", &s.tools),
            ("NO_TOOLS", &s.no_tools),
            ("TAIL_TOOLS", &s.tail_tools),
            ("TAIL_SHARED", &s.tail_shared),
        ] {
            assert!(!body.is_empty(), "section {} missing", name);
        }
        assert!(s.head.contains("{{NOW}}"));
        assert!(s.tools.contains("{{TOOL_LIST}}"));
    }

    #[test]
    fn render_modes_have_no_leftovers() {
        let s = prompt_sections();
        let specs = tool_specs();
        let pairs: Vec<(&str, &str)> = specs
            .iter()
            .map(|t| (t.name.as_str(), t.description.as_str()))
            .collect();
        let list = render_tool_list(&pairs);
        assert_eq!(list.lines().count(), specs.len());
        for line in list.lines() {
            assert!(line.starts_with("- "));
        }
        let full = render_prompt(
            s,
            &PromptInput {
                now: "NU: ...",
                notes: Some("<notities/>"),
                context: Some("ctx"),
                tool_list: Some(&list),
            },
        );
        assert!(!full.contains("{{"));
        assert!(!full.contains("SECTION:"));
        let plain = render_prompt(
            s,
            &PromptInput {
                now: "NU: ...",
                notes: None,
                context: None,
                tool_list: None,
            },
        );
        assert!(!plain.contains("{{"));
        assert!(plain.contains("geen directe toegang"));
    }

    #[test]
    fn first_sentence_matches_typescript() {
        assert_eq!(first_sentence("Haal x op. Meer."), "Haal x op");
        assert_eq!(first_sentence("Zonder punt"), "Zonder punt");
    }
}
