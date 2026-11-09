//! Small helpers shared by the download and export commands.
//!
//! Kept free of any Tauri/Android types so they compile (and are unit-tested)
//! on every platform, even though the Android hand-off itself only runs there.

/// Longest file name (in characters) we write. File systems allow 255 *bytes*,
/// so this leaves room for multi-byte characters.
const MAX_NAME_CHARS: usize = 120;

/// Turns an attachment name from Magister into something that is safe to use
/// as a single file name: no path separators or characters Windows/Android
/// reject, no leading/trailing dots, never empty, and not absurdly long.
///
/// Without this a name like `verslag 1/2.pdf` fails to save, and `../x` could
/// escape the download folder.
pub fn safe_file_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let base = if cleaned.is_empty() { fallback } else { cleaned };
    shorten_keep_extension(base, MAX_NAME_CHARS)
}

fn shorten_keep_extension(name: &str, max_chars: usize) -> String {
    if name.chars().count() <= max_chars {
        return name.to_string();
    }
    match name.rfind('.') {
        Some(dot) if name.len() - dot <= 11 && dot > 0 => {
            let ext = &name[dot..];
            let keep = max_chars.saturating_sub(ext.chars().count());
            let stem: String = name[..dot].chars().take(keep).collect();
            format!("{stem}{ext}")
        }
        _ => name.chars().take(max_chars).collect(),
    }
}

/// What the Android `ShareHelper` did with a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareOutcome {
    /// An "Open bestand" chooser was shown.
    pub opened: bool,
    /// Human-readable place the file was saved, e.g. `Download/Friday`.
    pub location: String,
}

/// Parses the `STATUS|detail` string returned by `ShareHelper.shareFile`.
pub fn parse_share_status(raw: &str) -> Result<ShareOutcome, String> {
    let (status, detail) = raw.split_once('|').unwrap_or((raw, ""));
    match status {
        "OPENED" => Ok(ShareOutcome {
            opened: true,
            location: detail.to_string(),
        }),
        "SAVED" => Ok(ShareOutcome {
            opened: false,
            location: detail.to_string(),
        }),
        "ERROR" => Err(if detail.is_empty() {
            "Onbekende fout bij het opslaan".to_string()
        } else {
            detail.to_string()
        }),
        _ => Err(format!("Onverwacht antwoord van Android: {raw}")),
    }
}

/// A folder chosen with the Android folder picker is a Storage Access Framework
/// tree URI. Anything else (an old desktop path, an empty string) is not usable
/// on Android and means "use the default location".
pub fn android_tree_uri(download_dir: Option<&str>) -> Option<&str> {
    download_dir
        .map(str::trim)
        .filter(|d| d.starts_with("content://"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_file_name_removes_separators_and_reserved_characters() {
        assert_eq!(safe_file_name("verslag 1/2.pdf", "x"), "verslag 1_2.pdf");
        assert_eq!(safe_file_name("a\\b:c*d?e\"f<g>h|i.txt", "x"), "a_b_c_d_e_f_g_h_i.txt");
    }

    #[test]
    fn safe_file_name_blocks_path_traversal_and_hidden_names() {
        assert_eq!(safe_file_name("../../etc/passwd", "x"), "_.._etc_passwd");
        assert_eq!(safe_file_name("..", "bijlage"), "bijlage");
        assert_eq!(safe_file_name(".bashrc", "x"), "bashrc");
        assert_eq!(safe_file_name("   ", "bijlage"), "bijlage");
        assert_eq!(safe_file_name("", "bijlage"), "bijlage");
    }

    #[test]
    fn safe_file_name_keeps_normal_names_untouched() {
        assert_eq!(safe_file_name("Opdracht Nederlands (2).docx", "x"), "Opdracht Nederlands (2).docx");
        assert_eq!(safe_file_name("é-ö.pdf", "x"), "é-ö.pdf");
    }

    #[test]
    fn safe_file_name_shortens_but_keeps_the_extension() {
        let long = format!("{}.pdf", "a".repeat(300));
        let out = safe_file_name(&long, "x");
        assert_eq!(out.chars().count(), MAX_NAME_CHARS);
        assert!(out.ends_with(".pdf"));

        let no_ext = "b".repeat(300);
        assert_eq!(safe_file_name(&no_ext, "x").chars().count(), MAX_NAME_CHARS);

        let multibyte = format!("{}.pdf", "é".repeat(300));
        let out = safe_file_name(&multibyte, "x");
        assert!(out.ends_with(".pdf"));
        assert!(out.len() <= 255, "must fit in 255 bytes, got {}", out.len());
    }

    #[test]
    fn parse_share_status_understands_every_status() {
        assert_eq!(
            parse_share_status("OPENED|Download/Friday"),
            Ok(ShareOutcome { opened: true, location: "Download/Friday".into() })
        );
        assert_eq!(
            parse_share_status("SAVED|Documents/School"),
            Ok(ShareOutcome { opened: false, location: "Documents/School".into() })
        );
        assert_eq!(parse_share_status("ERROR|Schijf vol"), Err("Schijf vol".to_string()));
        assert!(parse_share_status("ERROR").unwrap_err().contains("Onbekende fout"));
        assert!(parse_share_status("???").unwrap_err().contains("Onverwacht"));
        assert!(parse_share_status("").unwrap_err().contains("Onverwacht"));
    }

    #[test]
    fn parse_share_status_keeps_pipes_inside_the_detail() {
        assert_eq!(
            parse_share_status("SAVED|a|b").unwrap().location,
            "a|b"
        );
    }

    #[test]
    fn android_tree_uri_only_accepts_content_uris() {
        assert_eq!(android_tree_uri(None), None);
        assert_eq!(android_tree_uri(Some("")), None);
        assert_eq!(android_tree_uri(Some("/home/joris/Downloads")), None);
        assert_eq!(
            android_tree_uri(Some(" content://com.android.externalstorage.documents/tree/primary%3AFriday ")),
            Some("content://com.android.externalstorage.documents/tree/primary%3AFriday")
        );
    }
}
