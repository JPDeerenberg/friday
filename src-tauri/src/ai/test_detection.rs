//! Shared test/toetsweek detection (single source of truth:
//! `shared/ai-spec/test-signals.json`).
//!
//! TS twin: `src/lib/test-detection.ts` — same tokenisation (split on
//! non-alphanumeric, no regex crate), same matching (tokens
//! case-insensitive, uppercaseOnlyTokens only when written uppercase in
//! the original, negativePhrases on the lower-cased text), same output
//! shape `{ isTest, source, hint }`.

static TEST_SIGNALS_JSON: &str = include_str!("../../../shared/ai-spec/test-signals.json");

#[derive(Debug, Clone)]
pub struct TestSignals {
    pub info_types: Vec<i64>,
    pub tokens: Vec<String>,
    pub uppercase_only_tokens: Vec<String>,
    pub negative_phrases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestDetection {
    pub is_test: bool,
    /// "infotype" | "opmerking" | "aantekening" | None
    pub source: Option<String>,
    /// Trimmed note text, if any.
    pub hint: Option<String>,
}

fn test_signals_static() -> &'static TestSignals {
    static SIGNALS: std::sync::OnceLock<TestSignals> = std::sync::OnceLock::new();
    SIGNALS.get_or_init(|| {
        let parsed: serde_json::Value = serde_json::from_str(TEST_SIGNALS_JSON)
            .expect("shared/ai-spec/test-signals.json must parse");
        let get_strs = |key: &str| -> Vec<String> {
            parsed
                .get(key)
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default()
        };
        TestSignals {
            info_types: parsed
                .get("infoTypes")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default(),
            tokens: get_strs("tokens"),
            uppercase_only_tokens: get_strs("uppercaseOnlyTokens"),
            negative_phrases: get_strs("negativePhrases"),
        }
    })
}

/// Parsed test signals from the shared spec.
pub fn test_signals() -> &'static TestSignals {
    test_signals_static()
}

fn trimmed_or_none(v: Option<&str>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Split on non-alphanumeric characters (unicode-aware, like TS `/[^\p{L}\p{N}]+/u`).
fn split_tokens(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect()
}

/// True when the note text carries a test signal (and no negative phrase).
fn text_is_test_signal(text: &str, signals: &TestSignals) -> bool {
    let lower = text.to_lowercase();
    if signals
        .negative_phrases
        .iter()
        .any(|p| lower.contains(&p.to_lowercase()))
    {
        return false;
    }
    let raw_tokens = split_tokens(text);
    let lower_tokens: Vec<String> = raw_tokens.iter().map(|t| t.to_lowercase()).collect();
    if signals
        .tokens
        .iter()
        .any(|tok| lower_tokens.iter().any(|t| t == &tok.to_lowercase()))
    {
        return true;
    }
    if signals
        .uppercase_only_tokens
        .iter()
        .any(|tok| raw_tokens.iter().any(|t| *t == tok))
    {
        return true;
    }
    false
}

/// Detect whether a calendar event is a test. Personal events (`event_type == 1`)
/// are always skipped.
pub fn detect_test(
    event_type: i64,
    info_type: i64,
    opmerking: Option<&str>,
    aantekening: Option<&str>,
) -> TestDetection {
    if event_type == 1 {
        return TestDetection {
            is_test: false,
            source: None,
            hint: None,
        };
    }
    let signals = test_signals();
    let opm = trimmed_or_none(opmerking);
    let aant = trimmed_or_none(aantekening);
    if signals.info_types.contains(&info_type) {
        return TestDetection {
            is_test: true,
            source: Some("infotype".to_string()),
            hint: opm.or(aant),
        };
    }
    if let Some(ref t) = opm {
        if text_is_test_signal(t, signals) {
            return TestDetection {
                is_test: true,
                source: Some("opmerking".to_string()),
                hint: opm,
            };
        }
    }
    if let Some(ref t) = aant {
        if text_is_test_signal(t, signals) {
            return TestDetection {
                is_test: true,
                source: Some("aantekening".to_string()),
                hint: aant,
            };
        }
    }
    TestDetection {
        is_test: false,
        source: None,
        hint: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Case {
        event_type: i64,
        info_type: i64,
        opmerking: Option<&'static str>,
        aantekening: Option<&'static str>,
        is_test: bool,
        source: Option<&'static str>,
        hint: Option<&'static str>,
    }

    /// Same case table as `shared/ai-spec/test-signals.cases.json`
    /// (covered on the TS side by `src/lib/test-detection.test.ts`).
    fn cases() -> Vec<Case> {
        vec![
            Case {
                event_type: 13,
                info_type: 0,
                opmerking: Some("Toets: BV4 schk extra tijd"),
                aantekening: None,
                is_test: true,
                source: Some("opmerking"),
                hint: Some("Toets: BV4 schk extra tijd"),
            },
            Case {
                event_type: 13,
                info_type: 2,
                opmerking: None,
                aantekening: None,
                is_test: true,
                source: Some("infotype"),
                hint: None,
            },
            Case {
                event_type: 13,
                info_type: 0,
                opmerking: Some("geen toets deze week"),
                aantekening: None,
                is_test: false,
                source: None,
                hint: None,
            },
            Case {
                event_type: 13,
                info_type: 0,
                opmerking: None,
                aantekening: None,
                is_test: false,
                source: None,
                hint: None,
            },
            Case {
                event_type: 1,
                info_type: 0,
                opmerking: Some("Toets wiskunde leren"),
                aantekening: None,
                is_test: false,
                source: None,
                hint: None,
            },
            Case {
                event_type: 13,
                info_type: 0,
                opmerking: None,
                aantekening: Some("morgen proefwerk hoofdstuk 4"),
                is_test: true,
                source: Some("aantekening"),
                hint: Some("morgen proefwerk hoofdstuk 4"),
            },
            Case {
                event_type: 13,
                info_type: 0,
                opmerking: Some("SO hoofdstuk 3"),
                aantekening: None,
                is_test: true,
                source: Some("opmerking"),
                hint: Some("SO hoofdstuk 3"),
            },
            Case {
                event_type: 13,
                info_type: 0,
                opmerking: Some("neem je so mee"),
                aantekening: None,
                is_test: false,
                source: None,
                hint: None,
            },
        ]
    }

    #[test]
    fn shared_case_table_parity() {
        for c in cases() {
            let got = detect_test(c.event_type, c.info_type, c.opmerking, c.aantekening);
            assert_eq!(
                got.is_test,
                c.is_test,
                "is_test for {:?}",
                c.opmerking.or(c.aantekening)
            );
            assert_eq!(
                got.source.as_deref(),
                c.source,
                "source for {:?}",
                c.opmerking.or(c.aantekening)
            );
            assert_eq!(
                got.hint.as_deref(),
                c.hint,
                "hint for {:?}",
                c.opmerking.or(c.aantekening)
            );
        }
    }

    #[test]
    fn signals_json_has_expected_shape() {
        let s = test_signals();
        assert_eq!(s.info_types, vec![2, 3, 4, 5]);
        assert!(s.tokens.contains(&"toets".to_string()));
        assert!(s.uppercase_only_tokens.contains(&"SO".to_string()));
        assert!(s.negative_phrases.contains(&"geen toets".to_string()));
    }
}
