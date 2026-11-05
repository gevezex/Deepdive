use serde::Serialize;

/// Fout die de interface kan tonen. `kind` bepaalt of de knop "Tekst plakken" verschijnt.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub kind: &'static str,
    pub message: String,
    /// Technische details, voor de site-test en het uitklapbare deel van de melding.
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), detail: None }
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
    pub fn invalid_url() -> Self {
        Self::new("invalid_url", "Dit is geen geldig webadres. Gebruik een adres dat begint met http:// of https://.")
    }
    pub fn network(detail: impl Into<String>) -> Self {
        Self::new("network", "De site is niet bereikbaar. Controleer het adres en je internetverbinding, of plak de tekst zelf.").with_detail(detail)
    }
    pub fn timeout() -> Self {
        Self::new("timeout", "De pagina bleef te lang laden en is niet opgeslagen. Probeer het opnieuw of plak de tekst zelf.")
    }
    pub fn engine(detail: impl Into<String>) -> Self {
        Self::new("engine", "De pagina kon niet worden vastgelegd. Plak de tekst zelf als dit blijft gebeuren.").with_detail(detail)
    }
    pub fn storage(detail: impl std::fmt::Display) -> Self {
        Self::new("storage", "De kopie kon niet op deze computer worden opgeslagen.").with_detail(detail.to_string())
    }
    pub fn not_found(id: &str) -> Self {
        Self::new("not_found", "Deze bron bestaat niet meer op deze computer.").with_detail(id.to_string())
    }
}
