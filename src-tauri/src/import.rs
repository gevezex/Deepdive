//! Van invoer naar opgeslagen bron: website, pdf of geplakte tekst.

use crate::engine::{webview::WebviewEngine, PageEngine, RenderedPage};
use crate::error::AppError;
use crate::model::{word_count, AssetStats, Block, Source, SourceKind, SCHEMA_VERSION};
use crate::snapshot;
use crate::store::{new_id, Store};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::AppHandle;
use url::Url;

const MAX_PDF: usize = 500 * 1024 * 1024;
/// Onder dit aantal woorden is er vermoedelijk geen artikel vastgelegd.
const EMPTY_WORDS: u32 = 30;
/// Hieronder kijken we of de pagina een blokkade of cookiemuur is. Een lang artikel over captcha's mag gewoon.
const SUSPECT_WORDS: u32 = 250;

pub fn parse_url(raw: &str) -> Result<Url, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return Err(AppError::invalid_url());
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let url = Url::parse(&with_scheme).map_err(|_| AppError::invalid_url())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::invalid_url());
    }
    Ok(url)
}

fn now() -> String {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

fn base_source(id: String, kind: SourceKind, title: String) -> Source {
    Source {
        schema_version: SCHEMA_VERSION,
        id,
        kind,
        title,
        url: None,
        final_url: None,
        captured_at: now(),
        author: None,
        site_name: None,
        published: None,
        lang: None,
        content_hash: None,
        page_count: None,
        text_ready: true,
        blocks: vec![],
        word_count: 0,
        assets: AssetStats::default(),
        warnings: vec![],
    }
}

// ---------- beoordelen wat de engine teruggaf ----------

const BLOCK_PHRASES: &[&str] = &[
    "just a moment", "attention required", "verify you are human", "verifying you are human", "checking your browser",
    "access denied", "access to this page has been denied", "are you a robot", "are you human", "captcha",
    "pardon our interruption", "request blocked", "403 forbidden", "enable javascript and cookies",
    "unusual traffic", "ben je een robot", "toegang geweigerd", "security check", "bot detection",
];
const CONSENT_PHRASES: &[&str] = &[
    "cookie", "privacy-instellingen", "privacyinstellingen", "toestemming", "consent", "we value your privacy", "akkoord",
];

fn lower_join(page: &RenderedPage) -> String {
    let mut text = page.document_title.clone().unwrap_or_default();
    for b in page.blocks.iter().take(40) {
        text.push(' ');
        text.push_str(&b.text);
    }
    text.to_lowercase()
}

/// Bepaalt of dit een bruikbare kopie is. Geeft waarschuwingen terug, of een fout die de lezer naar plakken leidt.
pub fn classify(page: &RenderedPage, http_status: Option<u16>) -> Result<Vec<String>, AppError> {
    let words: u32 = page.blocks.iter().map(|b| b.text.split_whitespace().count() as u32).sum();
    let text = lower_join(page);
    let host = Url::parse(&page.final_url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let detail = format!("{words} woorden, status {http_status:?}, adres {}", page.final_url);

    if words < SUSPECT_WORDS {
        if BLOCK_PHRASES.iter().any(|p| text.contains(p)) {
            return Err(AppError::new("blocked", "Deze site blokkeert het automatisch ophalen (bijvoorbeeld met een robotcontrole). Er is niets opgeslagen. Kopieer de tekst uit je browser en plak die hier.").with_detail(detail));
        }
        let consent_host = host.contains("consent") || host.contains("privacy") || host.starts_with("cmp.");
        if consent_host || (words < 120 && CONSENT_PHRASES.iter().any(|p| text.contains(p))) {
            return Err(AppError::new("consent", "Deze site toont eerst een cookiemuur, en die kan de app niet zelf beantwoorden. Er is niets opgeslagen. Kopieer de tekst uit je browser en plak die hier.").with_detail(detail));
        }
    }
    if let Some(status) = http_status {
        if words < SUSPECT_WORDS && (status == 404 || status == 410) {
            return Err(AppError::new("not_found_page", "Deze pagina bestaat niet (fout 404). Controleer het adres.").with_detail(detail));
        }
        if words < SUSPECT_WORDS && (status == 401 || status == 403 || status == 429 || status == 451 || status == 503) {
            return Err(AppError::new("blocked", format!("De site weigert het ophalen (fout {status}). Er is niets opgeslagen. Kopieer de tekst uit je browser en plak die hier.")).with_detail(detail));
        }
    }
    if words < EMPTY_WORDS {
        return Err(AppError::new("empty", "Op deze pagina is geen leesbare tekst gevonden. Er is niets opgeslagen. Kopieer de tekst uit je browser en plak die hier.").with_detail(detail));
    }
    let mut warnings = vec![];
    if words < SUSPECT_WORDS {
        warnings.push(format!("Er zijn maar {words} woorden gevonden. Het stuk is misschien onvolledig, bijvoorbeeld door een betaalmuur."));
    }
    Ok(warnings)
}

fn to_blocks(page: &RenderedPage) -> Vec<Block> {
    page.blocks
        .iter()
        .enumerate()
        .map(|(i, b)| Block { n: i as u32 + 1, kind: b.kind.clone(), level: b.level, text: b.text.clone(), page: None, bbox: None })
        .collect()
}

// ---------- website of pdf-link ----------

enum Preflight {
    Pdf { bytes: Vec<u8>, name: String },
    Page { status: Option<u16> },
}

fn client(user_agent: &str) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(AppError::storage)
}

/// Kijkt of het adres een pdf is, en vangt onbereikbare sites meteen af.
/// Andere fouten zijn niet beslissend: sommige sites weigeren dit verzoek en laten de webview wel door.
async fn preflight(url: &Url, user_agent: &str) -> Result<Preflight, AppError> {
    let resp = match client(user_agent)?.get(url.clone()).send().await {
        Ok(r) => r,
        Err(e) => {
            let mut chain = format!("{e}");
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                chain.push_str(&format!(": {s}"));
                src = s.source();
            }
            let low = chain.to_lowercase();
            if low.contains("dns error") || low.contains("connection refused") || low.contains("unreachable") || low.contains("nodename nor servname") {
                return Err(AppError::network(chain));
            }
            return Ok(Preflight::Page { status: None });
        }
    };
    let status = resp.status().as_u16();
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let final_url = resp.url().clone();
    let looks_pdf = ct.contains("application/pdf") || (ct.contains("octet-stream") && final_url.path().to_ascii_lowercase().ends_with(".pdf"));
    if !looks_pdf || !resp.status().is_success() {
        return Ok(Preflight::Page { status: Some(status) });
    }
    let name = final_url.path_segments().and_then(|mut s| s.next_back().map(String::from)).unwrap_or_else(|| "document.pdf".into());
    let mut bytes = Vec::new();
    let mut body = resp.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| AppError::network(e.to_string()))?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_PDF {
            return Err(AppError::new("pdf", "Deze pdf is groter dan 500 MB en is niet opgeslagen."));
        }
    }
    Ok(Preflight::Pdf { bytes, name })
}

pub async fn open_url(app: &AppHandle, store: &Store, raw: &str, refresh: bool) -> Result<Source, AppError> {
    let url = parse_url(raw)?;
    if !refresh {
        if let Some(existing) = store.find_by_url(url.as_str()) {
            return Ok(existing);
        }
    }
    let engine = WebviewEngine::new(app.clone());
    match preflight(&url, engine.user_agent()).await? {
        Preflight::Pdf { bytes, name } => save_pdf(store, &bytes, &name, Some(url.as_str())),
        Preflight::Page { status } => capture_page(store, &engine, &url, status).await,
    }
}

async fn capture_page(store: &Store, engine: &impl PageEngine, url: &Url, status: Option<u16>) -> Result<Source, AppError> {
    let page = engine.render(url).await?;
    let warnings = classify(&page, status)?;
    let final_url = Url::parse(&page.final_url).unwrap_or_else(|_| url.clone());

    let id = new_id();
    let dir = store.begin(&id)?;
    let result = async {
        let assets = snapshot::build(&page.html, &final_url, &dir, engine.user_agent()).await?;
        let title = page.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| final_url.host_str().unwrap_or("Pagina").to_string());
        let mut source = base_source(id.clone(), SourceKind::Web, title);
        source.url = Some(url.to_string());
        source.final_url = Some(final_url.to_string());
        source.author = page.author.clone();
        source.site_name = page.site_name.clone();
        source.published = page.published.clone();
        source.lang = page.lang.clone();
        source.blocks = to_blocks(&page);
        source.word_count = word_count(&source.blocks);
        source.warnings = warnings;
        if assets.failed > 0 {
            source.warnings.push(format!("{} afbeeldingen of stijlbestanden konden niet worden opgeslagen.", assets.failed));
        }
        source.assets = assets;
        store.commit(&dir, &source)?;
        Ok::<_, AppError>(source)
    }
    .await;
    if result.is_err() {
        store.discard(&dir);
    }
    result
}

// ---------- pdf ----------

pub fn save_pdf(store: &Store, bytes: &[u8], name: &str, url: Option<&str>) -> Result<Source, AppError> {
    if !bytes.starts_with(b"%PDF-") && !bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-") {
        return Err(AppError::new("pdf", "Dit bestand is geen geldige pdf."));
    }
    if bytes.len() > MAX_PDF {
        return Err(AppError::new("pdf", "Deze pdf is groter dan 500 MB en is niet opgeslagen."));
    }
    let hash = hex::encode(Sha256::digest(bytes));
    if let Some(existing) = store.find_by_hash(&hash) {
        return Ok(existing);
    }
    let id = new_id();
    let dir = store.begin(&id)?;
    let title = name.strip_suffix(".pdf").or(name.strip_suffix(".PDF")).unwrap_or(name).to_string();
    let mut source = base_source(id, SourceKind::Pdf, if title.is_empty() { "Pdf".into() } else { title });
    source.url = url.map(String::from);
    source.final_url = url.map(String::from);
    source.content_hash = Some(hash);
    source.text_ready = false;
    let result = std::fs::write(dir.join("original.pdf"), bytes).map_err(AppError::storage).and_then(|_| store.commit(&dir, &source));
    if result.is_err() {
        store.discard(&dir);
    }
    result.map(|_| source)
}

/// De tekst van een pdf wordt in de interface met pdf.js gelezen en hier één keer vastgelegd.
pub fn save_pdf_text(store: &Store, id: &str, title: Option<String>, page_count: u32, mut blocks: Vec<Block>) -> Result<Source, AppError> {
    let mut source = store.get(id)?;
    if source.kind != SourceKind::Pdf {
        return Err(AppError::new("pdf", "Deze bron is geen pdf."));
    }
    if source.text_ready {
        return Ok(source);
    }
    for (i, b) in blocks.iter_mut().enumerate() {
        b.n = i as u32 + 1;
    }
    if let Some(t) = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        source.title = t;
    }
    source.page_count = Some(page_count);
    source.word_count = word_count(&blocks);
    source.blocks = blocks;
    source.text_ready = true;
    if source.word_count == 0 {
        source.warnings.push("Deze pdf heeft geen tekstlaag (waarschijnlijk een scan). De pagina's zijn te lezen, maar tekst selecteren werkt hier niet.".into());
    }
    store.update(&source)?;
    Ok(source)
}

// ---------- geplakte tekst ----------

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn split_paragraphs(text: &str) -> Vec<String> {
    let text = text.replace("\r\n", "\n");
    let has_blank = text.split('\n').collect::<Vec<_>>().windows(2).any(|w| w[0].trim().is_empty() && !w[1].trim().is_empty());
    let parts: Vec<String> = if has_blank {
        let mut out = vec![];
        let mut cur = String::new();
        for line in text.split('\n') {
            if line.trim().is_empty() {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            } else {
                if !cur.is_empty() {
                    cur.push(' ');
                }
                cur.push_str(line.trim());
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
        out
    } else {
        text.split('\n').map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
    };
    parts.into_iter().map(|p| p.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|p| !p.is_empty()).collect()
}

pub fn import_text(store: &Store, title: Option<String>, url: Option<String>, text: &str) -> Result<Source, AppError> {
    let paragraphs = split_paragraphs(text);
    if paragraphs.is_empty() {
        return Err(AppError::new("empty_text", "Er is geen tekst geplakt."));
    }
    let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| {
        let first = &paragraphs[0];
        if first.chars().count() <= 90 { first.clone() } else { format!("{}…", first.chars().take(90).collect::<String>()) }
    });
    let blocks: Vec<Block> = paragraphs
        .into_iter()
        .enumerate()
        .map(|(i, text)| Block { n: i as u32 + 1, kind: "paragraph".into(), level: None, text, page: None, bbox: None })
        .collect();

    let mut body = format!("<h1>{}</h1>", escape(&title));
    for b in &blocks {
        body.push_str(&format!("<p data-dd-n=\"{}\">{}</p>", b.n, escape(&b.text)));
    }
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{}\"><title>{}</title>\
<style>body{{max-width:38em;margin:3em auto;padding:0 1.5em;font:18px/1.6 Georgia,'Iowan Old Style',serif;color:#2b2620;background:#fff}}h1{{font-size:1.5em;line-height:1.25}}</style></head><body>{body}</body></html>",
        snapshot::CSP,
        escape(&title)
    );

    let id = new_id();
    let dir = store.begin(&id)?;
    let mut source = base_source(id, SourceKind::Text, title);
    source.url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    source.word_count = word_count(&blocks);
    source.blocks = blocks;
    let result = std::fs::write(dir.join("index.html"), html).map_err(AppError::storage).and_then(|_| store.commit(&dir, &source));
    if result.is_err() {
        store.discard(&dir);
    }
    result.map(|_| source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::RawBlock;

    fn page(title: &str, text: &str, words: usize, url: &str) -> RenderedPage {
        let filler = vec!["woord"; words].join(" ");
        RenderedPage {
            html: String::new(),
            final_url: url.into(),
            title: None,
            document_title: Some(title.into()),
            author: None,
            site_name: None,
            published: None,
            lang: None,
            blocks: vec![RawBlock { kind: "paragraph".into(), level: None, text: format!("{text} {filler}") }],
        }
    }

    #[test]
    fn robot_check_is_blocked() {
        let err = classify(&page("Just a moment...", "Verify you are human", 10, "https://a.nl/"), Some(403)).unwrap_err();
        assert_eq!(err.kind, "blocked");
    }

    #[test]
    fn long_article_about_captchas_is_fine() {
        assert!(classify(&page("Waarom captcha's falen", "captcha", 800, "https://a.nl/"), Some(200)).unwrap().is_empty());
    }

    #[test]
    fn cookie_wall_is_recognised() {
        let err = classify(&page("Privacy", "Wij gebruiken cookies", 20, "https://myprivacy.example.nl/consent"), Some(200)).unwrap_err();
        assert_eq!(err.kind, "consent");
    }

    #[test]
    fn little_text_is_a_warning_and_nothing_is_an_error() {
        assert_eq!(classify(&page("Stuk", "Begin", 100, "https://a.nl/"), Some(200)).unwrap().len(), 1);
        assert_eq!(classify(&page("Stuk", "", 3, "https://a.nl/"), Some(200)).unwrap_err().kind, "empty");
    }

    #[test]
    fn http_error_with_little_text_is_an_error() {
        assert_eq!(classify(&page("Oeps", "Niet gevonden", 40, "https://a.nl/x"), Some(404)).unwrap_err().kind, "not_found_page");
        assert_eq!(classify(&page("Oeps", "Geen toegang", 40, "https://a.nl/x"), Some(403)).unwrap_err().kind, "blocked");
        assert!(classify(&page("Stuk", "lang", 900, "https://a.nl/x"), Some(403)).unwrap().is_empty());
    }

    #[test]
    fn urls_are_checked() {
        assert_eq!(parse_url("nrc.nl/stuk").unwrap().as_str(), "https://nrc.nl/stuk");
        for bad in ["", "file:///etc/passwd", "javascript:alert(1)", "twee woorden", "http://"] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn paragraphs_split_on_blank_lines_or_lines() {
        assert_eq!(split_paragraphs("Een\nregel\n\nTwee\r\n\r\n\r\nDrie"), vec!["Een regel", "Twee", "Drie"]);
        assert_eq!(split_paragraphs("Een\nTwee\n"), vec!["Een", "Twee"]);
        assert!(split_paragraphs(" \n ").is_empty());
    }
}
