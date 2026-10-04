//! Central tool-result budgeter for the AI assistant.
//!
//! Phase 3 of `fixes/friday-ai-upgrade-plan.md`. Mirrors
//! `src/lib/ai-budget.ts`: same constants, same shapes, same order of
//! truncation steps.
//!
//! Why: one fat tool result can overflow the model context and kill the chat.
//! Every successful tool payload passes through [`TurnBudget::account`],
//! which limits it and counts it against the per-turn budget.

use serde_json::{Map, Value};

/// Max serialised chars per tool result.
pub const TOOL_RESULT_MAX_CHARS: usize = 6000;
/// Max serialised chars of all tool results together per user turn.
pub const TURN_BUDGET_MAX_CHARS: usize = 24000;
/// Long strings are cut to this many chars of content (plus …).
pub const LONG_STRING_CUT: usize = 300;

const HOW_TO_GET_MORE: &str = "Beperk het bereik of gebruik offset/limit om verder te bladeren.";

fn serialized_len(v: &Value) -> usize {
    serde_json::to_string(v).map(|s| s.len()).unwrap_or(0)
}

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// Step 1: deep-strip nulls/empty fields (key order preserved).
fn strip_empties(v: &Value) -> Value {
    match v {
        Value::Array(arr) => Value::Array(arr.iter().map(strip_empties).collect()),
        Value::Object(obj) => {
            let mut out = Map::new();
            for (k, val) in obj {
                if is_empty_value(val) {
                    continue;
                }
                out.insert(k.clone(), strip_empties(val));
            }
            Value::Object(out)
        }
        _ => v.clone(),
    }
}

/// Unicode-safe cut: content chars + …, never splits a UTF-8 char.
fn cut_str(s: &str, max_content: usize) -> String {
    if s.chars().count() <= max_content {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_content).collect();
    out.push('…');
    out
}

/// Step 2: cut every long string in the tree.
fn cut_long_strings(v: &Value) -> Value {
    match v {
        Value::String(s) => {
            if s.chars().count() > LONG_STRING_CUT {
                Value::String(cut_str(s, LONG_STRING_CUT))
            } else {
                v.clone()
            }
        }
        Value::Array(arr) => Value::Array(arr.iter().map(cut_long_strings).collect()),
        Value::Object(obj) => {
            let mut out = Map::new();
            for (k, val) in obj {
                out.insert(k.clone(), cut_long_strings(val));
            }
            Value::Object(out)
        }
        _ => v.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum PathSeg {
    Key(String),
    Idx(usize),
}

/// Collect paths of non-empty arrays in the tree.
fn collect_arrays(node: &Value, path: &mut Vec<PathSeg>, out: &mut Vec<Vec<PathSeg>>) {
    match node {
        Value::Array(arr) => {
            if !arr.is_empty() {
                out.push(path.clone());
            }
            for (i, el) in arr.iter().enumerate() {
                path.push(PathSeg::Idx(i));
                collect_arrays(el, path, out);
                path.pop();
            }
        }
        Value::Object(obj) => {
            for (k, val) in obj {
                path.push(PathSeg::Key(k.clone()));
                collect_arrays(val, path, out);
                path.pop();
            }
        }
        _ => {}
    }
}

fn get_at<'a>(mut node: &'a Value, path: &[PathSeg]) -> Option<&'a Value> {
    for seg in path {
        node = match (node, seg) {
            (Value::Array(arr), PathSeg::Idx(i)) => arr.get(*i)?,
            (Value::Object(obj), PathSeg::Key(k)) => obj.get(k)?,
            _ => return None,
        };
    }
    Some(node)
}

fn get_mut_at<'a>(mut node: &'a mut Value, path: &[PathSeg]) -> Option<&'a mut Value> {
    for seg in path {
        node = match (node, seg) {
            (Value::Array(arr), PathSeg::Idx(i)) => arr.get_mut(*i)?,
            (Value::Object(obj), PathSeg::Key(k)) => obj.get_mut(k)?,
            _ => return None,
        };
    }
    Some(node)
}

fn path_string(path: &[PathSeg]) -> String {
    path.iter()
        .map(|s| match s {
            PathSeg::Key(k) => format!("/{}", k),
            PathSeg::Idx(i) => format!("/{}", i),
        })
        .collect()
}

fn truncated_meta(shown: usize, total: usize) -> Value {
    serde_json::json!({
        "shown": shown,
        "total": total,
        "how_to_get_more": HOW_TO_GET_MORE,
    })
}

/// Limit a tool-result payload to `max_chars` serialised chars. Steps, in
/// order: (1) drop nulls/empties, (2) cut long strings to 300 chars,
/// (3) halve the largest arrays until it fits, marking `_truncated` as the
/// last key, (4) drop trailing object keys as a last resort, else a small
/// `_dropped` notice. Never mutates the input; always valid JSON.
pub fn limit_tool_result(value: &Value, max_chars: usize) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    if let Some(s) = value.as_str() {
        return Value::String(cut_str(s, max_chars));
    }
    if !value.is_object() && !value.is_array() {
        return value.clone();
    }

    // Steps 1+2 rebuild fresh containers, so `work` is fully owned and the
    // halving below can mutate array lengths in place safely.
    let mut work = cut_long_strings(&strip_empties(value));
    if serialized_len(&work) <= max_chars {
        return work;
    }

    // Step 3: halve the largest arrays until it fits.
    let mut originals: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    loop {
        if serialized_len(&work) <= max_chars {
            break;
        }
        let mut paths: Vec<Vec<PathSeg>> = Vec::new();
        collect_arrays(&work, &mut Vec::new(), &mut paths);
        if paths.is_empty() {
            break;
        }
        let mut largest = &paths[0];
        for p in &paths {
            let a = get_at(&work, p)
                .and_then(|v| v.as_array())
                .map(|a| serialized_len(&Value::Array(a.clone())))
                .unwrap_or(0);
            let b = get_at(&work, largest)
                .and_then(|v| v.as_array())
                .map(|a| serialized_len(&Value::Array(a.clone())))
                .unwrap_or(0);
            if a > b {
                largest = p;
            }
        }
        let key = path_string(largest);
        let len = get_at(&work, largest)
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        originals.entry(key).or_insert(len);
        if let Some(Value::Array(arr)) = get_mut_at(&mut work, largest) {
            arr.truncate(len / 2);
        }
    }

    // Current shown/total over the cut arrays (paths are stable; only
    // lengths changed). See recount_on below.
    if work.is_array() {
        if originals.is_empty() {
            return work; // fit without cuts
        }
        let (shown, total) = recount_on(&work, &originals);
        return serde_json::json!({ "items": work, "_truncated": truncated_meta(shown, total) });
    }

    if serialized_len(&work) <= max_chars {
        if originals.is_empty() {
            return work;
        }
        let (shown, total) = recount_on(&work, &originals);
        if let Value::Object(mut obj) = work {
            obj.insert("_truncated".to_string(), truncated_meta(shown, total));
            return Value::Object(obj);
        }
        return work;
    }

    // Step 4: drop trailing keys as a last resort (never the marker itself).
    if let Value::Object(mut obj) = work {
        while serialized_len(&Value::Object(obj.clone())) > max_chars && !obj.is_empty() {
            if let Some(last) = obj.keys().last().cloned() {
                obj.shift_remove(&last);
            } else {
                break;
            }
        }
        let (shown, total) = recount_on(&Value::Object(obj.clone()), &originals);
        let mut with_marker = obj.clone();
        with_marker.insert("_truncated".to_string(), truncated_meta(shown, total));
        if serialized_len(&Value::Object(with_marker.clone())) <= max_chars {
            return Value::Object(with_marker);
        }
        let (shown, total) = recount_on(&Value::Object(obj), &originals);
        return serde_json::json!({
            "_dropped": "Resultaat te groot voor de context, ook na inkorten; vernauw je verzoek.",
            "_truncated": truncated_meta(shown, total),
        });
    }

    work
}

/// Shown/total over cut arrays for an arbitrary snapshot.
fn recount_on(
    work: &Value,
    originals: &std::collections::HashMap<String, usize>,
) -> (usize, usize) {
    let mut shown = 0usize;
    let mut total = 0usize;
    let mut paths: Vec<Vec<PathSeg>> = Vec::new();
    collect_arrays(work, &mut Vec::new(), &mut paths);
    for p in &paths {
        let k = path_string(p);
        if let Some(&orig) = originals.get(&k) {
            let cur = get_at(work, p)
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            if orig > cur {
                shown += cur;
                total += orig;
            }
        }
    }
    (shown, total)
}

/// Per-turn budget: all successful tool payloads of one user turn counted
/// together (default 24k chars). Once exceeded, later results are replaced
/// by a budget error instead of data. Failure texts bypass (tens of chars;
/// Phase 6 owns the error taxonomy).
pub struct TurnBudget {
    used: usize,
    max: usize,
}

impl TurnBudget {
    pub fn new() -> Self {
        Self {
            used: 0,
            max: TURN_BUDGET_MAX_CHARS,
        }
    }

    pub fn with_max(max: usize) -> Self {
        Self { used: 0, max }
    }

    pub fn used_chars(&self) -> usize {
        self.used
    }

    pub fn remaining_chars(&self) -> usize {
        self.max.saturating_sub(self.used)
    }

    /// Limit a successful tool-result payload and count it. Returns
    /// (payload, budget_hit).
    pub fn account(&mut self, data: &Value) -> (Value, bool) {
        let limited = limit_tool_result(data, TOOL_RESULT_MAX_CHARS);
        let size = serialized_len(&limited);
        if self.used + size > self.max {
            (
                serde_json::json!({ "error": "budget", "hint": "Narrow your request." }),
                true,
            )
        } else {
            self.used += size;
            (limited, false)
        }
    }
}

impl Default for TurnBudget {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn size(v: &Value) -> usize {
        serialized_len(v)
    }

    #[test]
    fn small_results_pass_through() {
        let input = json!({ "items": [{ "id": 1 }], "count": 1 });
        assert_eq!(limit_tool_result(&input, TOOL_RESULT_MAX_CHARS), input);
        assert_eq!(
            limit_tool_result(&Value::Null, TOOL_RESULT_MAX_CHARS),
            Value::Null
        );
    }

    #[test]
    fn nulls_and_empties_dropped_first() {
        let mut filler = Map::new();
        filler.insert("keep".to_string(), Value::String("yes".to_string()));
        for i in 0..800 {
            filler.insert(format!("pad{}", i), Value::Null);
        }
        let input = Value::Object(filler);
        assert!(size(&input) > TOOL_RESULT_MAX_CHARS);
        assert_eq!(
            limit_tool_result(&input, TOOL_RESULT_MAX_CHARS),
            json!({ "keep": "yes" })
        );
    }

    #[test]
    fn long_strings_cut_unicode_safe() {
        let out = limit_tool_result(&json!({ "text": "🎓".repeat(500) }), TOOL_RESULT_MAX_CHARS);
        let s = out["text"].as_str().unwrap();
        assert_eq!(s.chars().count(), LONG_STRING_CUT + 1); // 300 + …
        assert!(out["text"].as_str().is_some());
    }

    #[test]
    fn fat_lists_halved_with_trailing_marker() {
        let items: Vec<Value> = (0..100)
            .map(|i| json!({ "id": i, "pad": "z".repeat(200), "more": "w".repeat(200) }))
            .collect();
        let out = limit_tool_result(
            &json!({ "items": items, "meta": { "total": 100 } }),
            TOOL_RESULT_MAX_CHARS,
        );
        assert!(size(&out) <= TOOL_RESULT_MAX_CHARS, "got {}", size(&out));
        let obj = out.as_object().unwrap();
        let keys: Vec<&String> = obj.keys().collect();
        assert_eq!(keys[keys.len() - 1], "_truncated");
        assert_eq!(out["_truncated"]["total"], 100);
        assert!(out["_truncated"]["shown"].as_u64().unwrap() < 100);
        assert_eq!(
            out["items"].as_array().unwrap().len() as u64,
            out["_truncated"]["shown"].as_u64().unwrap()
        );
    }

    #[test]
    fn unshrinkable_objects_fall_back() {
        let mut wide = Map::new();
        for i in 0..100 {
            wide.insert(format!("k{}", i), Value::String("v".repeat(300)));
        }
        let out = limit_tool_result(&Value::Object(wide), TOOL_RESULT_MAX_CHARS);
        assert!(size(&out) <= TOOL_RESULT_MAX_CHARS, "got {}", size(&out));
        assert!(out.get("_dropped").is_some() || out.get("_truncated").is_some());
        // Still valid JSON.
        serde_json::to_string(&out).unwrap();
    }

    #[test]
    fn turn_budget_replaces_later_results() {
        let mut budget = TurnBudget::with_max(1000);
        let chunk = json!({ "pad": "q".repeat(300) });
        let mut hits = 0;
        for _ in 0..10 {
            let (payload, hit) = budget.account(&chunk);
            if hit {
                hits += 1;
                assert_eq!(
                    payload,
                    json!({ "error": "budget", "hint": "Narrow your request." })
                );
            } else {
                assert_eq!(payload, chunk);
            }
        }
        assert!(hits > 0, "budget must trip");
        assert!(budget.used_chars() <= 1000);
        assert_eq!(budget.remaining_chars(), 1000 - budget.used_chars());
    }

    #[test]
    fn custom_per_result_limit_honoured() {
        let out = limit_tool_result(&json!({ "items": [1, 2, 3] }), 60);
        assert!(size(&out) <= 60, "got {}: {}", size(&out), out);
    }
}
