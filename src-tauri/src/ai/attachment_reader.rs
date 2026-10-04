//! Best-effort text extraction from assignment/message attachments so the AI
//! can actually read a worksheet PDF or Word doc instead of only seeing the
//! filename/size. Plain text only — images and diagrams are not described.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Maximum number of characters returned to the model (keeps the tool result
/// small enough for the model's context window).
pub const MAX_TEXT_CHARS: usize = 8000;

/// Default page size for `read_attachment_text` (paged reads).
pub const DEFAULT_PAGE_CHARS: usize = 8000;

/// Max download size accepted for attachments (plan item 5).
pub const MAX_DOWNLOAD_BYTES: usize = 15 * 1024 * 1024;

/// Extraction is capped so a huge document can't blow up the cache.
pub const EXTRACT_MAX_CHARS: usize = 200_000;

/// Cached extracted texts (cap + oldest-first eviction).
pub const TEXT_CACHE_LIMIT: usize = 20;

/// File registry entries (cap, oldest dropped).
pub const REGISTRY_LIMIT: usize = 200;

/// Extract plain text from attachment bytes.
///
/// File type is determined from the filename extension first, falling back to
/// the HTTP content-type. Supported: PDF, Word (.docx), PowerPoint (.pptx,
/// slides as text), plain text (.txt .md .csv .json .html and friends).
/// Anything else returns a clear error instead of silently returning garbage.
pub fn extract_text(bytes: &[u8], filename: &str, content_type: &str) -> Result<String, String> {
    let lower = filename.to_lowercase();
    let ext = std::path::Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();

    let ct = content_type.to_lowercase();

    if ext == "pdf" || ct.contains("application/pdf") || ct.contains("pdf") {
        extract_pdf(bytes)
    } else if ext == "docx"
        || ct.contains("wordprocessingml")
        || ct.contains("officedocument.wordprocessingml")
        || ct.contains("docx")
    {
        extract_docx(bytes)
    } else if ext == "pptx" || ct.contains("presentationml") || ct.contains("pptx") {
        extract_pptx(bytes)
    } else if matches!(
        ext.as_str(),
        "txt"
            | "text"
            | "md"
            | "markdown"
            | "rtf"
            | "csv"
            | "log"
            | "json"
            | "xml"
            | "html"
            | "htm"
            | "yaml"
            | "yml"
            | "css"
            | "js"
            | "ts"
    ) || ct.starts_with("text/")
        || ct.contains("json")
        || ct.contains("html")
        || ct.contains("csv")
    {
        extract_plain(bytes)
    } else {
        // Unknown type: try to decode as UTF-8 text; if that fails it's clearly
        // a binary format we don't support.
        match String::from_utf8(bytes.to_vec()) {
            Ok(s) if !s.contains('\u{0}') => Ok(s),
            _ => Err(format!(
                "Niet-ondersteund bestandstype '{}' ({}). Alleen PDF, Word (.docx), PowerPoint (.pptx) en tekstbestanden kunnen worden gelezen.",
                filename,
                if content_type.is_empty() { "onbekend type" } else { content_type }
            )),
        }
    }
}

/// Which engine reads a file (platform capabilities differ: web has no PPTX).
/// `None` = unsupported, with a Dutch reason for the model.
pub fn unsupported_reason(
    filename: &str,
    content_type: &str,
    pptx_supported: bool,
) -> Option<String> {
    let lower = filename.to_lowercase();
    let ext = std::path::Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let ct = content_type.to_lowercase();
    let is_image = matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tiff" | "tif" | "svg"
    ) || ct.starts_with("image/");
    if is_image {
        return Some("afbeeldingen worden niet gelezen (alleen tekst)".to_string());
    }
    if ext == "xlsx" || ext == "xls" || ct.contains("spreadsheetml") || ct.contains("excel") {
        return Some("spreadsheets worden nog niet ondersteund".to_string());
    }
    if (ext == "pptx" || ct.contains("presentationml")) && !pptx_supported {
        return Some("presentaties worden op web nog niet ondersteund".to_string());
    }
    None
}

/// True for formats the engine can extract (used for `readable` in listings).
pub fn is_readable_extension(filename: &str, pptx_supported: bool) -> bool {
    let lower = filename.to_lowercase();
    let ext = std::path::Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if unsupported_reason(filename, "", pptx_supported).is_some() {
        return false;
    }
    matches!(
        ext,
        "txt"
            | "text"
            | "md"
            | "markdown"
            | "rtf"
            | "csv"
            | "log"
            | "json"
            | "xml"
            | "html"
            | "htm"
            | "yaml"
            | "yml"
            | "css"
            | "js"
            | "ts"
            | "pdf"
            | "docx"
            | "pptx"
    )
}

/// Extract text from a PDF in memory. Scanned/image-only PDFs yield empty or
/// garbled output — that's the documented best-effort limitation.
fn extract_pdf(bytes: &[u8]) -> Result<String, String> {
    let text = pdf_extract::extract_text_from_mem(bytes)
        .map_err(|e| format!("Kon PDF-tekst niet extraheren: {}", e))?;
    Ok(text)
}

/// Extract text from a .docx (a ZIP of XML). We only need the text, so we read
/// `word/document.xml`, turn paragraph/line-break/tab elements into whitespace,
/// and strip the remaining markup — no full XML parser required.
fn extract_docx(bytes: &[u8]) -> Result<String, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("Kon .docx niet openen (ongeldig archief): {}", e))?;

    let entry_name = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n.eq_ignore_ascii_case("word/document.xml"))
        .ok_or_else(|| "Geen word/document.xml gevonden in het .docx-bestand.".to_string())?;

    let mut file = archive
        .by_name(&entry_name)
        .map_err(|e| format!("Kon word/document.xml niet lezen: {}", e))?;
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut file, &mut xml)
        .map_err(|e| format!("Kon document-inhoud niet lezen: {}", e))?;

    Ok(office_xml_to_text(&xml))
}

/// Alias kept for the existing unit tests.
#[cfg(test)]
fn docx_xml_to_text(xml: &str) -> String {
    office_xml_to_text(xml)
}

/// Extract text from a .pptx (a ZIP of slide XML), slide by slide.
/// Same tag-stripping approach as .docx: DrawingML `a:t` text passes
/// through, `a:p` closes become newlines.
fn extract_pptx(bytes: &[u8]) -> Result<String, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("Kon .pptx niet openen (ongeldig archief): {}", e))?;

    let mut names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| {
            let l = n.to_lowercase();
            l.starts_with("ppt/slides/slide") && l.ends_with(".xml")
        })
        .collect();
    names.sort();
    if names.is_empty() {
        return Err("Geen slides gevonden in het .pptx-bestand.".to_string());
    }

    let mut out = String::new();
    for (idx, name) in names.iter().enumerate() {
        let mut file = archive
            .by_name(name)
            .map_err(|e| format!("Kon {} niet lezen: {}", name, e))?;
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut file, &mut xml)
            .map_err(|e| format!("Kon slide-inhoud niet lezen: {}", e))?;
        if idx > 0 {
            out.push_str(&format!("\n\n--- slide {} ---\n", idx + 1));
        }
        out.push_str(&office_xml_to_text(&xml));
    }
    Ok(out.trim().to_string())
}

/// Convert a raw Office XML string (`word/document.xml`, `ppt/slides/*.xml`)
/// into readable text: paragraphs and line breaks become newlines, tabs
/// become tabs, all other tags are stripped.
fn office_xml_to_text(xml: &str) -> String {
    let mut out = String::new();
    let mut rest = xml;

    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        rest = &rest[open..];
        let Some(close) = rest.find('>') else { break };
        let tag = &rest[1..close]; // content between < and >
        let stripped = tag.trim();
        let lower = stripped
            .trim_start_matches('/')
            .trim_start()
            .trim_end_matches('/')
            .trim_end()
            .to_lowercase();

        // Tag-name boundary: exact "w:p"/"a:p" (not "w:pPr"), breaks, tabs.
        if stripped.starts_with('/') && (lower == "w:p" || lower == "w:p " || lower == "a:p") {
            out.push('\n');
        } else if lower == "w:br" || lower == "w:cr" || lower == "br" || lower == "a:br" {
            out.push('\n');
        } else if lower == "w:tab" || lower == "tab" {
            out.push('\t');
        } else if lower == "w:noBreakHyphen" {
            out.push('-');
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);

    let decoded = decode_xml_entities(&out);
    // Collapse 3+ consecutive blank lines into a single blank line.
    let mut clean = String::with_capacity(decoded.len());
    let mut blank_count = 0u32;
    for line in decoded.split_inclusive('\n') {
        if line.trim().is_empty() {
            blank_count += 1;
            if blank_count <= 2 {
                clean.push_str(line);
            }
        } else {
            blank_count = 0;
            clean.push_str(line);
        }
    }
    clean.trim().to_string()
}

/// Decode the XML entities that commonly appear in docx text (named + numeric).
fn decode_xml_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '&' {
            out.push(c);
            continue;
        }
        // Peek the full entity (max ~16 chars).
        let mut entity = String::from("&");
        while let Some(&next) = chars.peek() {
            entity.push(next);
            chars.next();
            if next == ';' || entity.len() > 16 {
                break;
            }
        }
        let decoded = match entity.as_str() {
            "&amp;" => "&".to_string(),
            "&lt;" => "<".to_string(),
            "&gt;" => ">".to_string(),
            "&quot;" => "\"".to_string(),
            "&apos;" => "'".to_string(),
            "&nbsp;" => " ".to_string(),
            _ => {
                // Numeric entities: &#dd; and &#xhh;
                let inner = entity.strip_prefix("&#").and_then(|e| e.strip_suffix(';'));
                match inner {
                    Some(hex) if hex.starts_with(['x', 'X']) => u32::from_str_radix(&hex[1..], 16)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|ch| ch.to_string())
                        .unwrap_or_else(|| entity.clone()),
                    Some(dec) => dec
                        .parse::<u32>()
                        .ok()
                        .and_then(char::from_u32)
                        .map(|ch| ch.to_string())
                        .unwrap_or_else(|| entity.clone()),
                    None => entity.clone(),
                }
            }
        };
        out.push_str(&decoded);
    }
    out
}

/// Decode bytes as UTF-8 (lossy) — works for txt/md/rtf.
fn extract_plain(bytes: &[u8]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(bytes).to_string())
}

/// True when extracted text has no readable layer at all (scanned PDF).
pub fn is_empty_text(text: &str) -> bool {
    text.trim().is_empty()
}

/// Cap extracted text for the cache (plan item 4). Returns (capped, truncated).
pub fn cap_extracted(text: String) -> (String, bool) {
    if text.chars().count() <= EXTRACT_MAX_CHARS {
        return (text, false);
    }
    (text.chars().take(EXTRACT_MAX_CHARS).collect(), true)
}

/// Page through extracted text (char offsets, never splits UTF-8).
/// Returns (page, next_offset, total_chars).
pub fn page_text(text: &str, offset: usize, max_chars: usize) -> (String, Option<usize>, usize) {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let start = offset.min(total);
    let end = (start + max_chars.max(1)).min(total);
    let page: String = chars[start..end].iter().collect();
    let next = if end < total { Some(end) } else { None };
    (page, next, total)
}

/// How a model-supplied URL resolved against the Magister endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlKind {
    /// Relative path — joined onto the Magister endpoint by the HTTP layer.
    Relative,
    /// Absolute URL on the user's own Magister host.
    SameHost,
}

/// Validate a model-supplied attachment URL (plan item 5: SSRF guard).
/// Accepts relative paths and absolute URLs on the endpoint's own host;
/// rejects foreign hosts, userinfo tricks, non-HTTP schemes and
/// protocol-relative URLs.
pub fn validate_attachment_url(url: &str, endpoint: &str) -> Result<UrlKind, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Geen URL opgegeven.".to_string());
    }
    if url.starts_with("//") {
        return Err("Ongeldige URL: alleen Magister-links zijn toegestaan.".to_string());
    }
    match url::Url::parse(url) {
        Ok(parsed) => {
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("Ongeldige URL: alleen Magister-links zijn toegestaan.".to_string());
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("Ongeldige URL: alleen Magister-links zijn toegestaan.".to_string());
            }
            let ep = url::Url::parse(endpoint)
                .map_err(|_| "Ongeldige URL: alleen Magister-links zijn toegestaan.".to_string())?;
            let host_eq = parsed.host_str().map(|h| h.to_lowercase())
                == ep.host_str().map(|h| h.to_lowercase());
            let port_eq = parsed.port_or_known_default() == ep.port_or_known_default();
            if host_eq && port_eq {
                Ok(UrlKind::SameHost)
            } else {
                Err(
                    "Ongeldige URL: alleen links van je eigen Magister-domein zijn toegestaan."
                        .to_string(),
                )
            }
        }
        Err(_) => {
            let lower = url.to_lowercase();
            if lower.contains("://") {
                return Err("Ongeldige URL: alleen Magister-links zijn toegestaan.".to_string());
            }
            for scheme in ["file:", "ftp:", "data:", "javascript:", "blob:"] {
                if lower.starts_with(scheme) {
                    return Err("Ongeldige URL: alleen Magister-links zijn toegestaan.".to_string());
                }
            }
            Ok(UrlKind::Relative)
        }
    }
}

/// Check a final (post-redirect) URL against the endpoint host.
/// Call after downloading: redirects to a different host are refused.
pub fn validate_final_url(final_url: &str, endpoint: &str) -> Result<(), String> {
    match validate_attachment_url(final_url, endpoint) {
        Ok(UrlKind::SameHost) => Ok(()),
        Ok(UrlKind::Relative) => Err(
            "Ongeldige download-locatie: alleen links van je eigen Magister-domein zijn toegestaan.".to_string(),
        ),
        Err(e) => Err(e),
    }
}

/// A file enumerated by `list_files`, resolvable later by `file_id`.
#[derive(Debug, Clone)]
pub struct FileRef {
    pub url: String,
    pub name: String,
    pub source: String,
}

/// Extracted text cached per file id (plan item 4).
#[derive(Debug, Clone)]
pub struct CachedText {
    pub url: String,
    pub name: String,
    pub text: String,
    pub total_chars: usize,
    pub size_bytes: usize,
    pub truncated: bool,
}

struct Registry {
    refs: HashMap<String, FileRef>,
    order: VecDeque<String>,
}

struct TextCache {
    entries: HashMap<String, CachedText>,
    order: VecDeque<String>,
}

static FILE_REGISTRY: std::sync::LazyLock<Mutex<Registry>> = std::sync::LazyLock::new(|| {
    Mutex::new(Registry {
        refs: HashMap::new(),
        order: VecDeque::new(),
    })
});

static TEXT_CACHE: std::sync::LazyLock<Mutex<TextCache>> = std::sync::LazyLock::new(|| {
    Mutex::new(TextCache {
        entries: HashMap::new(),
        order: VecDeque::new(),
    })
});

/// Register a listed file for later `file_id` reads. Evicts oldest past cap.
pub fn registry_put(file_id: String, file_ref: FileRef) {
    if let Ok(mut reg) = FILE_REGISTRY.lock() {
        if !reg.refs.contains_key(&file_id) {
            reg.order.push_back(file_id.clone());
        }
        reg.refs.insert(file_id, file_ref);
        while reg.refs.len() > REGISTRY_LIMIT {
            if let Some(old) = reg.order.pop_front() {
                reg.refs.remove(&old);
            } else {
                break;
            }
        }
    }
}

pub fn registry_get(file_id: &str) -> Option<FileRef> {
    FILE_REGISTRY.lock().ok()?.refs.get(file_id).cloned()
}

/// Cached text hit requires the same source URL (stale ids re-download).
pub fn cache_get(file_id: &str, url: &str) -> Option<CachedText> {
    let cache = TEXT_CACHE.lock().ok()?;
    let entry = cache.entries.get(file_id)?;
    if entry.url == url {
        Some(entry.clone())
    } else {
        None
    }
}

pub fn cache_put(file_id: String, entry: CachedText) {
    if let Ok(mut cache) = TEXT_CACHE.lock() {
        if !cache.entries.contains_key(&file_id) {
            cache.order.push_back(file_id.clone());
        }
        cache.entries.insert(file_id, entry);
        while cache.entries.len() > TEXT_CACHE_LIMIT {
            if let Some(old) = cache.order.pop_front() {
                cache.entries.remove(&old);
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
pub fn registry_len() -> usize {
    FILE_REGISTRY.lock().map(|r| r.refs.len()).unwrap_or(0)
}

#[cfg(test)]
pub fn cache_len() -> usize {
    TEXT_CACHE.lock().map(|c| c.entries.len()).unwrap_or(0)
}

#[cfg(test)]
pub fn registry_clear() {
    if let Ok(mut reg) = FILE_REGISTRY.lock() {
        reg.refs.clear();
        reg.order.clear();
    }
}

#[cfg(test)]
pub fn cache_clear() {
    if let Ok(mut cache) = TEXT_CACHE.lock() {
        cache.entries.clear();
        cache.order.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_xml_to_text_converts_paragraphs() {
        let xml = r#"<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hallo</w:t></w:r></w:p><w:p><w:r><w:t>tweede &amp; paragraaf</w:t><w:tab/><w:t>met tab</w:t></w:r></w:p></w:body></w:document>"#;
        let text = docx_xml_to_text(xml);
        assert!(text.contains("Hallo"));
        assert!(text.contains("tweede & paragraaf"));
        assert!(text.contains('\t'));
    }

    #[test]
    fn docx_xml_to_text_does_not_split_paragraph_props() {
        let xml =
            "<w:p><w:pPr><w:pStyle w:val=\"Normal\"/></w:pPr><w:r><w:t>Tekst</w:t></w:r></w:p>";
        let text = docx_xml_to_text(xml);
        assert_eq!(text.trim(), "Tekst");
    }

    #[test]
    fn decode_entities_handles_named_and_numeric() {
        assert_eq!(
            decode_xml_entities("a &lt;b&gt; &amp; c &#65;&#x42;"),
            "a <b> & c AB"
        );
    }

    #[test]
    fn plain_text_is_readable() {
        let text = extract_text(b"een simpel tekstbestand", "opdracht.txt", "text/plain").unwrap();
        assert_eq!(text, "een simpel tekstbestand");
    }

    #[test]
    fn pdf_fixture_extracts() {
        let bytes = include_bytes!("../../../src/lib/fixtures/werkstuk.pdf");
        let text = extract_text(bytes, "werkstuk.pdf", "application/pdf").unwrap();
        assert!(text.contains("Hallo PDF wereld"), "got: {}", text);
    }

    #[test]
    fn docx_fixture_extracts() {
        let bytes = include_bytes!("../../../src/lib/fixtures/werkstuk.docx");
        let text = extract_text(
            bytes,
            "werkstuk.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        .unwrap();
        assert!(text.contains("Hallo Word wereld"), "got: {}", text);
        assert!(
            text.contains("Tweede paragraaf met & teken"),
            "got: {}",
            text
        );
    }

    #[test]
    fn pptx_fixture_extracts_slides() {
        let bytes = include_bytes!("../../../src/lib/fixtures/presentatie.pptx");
        let text = extract_text(
            bytes,
            "presentatie.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )
        .unwrap();
        assert!(text.contains("Hallo Slide een"), "got: {}", text);
        assert!(text.contains("Tweede bullet"), "got: {}", text);
    }

    #[test]
    fn scanned_pdf_reports_empty() {
        // A PDF with no text layer extracts to whitespace at best.
        assert!(is_empty_text("  \n "));
        assert!(!is_empty_text("Hallo"));
    }

    #[test]
    fn unsupported_reasons() {
        assert_eq!(
            unsupported_reason("foto.png", "image/png", true),
            Some("afbeeldingen worden niet gelezen (alleen tekst)".to_string())
        );
        assert_eq!(
            unsupported_reason("tabel.xlsx", "", true),
            Some("spreadsheets worden nog niet ondersteund".to_string())
        );
        assert_eq!(
            unsupported_reason("deck.pptx", "", false),
            Some("presentaties worden op web nog niet ondersteund".to_string())
        );
        assert_eq!(unsupported_reason("deck.pptx", "", true), None);
        assert_eq!(unsupported_reason("a.txt", "text/plain", false), None);
        assert!(is_readable_extension("werkstuk.pdf", false));
        assert!(is_readable_extension("werkstuk.docx", false));
        assert!(!is_readable_extension("deck.pptx", false));
        assert!(is_readable_extension("deck.pptx", true));
        assert!(!is_readable_extension("foto.jpg", true));
    }

    #[test]
    fn url_validation_blocks_tricks() {
        let ep = "https://jan.magister.net";
        assert!(validate_attachment_url("personen/1/bijlagen/2", ep).is_ok());
        assert!(validate_attachment_url("/api/personen/1/x", ep).is_ok());
        assert_eq!(
            validate_attachment_url("https://jan.magister.net/api/x", ep),
            Ok(UrlKind::SameHost)
        );
        // Case-insensitive host.
        assert!(validate_attachment_url("https://JAN.MAGISTER.NET/x", ep).is_ok());
        // Foreign hosts.
        assert!(validate_attachment_url("https://evil.example.com/x", ep).is_err());
        assert!(validate_attachment_url("https://jan.magister.net.evil.com/x", ep).is_err());
        // Userinfo trick — even on the right host.
        assert!(validate_attachment_url("https://user@jan.magister.net/x", ep).is_err());
        assert!(validate_attachment_url("https://jan.magister.net@evil.com/x", ep).is_err());
        // Schemes and protocol-relative.
        assert!(validate_attachment_url("file:///etc/passwd", ep).is_err());
        assert!(validate_attachment_url("javascript:alert(1)", ep).is_err());
        assert!(validate_attachment_url("data:text/plain,hi", ep).is_err());
        assert!(validate_attachment_url("//evil.com/x", ep).is_err());
        // Port mismatch.
        assert!(validate_attachment_url("https://jan.magister.net:8443/x", ep).is_err());
        assert!(validate_attachment_url("", ep).is_err());
    }

    #[test]
    fn paging_is_char_based_and_safe() {
        let text = "a".repeat(100) + &"🎓".repeat(10);
        let (page, next, total) = page_text(&text, 95, 10);
        assert_eq!(total, 110);
        assert_eq!(next, Some(105));
        assert_eq!(page.chars().count(), 10);
        let (last, next2, _) = page_text(&text, 105, 10);
        assert_eq!(next2, None);
        assert_eq!(last.chars().count(), 5);
        let (empty, none, _) = page_text(&text, 500, 10);
        assert!(empty.is_empty());
        assert_eq!(none, None);
    }

    #[test]
    fn cap_and_cache_round_trip() {
        registry_put(
            "zz:1:2".to_string(),
            FileRef {
                url: "bijlagen/2".to_string(),
                name: "a.txt".to_string(),
                source: "assignment".to_string(),
            },
        );
        assert_eq!(registry_get("zz:1:2").unwrap().name, "a.txt");
        assert!(registry_get("nope").is_none());
        // Stale URL does not hit.
        cache_put(
            "zz:1:2".to_string(),
            CachedText {
                url: "bijlagen/2".to_string(),
                name: "a.txt".to_string(),
                text: "hallo".to_string(),
                total_chars: 5,
                size_bytes: 5,
                truncated: false,
            },
        );
        assert!(cache_get("zz:1:2", "bijlagen/2").is_some());
        assert!(cache_get("zz:1:2", "bijlagen/3").is_none());
        assert_eq!(cache_len(), 1);
        // Eviction keeps the cap.
        for i in 0..30 {
            cache_put(
                format!("k{}", i),
                CachedText {
                    url: "u".to_string(),
                    name: "n".to_string(),
                    text: "t".to_string(),
                    total_chars: 1,
                    size_bytes: 1,
                    truncated: false,
                },
            );
        }
        assert!(cache_len() <= TEXT_CACHE_LIMIT);
    }

    #[test]
    fn unsupported_binary_is_an_error() {
        let bytes = [0x89, 0x50, 0x4E, 0x47, 0x0A, 0x00, 0x00, 0x00]; // PNG magic
        let err = extract_text(&bytes, "plaatje.png", "image/png").unwrap_err();
        assert!(err.contains("Niet-ondersteund bestandstype"));
    }
}
