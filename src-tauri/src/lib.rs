/// `format!` in the interface language: `tr_fmt!("{n} words", "{n} woorden", "{n} kelime")`. Each language gets its
/// own literal, so word order can differ. Defined before the modules so that all of them can use it.
macro_rules! tr_fmt {
    ($en:literal, $nl:literal, $tr:literal $(, $arg:expr)* $(,)?) => {
        match crate::i18n::ui() {
            crate::i18n::Lang::En => format!($en $(, $arg)*),
            crate::i18n::Lang::Nl => format!($nl $(, $arg)*),
            crate::i18n::Lang::Tr => format!($tr $(, $arg)*),
        }
    };
}

mod ai;
mod blueprint;
mod chatgpt;
mod completeness;
mod engine;
mod error;
mod i18n;
mod import;
mod markdown;
mod model;
mod preview;
mod professor;
mod providers;
mod sessions;
mod snapshot;
mod store;
mod update;
#[cfg(debug_assertions)]
mod testhook;

use error::AppError;
use model::{Block, Source, SourceSummary};
use providers::{secrets::{CachedSecrets, Keychain}, ProviderStore};
use sessions::SiteSessions;
use std::sync::Arc;
use store::Store;
use tauri::http::{header, Response, StatusCode};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
async fn open_url(app: AppHandle, store: State<'_, Store>, url: String, refresh: Option<bool>, preview_request: Option<String>) -> Result<Source, AppError> {
    import::open_url(&app, &store, &url, refresh.unwrap_or(false), preview_request.as_deref()).await
}

#[tauri::command]
async fn refetch_source(app: AppHandle, store: State<'_, Store>, id: String) -> Result<import::RefetchOutcome, AppError> {
    import::refetch(&app, &store, &id).await
}

#[tauri::command]
async fn adopt_candidate(store: State<'_, Store>, id: String, candidate_id: String) -> Result<Source, AppError> {
    import::adopt_candidate(&store, &id, &candidate_id)
}

#[tauri::command]
async fn discard_candidate(store: State<'_, Store>, id: String, candidate_id: String) -> Result<(), AppError> {
    import::discard_candidate(&store, &id, &candidate_id)
}

#[tauri::command]
async fn accept_incomplete(store: State<'_, Store>, id: String) -> Result<Source, AppError> {
    import::accept_incomplete(&store, &id)
}

#[tauri::command]
async fn set_hide_floating(store: State<'_, Store>, id: String, hide: bool) -> Result<Source, AppError> {
    import::set_hide_floating(&store, &id, hide)
}

#[tauri::command]
async fn set_ai_language(store: State<'_, Store>, id: String, language: Option<String>) -> Result<Source, AppError> {
    import::set_ai_language(&store, &id, language)
}

#[tauri::command]
async fn import_pdf(store: State<'_, Store>, request: Request<'_>) -> Result<Source, AppError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new("pdf", i18n::tr("The file did not arrive intact.", "Het bestand is niet goed aangekomen.", "Dosya düzgün ulaşmadı.")));
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
async fn import_text(store: State<'_, Store>, title: Option<String>, url: Option<String>, text: String, markdown: Option<bool>) -> Result<Source, AppError> {
    import::import_text(&store, title, url, &text, markdown)
}

/// Opent de projectpagina op GitHub in de gewone browser. Het adres staat vast; de voorkant geeft niets mee.
#[tauri::command]
async fn open_project_page() -> Result<(), AppError> {
    let failed = |detail: String| AppError::new("browser", i18n::tr("The browser could not be opened.", "De browser kon niet worden geopend.", "Tarayıcı açılamadı.")).with_detail(detail);
    let status = std::process::Command::new("open").arg("https://github.com/gevezex/Deepdive").status().map_err(|e| failed(e.to_string()))?;
    status.success().then_some(()).ok_or_else(|| failed(status.to_string()))
}

#[tauri::command]
async fn list_sources(store: State<'_, Store>) -> Result<Vec<SourceSummary>, AppError> {
    Ok(store.summaries())
}

/// Verwijdert een artikel voorgoed, met alle versies, markeringen, vragen en blauwdrukken.
#[tauri::command]
async fn delete_source(store: State<'_, Store>, id: String) -> Result<(), AppError> {
    store.remove_with_versions(&id)
}

#[tauri::command]
async fn get_source(store: State<'_, Store>, id: String) -> Result<Source, AppError> {
    store.get(&id)
}

/// Serveert de visuele kopie aan de afgeschermde iframe. Antwoordt zelf nooit met iets buiten de bronmap.
fn serve_snapshot(app: &AppHandle, request: tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin_is_opaque = request.headers().get(header::ORIGIN).is_some_and(|o| o == "null");
    let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    if let Some(html) = app.state::<preview::Previews>().file(request.uri().path()) {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, snapshot::PREVIEW_CSP)
            .header("X-Content-Type-Options", "nosniff")
            .header(header::REFERRER_POLICY, "no-referrer")
            .body(html)
            .unwrap();
    }
    let store = app.state::<Store>();
    let Some(path) = store.snapshot_file(request.uri().path()) else { return not_found() };
    let Ok(bytes) = std::fs::read(&path) else { return not_found() };
    // Zo werkt springen zonder iets aan de afscherming te veranderen: de iframe krijgt een nieuwe pagina met de
    // alinea's al gemarkeerd, en het adres eindigt op een anker waar de browser zelf heen scrolt.
    let bytes = match request.uri().query().and_then(snapshot::highlight_query) {
        Some(ranges) if store::mime_for(&path).starts_with("text/html") => snapshot::highlight(bytes, &ranges),
        _ => bytes,
    };
    // De lezer koos "Popup weghalen": de server zet een stijl in de pagina. De kopie op schijf blijft zoals ze is.
    let is_page = store::mime_for(&path).starts_with("text/html");
    let bytes = if is_page && store.snapshot_hides_floating(request.uri().path()) {
        snapshot::hide_floating(bytes, path.parent().map(|dir| dir.join("assets")).as_deref())
    } else {
        bytes
    };
    // Het eigen script voor selecteren en markeren. De CSP in de kop laat alleen dat script toe.
    let (bytes, csp) = if is_page { (snapshot::with_bridge(bytes), snapshot::page_csp()) } else { (bytes, snapshot::CSP) };
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, store::mime_for(&path))
        .header(header::CONTENT_SECURITY_POLICY, csp)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("deepdive-snapshot", |ctx, request, responder| {
            // Alleen het hoofdvenster: een pagina in een inlog- of ophaalvenster komt niet bij opgeslagen kopieën.
            if ctx.webview_label() != "main" {
                responder.respond(Response::builder().status(StatusCode::FORBIDDEN).body(Vec::new()).unwrap());
                return;
            }
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
            app.manage(ProviderStore::open(root.clone(), Arc::new(CachedSecrets::new(Keychain::new(keychain_service))))?);
            app.manage(SiteSessions::open(root.clone()));
            app.manage(blueprint::commands::Jobs::default());
            app.manage(professor::commands::Asks::default());
            app.manage(Store::new(root)?);
            app.manage(preview::Previews::default());
            app.manage(update::Pending::default());
            sessions::finish_pending_wipes(app.handle().clone());
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
            open_project_page,
            list_sources,
            get_source,
            delete_source,
            refetch_source,
            adopt_candidate,
            discard_candidate,
            accept_incomplete,
            set_hide_floating,
            set_ai_language,
            i18n::set_ui_language,
            blueprint::commands::generate_blueprint,
            blueprint::commands::cancel_blueprint,
            blueprint::commands::saved_blueprints,
            professor::commands::ask_professor,
            professor::commands::cancel_ask,
            professor::commands::list_threads,
            professor::commands::delete_thread,
            professor::commands::list_highlights,
            professor::commands::save_highlight,
            professor::commands::delete_highlight,
            sessions::site_login_open,
            sessions::site_login_close,
            sessions::list_site_sessions,
            sessions::wipe_site_session,
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
            update::check_update,
            update::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("Deepdive kon niet starten");
}
