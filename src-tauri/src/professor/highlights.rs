//! Markeringen in vier kleuren, met een notitie als de lezer die schrijft. Per bron één bestand
//! `sources/<id>/highlights.json`, buiten wat de afgeschermde iframe kan opvragen.
//!
//! Een kopie verandert nooit, dus een plek blijft geldig: bij een website als tekenpositie in de pagina, bij een pdf
//! als rechthoeken op de pagina. De tekst gaat mee, zodat de lezer ziet wat er gemarkeerd is.

use super::now;
use crate::error::AppError;
use crate::store::{is_valid_id, Store};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_TEXT: usize = 20_000;
const MAX_NOTE: usize = 10_000;
const MAX_RECTS: usize = 400;
const MAX_HIGHLIGHTS: usize = 5_000;

/// Eén schrijver tegelijk: lezen, aanpassen en wegschrijven horen bij elkaar.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Yellow,
    Green,
    Blue,
    Pink,
}

/// Een rechthoek op een pdf-pagina, als deel van de pagina (0 tot 1), zodat hij meeschaalt.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PageRect {
    pub page: u32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Anchor {
    /// Tekenposities in de tekst van de pagina.
    Web { start: u32, end: u32 },
    Pdf { rects: Vec<PageRect> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub color: Color,
    pub text: String,
    #[serde(default)]
    pub from: Option<u32>,
    #[serde(default)]
    pub to: Option<u32>,
    pub anchor: Anchor,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

fn path(store: &Store, source_id: &str) -> Result<PathBuf, AppError> {
    Ok(store.source_dir(source_id)?.join("highlights.json"))
}

pub fn all(store: &Store, source_id: &str) -> Result<Vec<Highlight>, AppError> {
    let Ok(bytes) = std::fs::read(path(store, source_id)?) else { return Ok(vec![]) };
    serde_json::from_slice(&bytes).map_err(AppError::storage)
}

fn write(store: &Store, source_id: &str, list: &[Highlight]) -> Result<(), AppError> {
    let path = path(store, source_id)?;
    if !path.parent().is_some_and(|d| d.is_dir()) {
        return Err(AppError::not_found(source_id));
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(AppError::storage)?).map_err(AppError::storage)?;
    std::fs::rename(tmp, path).map_err(AppError::storage)
}

fn check(mut h: Highlight) -> Result<Highlight, AppError> {
    let bad = |why: &str| AppError::new("bad_highlight", crate::i18n::tr("This highlight could not be saved.", "Deze markering kon niet worden bewaard.", "Bu işaretleme kaydedilemedi.")).with_detail(why.to_string());
    if !is_valid_id(&h.id) {
        return Err(bad("id"));
    }
    h.text = h.text.chars().take(MAX_TEXT).collect();
    h.note = h.note.map(|n| n.chars().take(MAX_NOTE).collect::<String>()).filter(|n| !n.trim().is_empty());
    match &h.anchor {
        Anchor::Web { start, end } if end <= start => return Err(bad("empty range")),
        Anchor::Pdf { rects } if rects.is_empty() || rects.len() > MAX_RECTS => return Err(bad("rectangles")),
        Anchor::Pdf { rects } if rects.iter().any(|r| ![r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite() && (-0.01..=1.01).contains(v)) || r.page == 0) => {
            return Err(bad("rectangle outside the page"))
        }
        _ => {}
    }
    if h.created_at.is_empty() {
        h.created_at = now();
    }
    Ok(h)
}

/// Nieuw of aangepast (kleur, notitie). Geeft de hele lijst terug.
pub fn upsert(store: &Store, source_id: &str, highlight: Highlight) -> Result<Vec<Highlight>, AppError> {
    let highlight = check(highlight)?;
    let _lock = LOCK.lock().unwrap();
    let mut list = all(store, source_id)?;
    if let Some(old) = list.iter_mut().find(|h| h.id == highlight.id) {
        // De plek en de tekst liggen vast; alleen kleur en notitie veranderen.
        old.color = highlight.color;
        old.note = highlight.note;
    } else if list.len() >= MAX_HIGHLIGHTS {
        return Err(AppError::new("bad_highlight", crate::i18n::tr("This source has too many highlights.", "Er zijn te veel markeringen bij deze bron.", "Bu kaynakta çok fazla işaretleme var.")));
    } else {
        list.push(highlight);
    }
    write(store, source_id, &list)?;
    Ok(list)
}

pub fn remove(store: &Store, source_id: &str, id: &str) -> Result<Vec<Highlight>, AppError> {
    let _lock = LOCK.lock().unwrap();
    let mut list = all(store, source_id)?;
    list.retain(|h| h.id != id);
    write(store, source_id, &list)?;
    Ok(list)
}
