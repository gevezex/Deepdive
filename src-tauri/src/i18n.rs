//! Languages. The interface language decides the language of messages the app shows; each source can pick its own
//! language for what the model writes (blueprint and answers). Without a choice, a source follows the interface.

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Nl,
    Tr,
}

static UI: AtomicU8 = AtomicU8::new(0);

impl Lang {
    #[cfg(test)]
    pub const ALL: [Lang; 3] = [Lang::En, Lang::Nl, Lang::Tr];

    pub fn from_code(code: &str) -> Option<Self> {
        match code.trim().to_ascii_lowercase().split(['-', '_']).next()? {
            "en" => Some(Lang::En),
            "nl" => Some(Lang::Nl),
            "tr" => Some(Lang::Tr),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Nl => "nl",
            Lang::Tr => "tr",
        }
    }

    /// The name as it fits in an English prompt: "Write in Turkish".
    pub fn english_name(self) -> &'static str {
        match self {
            Lang::En => "English",
            Lang::Nl => "Dutch",
            Lang::Tr => "Turkish",
        }
    }

    /// How an answer marks knowledge that is not in the text. The interface does not parse it; it is for the reader.
    pub fn outside_text_label(self) -> &'static str {
        match self {
            Lang::En => "Outside the text:",
            Lang::Nl => "Buiten de tekst:",
            Lang::Tr => "Metnin dışında:",
        }
    }

    fn index(self) -> u8 {
        match self {
            Lang::En => 0,
            Lang::Nl => 1,
            Lang::Tr => 2,
        }
    }
}

/// The interface language. English until the interface says otherwise.
pub fn ui() -> Lang {
    match UI.load(Ordering::Relaxed) {
        1 => Lang::Nl,
        2 => Lang::Tr,
        _ => Lang::En,
    }
}

pub fn set_ui(lang: Lang) {
    UI.store(lang.index(), Ordering::Relaxed);
}

/// A message in the interface language. Every message the reader can see is written out in all three languages
/// right where it is used, so a missing translation cannot slip through.
pub fn tr(en: &str, nl: &str, tr: &str) -> String {
    match ui() {
        Lang::En => en,
        Lang::Nl => nl,
        Lang::Tr => tr,
    }
    .to_string()
}

/// The language the model writes in for a source: its own choice, otherwise the interface language.
pub fn for_source(choice: Option<&str>) -> Lang {
    choice.and_then(Lang::from_code).unwrap_or_else(ui)
}

/// Sets the interface language and returns the one in force. Only test builds can force a language
/// (`DEEPDIVE_LANGUAGE`), so the end-to-end tests do not depend on what the reader chose in this webview.
#[tauri::command]
pub async fn set_ui_language(language: String) -> Result<String, crate::error::AppError> {
    #[allow(unused_mut)]
    let mut lang = Lang::from_code(&language).unwrap_or(Lang::En);
    #[cfg(debug_assertions)]
    if let Some(forced) = std::env::var("DEEPDIVE_LANGUAGE").ok().as_deref().and_then(Lang::from_code) {
        lang = forced;
    }
    set_ui(lang);
    Ok(lang.code().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        assert_eq!(Lang::from_code("nl-NL"), Some(Lang::Nl));
        assert_eq!(Lang::from_code("TR"), Some(Lang::Tr));
        assert_eq!(Lang::from_code("de"), None);
        for lang in Lang::ALL {
            assert_eq!(Lang::from_code(lang.code()), Some(lang));
        }
    }
}
