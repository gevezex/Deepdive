//! Lokale opslag. Elke bron is een eigen map onder `sources/`, die in één keer wordt neergezet:
//!   source.json   het bronmodel met de tekstkopie
//!   index.html    visuele kopie (website en geplakte tekst)
//!   assets/       afbeeldingen, CSS en fonts van de visuele kopie
//!   original.pdf  het bestand (pdf)

use crate::error::AppError;
use crate::model::{Source, SourceSummary};
use std::path::{Path, PathBuf};

pub struct Store {
    root: PathBuf,
}

/// Bron-id's zijn willekeurige hex-reeksen. Alles anders komt nooit in een pad terecht.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl Store {
    pub fn new(root: PathBuf) -> Result<Self, AppError> {
        std::fs::create_dir_all(root.join("sources")).map_err(AppError::storage)?;
        let store = Self { root };
        store.clear_unfinished();
        Ok(store)
    }

    fn clear_unfinished(&self) {
        if let Ok(entries) = std::fs::read_dir(self.root.join("tmp")) {
            for e in entries.flatten() {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    pub fn source_dir(&self, id: &str) -> Result<PathBuf, AppError> {
        if !is_valid_id(id) {
            return Err(AppError::not_found(id));
        }
        Ok(self.root.join("sources").join(id))
    }

    /// Lege werkmap. Een afgebroken opslag blijft zo buiten de bronnenlijst.
    pub fn begin(&self, id: &str) -> Result<PathBuf, AppError> {
        if !is_valid_id(id) {
            return Err(AppError::not_found(id));
        }
        let dir = self.root.join("tmp").join(id);
        std::fs::create_dir_all(&dir).map_err(AppError::storage)?;
        Ok(dir)
    }

    pub fn commit(&self, work_dir: &Path, source: &Source) -> Result<(), AppError> {
        let json = serde_json::to_vec_pretty(source).map_err(AppError::storage)?;
        std::fs::write(work_dir.join("source.json"), json).map_err(AppError::storage)?;
        std::fs::rename(work_dir, self.source_dir(&source.id)?).map_err(AppError::storage)
    }

    pub fn discard(&self, work_dir: &Path) {
        let _ = std::fs::remove_dir_all(work_dir);
    }

    pub fn get(&self, id: &str) -> Result<Source, AppError> {
        let path = self.source_dir(id)?.join("source.json");
        let bytes = std::fs::read(path).map_err(|_| AppError::not_found(id))?;
        serde_json::from_slice(&bytes).map_err(AppError::storage)
    }

    /// Werkt alleen het bronmodel bij; schrijft via een tijdelijk bestand.
    pub fn update(&self, source: &Source) -> Result<(), AppError> {
        let dir = self.source_dir(&source.id)?;
        let tmp = dir.join("source.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(source).map_err(AppError::storage)?).map_err(AppError::storage)?;
        std::fs::rename(tmp, dir.join("source.json")).map_err(AppError::storage)
    }

    /// Verwijdert een hele bronmap. Alleen voor een nieuwe kopie die de lezer niet wil.
    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        std::fs::remove_dir_all(self.source_dir(id)?).map_err(AppError::storage)
    }

    pub fn all(&self) -> Vec<Source> {
        let Ok(entries) = std::fs::read_dir(self.root.join("sources")) else { return vec![] };
        let mut out: Vec<Source> = entries
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter_map(|id| self.get(&id).ok())
            .collect();
        out.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
        out
    }

    pub fn summaries(&self) -> Vec<SourceSummary> {
        self.all()
            .into_iter()
            .filter(|s| s.superseded_by.is_none())
            .map(|s| SourceSummary { id: s.id, kind: s.kind, title: s.title, url: s.url, captured_at: s.captured_at, word_count: s.word_count })
            .collect()
    }

    pub fn find_by_url(&self, url: &str) -> Option<Source> {
        self.all().into_iter().find(|s| s.superseded_by.is_none() && (s.url.as_deref() == Some(url) || s.final_url.as_deref() == Some(url)))
    }

    pub fn find_by_hash(&self, hash: &str) -> Option<Source> {
        self.all().into_iter().find(|s| s.content_hash.as_deref() == Some(hash))
    }

    /// Geeft een bestand van de kopie terug, uitsluitend `index.html` of iets direct in `assets/`.
    pub fn snapshot_file(&self, path: &str) -> Option<PathBuf> {
        let mut parts = path.trim_start_matches('/').split('/');
        let id = parts.next()?;
        let dir = self.source_dir(id).ok()?;
        let safe = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.') && !s.starts_with('.');
        match (parts.next()?, parts.next(), parts.next()) {
            ("index.html", None, _) => Some(dir.join("index.html")),
            ("assets", Some(file), None) if safe(file) => Some(dir.join("assets").join(file)),
            _ => None,
        }
    }
}

pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_paths_stay_inside_the_source() {
        let store = Store { root: PathBuf::from("/data") };
        let id = "0123456789abcdef0123456789abcdef";
        assert!(store.snapshot_file(&format!("/{id}/index.html")).is_some());
        assert!(store.snapshot_file(&format!("/{id}/assets/abc.png")).is_some());
        for bad in [
            format!("/{id}/source.json"),
            format!("/{id}/original.pdf"),
            format!("/{id}/assets/../source.json"),
            format!("/{id}/assets/..%2Fsource.json"),
            format!("/{id}/assets/a/b.png"),
            "/../../etc/passwd".to_string(),
            "/index.html".to_string(),
        ] {
            assert!(store.snapshot_file(&bad).is_none(), "{bad}");
        }
    }
}
