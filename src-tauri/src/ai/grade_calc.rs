//! Grade calculation helpers — a Rust port of the frontend calculator so both
//! the UI (`src/lib/grades/predictor.ts`) and the AI tool
//! (`calculate_grade_scenario`) compute identical numbers from the same rules.
//!
//! The TypeScript `predictor.ts` is the source of truth for the *rules*; this
//! module is a straightforward port, kept in sync by hand. If a rule changes,
//! change it in both places.
//!
//! Input numbers use the dot as decimal separator (JSON/ISO). Grades fetched
//! from Magister may use a comma — convert with [`parse_dutch_grade`] first.

use serde::Deserialize;

/// A single grade value + weight (matches `WeightedGrade` in predictor.ts).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct GradePoint {
    #[serde(default)]
    pub value: f64,
    #[serde(default = "default_weight")]
    pub weight: f64,
}

fn default_weight() -> f64 {
    1.0
}

/// Sum of `value * weight` over the points, plus the total weight.
/// Mirrors the accumulator loops in predictor.ts.
pub fn weighted_sum(points: &[GradePoint]) -> (f64, f64) {
    points
        .iter()
        .fold((0.0, 0.0), |(p, w), g| (p + g.value * g.weight, w + g.weight))
}

/// Parse a Magister grade string ("7,5" or "7.5") into a number.
pub fn parse_dutch_grade(s: &str) -> Option<f64> {
    let normalized = s.trim().replace(',', ".");
    normalized.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Grade needed on the next test (weight = `grade_weight`) to reach
/// `target_average`. Mirrors `calcRequiredGrade` in predictor.ts.
pub fn required_grade(
    total_points: f64,
    total_weight: f64,
    target_average: f64,
    grade_weight: f64,
    simulation: &[GradePoint],
    decimal_points: usize,
) -> String {
    if total_weight == 0.0 {
        return "?".to_string();
    }
    let (sim_points, sim_weight) = weighted_sum(simulation);
    let current_points = total_points + sim_points;
    let current_weight = total_weight + sim_weight;
    let required = (target_average * (current_weight + grade_weight) - current_points) / grade_weight;
    if required > 10.0 {
        return "Onmogelijk (>10)".to_string();
    }
    if required < 1.0 {
        return "1.0".to_string();
    }
    format!("{:.*}", decimal_points, required)
}

/// Average when the simulation grades are (optionally) added to the current
/// grades. Mirrors `calcPredictedAverage` in predictor.ts.
pub fn predicted_average(
    total_points: f64,
    total_weight: f64,
    simulation: &[GradePoint],
    include_simulation: bool,
    decimal_points: usize,
) -> String {
    let (sim_points, sim_weight) = weighted_sum(simulation);
    let total_p = total_points + if include_simulation { sim_points } else { 0.0 };
    let total_w = total_weight + if include_simulation { sim_weight } else { 0.0 };
    if total_w > 0.0 {
        format!("{:.*}", decimal_points, total_p / total_w)
    } else {
        "0".to_string()
    }
}

/// Lowest grade on one more test (weight 1) to still pass, or
/// `MinGradeForPass::None` if moot/impossible. Mirrors `calcMinGradeForPass`
/// in predictor.ts (which returns `null` for those cases).
#[derive(Debug, Clone, PartialEq)]
pub enum MinGradeForPass {
    /// Already passing without any extra grade.
    AlreadyPassing,
    /// Pass impossible — even a 10 can't reach the threshold.
    Impossible,
    /// Lowest grade needed, formatted with one decimal.
    Needed(String),
}

pub fn min_grade_for_pass(total_points: f64, total_weight: f64, threshold: f64) -> MinGradeForPass {
    if total_weight == 0.0 {
        return MinGradeForPass::Impossible;
    }
    let required = (threshold * (total_weight + 1.0) - total_points) / 1.0;
    if required <= 1.0 {
        MinGradeForPass::AlreadyPassing
    } else if required > 10.0 {
        MinGradeForPass::Impossible
    } else {
        MinGradeForPass::Needed(format!("{:.1}", required))
    }
}

/// New subject average after adding a single grade with a given weight.
/// Mirrors `calcAverageForGrade` in predictor.ts.
pub fn average_for_grade(
    total_points: f64,
    total_weight: f64,
    grade: f64,
    weight: f64,
    decimal_points: usize,
) -> String {
    let total_p = total_points + grade * weight;
    let total_w = total_weight + weight;
    if total_w > 0.0 {
        format!("{:.*}", decimal_points, total_p / total_w)
    } else {
        "0".to_string()
    }
}

/// Overall average over valid subjects (avg > 0) with one subject replaced by
/// `replacement_avg`. Mirrors `calcNewOverallAverage` in predictor.ts.
pub fn new_overall_average(
    subjects: &[(String, f64)],
    subject_name: &str,
    replacement_avg: f64,
    decimal_points: usize,
) -> String {
    let valid: Vec<&(String, f64)> = subjects.iter().filter(|(_, avg)| *avg > 0.0).collect();
    if valid.is_empty() {
        return format!("{:.*}", decimal_points, replacement_avg);
    }
    let total: f64 = valid
        .iter()
        .map(|(name, avg)| if name.eq_ignore_ascii_case(subject_name) { replacement_avg } else { *avg })
        .sum();
    format!("{:.*}", decimal_points, total / valid.len() as f64)
}

/// Projected end average given the number of remaining tests and an expected
/// grade. Mirrors `calcPredicted` in predictor.ts.
pub fn predicted_end(
    total_points: f64,
    total_weight: f64,
    remaining_tests: usize,
    expected_grade: f64,
) -> f64 {
    let predicted_points = total_points + expected_grade * remaining_tests as f64;
    let predicted_weight = total_weight + remaining_tests as f64;
    if predicted_weight > 0.0 {
        predicted_points / predicted_weight
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_grade_matches_frontend_examples() {
        // Simple case: 4 grades averaging 6.0, want 6.5 next test (weight 1).
        let points = [GradePoint { value: 6.0, weight: 1.0 }; 4];
        let (tp, tw) = weighted_sum(&points);
        assert_eq!((tp, tw), (24.0, 4.0));
        let req = required_grade(tp, tw, 6.5, 1.0, &[], 1);
        // (6.5 * 5 - 24) / 1 = 8.5
        assert_eq!(req, "8.5");
    }

    #[test]
    fn required_grade_impossible_and_floor() {
        let points = [GradePoint { value: 2.0, weight: 1.0 }];
        let (tp, tw) = weighted_sum(&points);
        assert_eq!(required_grade(tp, tw, 9.0, 1.0, &[], 1), "Onmogelijk (>10)");
        // Required < 1 clamps to "1.0" like the frontend.
        let points = [GradePoint { value: 9.5, weight: 3.0 }; 4];
        let (tp, tw) = weighted_sum(&points);
        assert_eq!(required_grade(tp, tw, 5.5, 1.0, &[], 1), "1.0");
    }

    #[test]
    fn predicted_average_adds_simulation() {
        let points = [GradePoint { value: 7.0, weight: 1.0 }; 3];
        let (tp, tw) = weighted_sum(&points);
        let sim = [GradePoint { value: 5.0, weight: 1.0 }];
        assert_eq!(predicted_average(tp, tw, &sim, true, 1), "6.5");
        assert_eq!(predicted_average(tp, tw, &sim, false, 1), "7.0");
    }

    #[test]
    fn min_grade_for_pass_variants() {
        let (tp, tw) = weighted_sum(&[GradePoint { value: 6.0, weight: 2.0 }]);
        // 5.5 * 3 - 12 = 4.5
        assert_eq!(min_grade_for_pass(tp, tw, 5.5), MinGradeForPass::Needed("4.5".to_string()));

        let (tp, tw) = weighted_sum(&[GradePoint { value: 9.0, weight: 3.0 }]);
        assert_eq!(min_grade_for_pass(tp, tw, 5.5), MinGradeForPass::AlreadyPassing);

        let (tp, tw) = weighted_sum(&[GradePoint { value: 1.0, weight: 2.0 }]);
        assert_eq!(min_grade_for_pass(tp, tw, 5.5), MinGradeForPass::Impossible);
    }

    #[test]
    fn average_for_grade_is_weighted() {
        let (tp, tw) = weighted_sum(&[GradePoint { value: 7.0, weight: 1.0 }]);
        assert_eq!(average_for_grade(tp, tw, 5.0, 1.0, 1), "6.0");
    }

    #[test]
    fn new_overall_average_replaces_subject() {
        let subjects = vec![
            ("Wiskunde".to_string(), 7.0),
            ("Nederlands".to_string(), 8.0),
            ("Engels".to_string(), 6.0),
        ];
        // Wiskunde 7.0 → 9.0: (9 + 8 + 6) / 3 = 7.67
        assert_eq!(new_overall_average(&subjects, "Wiskunde", 9.0, 2), "7.67");
    }

    #[test]
    fn parse_dutch_grade_handles_comma() {
        assert_eq!(parse_dutch_grade("7,5"), Some(7.5));
        assert_eq!(parse_dutch_grade("7.5"), Some(7.5));
        assert_eq!(parse_dutch_grade("abc"), None);
    }
}