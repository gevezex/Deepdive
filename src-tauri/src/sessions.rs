//! Inloggen op sites. Elke site krijgt een eigen WebKit-opslag, die alleen door die site wordt gebruikt:
//! het zichtbare inlogvenster en het verborgen ophalen van pagina's op dezelfde site.
//!
//! - De app ziet geen wachtwoorden: in het inlogvenster draait geen script van de app.
//! - Cookies staan alleen in de opslag van de webview. Ze worden voor het ophalen van bestanden
//!   kort in het geheugen gelezen en nooit naar schijf geschreven.
//! - Een pagina van een andere site draait nooit in deze opslag, en kan de sessie dus niet gebruiken.
//! - Uitloggen verwijdert de hele opslag, ook van inlogdiensten op een ander domein.

use crate::engine::webview;
use crate::error::AppError;
use crate::import::parse_url;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::{Host, Url};

const FILE: &str = "site-sessions.json";
const WIPE_ATTEMPTS: u32 = 20;

/// De site waar een sessie bij hoort: het domein dat een browser als één site ziet (nrc.nl, bbc.co.uk).
pub fn site_key(url: &Url) -> Option<String> {
    match url.host()? {
        Host::Domain(d) => {
            let d = d.to_ascii_lowercase();
            Some(psl::domain_str(&d).unwrap_or(&d).to_string())
        }
        other => Some(other.to_string()),
    }
}

/// Een cookie uit de opslag van de webview. De waarde verschijnt nooit in logs.
#[derive(Clone)]
pub struct SessionCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
}

impl std::fmt::Debug for SessionCookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SessionCookie({} op {})", self.name, self.domain)
    }
}

fn domain_matches(host: &str, domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    !domain.is_empty() && (host == domain || host.strip_suffix(&domain).is_some_and(|rest| rest.ends_with('.')))
}

fn path_matches(path: &str, cookie_path: &str) -> bool {
    let cookie_path = if cookie_path.is_empty() { "/" } else { cookie_path };
    path == cookie_path || (path.starts_with(cookie_path) && (cookie_path.ends_with('/') || path[cookie_path.len()..].starts_with('/')))
}

/// De Cookie-kop voor dit adres, volgens de regels die een browser ook toepast.
pub fn cookie_header(cookies: &[SessionCookie], url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let parts: Vec<String> = cookies
        .iter()
        .filter(|c| domain_matches(&host, &c.domain) && path_matches(url.path(), &c.path) && (!c.secure || url.scheme() == "https"))
        .map(|c| format!("{}={}", c.name, c.value))
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    site: String,
    /// Willekeurig per inlogronde, dus na uitloggen nooit opnieuw gebruikt.
    store_id: String,
    created_at: String,
    last_used_at: Option<String>,
    /// De opslag was nog in gebruik toen die gewist moest worden. Wordt nooit meer gebruikt en bij de volgende start gewist.
    wipe_pending: bool,
}

/// Wat de interface te zien krijgt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub site: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub wipe_pending: bool,
    pub login_open: bool,
}

/// De opslag waarmee een pagina wordt opgehaald.
#[derive(Debug, Clone)]
pub struct ActiveSession {
    pub site: String,
    pub store: [u8; 16],
}

pub struct SiteSessions {
    path: PathBuf,
    entries: Mutex<Vec<Entry>>,
    busy: Arc<Mutex<HashMap<String, u32>>>,
}

/// Zolang dit bestaat, gebruikt een verborgen venster de opslag van deze site.
pub struct BusyGuard {
    site: String,
    busy: Arc<Mutex<HashMap<String, u32>>>,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let mut busy = self.busy.lock().unwrap();
        if let Some(n) = busy.get_mut(&self.site) {
            *n -= 1;
            if *n == 0 {
                busy.remove(&self.site);
            }
        }
    }
}

fn store_bytes(id: &str) -> Option<[u8; 16]> {
    hex::decode(id).ok()?.try_into().ok()
}

fn now() -> String {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

fn login_label(store_id: &str) -> String {
    format!("login-{store_id}")
}

/// Eigen opslagen bestaan pas vanaf macOS 14. Daarvoor zou WebKit stilzwijgend de gedeelde opslag gebruiken.
#[cfg(target_os = "macos")]
fn check_platform() -> Result<(), AppError> {
    let out = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().map_err(|e| AppError::engine(e.to_string()))?;
    let major: u32 = String::from_utf8_lossy(&out.stdout).trim().split('.').next().and_then(|v| v.parse().ok()).unwrap_or(0);
    if major >= 14 {
        Ok(())
    } else {
        Err(AppError::new("login_unsupported", "Inloggen op sites vraagt om macOS 14 of nieuwer."))
    }
}

#[cfg(not(target_os = "macos"))]
fn check_platform() -> Result<(), AppError> {
    Err(AppError::new("login_unsupported", "Inloggen op sites werkt nog alleen op macOS."))
}

impl SiteSessions {
    pub fn open(root: PathBuf) -> Self {
        let path = root.join(FILE);
        let entries = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, entries: Mutex::new(entries), busy: Arc::default() }
    }

    fn save(&self, entries: &[Entry]) -> Result<(), AppError> {
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(entries).map_err(AppError::storage)?).map_err(AppError::storage)?;
        std::fs::rename(tmp, &self.path).map_err(AppError::storage)
    }

    /// De bewaarde sessie voor dit adres, als die er is.
    pub fn active(&self, url: &Url) -> Option<ActiveSession> {
        let site = site_key(url)?;
        let entries = self.entries.lock().unwrap();
        let entry = entries.iter().find(|e| e.site == site && !e.wipe_pending)?;
        Some(ActiveSession { site, store: store_bytes(&entry.store_id)? })
    }

    pub fn begin_use(&self, site: &str) -> BusyGuard {
        *self.busy.lock().unwrap().entry(site.to_string()).or_insert(0) += 1;
        BusyGuard { site: site.to_string(), busy: self.busy.clone() }
    }

    pub fn touch(&self, site: &str) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(e) = entries.iter_mut().find(|e| e.site == site) {
            e.last_used_at = Some(now());
        }
        let _ = self.save(&entries);
    }

    fn entry_for_login(&self, site: &str) -> Result<Entry, AppError> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(e) = entries.iter().find(|e| e.site == site) {
            if e.wipe_pending {
                return Err(AppError::new("session_busy", "De vorige sessie van deze site wordt nog gewist. Start de app opnieuw en probeer het dan nog eens."));
            }
            return Ok(e.clone());
        }
        let entry = Entry { site: site.to_string(), store_id: uuid::Uuid::new_v4().simple().to_string(), created_at: now(), last_used_at: None, wipe_pending: false };
        entries.push(entry.clone());
        self.save(&entries)?;
        Ok(entry)
    }

    fn view(&self, app: &AppHandle) -> Vec<SessionView> {
        let entries = self.entries.lock().unwrap();
        let mut out: Vec<SessionView> = entries
            .iter()
            .map(|e| SessionView {
                site: e.site.clone(),
                created_at: e.created_at.clone(),
                last_used_at: e.last_used_at.clone(),
                wipe_pending: e.wipe_pending,
                login_open: app.get_webview_window(&login_label(&e.store_id)).is_some(),
            })
            .collect();
        out.sort_by(|a, b| a.site.cmp(&b.site));
        out
    }

    fn take_for_wipe(&self, site: &str) -> Result<Option<String>, AppError> {
        if self.busy.lock().unwrap().contains_key(site) {
            return Err(AppError::new("session_busy", "Er wordt nu een pagina van deze site opgehaald. Probeer het zo nog eens."));
        }
        let mut entries = self.entries.lock().unwrap();
        let Some(e) = entries.iter_mut().find(|e| e.site == site) else { return Ok(None) };
        e.wipe_pending = true;
        let id = e.store_id.clone();
        self.save(&entries)?;
        Ok(Some(id))
    }

    fn forget(&self, site: &str) -> Result<(), AppError> {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|e| e.site != site);
        self.save(&entries)
    }

    fn pending(&self) -> Vec<(String, String)> {
        self.entries.lock().unwrap().iter().filter(|e| e.wipe_pending).map(|e| (e.site.clone(), e.store_id.clone())).collect()
    }
}

/// Verwijdert de hele opslag. WebKit weigert zolang een net gesloten venster nog niet is opgeruimd.
#[cfg(target_os = "macos")]
async fn remove_store(app: &AppHandle, id: &str) -> Result<(), AppError> {
    let bytes = store_bytes(id).ok_or_else(|| AppError::storage("ongeldige opslag"))?;
    let mut last = String::new();
    for _ in 0..WIPE_ATTEMPTS {
        match app.remove_data_store(bytes).await {
            Ok(()) => {
                let left = app.fetch_data_store_identifiers().await.map_err(AppError::storage)?;
                if !left.contains(&bytes) {
                    return Ok(());
                }
                last = "de opslag bestaat nog".into();
            }
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(AppError::new("session_busy", "De sessie kon nog niet worden gewist. Dat gebeurt automatisch bij de volgende start; tot die tijd gebruikt de app haar niet meer.").with_detail(last))
}

#[cfg(not(target_os = "macos"))]
async fn remove_store(_app: &AppHandle, _id: &str) -> Result<(), AppError> {
    let _ = (WIPE_ATTEMPTS, Duration::from_millis(0));
    Ok(())
}

async fn wipe(app: &AppHandle, site: &str) -> Result<(), AppError> {
    let sessions = app.state::<SiteSessions>();
    let Some(id) = sessions.take_for_wipe(site)? else { return Ok(()) };
    if let Some(window) = app.get_webview_window(&login_label(&id)) {
        let _ = window.destroy();
    }
    remove_store(app, &id).await?;
    sessions.forget(site)
}

/// Maakt af wat bij de vorige keer niet lukte.
pub fn finish_pending_wipes(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let pending = app.state::<SiteSessions>().pending();
        for (site, id) in pending {
            if remove_store(&app, &id).await.is_ok() {
                let _ = app.state::<SiteSessions>().forget(&site);
            }
        }
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginClosed {
    site: String,
    has_session: bool,
}

/// Het venster is dicht. Zonder één cookie is er niets om te onthouden: dan verdwijnt de site weer uit de lijst.
async fn login_closed(app: AppHandle, site: String, store_id: String) {
    // Gesloten omdat de sessie wordt gewist: de opslag niet opnieuw aanraken, dat zou haar weer aanmaken.
    let still_active = app.state::<SiteSessions>().entries.lock().unwrap().iter().any(|e| e.store_id == store_id && !e.wipe_pending);
    if !still_active {
        let _ = app.emit_to(EventTarget::webview_window("main"), "site-login-closed", LoginClosed { site, has_session: false });
        return;
    }
    let cookies = match store_bytes(&store_id) {
        Some(store) => webview::read_cookies(&app, store).await.map(|c| c.len()).unwrap_or(1),
        None => 0,
    };
    let has_session = cookies > 0;
    if !has_session {
        let _ = wipe(&app, &site).await;
    }
    let _ = app.emit_to(EventTarget::webview_window("main"), "site-login-closed", LoginClosed { site, has_session });
}

fn title_for(site: &str, url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    let secure = if url.scheme() == "https" { "" } else { " (niet beveiligd)" };
    format!("Inloggen bij {site} – je bent nu op {host}{secure}")
}

/// Opent de site in een zichtbaar venster. De gebruiker logt daar zelf in; de app kijkt niet mee.
#[tauri::command]
pub async fn site_login_open(app: AppHandle, sessions: State<'_, SiteSessions>, url: String) -> Result<SessionView, AppError> {
    let url = parse_url(&url)?;
    check_platform()?;
    let site = site_key(&url).ok_or_else(AppError::invalid_url)?;
    let entry = sessions.entry_for_login(&site)?;
    let label = login_label(&entry.store_id);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_focus();
    } else {
        let store = store_bytes(&entry.store_id).ok_or_else(|| AppError::storage("ongeldige opslag"))?;
        let handle = app.clone();
        let popup_label = label.clone();
        let title_site = site.clone();
        let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.clone()))
            .title(title_for(&site, &url))
            .inner_size(1040.0, 820.0)
            .user_agent(webview::USER_AGENT)
            // Geen initialisatiescript en geen eval: de app leest niets uit dit venster.
            .on_navigation(|u| matches!(u.scheme(), "http" | "https" | "about" | "blob"))
            // Inloggen via een pop-up blijft zo in dit venster, en dus in deze opslag.
            .on_new_window(move |target, _| {
                if matches!(target.scheme(), "http" | "https") {
                    if let Some(w) = handle.get_webview_window(&popup_label) {
                        let _ = w.navigate(target);
                    }
                }
                NewWindowResponse::Deny
            })
            .on_download(|_, _| false)
            .on_page_load(move |w, payload| {
                let _ = w.set_title(&title_for(&title_site, payload.url()));
            });
        #[cfg(target_os = "macos")]
        let builder = builder.data_store_identifier(store);
        #[cfg(not(target_os = "macos"))]
        let _ = store;
        let window = builder.build().map_err(|e| AppError::engine(e.to_string()))?;

        let (closed_app, closed_site, closed_id) = (app.clone(), site.clone(), entry.store_id.clone());
        let done = std::sync::atomic::AtomicBool::new(false);
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) && !done.swap(true, std::sync::atomic::Ordering::SeqCst) {
                tauri::async_runtime::spawn(login_closed(closed_app.clone(), closed_site.clone(), closed_id.clone()));
            }
        });
    }
    sessions.view(&app).into_iter().find(|s| s.site == site).ok_or_else(|| AppError::storage("sessie verdwenen"))
}

/// Sluit het inlogvenster, bijvoorbeeld als de gebruiker op "Opnieuw ophalen" drukt.
#[tauri::command]
pub async fn site_login_close(app: AppHandle, sessions: State<'_, SiteSessions>, site: String) -> Result<(), AppError> {
    let id = sessions.entries.lock().unwrap().iter().find(|e| e.site == site).map(|e| e.store_id.clone());
    if let Some(window) = id.and_then(|id| app.get_webview_window(&login_label(&id))) {
        let _ = window.destroy();
    }
    Ok(())
}

#[tauri::command]
pub async fn list_site_sessions(app: AppHandle, sessions: State<'_, SiteSessions>) -> Result<Vec<SessionView>, AppError> {
    Ok(sessions.view(&app))
}

/// Wist alles wat de app van deze site bewaart aan sessie. Opgeslagen kopieën blijven staan.
#[tauri::command]
pub async fn wipe_site_session(app: AppHandle, site: String) -> Result<(), AppError> {
    wipe(&app, &site).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, domain: &str, path: &str, secure: bool) -> SessionCookie {
        SessionCookie { name: name.into(), value: "w".into(), domain: domain.into(), path: path.into(), secure }
    }

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn site_is_the_registrable_domain() {
        assert_eq!(site_key(&u("https://www.nrc.nl/a")).unwrap(), "nrc.nl");
        assert_eq!(site_key(&u("https://news.bbc.co.uk/")).unwrap(), "bbc.co.uk");
        assert_eq!(site_key(&u("http://127.0.0.1:8080/")).unwrap(), "127.0.0.1");
        assert_eq!(site_key(&u("http://localhost:8080/")).unwrap(), "localhost");
    }

    #[test]
    fn cookies_only_go_where_a_browser_would_send_them() {
        let jar = [cookie("a", ".nrc.nl", "/", false), cookie("b", "id.nrc.nl", "/", false), cookie("c", "nrc.nl", "/plus", false), cookie("d", "nrc.nl", "/", true)];
        assert_eq!(cookie_header(&jar, &u("https://www.nrc.nl/x")).unwrap(), "a=w; d=w");
        assert_eq!(cookie_header(&jar, &u("http://nrc.nl/plus/x")).unwrap(), "a=w; c=w");
        assert_eq!(cookie_header(&jar, &u("http://nrc.nl/plusminus")).unwrap(), "a=w");
        assert!(cookie_header(&jar, &u("https://nietnrc.nl/")).is_none());
        assert!(cookie_header(&jar, &u("https://nrc.nl.evil.example/")).is_none());
    }

    #[test]
    fn debug_output_never_shows_the_value() {
        let c = SessionCookie { name: "sessie".into(), value: "geheim".into(), domain: "a.nl".into(), path: "/".into(), secure: true };
        assert!(!format!("{c:?}").contains("geheim"));
    }
}
