//! Selecteren en vragen: de lezer kiest een stuk tekst en vraagt de professor iets. Het antwoord komt stukje voor
//! stukje binnen en wordt per bron bewaard als gesprek, met vervolgvragen. De hele bron gaat mee als context.
//!
//! Bewaard in `sources/<id>/threads/<thread>.json`, buiten wat de afgeschermde iframe kan opvragen.

pub mod commands;
pub mod highlights;
#[cfg(test)]
mod tests;

use crate::ai::{ChatRequest, Message, Part, Role};
use crate::blueprint::source_prompt;
use crate::error::AppError;
use crate::model::Source;
use crate::store::{is_valid_id, Store};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const SYSTEM: &str = include_str!("prompts/system.md");
/// Ruim, omdat denkende modellen een deel daarvan aan denkstappen besteden.
const MAX_TOKENS: u32 = 16_000;
/// Langer dan dit is geen selectie meer maar de halve tekst; die staat toch al in de bron.
const MAX_SELECTION_CHARS: usize = 6_000;
const MAX_QUESTION_CHARS: usize = 2_000;

/// Wat de lezer kan vragen. De naam komt van de interface; alleen deze zijn geldig.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Ask,
    Explain,
    Simplify,
    Define,
    FactCheck,
    Related,
    Counterpoint,
    /// Een open vraag over de hele tekst, zonder selectie.
    Document,
}

impl Action {
    fn task(self) -> &'static str {
        match self {
            Action::Ask => "Answer the reader's question about the selected passage.",
            Action::Explain => "Explain what the selected passage means here and why it stands at this place in the text. If there is a name, say who or what it is. Explain figurative language.",
            Action::Simplify => "Say the same idea in plain words, without jargon, so that someone without prior knowledge gets it. End with one line about the point the passage makes.",
            Action::Define => "What does this word or term mean as *this* author uses it here? Say whether it is jargon, old-fashioned or unusual, and whether the author uses it differently elsewhere.",
            Action::FactCheck => "Is this still correct? You cannot search the web. Say what you know up to your knowledge cutoff, what may have changed since and how sure you are. Say in the core sentence that this was not checked on the internet.",
            Action::Related => "Where else does the text take up this idea? Name the places with paragraph numbers and say in one sentence per place what happens there. If there is no other place, say so.",
            Action::Counterpoint => "Give the strongest objection to what is said here. Then say how the author could answer on the basis of the text, and whether that removes the objection.",
            Action::Document => "Answer the reader's question about the text as a whole. The reader did not select a passage. Point to the paragraphs your answer rests on.",
        }
    }
}

/// Het stuk dat de lezer selecteerde, met de alinea's waar het in staat als die bekend zijn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub text: String,
    #[serde(default)]
    pub from: Option<u32>,
    #[serde(default)]
    pub to: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub source_id: String,
    pub action: Action,
    pub selection: Selection,
    /// Om en om: de lezer, dan de professor. De eerste beurt van de lezer is de vraag of de naam van de actie.
    pub turns: Vec<Turn>,
    pub provider_id: String,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
    /// De lezer stopte het laatste antwoord voordat het af was.
    #[serde(default)]
    pub stopped: bool,
}

pub fn now() -> String {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

impl Selection {
    pub fn cleaned(&self) -> Result<Self, AppError> {
        let text = clip(&self.text.split_whitespace().collect::<Vec<_>>().join(" "), MAX_SELECTION_CHARS);
        if text.is_empty() {
            return Err(AppError::new("empty_selection", crate::i18n::tr("Select a piece of text first.", "Selecteer eerst een stuk tekst.", "Önce bir metin parçası seçin.")));
        }
        let (from, to) = match (self.from, self.to) {
            (Some(a), Some(b)) => (Some(a.min(b)), Some(a.max(b))),
            (a, b) => (a.or(b), b.or(a)),
        };
        Ok(Self { text, from, to })
    }

    fn place(&self) -> String {
        match (self.from, self.to) {
            (Some(a), Some(b)) if a == b => format!(" (in ¶{a})"),
            (Some(a), Some(b)) => format!(" (in ¶{a}–{b})"),
            _ => String::new(),
        }
    }
}

pub fn clean_question(question: &str) -> Result<String, AppError> {
    let q = clip(question, MAX_QUESTION_CHARS);
    if q.is_empty() {
        return Err(AppError::new("empty_question", crate::i18n::tr("Type a question first.", "Typ eerst een vraag.", "Önce bir soru yazın.")));
    }
    Ok(q)
}

/// De eerste vraag: de hele bron, dan de selectie, dan de opdracht. Vervolgvragen komen als gewone beurten.
pub fn first_message(source: &Source, action: Action, selection: &Selection, question: Option<&str>, nonce: &str) -> String {
    let tag = format!("selection-{nonce}");
    let mut out = source_prompt(source, nonce);
    if action == Action::Document {
        out.push('\n');
    } else {
        out.push_str(&format!("\nThe reader selected this passage{}:\n<{tag}>\n{}\n</{tag}>\n\n", selection.place(), selection.text));
    }
    out.push_str(&format!("Task: {}\n", action.task()));
    if let Some(q) = question {
        out.push_str(&format!("\nThe reader's question: {q}\n"));
    }
    out
}

/// Het verzoek voor het hele gesprek tot nu toe. De eerste beurt van de lezer wordt het bericht met de bron.
pub fn request(source: &Source, thread: &Thread, nonce: &str) -> ChatRequest {
    let mut messages = vec![];
    for (i, turn) in thread.turns.iter().enumerate() {
        let question = Some(turn.text.as_str()).filter(|q| !q.is_empty());
        let text = if i == 0 { first_message(source, thread.action, &thread.selection, question, nonce) } else { turn.text.clone() };
        messages.push(Message { role: turn.role, parts: vec![Part::Text(text)] });
    }
    let language = crate::i18n::for_source(source.ai_language.as_deref());
    let system = SYSTEM.replace("{{LANGUAGE}}", language.english_name()).replace("{{OUTSIDE}}", language.outside_text_label());
    ChatRequest { system: Some(system), messages, max_tokens: MAX_TOKENS }
}

// ---------- opslag ----------

fn dir(store: &Store, source_id: &str) -> Result<PathBuf, AppError> {
    Ok(store.source_dir(source_id)?.join("threads"))
}

pub fn save(store: &Store, thread: &Thread) -> Result<(), AppError> {
    if !is_valid_id(&thread.id) {
        return Err(AppError::not_found(&thread.id));
    }
    let dir = dir(store, &thread.source_id)?;
    std::fs::create_dir_all(&dir).map_err(AppError::storage)?;
    let path = dir.join(format!("{}.json", thread.id));
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(thread).map_err(AppError::storage)?).map_err(AppError::storage)?;
    std::fs::rename(tmp, path).map_err(AppError::storage)
}

pub fn load(store: &Store, source_id: &str, id: &str) -> Result<Thread, AppError> {
    if !is_valid_id(id) {
        return Err(AppError::not_found(id));
    }
    let bytes = std::fs::read(dir(store, source_id)?.join(format!("{id}.json"))).map_err(|_| AppError::not_found(id))?;
    serde_json::from_slice(&bytes).map_err(AppError::storage)
}

/// Alle gesprekken bij deze bron, oudste eerst.
pub fn all(store: &Store, source_id: &str) -> Result<Vec<Thread>, AppError> {
    let Ok(entries) = std::fs::read_dir(dir(store, source_id)?) else { return Ok(vec![]) };
    let mut out: Vec<Thread> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok())
        .collect();
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(out)
}

pub fn remove(store: &Store, source_id: &str, id: &str) -> Result<(), AppError> {
    if !is_valid_id(id) {
        return Err(AppError::not_found(id));
    }
    match std::fs::remove_file(dir(store, source_id)?.join(format!("{id}.json"))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(AppError::storage(e)),
        _ => Ok(()),
    }
}
