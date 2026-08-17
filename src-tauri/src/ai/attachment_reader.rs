//! Best-effort text extraction from assignment/message attachments so the AI
//! can actually read a worksheet PDF or Word doc instead of only seeing the
//! filename/size. Plain text only — images and diagrams are not described.

/// Maximum number of characters returned to the model (keeps the tool result
/// small enough for the model's context window).
pub const MAX_TEXT_CHARS: usize = 8000;

/// Extract plain text from attachment bytes.
///
/// File type is determined from the filename extension first, falling back to
/// the HTTP content-type. Supported: PDF, Word (.docx), plain text. Anything
/// else returns a clear error instead of silently returning garbage.
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
    } else if matches!(ext.as_str(), "txt" | "text" | "md" | "markdown" | "rtf" | "csv" | "log")
        || ct.starts_with("text/")
    {
        extract_plain(bytes)
    } else {
        // Unknown type: try to decode as UTF-8 text; if that fails it's clearly
        // a binary format we don't support.
        match String::from_utf8(bytes.to_vec()) {
            Ok(s) if !s.contains('\u{0}') => Ok(s),
            _ => Err(format!(
                "Niet-ondersteund bestandstype '{}' ({}). Alleen PDF, Word (.docx) en tekstbestanden kunnen worden gelezen.",
                filename,
                if content_type.is_empty() { "onbekend type" } else { content_type }
            )),
        }
    }
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

    Ok(docx_xml_to_text(&xml))
}

/// Convert a raw `word/document.xml` string into readable text: paragraphs and
/// line breaks become newlines, tabs become tabs, all other tags are stripped.
fn docx_xml_to_text(xml: &str) -> String {
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

        // Tag-name boundary: exact "w:p" (not "w:pPr"), "w:br", "w:cr", "w:tab".
        if stripped.starts_with('/') && (lower == "w:p" || lower == "w:p ") {
            out.push('\n');
        } else if lower == "w:br" || lower == "w:cr" || lower == "br" {
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
                let inner = entity
                    .strip_prefix("&#")
                    .and_then(|e| e.strip_suffix(';'));
                match inner {
                    Some(hex) if hex.starts_with(['x', 'X']) => {
                        u32::from_str_radix(&hex[1..], 16)
                            .ok()
                            .and_then(char::from_u32)
                            .map(|ch| ch.to_string())
                            .unwrap_or_else(|| entity.clone())
                    }
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
        let xml = "<w:p><w:pPr><w:pStyle w:val=\"Normal\"/></w:pPr><w:r><w:t>Tekst</w:t></w:r></w:p>";
        let text = docx_xml_to_text(xml);
        assert_eq!(text.trim(), "Tekst");
    }

    #[test]
    fn decode_entities_handles_named_and_numeric() {
        assert_eq!(decode_xml_entities("a &lt;b&gt; &amp; c &#65;&#x42;"), "a <b> & c AB");
    }

    #[test]
    fn plain_text_is_readable() {
        let text = extract_text(b"een simpel tekstbestand", "opdracht.txt", "text/plain").unwrap();
        assert_eq!(text, "een simpel tekstbestand");
    }

    #[test]
    fn unsupported_binary_is_an_error() {
        let bytes = [0x89, 0x50, 0x4E, 0x47, 0x0A, 0x00, 0x00, 0x00]; // PNG magic
        let err = extract_text(&bytes, "plaatje.png", "image/png").unwrap_err();
        assert!(err.contains("Niet-ondersteund bestandstype"));
    }
}