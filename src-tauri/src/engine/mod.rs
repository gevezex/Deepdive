//! Het laden van pagina's, afgebakend achter één trait. Alles hierbuiten kent alleen `RenderedPage`:
//! een andere engine (bijvoorbeeld Chromium via CEF) hoeft alleen `PageEngine` te implementeren.

pub mod webview;

use crate::error::AppError;
use crate::sessions::SessionCookie;
use serde::{Deserialize, Serialize};
use url::Url;

/// De volledig opgebouwde pagina zoals de engine die teruggeeft. De inhoud is onbetrouwbaar.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPage {
    pub html: String,
    pub final_url: String,
    pub title: Option<String>,
    pub document_title: Option<String>,
    pub author: Option<String>,
    pub site_name: Option<String>,
    pub published: Option<String>,
    pub lang: Option<String>,
    pub blocks: Vec<RawBlock>,
    /// Aanwijzingen voor het oordeel over de volledigheid. Zie `completeness`.
    #[serde(default)]
    pub signals: PageSignals,
    /// Alleen bij ophalen met een sessie: de cookies uit de opslag van de webview. Blijven in het geheugen.
    #[serde(skip)]
    pub session_cookies: Vec<SessionCookie>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PageSignals {
    /// Waarden van `isAccessibleForFree` uit de gestructureerde data van de pagina.
    pub ld_free: Vec<bool>,
    /// `wordCount` uit de gestructureerde data.
    pub ld_word_count: Option<u32>,
    /// Aantal woorden in `articleBody` uit de gestructureerde data.
    pub ld_body_words: Option<u32>,
    pub content_tier: Option<String>,
    /// Korte zichtbare teksten die op een betaalmuur kunnen wijzen.
    pub gate_candidates: Vec<GateCandidate>,
    /// Zichtbare blokken met een naam als "paywall".
    pub gate_elements: Vec<String>,
    pub password_field: bool,
    pub clipped: bool,
    pub fade: bool,
    /// Alle zichtbare woorden op de pagina, ook buiten het stuk.
    pub page_words: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateCandidate {
    pub text: String,
    /// overlay (zwevend), after (na het stuk), in (in het stuk), before, chrome (menu of voettekst).
    pub place: String,
    /// Hoeveel woorden van de tekstkopie hierna nog volgen.
    pub words_after: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawBlock {
    pub kind: String,
    pub level: Option<u8>,
    pub text: String,
}

#[allow(async_fn_in_trait)]
pub trait PageEngine {
    /// Laadt `url`, wacht tot de pagina is opgebouwd en geeft de DOM en tekstblokken terug.
    /// Met `session` draait de pagina in de eigen opslag van die site, anders in de gedeelde.
    async fn render(&self, url: &Url, session: Option<[u8; 16]>) -> Result<RenderedPage, AppError>;
    /// De user-agent die ook voor het ophalen van afbeeldingen en CSS wordt gebruikt.
    fn user_agent(&self) -> &'static str;
}
