use serde::Serialize;

use crate::i18n::tr;

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
        Self::new("invalid_url", tr("This is not a valid web address. Use an address that starts with http:// or https://.", "Dit is geen geldig webadres. Gebruik een adres dat begint met http:// of https://.", "Bu geçerli bir web adresi değil. http:// veya https:// ile başlayan bir adres kullanın."))
    }
    pub fn network(detail: impl Into<String>) -> Self {
        Self::new("network", tr("The site cannot be reached. Check the address and your internet connection, or paste the text yourself.", "De site is niet bereikbaar. Controleer het adres en je internetverbinding, of plak de tekst zelf.", "Siteye ulaşılamıyor. Adresi ve internet bağlantınızı kontrol edin ya da metni kendiniz yapıştırın.")).with_detail(detail)
    }
    pub fn timeout() -> Self {
        Self::new("timeout", tr("The page took too long to load and was not saved. Try again or paste the text yourself.", "De pagina bleef te lang laden en is niet opgeslagen. Probeer het opnieuw of plak de tekst zelf.", "Sayfanın yüklenmesi çok uzun sürdü ve kaydedilmedi. Tekrar deneyin ya da metni kendiniz yapıştırın."))
    }
    pub fn engine(detail: impl Into<String>) -> Self {
        Self::new("engine", tr("The page could not be captured. Paste the text yourself if this keeps happening.", "De pagina kon niet worden vastgelegd. Plak de tekst zelf als dit blijft gebeuren.", "Sayfa kaydedilemedi. Bu tekrarlanırsa metni kendiniz yapıştırın.")).with_detail(detail)
    }
    pub fn storage(detail: impl std::fmt::Display) -> Self {
        Self::new("storage", tr("The copy could not be saved on this computer.", "De kopie kon niet op deze computer worden opgeslagen.", "Kopya bu bilgisayara kaydedilemedi.")).with_detail(detail.to_string())
    }
    pub fn not_found(id: &str) -> Self {
        Self::new("not_found", tr("This source no longer exists on this computer.", "Deze bron bestaat niet meer op deze computer.", "Bu kaynak artık bu bilgisayarda yok.")).with_detail(id.to_string())
    }
}
