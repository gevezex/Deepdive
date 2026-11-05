//! Het laden van pagina's, afgebakend achter één trait. Alles hierbuiten kent alleen `RenderedPage`:
//! een andere engine (bijvoorbeeld Chromium via CEF) hoeft alleen `PageEngine` te implementeren.

pub mod webview;

use crate::error::AppError;
use serde::Deserialize;
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
    async fn render(&self, url: &Url) -> Result<RenderedPage, AppError>;
    /// De user-agent die ook voor het ophalen van afbeeldingen en CSS wordt gebruikt.
    fn user_agent(&self) -> &'static str;
}
