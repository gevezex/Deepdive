//! De commando's voor de interface. Geen van deze antwoorden bevat ooit een sleutel: `ProvidersFile` kent
//! alleen `hasKey`, en `ApiKey` is niet te serialiseren.

use super::{KeyChange, ModelInput, ModelRef, Provider, ProviderInput, ProviderStore, ProvidersFile};
use crate::ai::{self, ConnectionReport, StreamEvent};
use crate::error::AppError;
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
