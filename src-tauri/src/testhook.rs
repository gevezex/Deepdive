//! Alleen in debug-builds: bedient de echte app vanaf de opdrachtregel voor end-to-endtests.
//!   DEEPDIVE_SITE_TEST=lijst.txt  legt elk adres vast en schrijft de uitslag naar DEEPDIVE_SITE_TEST_OUT
//!   DEEPDIVE_E2E_DIR=map          voert map/cmd.js uit in het hoofdvenster en schrijft het antwoord naar map/out.json

use crate::{import, store::Store};
use serde_json::json;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub fn start(app: AppHandle) {
    if let Ok(list) = std::env::var("DEEPDIVE_SITE_TEST") {
        let out = std::env::var("DEEPDIVE_SITE_TEST_OUT").unwrap_or_else(|_| "site-test.json".into());
        tauri::async_runtime::spawn(run_site_test(app.clone(), list, out));
    }
    if let Ok(dir) = std::env::var("DEEPDIVE_E2E_DIR") {
        tauri::async_runtime::spawn(run_e2e(app, dir));
    }
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
                "warnings": s.warnings, "textReady": s.text_ready,
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

async fn run_e2e(app: AppHandle, dir: String) {
    let cmd = std::path::Path::new(&dir).join("cmd.js");
    let out = std::path::Path::new(&dir).join("out.json");
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let Ok(js) = std::fs::read_to_string(&cmd) else { continue };
        let _ = std::fs::remove_file(&cmd);
        let Some(window) = app.get_webview_window("main") else { continue };
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
