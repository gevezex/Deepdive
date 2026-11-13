//! De voorvertoning: de pagina alvast tonen terwijl de vaste kopie nog wordt gemaakt. Staat alleen in het geheugen.

use crate::engine::PagePreview;
use crate::import;
use crate::snapshot;
use crate::store::{is_valid_id, new_id};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use url::Url;

/// Meer tegelijk kan de lezer niet net hebben geopend. Oudere verdwijnen vanzelf.
const KEEP: usize = 4;

#[derive(Default)]
pub struct Previews(Mutex<VecDeque<(String, Vec<u8>)>>);

impl Previews {
    fn put(&self, id: String, html: Vec<u8>) {
        let mut list = self.0.lock().unwrap();
        list.push_back((id, html));
        while list.len() > KEEP {
            list.pop_front();
        }
    }

    /// De HTML bij een adres als `/preview/<id>/index.html`.
    pub fn file(&self, path: &str) -> Option<Vec<u8>> {
        let id = preview_id(path)?;
        self.0.lock().unwrap().iter().find(|(known, _)| known == id).map(|(_, html)| html.clone())
    }
}

fn preview_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/preview/")?.strip_suffix("/index.html")?;
    is_valid_id(id).then_some(id)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewReady {
    request: String,
    id: String,
    title: String,
}

/// Schoont de eerste versie op en meldt de interface dat die klaarstaat. `false` als er nog niets te tonen is.
pub fn publish(app: &AppHandle, request: &str, page: PagePreview) -> bool {
    let Ok(url) = Url::parse(&page.final_url) else { return false };
    let host = url.host_str().unwrap_or("").to_string();
    let text = format!("{} {}", page.document_title.as_deref().unwrap_or(""), page.sample).to_lowercase();
    if import::is_wall(&text, &host, page.words) {
        return false;
    }
    let Ok(html) = snapshot::preview_html(&page.html, &url) else { return false };
    // Zonder scripts is een laag niet weg te klikken, en bij het vastleggen is die nog niet weggehaald.
    let html = snapshot::hide_floating(html.into_bytes(), None);
    let id = new_id();
    app.state::<Previews>().put(id.clone(), html);
    let title = page.title.filter(|t| !t.is_empty()).unwrap_or(host);
    let _ = app.emit_to(EventTarget::webview_window("main"), "page-preview", PreviewReady { request: request.to_string(), id, title });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_preview_paths_with_a_real_id_are_served() {
        let id = "0123456789abcdef0123456789abcdef";
        let list = Previews::default();
        list.put(id.to_string(), b"html".to_vec());
        assert_eq!(list.file(&format!("/preview/{id}/index.html")).as_deref(), Some(&b"html"[..]));
        for bad in [format!("/{id}/index.html"), format!("/preview/{id}/assets/a.png"), "/preview/../index.html".to_string(), "/preview//index.html".to_string()] {
            assert!(list.file(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn old_previews_are_dropped() {
        let list = Previews::default();
        let ids: Vec<String> = (0..KEEP + 1).map(|_| new_id()).collect();
        for id in &ids {
            list.put(id.clone(), vec![1]);
        }
        assert!(list.file(&format!("/preview/{}/index.html", ids[0])).is_none());
        assert!(list.file(&format!("/preview/{}/index.html", ids[KEEP])).is_some());
    }

    #[test]
    fn preview_stays_shielded_and_keeps_site_files_remote() {
        let page = Url::parse("https://krant.nl/stuk").unwrap();
        let html = "<html><head><link rel=stylesheet href=/s.css><script>x()</script></head><body onload=y()><img src=/a.png><iframe src=https://krant.nl/x></iframe></body></html>";
        let out = snapshot::preview_html(html, &page).unwrap();
        assert!(out.contains("https://krant.nl/s.css") && out.contains("https://krant.nl/a.png"), "{out}");
        assert!(!out.contains("<script") && !out.contains("onload") && !out.contains("<iframe"), "{out}");
        assert!(out.contains(&format!("content=\"{}\"", snapshot::PREVIEW_CSP)), "{out}");
        assert!(!snapshot::PREVIEW_CSP.contains("script-src"));
    }

    #[test]
    fn preview_never_reaches_the_local_network() {
        let page = Url::parse("https://krant.nl/stuk").unwrap();
        let out = snapshot::preview_html("<html><head></head><body><img src=http://192.168.1.1/a.png></body></html>", &page).unwrap();
        assert!(!out.contains("192.168"), "{out}");
    }
}
