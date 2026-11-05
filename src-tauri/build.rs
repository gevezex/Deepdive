fn main() {
    // Met een lijst commando's gaan ook de eigen commando's via de rechten. Zo kan een pagina in het
    // verborgen venster ze niet aanroepen: alleen het hoofdvenster heeft een capability.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "open_url",
        "import_pdf",
        "save_pdf_text",
        "read_pdf",
        "import_text",
        "list_sources",
        "get_source",
        "refetch_source",
        "adopt_candidate",
        "discard_candidate",
        "accept_incomplete",
        "site_login_open",
        "site_login_close",
        "list_site_sessions",
        "wipe_site_session",
        "list_providers",
        "save_provider",
        "delete_provider",
        "save_model",
        "delete_model",
        "refresh_models",
        "select_model",
        "test_connection",
        "chatgpt_login",
        "chatgpt_cancel_login",
        "chatgpt_logout",
        "chatgpt_welcome_seen",
        "open_chatgpt_usage",
    ])))
    .expect("tauri-build mislukte");
}
