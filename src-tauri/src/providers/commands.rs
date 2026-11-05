//! De commando's voor de interface. Geen van deze antwoorden bevat ooit een sleutel of token: `ProvidersFile`
//! kent alleen `hasKey`, en `ApiKey` is niet te serialiseren.

use super::{KeyChange, ModelInput, ModelRef, Provider, ProviderInput, ProviderStore, ProvidersFile};
use crate::ai::{self, ConnectionReport, StreamEvent};
use crate::error::AppError;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub async fn list_providers(store: State<'_, ProviderStore>) -> Result<ProvidersFile, AppError> {
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn save_provider(store: State<'_, ProviderStore>, input: ProviderInput, key: KeyChange) -> Result<Provider, AppError> {
    store.save_provider(input, key)
}

#[tauri::command]
pub async fn delete_provider(store: State<'_, ProviderStore>, id: String) -> Result<(), AppError> {
    if store.is_chatgpt(&id) {
        // Eerst de sessie intrekken; lukt dat niet, dan gaan de tokens hieronder toch weg.
        let _ = store.hub().logout(&id).await;
    }
    store.delete_provider(&id)
}

#[tauri::command]
pub async fn save_model(store: State<'_, ProviderStore>, provider_id: String, input: ModelInput) -> Result<Provider, AppError> {
    store.upsert_model(&provider_id, input)
}

#[tauri::command]
pub async fn delete_model(store: State<'_, ProviderStore>, provider_id: String, model_id: String) -> Result<Provider, AppError> {
    store.delete_model(&provider_id, &model_id)
}

#[tauri::command]
pub async fn refresh_models(store: State<'_, ProviderStore>, provider_id: String) -> Result<Provider, AppError> {
    let endpoint = store.endpoint(&provider_id)?;
    let fetched = ai::list_models(&endpoint).await?;
    store.merge_fetched(&provider_id, fetched)
}

#[tauri::command]
pub async fn select_model(store: State<'_, ProviderStore>, selection: Option<ModelRef>) -> Result<(), AppError> {
    store.select(selection)
}

#[tauri::command]
pub async fn test_connection(store: State<'_, ProviderStore>, provider_id: String, model_id: Option<String>, on_event: Channel<StreamEvent>) -> Result<ConnectionReport, AppError> {
    let endpoint = store.endpoint(&provider_id)?;
    let target = match model_id {
        Some(model_id) => Some(store.target(&ModelRef { provider_id, model_id })?),
        None => None,
    };
    ai::check_connection(&endpoint, target, |event| {
        let _ = on_event.send(event.clone());
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    provider: Provider,
    show_welcome: bool,
    /// Inloggen is gelukt, maar de modellen konden niet worden opgehaald.
    models_error: Option<AppError>,
}

/// Wacht op de browser, dus dit commando kan minuten duren; de rest van de app blijft gewoon werken.
#[tauri::command]
pub async fn chatgpt_login(store: State<'_, ProviderStore>, provider_id: Option<String>, ask_consent: bool) -> Result<LoginOutcome, AppError> {
    let request = store.login_request(provider_id.as_deref(), ask_consent)?;
    let result = store.hub().login(request).await?;
    let (mut provider, show_welcome) = store.finish_login(provider_id.as_deref(), result)?;
    let mut models_error = None;
    if provider.chatgpt.as_ref().is_some_and(|a| a.plan_enabled) {
        let fetched = match store.endpoint(&provider.id) {
            Ok(endpoint) => ai::list_models(&endpoint).await,
            Err(e) => Err(e),
        };
        match fetched.and_then(|models| store.merge_fetched(&provider.id, models)) {
            Ok(updated) => provider = updated,
            Err(e) => models_error = Some(e),
        }
    }
    Ok(LoginOutcome { provider, show_welcome, models_error })
}

#[tauri::command]
pub async fn chatgpt_cancel_login(store: State<'_, ProviderStore>) -> Result<(), AppError> {
    store.hub().cancel_login();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutOutcome {
    provider: Provider,
    /// Of OpenAI het intrekken van de sessie bevestigde.
    revoked: bool,
}

#[tauri::command]
pub async fn chatgpt_logout(store: State<'_, ProviderStore>, provider_id: String) -> Result<LogoutOutcome, AppError> {
    if !store.is_chatgpt(&provider_id) {
        return Err(AppError::new("provider_not_found", "Deze provider bestaat niet meer."));
    }
    let revoked = store.hub().logout(&provider_id).await?;
    Ok(LogoutOutcome { provider: store.finish_logout(&provider_id)?, revoked })
}

#[tauri::command]
pub async fn chatgpt_welcome_seen(store: State<'_, ProviderStore>) -> Result<(), AppError> {
    store.mark_welcome_seen()
}

/// Opent altijd hetzelfde vaste adres; de pagina kiest niet waarheen.
#[tauri::command]
pub async fn open_chatgpt_usage(store: State<'_, ProviderStore>) -> Result<(), AppError> {
    store.hub().open_usage()
}
