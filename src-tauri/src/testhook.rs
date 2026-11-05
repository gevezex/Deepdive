//! Alleen in debug-builds: bedient de echte app vanaf de opdrachtregel voor end-to-endtests.
//!   DEEPDIVE_SITE_TEST=lijst.txt  legt elk adres vast en schrijft de uitslag naar DEEPDIVE_SITE_TEST_OUT
//!   DEEPDIVE_E2E_DIR=map          voert map/cmd.js uit in het hoofdvenster en schrijft het antwoord naar map/out.json
//!                                 "win:login\n<js>" voert het uit in het eerste venster waarvan de naam zo begint,
//!                                 zodat de test de rol van de gebruiker kan spelen op de lokale testsite
//!   DEEPDIVE_BLUEPRINT_TEST=plan.json  maakt blauwdrukken volgens het plan en schrijft ze naar DEEPDIVE_BLUEPRINT_OUT
//!   DEEPDIVE_SIGNALS_OUT=map      schrijft de signalen en tekstblokken van elke opgehaalde pagina naar die map

use crate::{
    blueprint, engine::RenderedPage, import,
    model::Source,
    providers::{secrets::{CachedSecrets, Keychain}, ModelRef, ProviderStore},
    store::Store,
};
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub fn start(app: AppHandle) {
    if let Ok(list) = std::env::var("DEEPDIVE_SITE_TEST") {
        let out = std::env::var("DEEPDIVE_SITE_TEST_OUT").unwrap_or_else(|_| "site-test.json".into());
        tauri::async_runtime::spawn(run_site_test(app.clone(), list, out));
    }
    if let Ok(plan) = std::env::var("DEEPDIVE_BLUEPRINT_TEST") {
        let out = std::env::var("DEEPDIVE_BLUEPRINT_OUT").unwrap_or_else(|_| "blueprint-test".into());
        tauri::async_runtime::spawn(run_blueprint_test(app.clone(), plan, out));
    }
    if let Ok(dir) = std::env::var("DEEPDIVE_E2E_DIR") {
        tauri::async_runtime::spawn(run_e2e(app, dir));
    }
}

pub fn dump_signals(url: &url::Url, page: &RenderedPage) {
    let Ok(dir) = std::env::var("DEEPDIVE_SIGNALS_OUT") else { return };
    let name = hex::encode(url.as_str().as_bytes());
    let name = &name[..name.len().min(120)];
    let blocks: Vec<_> = page.blocks.iter().map(|b| json!({"kind": b.kind, "text": b.text})).collect();
    let value = json!({ "url": url.as_str(), "finalUrl": page.final_url, "signals": page.signals, "blocks": blocks });
    let _ = std::fs::write(std::path::Path::new(&dir).join(format!("{name}.json")), value.to_string());
}

async fn run_site_test(app: AppHandle, list: String, out: String) {
    let text = std::fs::read_to_string(&list).expect("lijst met adressen");
    let mut results = vec![];
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (label, url) = line.split_once(' ').unwrap_or(("", line));
        let start = Instant::now();
        let store = app.state::<Store>();
        let result = import::open_url(&app, &store, url.trim(), true).await;
        let seconds = start.elapsed().as_secs_f32();
        let entry = match result {
            Ok(s) => json!({
                "label": label, "url": url, "ok": true, "seconds": seconds, "id": s.id, "title": s.title, "kind": s.kind,
                "finalUrl": s.final_url, "blocks": s.blocks.len(), "words": s.word_count,
                "assetsSaved": s.assets.saved, "assetsFailed": s.assets.failed, "assetBytes": s.assets.bytes,
                "failedUrls": s.assets.failed_urls.iter().take(5).collect::<Vec<_>>(),
                "warnings": s.warnings, "textReady": s.text_ready, "completeness": s.completeness,
                "first": s.blocks.iter().take(4).map(|b| b.text.chars().take(120).collect::<String>()).collect::<Vec<_>>(),
                "last": s.blocks.iter().rev().take(2).map(|b| b.text.chars().take(120).collect::<String>()).collect::<Vec<_>>(),
            }),
            Err(e) => json!({ "label": label, "url": url, "ok": false, "seconds": seconds, "errorKind": e.kind, "error": e.message, "detail": e.detail }),
        };
        eprintln!("[site-test] {}", entry);
        results.push(entry);
        std::fs::write(&out, serde_json::to_string_pretty(&results).unwrap()).unwrap();
    }
    app.exit(0);
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanPiece {
    label: String,
    #[serde(default)]
    url: Option<String>,
    /// Een eigen testtekst: eerste regel de titel, daarna alinea's.
    #[serde(default)]
    fixture: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanModel {
    slug: String,
    provider_id: String,
    model_id: String,
}

#[derive(Deserialize)]
struct Plan {
    pieces: Vec<PlanPiece>,
    /// Leeg: alleen ophalen en de uitslag per stuk wegschrijven.
    #[serde(default)]
    models: Vec<PlanModel>,
    /// Alleen deze labels naar het model sturen. Leeg: alle stukken.
    #[serde(default)]
    only: Vec<String>,
}

/// Haalt elk stuk op zoals de app dat doet, en maakt de blauwdrukken met de providers die de gebruiker heeft
/// ingesteld. De bronnen komen in DEEPDIVE_DATA_DIR, dus buiten de bronnenlijst van de gebruiker.
async fn run_blueprint_test(app: AppHandle, plan: String, out: String) {
    let plan: Plan = serde_json::from_str(&std::fs::read_to_string(&plan).expect("plan")).expect("geldig plan");
    let out = PathBuf::from(out);
    std::fs::create_dir_all(&out).expect("uitvoermap");
    tokio::time::sleep(Duration::from_secs(3)).await;

    let mut pieces = vec![];
    let mut sources: Vec<(String, Source)> = vec![];
    for piece in &plan.pieces {
        let store = app.state::<Store>();
        let start = Instant::now();
        let result = match (&piece.url, &piece.fixture) {
            (_, Some(path)) => open_fixture(&store, &piece.label, path),
            (Some(url), _) => match import::open_url(&app, &store, url, false).await {
                Ok(source) if !source.text_ready => read_pdf_in_window(&app, url, &source.id).await,
                other => other,
            },
            _ => panic!("stuk zonder url of fixture"),
        };
        match result {
            Ok(source) => {
                let entry = json!({ "label": piece.label, "url": piece.url, "fixture": piece.fixture, "ok": true, "id": source.id, "title": source.title, "kind": source.kind, "blocks": source.blocks.len(), "words": source.word_count, "verdict": source.completeness.verdict, "reason": source.completeness.reason, "seconds": start.elapsed().as_secs_f32() });
                eprintln!("[blauwdruk] bron {entry}");
                pieces.push(entry);
                sources.push((piece.label.clone(), source));
            }
            Err(e) => {
                let entry = json!({ "label": piece.label, "url": piece.url, "ok": false, "errorKind": e.kind, "error": e.message });
                eprintln!("[blauwdruk] bron {entry}");
                pieces.push(entry);
            }
        }
        std::fs::write(out.join("pieces.json"), serde_json::to_string_pretty(&pieces).unwrap()).unwrap();
    }

    // De echte instellingen van de gebruiker. Sleutels en tokens blijven in de AI-laag.
    let root = app.path().app_data_dir().expect("gegevensmap");
    let providers = Arc::new(ProviderStore::open(root, Arc::new(CachedSecrets::new(Keychain::new(app.config().identifier.clone())))).expect("providers"));
    let sources = Arc::new(sources);
    let only = Arc::new(plan.only);
    let mut jobs = vec![];
    for model in plan.models {
        let (providers, sources, only, out) = (providers.clone(), sources.clone(), only.clone(), out.clone());
        jobs.push(tauri::async_runtime::spawn(async move {
            for (label, source) in sources.iter() {
                if only.is_empty() || only.contains(label) {
                    run_blueprint(&providers, &model, label, source, &out).await;
                }
            }
        }));
    }
    for job in jobs {
        let _ = job.await;
    }
    app.exit(0);
}

fn open_fixture(store: &Store, label: &str, path: &str) -> Result<Source, crate::error::AppError> {
    let url = format!("https://deepdive.invalid/fixture/{label}");
    if let Some(existing) = store.find_by_url(&url) {
        return Ok(existing);
    }
    let text = std::fs::read_to_string(path).map_err(crate::error::AppError::storage)?;
    let (title, body) = text.split_once('\n').unwrap_or(("", &text));
    import::import_text(store, Some(title.trim_start_matches("# ").to_string()), Some(url), body)
}

/// Bij een pdf leest de voorkant de tekst met pdf.js. Dus openen we het adres in het hoofdvenster, als een gebruiker.
async fn read_pdf_in_window(app: &AppHandle, url: &str, id: &str) -> Result<Source, crate::error::AppError> {
    if let Some(window) = app.get_webview_window("main") {
        let js = format!("document.getElementById('url-input').value = {}; document.getElementById('url-form').requestSubmit();", json!(url));
        let _ = window.eval(js);
    }
    let store = app.state::<Store>();
    for _ in 0..240 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let source = store.get(id)?;
        if source.text_ready {
            return Ok(source);
        }
    }
    Err(crate::error::AppError::new("pdf", "De tekst van de pdf is niet op tijd gelezen."))
}

async fn run_blueprint(providers: &ProviderStore, model: &PlanModel, label: &str, source: &Source, out: &Path) {
    let dir = out.join("runs").join(&model.slug);
    std::fs::create_dir_all(&dir).expect("uitvoermap");
    let file = dir.join(format!("{label}.json"));
    if file.exists() {
        return; // Elk stuk maximaal één keer per model. Wie opnieuw wil, haalt het bestand weg.
    }
    let start = Instant::now();
    let mut report = blueprint::RunReport::default();
    let chosen = ModelRef { provider_id: model.provider_id.clone(), model_id: model.model_id.clone() };
    let result = match providers.target(&chosen) {
        Ok(target) => blueprint::generate(&target, &model.provider_id, source, &blueprint::Options::default(), &mut report).await,
        Err(e) => Err(e),
    };
    let raw: Vec<_> = report.calls.iter().map(|c| json!({ "stage": c.stage, "attempt": c.attempt, "text": c.raw })).collect();
    let value = match &result {
        Ok(b) => json!({ "label": label, "model": model.model_id, "ok": true, "seconds": start.elapsed().as_secs_f32(), "report": report, "blueprint": b, "raw": raw }),
        Err(e) => json!({ "label": label, "model": model.model_id, "ok": false, "seconds": start.elapsed().as_secs_f32(), "report": report, "errorKind": e.kind, "error": e.message, "detail": e.detail, "raw": raw }),
    };
    eprintln!("[blauwdruk] {} {label}: {} in {:.0} s, {} aanroepen", model.slug, if result.is_ok() { "klaar" } else { "mislukt" }, start.elapsed().as_secs_f32(), report.calls.len());
    std::fs::write(&file, serde_json::to_string_pretty(&value).unwrap()).expect("wegschrijven");
}

async fn run_e2e(app: AppHandle, dir: String) {
    let cmd = std::path::Path::new(&dir).join("cmd.js");
    let out = std::path::Path::new(&dir).join("out.json");
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let Ok(js) = std::fs::read_to_string(&cmd) else { continue };
        let _ = std::fs::remove_file(&cmd);
        // Hetzelfde als de sluitknop van het venster.
        if let Some(prefix) = js.strip_prefix("closewin:") {
            if let Some((_, window)) = app.webview_windows().into_iter().find(|(label, _)| label.starts_with(prefix.trim())) {
                let _ = window.close();
            }
            let _ = std::fs::write(&out, "\"ok\"");
            continue;
        }
        #[cfg(feature = "screenshots")]
        if let Some((prefix, path)) = js.strip_prefix("shotwin:").and_then(|r| r.split_once(' ')) {
            if let Some((_, window)) = app.webview_windows().into_iter().find(|(label, _)| label.starts_with(prefix)) {
                shot(&window, path.trim().to_string(), out.clone());
            }
            continue;
        }
        let (js, window) = match js.strip_prefix("win:").and_then(|r| r.split_once('\n')) {
            Some((prefix, body)) => {
                let found = app.webview_windows().into_iter().find(|(label, _)| label.starts_with(prefix)).map(|(_, w)| w);
                let Some(window) = found else {
                    let _ = std::fs::write(&out, "\"geen venster\"");
                    continue;
                };
                (body.to_string(), window)
            }
            None => {
                let Some(window) = app.get_webview_window("main") else { continue };
                (js, window)
            }
        };
        #[cfg(feature = "screenshots")]
        if let Some(path) = js.strip_prefix("shot:") {
            shot(&window, path.trim().to_string(), out.clone());
            continue;
        }
        let out = out.clone();
        let _ = window.eval_with_callback(js, move |value| {
            let tmp = out.with_extension("tmp");
            let _ = std::fs::write(&tmp, value);
            let _ = std::fs::rename(&tmp, &out);
        });
    }
}

#[cfg(feature = "screenshots")]
fn shot(window: &tauri::WebviewWindow, path: String, out: std::path::PathBuf) {
    let _ = window.with_webview(move |view| unsafe {
        let wk: &objc2_web_kit::WKWebView = &*(view.inner() as *const objc2_web_kit::WKWebView);
        let block = block2::RcBlock::new(move |image: *mut objc2_app_kit::NSImage, _err: *mut objc2_foundation::NSError| {
            if let Some(image) = image.as_ref() {
                if let Some(data) = image.TIFFRepresentation() {
                    let _ = std::fs::write(&path, data.to_vec());
                }
            }
            let _ = std::fs::write(&out, "\"ok\"");
        });
        wk.takeSnapshotWithConfiguration_completionHandler(None, &block);
    });
}
