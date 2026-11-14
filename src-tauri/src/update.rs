//! Updates. At start the interface asks once whether GitHub has a newer release (`latest.json` of the latest
//! release, see `plugins.updater` in tauri.conf.json). If so, a button appears; a click downloads the new app,
//! checks its signature against the public key in the config, replaces the app and restarts it.
//!
//! The plugin's own commands are not given to any window: the interface only gets these two commands, so a page
//! can never choose an address or a file to install.

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::AppError;
use crate::i18n::tr;

/// The update found at start, kept until the reader clicks the button.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub current_version: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Progress {
    /// Bytes so far and, when the server says so, the total.
    Download { done: u64, total: Option<u64> },
    Install,
}

/// Is there a newer version? `None` without internet or when GitHub cannot be reached: then the app just carries on.
/// Debug builds do not look, so development and the end-to-end tests never see a button.
#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<Available>, AppError> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let found = match app.updater().map_err(failed)?.check().await {
        Ok(found) => found,
        Err(err) => {
            eprintln!("update check failed: {err}");
            return Ok(None);
        }
    };
    let available = found.as_ref().map(|u| Available { version: u.version.clone(), current_version: u.current_version.clone() });
    *pending.0.lock().unwrap() = found;
    Ok(available)
}

/// Downloads and installs the update found by `check_update`, then restarts the app. Returns only on an error.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, Pending>, on_progress: Channel<Progress>) -> Result<(), AppError> {
    let Some(update) = pending.0.lock().unwrap().clone() else {
        return Err(AppError::new("update", tr("There is no update to install.", "Er is geen update om te installeren.", "Yüklenecek güncelleme yok.")));
    };
    let mut done = 0u64;
    let progress = on_progress.clone();
    update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let _ = progress.send(Progress::Download { done, total });
            },
            || {
                let _ = on_progress.send(Progress::Install);
            },
        )
        .await
        .map_err(failed)?;
    app.restart();
}

fn failed(err: impl std::fmt::Display) -> AppError {
    AppError::new(
        "update",
        tr(
            "The update could not be installed. Try again later, or download the new version from GitHub yourself.",
            "De update kon niet worden geïnstalleerd. Probeer het later opnieuw of download de nieuwe versie zelf van GitHub.",
            "Güncelleme yüklenemedi. Daha sonra tekrar deneyin ya da yeni sürümü GitHub'dan kendiniz indirin.",
        ),
    )
    .with_detail(err.to_string())
}
