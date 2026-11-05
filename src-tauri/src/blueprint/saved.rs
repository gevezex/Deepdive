//! Eén keer maken en bewaren: per bron, model en promptversie een bestand in `sources/<id>/blueprints/`.
//! De kopie zelf verandert nooit, dus een bewaarde blauwdruk blijft kloppen met de alineanummers. Deze map valt
//! buiten wat de afgeschermde iframe kan opvragen.

use super::schema::{Blueprint, SCHEMA_VERSION};
use crate::error::AppError;
use crate::store::Store;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn dir(store: &Store, source_id: &str) -> Result<PathBuf, AppError> {
    Ok(store.source_dir(source_id)?.join("blueprints"))
}

fn file_name(provider_id: &str, model: &str, prompt_version: u32) -> String {
    let hash = Sha256::digest(format!("{provider_id}\0{model}").as_bytes());
    format!("{}-p{prompt_version}.json", hex::encode(&hash[..8]))
}

pub fn find(store: &Store, source_id: &str, provider_id: &str, model: &str, prompt_version: u32) -> Option<Blueprint> {
    let path = dir(store, source_id).ok()?.join(file_name(provider_id, model, prompt_version));
    let blueprint: Blueprint = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (blueprint.schema_version == SCHEMA_VERSION).then_some(blueprint)
}

/// Bewaart de blauwdruk. Een onvolledige komt nooit in de plaats van een volledige van hetzelfde model: "Opnieuw
/// maken" mag niets kapotmaken. Geeft terug of hij is weggeschreven.
pub fn save(store: &Store, blueprint: &Blueprint) -> Result<bool, AppError> {
    let source_id = &blueprint.source.source_id;
    if blueprint.critique.is_none() && find(store, source_id, &blueprint.provider_id, &blueprint.model, blueprint.prompt_version).is_some_and(|old| old.critique.is_some()) {
        return Ok(false);
    }
    let dir = dir(store, source_id)?;
    std::fs::create_dir_all(&dir).map_err(AppError::storage)?;
    let path = dir.join(file_name(&blueprint.provider_id, &blueprint.model, blueprint.prompt_version));
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(blueprint).map_err(AppError::storage)?).map_err(AppError::storage)?;
    std::fs::rename(tmp, path).map_err(AppError::storage)?;
    Ok(true)
}

/// Alles wat voor deze bron bewaard is, nieuwste eerst. Een bestand in een oudere vorm telt niet mee: dat maakt de
/// lezer gewoon opnieuw.
pub fn all(store: &Store, source_id: &str) -> Result<Vec<Blueprint>, AppError> {
    let Ok(entries) = std::fs::read_dir(dir(store, source_id)?) else { return Ok(vec![]) };
    let mut out: Vec<Blueprint> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<Blueprint>(&std::fs::read(e.path()).ok()?).ok())
        .filter(|b| b.schema_version == SCHEMA_VERSION)
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}
