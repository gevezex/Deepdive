mod ai;
mod chatgpt;
mod engine;
mod error;
mod import;
mod model;
mod providers;
mod snapshot;
mod store;
#[cfg(debug_assertions)]
mod testhook;

use error::AppError;
use model::{Block, Source, SourceSummary};
use providers::{secrets::Keychain, ProviderStore};
use std::sync::Arc;
use store::Store;
use tauri::http::{header, Response, StatusCode};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
async fn open_url(app: AppHandle, store: State<'_, Store>, url: String, refresh: Option<bool>) -> Result<Source, AppError> {
    import::open_url(&app, &store, &url, refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn import_pdf(store: State<'_, Store>, request: Request<'_>) -> Result<Source, AppError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new("pdf", "Het bestand is niet goed aangekomen."));
    };
    let name = request.headers().get("x-file-name").and_then(|v| v.to_str().ok()).unwrap_or("document.pdf");
    let name = url::form_urlencoded::parse(format!("n={name}").as_bytes()).next().map_or("document.pdf".to_string(), |(_, v)| v.into_owned());
    import::save_pdf(&store, bytes, &name, None)
}

#[tauri::command]
async fn save_pdf_text(store: State<'_, Store>, id: String, title: Option<String>, page_count: u32, blocks: Vec<Block>) -> Result<Source, AppError> {
    import::save_pdf_text(&store, &id, title, page_count, blocks)
}

#[tauri::command]
async fn read_pdf(store: State<'_, Store>, id: String) -> Result<tauri::ipc::Response, AppError> {
    let path = store.source_dir(&id)?.join("original.pdf");
    let bytes = std::fs::read(path).map_err(|_| AppError::not_found(&id))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn import_text(store: State<'_, Store>, title: Option<String>, url: Option<String>, text: String) -> Result<Source, AppError> {
    import::import_text(&store, title, url, &text)
}

#[tauri::command]
async fn list_sources(store: State<'_, Store>) -> Result<Vec<SourceSummary>, AppError> {
    Ok(store.summaries())
}

#[tauri::command]
async fn get_source(store: State<'_, Store>, id: String) -> Result<Source, AppError> {
    store.get(&id)
}

/// Serveert de visuele kopie aan de afgeschermde iframe. Antwoordt zelf nooit met iets buiten de bronmap.
fn serve_snapshot(app: &AppHandle, request: tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin_is_opaque = request.headers().get(header::ORIGIN).is_some_and(|o| o == "null");
    let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    let store = app.state::<Store>();
    let Some(path) = store.snapshot_file(request.uri().path()) else { return not_found() };
    let Ok(bytes) = std::fs::read(&path) else { return not_found() };
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, store::mime_for(&path))
        .header(header::CONTENT_SECURITY_POLICY, snapshot::CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer");
    // Fonts vragen om CORS. Alleen de afgeschermde iframe (origin "null") krijgt ze, geen pagina van internet.
    if origin_is_opaque {
        res = res.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "null");
    }
    res.body(bytes).unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("deepdive-snapshot", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || responder.respond(serve_snapshot(&app, request)));
        })
        .setup(|app| {
            let mut root = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            if let Ok(dir) = std::env::var("DEEPDIVE_DATA_DIR") {
                root = dir.into();
            }
            #[cfg(not(debug_assertions))]
            let _ = &mut root;
            #[allow(unused_mut)]
            let mut keychain_service = app.config().identifier.clone();
            // Alleen voor tests: houdt de nepsleutels gescheiden van de sleutels die de app echt gebruikt.
            #[cfg(debug_assertions)]
            if let Ok(service) = std::env::var("DEEPDIVE_KEYCHAIN_SERVICE") {
                keychain_service = service;
            }
            app.manage(ProviderStore::open(root.clone(), Arc::new(Keychain::new(keychain_service)))?);
            app.manage(Store::new(root)?);
            #[cfg(debug_assertions)]
            testhook::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_url,
            import_pdf,
            save_pdf_text,
            read_pdf,
            import_text,
            list_sources,
            get_source,
            providers::commands::list_providers,
            providers::commands::save_provider,
            providers::commands::delete_provider,
            providers::commands::save_model,
            providers::commands::delete_model,
            providers::commands::refresh_models,
            providers::commands::select_model,
            providers::commands::test_connection,
            providers::commands::chatgpt_login,
            providers::commands::chatgpt_cancel_login,
            providers::commands::chatgpt_logout,
            providers::commands::chatgpt_welcome_seen,
            providers::commands::open_chatgpt_usage,
        ])
        .run(tauri::generate_context!())
        .expect("Deepdive kon niet starten");
}
