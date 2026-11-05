//! Maakt van de opgebouwde HTML een zelfstandige visuele kopie: scripts eruit, afbeeldingen,
//! CSS en fonts lokaal. Onafhankelijk van de engine en onafhankelijk van wat de pagina zelf deed.

use crate::error::AppError;
use crate::model::AssetStats;
use futures_util::{stream, StreamExt};
use lol_html::html_content::ContentType;
use lol_html::{element, rewrite_str, text, RewriteStrSettings};
use regex::{Captures, Regex};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use url::{Host, Url};

/// Afscherming van de kopie: geen scripts, geen netwerk, geen formulieren, geen frames.
pub const CSP: &str = "default-src 'none'; \
img-src deepdive-snapshot: http://deepdive-snapshot.localhost data:; \
style-src deepdive-snapshot: http://deepdive-snapshot.localhost 'unsafe-inline'; \
font-src deepdive-snapshot: http://deepdive-snapshot.localhost data:; \
form-action 'none'; base-uri 'none'; frame-src 'none'";

const MAX_ASSET: u64 = 40 * 1024 * 1024;
const MAX_TOTAL: u64 = 500 * 1024 * 1024;
const MAX_CSS_DEPTH: usize = 5;
const MAX_FAILED_LISTED: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetKind {
    Css,
    Other,
}

fn ad_host() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(doubleclick|googlesyndication|googletagmanager|adnxs|amazon-adsystem|criteo|taboola|outbrain|adsafeprotected|moatads|rubiconproject|pubmatic|facebook\.com/tr)").unwrap()
    })
}

fn is_private(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local"),
        Some(Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified(),
        Some(Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
        None => true,
    }
}

/// Alleen http(s), en een pagina van internet mag ons niet laten ophalen van het lokale netwerk.
fn resolve_asset(raw: &str, base: &Url, page_is_private: bool) -> Option<Url> {
    if raw.trim().is_empty() {
        return None;
    }
    let url = base.join(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if is_private(&url) && !page_is_private {
        return None;
    }
    Some(url)
}

fn css_url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(@import\s+)?url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|@import\s+(?:"([^"]+)"|'([^']+)')"#).unwrap()
    })
}

/// Vervangt url(...) en @import in CSS. `map` geeft de nieuwe naam, of None als het niet is opgeslagen.
fn rewrite_css(css: &str, mut map: impl FnMut(&str, AssetKind) -> Option<String>) -> String {
    css_url_re()
        .replace_all(css, |c: &Captures| {
            let quoted_import = c.get(5).or(c.get(6));
            let raw = quoted_import.or(c.get(2)).or(c.get(3)).or(c.get(4)).map_or("", |m| m.as_str());
            let is_import = quoted_import.is_some() || c.get(1).is_some();
            let lower = raw.trim().to_ascii_lowercase();
            if !is_import && (raw.trim().starts_with('#') || lower.starts_with("data:")) {
                return c[0].to_string();
            }
            let kind = if is_import { AssetKind::Css } else { AssetKind::Other };
            match (map(raw, kind), is_import) {
                (Some(new), true) => format!("@import url(\"{new}\")"),
                (Some(new), false) => format!("url(\"{new}\")"),
                // Een @import zonder doel moet met puntkomma en al geldig blijven.
                (None, true) => "@import url(\"about:invalid\")".to_string(),
                (None, false) => "url(\"about:invalid\")".to_string(),
            }
        })
        .into_owned()
}

/// lol_html geeft attributen onbewerkt terug, dus met `&amp;` en `&#106;`. Adressen moeten eerst ontleed.
fn decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|colon|tab|newline));?").unwrap());
    re.replace_all(value, |c: &Captures| {
        let code = c.get(1).and_then(|d| d.as_str().parse::<u32>().ok()).or(c.get(2).and_then(|h| u32::from_str_radix(h.as_str(), 16).ok()));
        if let Some(code) = code {
            return char::from_u32(code).unwrap_or('\u{fffd}').to_string();
        }
        match c[3].to_ascii_lowercase().as_str() {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            "apos" => "'",
            "colon" => ":",
            "tab" => "\t",
            _ => "\n",
        }
        .to_string()
    })
    .into_owned()
}

fn attr(el: &lol_html::html_content::Element<'_, '_, impl lol_html::HandlerTypes>, name: &str) -> Option<String> {
    el.get_attribute(name).map(|v| decode_entities(&v))
}

fn is_dangerous_url(value: &str) -> bool {
    let cleaned: String = value.chars().filter(|c| !c.is_whitespace() && !c.is_control()).collect();
    let lower = cleaned.to_ascii_lowercase();
    lower.starts_with("javascript:") || lower.starts_with("vbscript:") || lower.starts_with("data:text/html")
}

/// Sanitair: haalt alles eruit wat kan uitvoeren of het netwerk op kan, en verwijst bronnen om via `map`.
/// `map` krijgt het adres zoals het in de HTML staat. None betekent: niet beschikbaar.
pub fn sanitize(html: &str, page_url: &Url, map: impl FnMut(&str, AssetKind) -> Option<String>) -> Result<String, String> {
    let map = RefCell::new(map);
    let style_buf = RefCell::new(String::new());
    let head_meta = format!(
        "<meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">\
<style>[data-dd-embed]{{box-sizing:border-box;display:flex;align-items:center;justify-content:center;max-width:100%;\
padding:1em;background:#f4efe6;border:1px dashed #b9ad98;color:#5d5546;font:14px/1.4 Georgia,serif;text-align:center}}</style>"
    );
    let page_no_frag = {
        let mut u = page_url.clone();
        u.set_fragment(None);
        u
    };

    let output = rewrite_str(
        html,
        RewriteStrSettings {
            element_content_handlers: vec![
                element!("head", |el| {
                    el.prepend(&head_meta, ContentType::Html);
                    Ok(())
                }),
                element!("script, noscript, object, embed, applet, frame, frameset, base, portal, source, track", |el| {
                    el.remove();
                    Ok(())
                }),
                element!("meta", |el| {
                    if el.get_attribute("name").is_some_and(|n| n.eq_ignore_ascii_case("viewport")) {
                        el.remove_attribute("http-equiv");
                    } else {
                        el.remove();
                    }
                    Ok(())
                }),
                element!("iframe", |el| {
                    let src = attr(el, "src").unwrap_or_default();
                    let link = page_url.join(&src).ok().filter(|u| matches!(u.scheme(), "http" | "https"));
                    match link {
                        Some(u) if !ad_host().is_match(u.as_str()) => {
                            let dim = |name: &str, fallback: &str| {
                                el.get_attribute(name).filter(|v| v.chars().all(|c| c.is_ascii_digit()) && !v.is_empty()).unwrap_or_else(|| fallback.to_string())
                            };
                            let (w, h) = (dim("width", "640"), dim("height", "360"));
                            let href = u.as_str().replace('&', "&amp;").replace('"', "&quot;");
                            el.replace(
                                &format!("<div data-dd-embed style=\"width:{w}px;height:{h}px\"><a href=\"{href}\" target=\"_blank\">Ingesloten inhoud is niet bewaard in de kopie</a></div>"),
                                ContentType::Html,
                            );
                        }
                        _ => el.remove(),
                    }
                    Ok(())
                }),
                element!("link", |el| {
                    let rel = el.get_attribute("rel").unwrap_or_default().to_ascii_lowercase();
                    let href = attr(el, "href");
                    match href {
                        Some(h) if rel.split_whitespace().any(|r| r == "stylesheet") => match map.borrow_mut()(&h, AssetKind::Css) {
                            Some(new) => {
                                el.set_attribute("href", &new)?;
                                el.set_attribute("rel", "stylesheet")?;
                            }
                            None => el.remove(),
                        },
                        _ => el.remove(),
                    }
                    Ok(())
                }),
                element!("img, input[type=image i]", |el| {
                    if let Some(src) = attr(el, "src") {
                        if src.trim().to_ascii_lowercase().starts_with("data:image/") {
                            return Ok(());
                        }
                        match map.borrow_mut()(&src, AssetKind::Other) {
                            Some(new) => el.set_attribute("src", &new)?,
                            None => el.remove_attribute("src"),
                        }
                    }
                    Ok(())
                }),
                element!("video, audio", |el| {
                    el.remove_attribute("src");
                    el.remove_attribute("autoplay");
                    if let Some(p) = attr(el, "poster") {
                        match map.borrow_mut()(&p, AssetKind::Other) {
                            Some(new) => el.set_attribute("poster", &new)?,
                            None => el.remove_attribute("poster"),
                        }
                    }
                    Ok(())
                }),
                // SVG: ingesloten afbeeldingen lokaal, verwijzingen buiten het document eruit.
                element!("image, feImage", |el| {
                    for name in ["href", "xlink:href"] {
                        if let Some(v) = attr(el, name) {
                            if v.trim().to_ascii_lowercase().starts_with("data:image/") {
                                continue;
                            }
                            match map.borrow_mut()(&v, AssetKind::Other) {
                                Some(new) => el.set_attribute(name, &new)?,
                                None => el.remove_attribute(name),
                            }
                        }
                    }
                    Ok(())
                }),
                element!("use", |el| {
                    for name in ["href", "xlink:href"] {
                        if attr(el, name).is_some_and(|v| !v.trim_start().starts_with('#')) {
                            el.remove_attribute(name);
                        }
                    }
                    Ok(())
                }),
                // Koppelingen openen niets: de iframe mag geen popups en navigeert dus niet naar de live site.
                element!("a, area", |el| {
                    for name in ["href", "xlink:href"] {
                        let Some(href) = attr(el, name) else { continue };
                        if href.trim_start().starts_with('#') {
                            el.remove_attribute("target");
                            continue;
                        }
                        match page_url.join(href.trim()) {
                            Ok(abs) if matches!(abs.scheme(), "http" | "https" | "mailto") => {
                                let mut bare = abs.clone();
                                bare.set_fragment(None);
                                if bare == page_no_frag && abs.fragment().is_some() {
                                    el.set_attribute(name, &format!("#{}", abs.fragment().unwrap_or("")))?;
                                    el.remove_attribute("target");
                                } else {
                                    el.set_attribute(name, abs.as_str())?;
                                    el.set_attribute("target", "_blank")?;
                                }
                            }
                            _ => el.remove_attribute(name),
                        }
                    }
                    Ok(())
                }),
                element!("form", |el| {
                    el.remove_attribute("action");
                    el.remove_attribute("method");
                    Ok(())
                }),
                text!("style", |t| {
                    style_buf.borrow_mut().push_str(t.as_str());
                    if t.last_in_text_node() {
                        let css = std::mem::take(&mut *style_buf.borrow_mut());
                        let new = rewrite_css(&css, |raw, kind| map.borrow_mut()(raw, kind));
                        t.replace(&new, ContentType::Html);
                    } else {
                        t.remove();
                    }
                    Ok(())
                }),
                // Als laatste, en voor elk element: handlers, gevaarlijke adressen en inline stijl.
                element!("*", |el| {
                    if el.removed() {
                        return Ok(());
                    }
                    let attrs: Vec<(String, String)> = el.attributes().iter().map(|a| (a.name(), decode_entities(&a.value()))).collect();
                    for (name, value) in attrs {
                        let is_url_attr = matches!(name.as_str(), "href" | "src" | "action" | "formaction" | "xlink:href" | "data" | "poster" | "background" | "to" | "values" | "from" | "by");
                        if name.starts_with("on")
                            || matches!(name.as_str(), "srcset" | "imagesrcset" | "sizes" | "ping" | "integrity" | "crossorigin" | "nonce" | "loading" | "referrerpolicy" | "autofocus" | "formaction" | "srcdoc" | "http-equiv" | "manifest" | "background")
                            || (is_url_attr && is_dangerous_url(&value))
                        {
                            el.remove_attribute(&name);
                        } else if name == "style" && value.contains("url(") {
                            let new = rewrite_css(&value, |raw, kind| map.borrow_mut()(raw, kind));
                            el.set_attribute("style", &new)?;
                        }
                    }
                    Ok(())
                }),
            ],
            ..RewriteStrSettings::new()
        },
    )
    .map_err(|e| e.to_string());
    output
}

fn extension_for(content_type: &str, url: &Url, kind: AssetKind) -> Option<&'static str> {
    if kind == AssetKind::Css {
        return if content_type.contains("html") { None } else { Some("css") };
    }
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let by_type = match ct.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/avif" => Some("avif"),
        "image/svg+xml" => Some("svg"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        "image/bmp" => Some("bmp"),
        "font/woff2" | "application/font-woff2" | "application/x-font-woff2" => Some("woff2"),
        "font/woff" | "application/font-woff" | "application/x-font-woff" => Some("woff"),
        "font/ttf" | "application/x-font-ttf" | "application/font-ttf" | "application/x-font-truetype" => Some("ttf"),
        "font/otf" | "application/x-font-opentype" | "application/font-otf" => Some("otf"),
        "application/vnd.ms-fontobject" => Some("eot"),
        _ => None,
    };
    if by_type.is_some() {
        return by_type;
    }
    if ct.contains("html") || ct.contains("json") || ct.contains("javascript") {
        return None;
    }
    let path = url.path().to_ascii_lowercase();
    ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico", "woff2", "woff", "ttf", "otf", "eot"]
        .into_iter()
        .find(|e| path.ends_with(&format!(".{e}")))
}

struct Fetched {
    url: Url,
    kind: AssetKind,
    name: String,
    bytes: Vec<u8>,
}

async fn fetch_asset(client: &reqwest::Client, url: Url, kind: AssetKind, referer: &str) -> Result<Fetched, Url> {
    let accept = if kind == AssetKind::Css { "text/css,*/*;q=0.1" } else { "image/avif,image/webp,image/*,font/*,*/*;q=0.8" };
    let fail = |u: &Url| u.clone();
    let resp = client.get(url.clone()).header("Referer", referer).header("Accept", accept).send().await.map_err(|_| fail(&url))?;
    if !resp.status().is_success() || resp.content_length().is_some_and(|l| l > MAX_ASSET) {
        return Err(url);
    }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let Some(ext) = extension_for(&ct, &url, kind) else { return Err(url) };
    let mut body = Vec::new();
    let mut chunks = resp.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| fail(&url))?;
        body.extend_from_slice(&chunk);
        if body.len() as u64 > MAX_ASSET {
            return Err(url);
        }
    }
    let hash = hex::encode(Sha256::digest(url.as_str().as_bytes()));
    Ok(Fetched { name: format!("{}.{ext}", &hash[..24]), url, kind, bytes: body })
}

/// Legt de pagina vast in `dir`: `index.html` en de map `assets`. Wat niet lukt, wordt geteld in de statistiek.
pub async fn build(html: &str, page_url: &Url, dir: &Path, user_agent: &str) -> Result<AssetStats, AppError> {
    let page_is_private = is_private(page_url);
    let client = reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 5 || (is_private(attempt.url()) && !page_is_private) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(AppError::storage)?;

    let assets_dir = dir.join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(AppError::storage)?;

    // Eerste ronde: alleen verzamelen wat er nodig is.
    let mut pending: Vec<(Url, AssetKind)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    sanitize(html, page_url, |raw, kind| {
        if let Some(u) = resolve_asset(raw, page_url, page_is_private) {
            if seen.insert(u.to_string()) {
                pending.push((u, kind));
            }
        }
        None
    })
    .map_err(|e| AppError::engine(format!("HTML niet te verwerken: {e}")))?;

    let referer = page_url.as_str().to_string();
    let mut names: HashMap<String, String> = HashMap::new();
    let mut sheets: Vec<(Url, String, String)> = Vec::new();
    let mut stats = AssetStats::default();

    for _ in 0..=MAX_CSS_DEPTH {
        if pending.is_empty() {
            break;
        }
        let batch = std::mem::take(&mut pending);
        let results: Vec<_> = stream::iter(batch.into_iter().map(|(u, k)| fetch_asset(&client, u, k, &referer)))
            .buffer_unordered(8)
            .collect()
            .await;
        for result in results {
            match result {
                Ok(f) if stats.bytes + f.bytes.len() as u64 <= MAX_TOTAL => {
                    stats.saved += 1;
                    stats.bytes += f.bytes.len() as u64;
                    names.insert(f.url.to_string(), f.name.clone());
                    if f.kind == AssetKind::Css {
                        let css = String::from_utf8_lossy(&f.bytes).into_owned();
                        rewrite_css(&css, |raw, kind| {
                            if let Some(u) = resolve_asset(raw, &f.url, page_is_private) {
                                if seen.insert(u.to_string()) {
                                    pending.push((u, kind));
                                }
                            }
                            None
                        });
                        sheets.push((f.url, f.name, css));
                    } else {
                        std::fs::write(assets_dir.join(&f.name), &f.bytes).map_err(AppError::storage)?;
                    }
                }
                Ok(f) => note_failure(&mut stats, f.url),
                Err(u) => note_failure(&mut stats, u),
            }
        }
    }

    // Tweede ronde: alles verwijst nu naar de lokale bestanden.
    for (url, name, css) in &sheets {
        let new = rewrite_css(css, |raw, _| {
            let u = resolve_asset(raw, url, page_is_private)?;
            names.get(u.as_str()).cloned()
        });
        std::fs::write(assets_dir.join(name), new).map_err(AppError::storage)?;
    }
    let out = sanitize(html, page_url, |raw, _| {
        let u = resolve_asset(raw, page_url, page_is_private)?;
        names.get(u.as_str()).map(|n| format!("assets/{n}"))
    })
    .map_err(|e| AppError::engine(format!("HTML niet te verwerken: {e}")))?;
    std::fs::write(dir.join("index.html"), out).map_err(AppError::storage)?;
    Ok(stats)
}

fn note_failure(stats: &mut AssetStats, url: Url) {
    stats.failed += 1;
    if stats.failed_urls.len() < MAX_FAILED_LISTED {
        stats.failed_urls.push(url.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(html: &str) -> String {
        let page = Url::parse("https://example.com/a/b.html").unwrap();
        sanitize(html, &page, |raw, _| Some(format!("assets/{}", raw.rsplit('/').next().unwrap()))).unwrap()
    }

    #[test]
    fn scripts_and_handlers_are_removed() {
        let out = clean(r#"<html><head><script>evil()</script><meta http-equiv="refresh" content="0;url=https://x"></head><body onload="evil()"><svg><script>evil()</script></svg><img src="x.png" onerror="evil()"><a href="javascript:evil()">a</a><noscript><img src="y.png"></noscript><object data="x"></object></body></html>"#);
        assert!(!out.contains("evil"), "{out}");
        assert!(!out.contains("refresh"), "{out}");
        assert!(!out.contains("<noscript"), "{out}");
        assert!(!out.contains("<object"), "{out}");
    }

    #[test]
    fn obfuscated_javascript_url_is_removed() {
        let out = clean("<a href=\"java\tscript:evil()\">a</a><form action=\"JaVaScRiPt:evil()\"><button formaction=\"javascript:evil()\">b</button></form>");
        assert!(!out.contains("evil"), "{out}");
    }

    #[test]
    fn entities_are_decoded_before_judging_urls() {
        let out = clean("<a href=\"&#106;avascript:evil()\">a</a><a href=\"java&#x09;script&colon;evil()\">b</a>");
        assert!(!out.contains("evil"), "{out}");
        let page = Url::parse("https://example.com/").unwrap();
        let mut seen = vec![];
        sanitize(r#"<img src="https://e.com/a.jpg?w=1&amp;h=2"><div style="background:url(&quot;https://e.com/b.jpg?x=1&amp;y=2&quot;)"></div>"#, &page, |raw, _| {
            seen.push(raw.to_string());
            None
        })
        .unwrap();
        assert_eq!(seen, ["https://e.com/a.jpg?w=1&h=2", "https://e.com/b.jpg?x=1&y=2"]);
    }

    #[test]
    fn head_gets_csp_and_assets_are_rewritten() {
        let out = clean(r#"<html><head><link rel="stylesheet" href="s.css" integrity="sha256-x" crossorigin></head><body><img src="p.png" srcset="q.png 2x" loading="lazy"><div style="background:url(bg.jpg)"></div></body></html>"#);
        assert!(out.contains("Content-Security-Policy"));
        assert!(out.contains(r#"href="assets/s.css""#), "{out}");
        assert!(out.contains(r#"src="assets/p.png""#), "{out}");
        assert!(out.contains("assets/bg.jpg"), "{out}");
        for gone in ["integrity", "crossorigin", "srcset", "loading"] {
            assert!(!out.contains(gone), "{gone} in {out}");
        }
    }

    #[test]
    fn links_cannot_navigate_the_frame() {
        let out = clean(r##"<body><a href="/elders">x</a><a href="#kop">y</a><a href="https://example.com/a/b.html#kop2">z</a></body>"##);
        assert!(out.contains(r#"href="https://example.com/elders""#), "{out}");
        assert!(out.contains(r#"target="_blank""#), "{out}");
        assert!(out.contains(r##"href="#kop""##), "{out}");
        assert!(out.contains(r##"href="#kop2""##), "{out}");
    }

    #[test]
    fn iframes_become_placeholder_and_ads_disappear() {
        let out = clean(r#"<body><iframe src="https://video.example/1" width="300" height="200"></iframe><iframe src="https://ad.doubleclick.net/x"></iframe></body>"#);
        assert!(!out.contains("<iframe"), "{out}");
        assert!(out.contains("data-dd-embed"), "{out}");
        assert!(out.contains("width:300px"), "{out}");
        assert!(!out.contains("doubleclick"), "{out}");
    }

    #[test]
    fn style_element_with_closing_tag_cannot_break_out() {
        let out = clean("<head><style>a{color:red}</style><script>evil()</script></head>");
        assert!(!out.contains("evil"), "{out}");
    }

    #[test]
    fn css_urls_are_rewritten() {
        let css = r#"@import "a.css"; @import url(b.css); x{background:url('c.png')} y{filter:url(#f)} z{src:url(data:font/woff2;base64,AA)}"#;
        let out = rewrite_css(css, |raw, kind| {
            assert_eq!(kind == AssetKind::Css, raw.ends_with(".css"));
            Some(format!("L{raw}"))
        });
        assert!(out.contains(r#"@import url("La.css")"#), "{out}");
        assert!(out.contains(r#"@import url("Lb.css")"#), "{out}");
        assert!(out.contains(r#"url("Lc.png")"#), "{out}");
        assert!(out.contains("url(#f)"), "{out}");
        assert!(out.contains("url(data:font/woff2;base64,AA)"), "{out}");
    }

    #[test]
    fn internet_page_cannot_reach_local_network_or_files() {
        let page = Url::parse("https://example.com/").unwrap();
        assert!(resolve_asset("http://192.168.1.1/x.png", &page, false).is_none());
        assert!(resolve_asset("http://localhost:8080/x.png", &page, false).is_none());
        assert!(resolve_asset("file:///etc/passwd", &page, false).is_none());
        assert!(resolve_asset("/x.png", &page, false).is_some());
    }
}
