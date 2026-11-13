//! Engine op basis van de systeem-webview (WebKit op macOS, WebView2 op Windows).
//! De pagina draait in een eigen verborgen venster zonder rechten op de commando's van de app.

use super::{PageEngine, PagePreview, PreviewSink, RenderedPage};
use crate::sessions::SessionCookie;
use crate::error::AppError;
use std::time::{Duration, Instant};
use tauri::{webview::NewWindowResponse, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, watch};
use url::Url;

const CAPTURE_JS: &str = include_str!("capture.js");
/// Geluid en video uit: het venster is onzichtbaar en mag niet gaan spelen.
const INIT_JS: &str = "try{HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('','NotAllowedError'))}}catch(_){}";

const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_PAYLOAD: usize = 200 * 1024 * 1024;
const MAX_PREVIEW: usize = 20 * 1024 * 1024;
/// Zo vaak wordt tijdens het laden gekeken of er al iets te tonen is.
const PREVIEW_POLL: Duration = Duration::from_millis(150);
/// Tekens zichtbare tekst voordat we iets tonen. Zo komt er geen lege schil van een site die nog wordt opgebouwd.
const PREVIEW_MIN_CHARS: usize = 500;
/// Als de pagina klaar is met laden, mag ook een kort bericht.
const PREVIEW_MIN_CHARS_LOADED: usize = 100;

#[cfg(target_os = "windows")]
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
#[cfg(not(target_os = "windows"))]
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

pub struct WebviewEngine {
    app: AppHandle,
}

impl WebviewEngine {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

/// Sluit het verborgen venster ook bij een fout of time-out.
struct CloseOnDrop(WebviewWindow);
impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}

/// Sluit het venster pas als de opslag is uitgelezen. `cookies()` wacht op de hoofdthread en mag die dus niet blokkeren.
async fn cookies_of(window: WebviewWindow) -> Result<Vec<SessionCookie>, AppError> {
    tauri::async_runtime::spawn_blocking(move || window.cookies())
        .await
        .map_err(|e| AppError::engine(e.to_string()))?
        .map(|list| {
            list.into_iter()
                .map(|c| SessionCookie {
                    name: c.name().to_string(),
                    value: c.value().to_string(),
                    domain: c.domain().unwrap_or("").to_string(),
                    path: c.path().unwrap_or("/").to_string(),
                    secure: c.secure().unwrap_or(false),
                })
                .collect()
        })
        .map_err(|e| AppError::engine(e.to_string()))
}

/// Leest de cookies van een site-opslag via een leeg verborgen venster. Er wordt geen pagina geladen.
pub async fn read_cookies(app: &AppHandle, store: [u8; 16]) -> Result<Vec<SessionCookie>, AppError> {
    let label = format!("cookies-{}", uuid::Uuid::new_v4().simple());
    let blank = Url::parse("about:blank").map_err(|e| AppError::engine(e.to_string()))?;
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank)).visible(false).focused(false);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(store);
    #[cfg(not(target_os = "macos"))]
    let _ = store;
    let window = builder.build().map_err(|e| AppError::engine(e.to_string()))?;
    let _guard = CloseOnDrop(window.clone());
    cookies_of(window).await
}

async fn eval(window: &WebviewWindow, js: String) -> Result<String, AppError> {
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    window
        .eval_with_callback(js, move |value| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(value);
            }
        })
        .map_err(|e| AppError::engine(e.to_string()))?;
    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| AppError::timeout())?
        .map_err(|_| AppError::engine("de webview gaf geen antwoord"))
}

/// Haalt een lange uitvoer in stukken op, want de webview geeft niet alles in één keer terug.
async fn read_chunks(window: &WebviewWindow, next: &str, limit: usize) -> Result<String, AppError> {
    let mut payload = String::new();
    loop {
        let chunk: String = serde_json::from_str(&eval(window, next.to_string()).await?)
            .map_err(|e| AppError::engine(format!("onleesbaar antwoord: {e}")))?;
        if chunk.is_empty() {
            return Ok(payload);
        }
        payload.push_str(&chunk);
        if payload.len() > limit {
            return Err(AppError::engine("de pagina is te groot om op te slaan"));
        }
    }
}

/// Geeft `true` als er verder geen voorvertoning meer hoeft te komen.
async fn offer_preview(window: &WebviewWindow, ns: &str, script: &str, min_chars: usize, sink: &PreviewSink) -> Result<bool, AppError> {
    let probe = format!("(function(){{var s=window['{ns}'];return s?(s.preview({min_chars})?'ready':'wait'):'absent'}})()");
    let status: String = serde_json::from_str(&eval(window, probe).await?).unwrap_or_default();
    match status.as_str() {
        "absent" => {
            window.eval(script).map_err(|e| AppError::engine(e.to_string()))?;
            Ok(false)
        }
        "ready" => {
            // Lukt het uitlezen niet, dan is er geen voorvertoning. Het vastleggen staat daar los van.
            let Ok(payload) = read_chunks(window, &format!("window['{ns}'].nextPreview()"), MAX_PREVIEW).await else { return Ok(true) };
            let Ok(page) = serde_json::from_str::<PagePreview>(&payload) else { return Ok(true) };
            Ok(sink(page))
        }
        _ => Ok(false),
    }
}

impl PageEngine for WebviewEngine {
    async fn render(&self, url: &Url, session: Option<[u8; 16]>, on_preview: Option<&PreviewSink>) -> Result<RenderedPage, AppError> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let label = format!("capture-{id}");
        let ns = format!("__dd_{id}");
        let (loaded_tx, mut loaded_rx) = watch::channel(false);

        let builder = WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::External(url.clone()))
            .title("Deepdive – vastleggen")
            .visible(false)
            .focused(false)
            .inner_size(1280.0, 900.0)
            .user_agent(USER_AGENT)
            .initialization_script(INIT_JS)
            .on_navigation(|u| matches!(u.scheme(), "http" | "https" | "about" | "data" | "blob"))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(move |_, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    let _ = loaded_tx.send(true);
                }
            });
        #[cfg(target_os = "macos")]
        let builder = match session {
            Some(store) => builder.data_store_identifier(store),
            None => builder,
        };
        let window = builder.build().map_err(|e| AppError::engine(e.to_string()))?;
        let _guard = CloseOnDrop(window.clone());
        debug_assert!(self.app.get_webview_window(&label).is_some());

        let script = CAPTURE_JS.replace("__NS__", &ns);
        let begin = format!("window['{ns}'].begin()");
        let mut preview = on_preview;
        let load_start = Instant::now();
        while let Some(sink) = preview.filter(|_| !*loaded_rx.borrow() && load_start.elapsed() < LOAD_TIMEOUT) {
            if offer_preview(&window, &ns, &script, PREVIEW_MIN_CHARS, sink).await.unwrap_or(false) {
                preview = None;
            }
            tokio::time::sleep(PREVIEW_POLL).await;
        }
        let _ = tokio::time::timeout(LOAD_TIMEOUT.saturating_sub(load_start.elapsed()), loaded_rx.wait_for(|v| *v)).await;

        let start = Instant::now();
        let probe = format!(
            "(function(){{var s=window['{ns}'];return s?(s.started?(s.done?(s.error?'error:'+s.error:'done'):'busy'):'idle'):'absent'}})()"
        );
        loop {
            if start.elapsed() > TOTAL_TIMEOUT {
                return Err(AppError::timeout());
            }
            // Bouwt een site de tekst pas na het laden op, dan kan het nog terwijl het vastleggen loopt.
            if let Some(sink) = preview {
                if offer_preview(&window, &ns, &script, PREVIEW_MIN_CHARS_LOADED, sink).await.unwrap_or(false) {
                    preview = None;
                }
            }
            let status: String = serde_json::from_str(&eval(&window, probe.clone()).await?).unwrap_or_default();
            match status.as_str() {
                "done" => break,
                // Bij een doorverwijzing is de vorige pagina weg: dan opnieuw beginnen.
                "absent" => window.eval(format!("{script};{begin}")).map_err(|e| AppError::engine(e.to_string()))?,
                "idle" => window.eval(begin.clone()).map_err(|e| AppError::engine(e.to_string()))?,
                s if s.starts_with("error:") => return Err(AppError::engine(s.to_string())),
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }

        let payload = read_chunks(&window, &format!("window['{ns}'].next()"), MAX_PAYLOAD).await?;
        let mut page: RenderedPage = serde_json::from_str(&payload).map_err(|e| AppError::engine(format!("onleesbaar antwoord: {e}")))?;
        if session.is_some() {
            // Na het laden gelezen: sites vernieuwen hun sessiecookie vaak bij elk bezoek.
            page.session_cookies = cookies_of(window.clone()).await?;
        }
        Ok(page)
    }

    fn user_agent(&self) -> &'static str {
        USER_AGENT
    }
}
