//! Providers en modellen. De gegevens staan in `providers.json`, de sleutels alleen in de sleutelhanger.
//! In het bestand staat per provider enkel `hasKey`, zodat de app zonder sleutelhanger weet wat ze kan tonen.
//! Een ChatGPT-koppeling werkt net zo: `hasKey` betekent ingelogd, de tokens staan alleen in de sleutelhanger.

pub mod commands;
pub mod secrets;

use crate::ai::{self, ApiKey, ApiKind, Endpoint, FetchedModel, Target};
use crate::chatgpt::{self, AccountChange, AccountSink, Hub, LoginRequest, LoginResult, Returning, Session};
use crate::error::AppError;
use secrets::SecretStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use url::Url;

const SCHEMA_VERSION: u32 = 1;
/// Bij meer modellen dan dit kiest de gebruiker zelf wat in de kiezer komt (OpenRouter heeft er honderden).
const AUTO_ENABLE_LIMIT: usize = 15;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub display_name: Option<String>,
    /// `None` is onbekend.
    pub supports_images: Option<bool>,
    pub context_tokens: Option<u32>,
    /// Staat in de modelkiezer.
    pub enabled: bool,
    /// Zelf toegevoegd: blijft staan als de provider het model niet noemt.
    pub manual: bool,
    /// Zelf aangepaste mogelijkheden: opnieuw ophalen overschrijft ze niet.
    pub user_edited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub kind: ApiKind,
    pub base_url: String,
    pub has_key: bool,
    pub models: Vec<Model>,
    /// Alleen bij een ChatGPT-koppeling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt: Option<ChatgptAccount>,
}

/// Wat de app over een koppeling weet zonder de sleutelhanger. Hier staat geen token in. De client-ID blijft
/// na uitloggen bewaard, zodat opnieuw inloggen geen nieuwe registratie maakt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptAccount {
    pub client_id: String,
    pub subject: String,
    pub email: Option<String>,
    pub plan_enabled: bool,
    /// De sessie bleek ingetrokken of verlopen; de gebruiker logde niet zelf uit.
    pub session_lost: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// De keuze bovenaan het rechterpaneel.
    pub active: Option<ModelRef>,
    /// Voorbereiding op "model per actie", met de actie als sleutel. Nog zonder scherm.
    #[serde(default)]
    pub per_action: BTreeMap<String, ModelRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersFile {
    pub schema_version: u32,
    pub providers: Vec<Provider>,
    pub selection: Selection,
    /// De bevestiging "You're using your ChatGPT plan" verschijnt maar één keer.
    #[serde(default)]
    pub chatgpt_welcome_seen: bool,
}

impl Default for ProvidersFile {
    fn default() -> Self {
        Self { schema_version: SCHEMA_VERSION, providers: vec![], selection: Selection::default(), chatgpt_welcome_seen: false }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: ApiKind,
    pub base_url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum KeyChange {
    #[default]
    Keep,
    Set { value: ApiKey },
    Clear,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInput {
    pub id: String,
    pub supports_images: Option<bool>,
    pub context_tokens: Option<u32>,
    pub enabled: bool,
}

pub fn normalize_base_url(input: &str, kind: ApiKind) -> Result<Url, AppError> {
    let invalid = || AppError::new("invalid_address", "Dit is geen geldig adres. Gebruik bijvoorbeeld https://api.openai.com/v1 of http://localhost:11434/v1.");
    let mut url = Url::parse(input.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(AppError::new("invalid_address", "Zet geen inlognaam, sleutel of andere extra's in het adres. De sleutel heeft een eigen veld."));
    }
    let mut path = url.path().trim_end_matches('/').to_string();
    if kind == ApiKind::Anthropic {
        path = path.strip_suffix("/v1").unwrap_or(&path).to_string();
    }
    url.set_path(&path);
    Ok(url)
}

fn clean_key(key: &ApiKey) -> Result<ApiKey, AppError> {
    let value = key.expose().trim();
    if value.is_empty() {
        return Err(AppError::new("key_invalid", "De sleutel is leeg."));
    }
    if !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(AppError::new("key_invalid", "De sleutel bevat tekens die er niet in horen, zoals spaties of regeleinden. Kopieer hem opnieuw."));
    }
    Ok(ApiKey::new(value))
}

fn account(provider_id: &str) -> String {
    format!("provider:{provider_id}")
}

pub struct ProviderStore {
    path: PathBuf,
    state: Arc<Mutex<ProvidersFile>>,
    secrets: Arc<dyn SecretStore>,
    hub: Arc<Hub>,
    sink: AccountSink,
}

fn write_file(path: &std::path::Path, state: &ProvidersFile) -> Result<(), AppError> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).map_err(AppError::storage)?).map_err(AppError::storage)?;
    std::fs::rename(tmp, path).map_err(AppError::storage)
}

impl ProviderStore {
    pub fn open(root: PathBuf, secrets: Arc<dyn SecretStore>) -> Result<Self, AppError> {
        Self::open_with(root, secrets, chatgpt::Config::for_app())
    }

    pub fn open_with(root: PathBuf, secrets: Arc<dyn SecretStore>, config: chatgpt::Config) -> Result<Self, AppError> {
        std::fs::create_dir_all(&root).map_err(AppError::storage)?;
        let path = root.join("providers.json");
        let state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                // Niet overschrijven: bewaar het kapotte bestand zodat er iets te redden valt.
                let _ = std::fs::rename(&path, root.join("providers.json.kapot"));
                ProvidersFile::default()
            }),
            Err(_) => ProvidersFile::default(),
        };
        let state = Arc::new(Mutex::new(state));
        let hub = Arc::new(Hub::new(config, secrets.clone(), root));
        // Wat tijdens gebruik blijkt, zoals een ingetrokken sessie, moet ook in de opgeslagen gegevens komen.
        let sink: AccountSink = {
            let (state, path) = (state.clone(), path.clone());
            Arc::new(move |provider_id: &str, change: AccountChange| {
                let mut guard = state.lock().unwrap();
                let Some(provider) = guard.providers.iter_mut().find(|p| p.id == provider_id) else { return };
                let Some(account) = provider.chatgpt.as_mut() else { return };
                match change {
                    AccountChange::SessionLost => {
                        account.session_lost = true;
                        provider.has_key = false;
                    }
                    AccountChange::PlanDisabled => account.plan_enabled = false,
                }
                let _ = write_file(&path, &guard);
            })
        };
        Ok(Self { path, state, secrets, hub, sink })
    }

    fn persist(&self, state: &ProvidersFile) -> Result<(), AppError> {
        write_file(&self.path, state)
    }

    /// Voert een wijziging uit en bewaart die. Mislukt de wijziging of het opslaan, dan blijft alles zoals het was.
    fn change<T>(&self, apply: impl FnOnce(&mut ProvidersFile) -> Result<T, AppError>) -> Result<T, AppError> {
        let mut guard = self.state.lock().unwrap();
        let mut next = guard.clone();
        let out = apply(&mut next)?;
        remove_dangling_selection(&mut next);
        self.persist(&next)?;
        *guard = next;
        Ok(out)
    }

    pub fn snapshot(&self) -> ProvidersFile {
        self.state.lock().unwrap().clone()
    }

    pub fn save_provider(&self, input: ProviderInput, key: KeyChange) -> Result<Provider, AppError> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::new("invalid_name", "Geef de provider een naam."));
        }
        let url = normalize_base_url(&input.base_url, input.kind)?;
        let key = match key {
            KeyChange::Set { value } => KeyChange::Set { value: clean_key(&value)? },
            other => other,
        };
        let id = input.id.clone().unwrap_or_else(crate::store::new_id);

        let provider = self.change(|state| {
            let existing = state.providers.iter().find(|p| p.id == id);
            if input.id.is_some() && existing.is_none() {
                return Err(not_found());
            }
            // Een ChatGPT-koppeling ontstaat alleen door in te loggen. Daarna is alleen de naam te wijzigen.
            let was_chatgpt = existing.is_some_and(|p| p.kind == ApiKind::ChatgptPlan);
            if was_chatgpt != (input.kind == ApiKind::ChatgptPlan) || (was_chatgpt && !matches!(key, KeyChange::Keep)) {
                return Err(AppError::new("chatgpt_only_login", "Een ChatGPT-koppeling maak je met de knop Continue with ChatGPT en heeft geen API-sleutel."));
            }
            if was_chatgpt {
                let slot = provider_mut(state, &id)?;
                slot.name = name;
                return Ok(slot.clone());
            }
            let had_key = existing.is_some_and(|p| p.has_key);
            let has_key = match &key {
                KeyChange::Keep => had_key,
                KeyChange::Set { .. } => true,
                KeyChange::Clear => false,
            };
            if has_key {
                ai::check_key_transport(&url)?;
            }
            // Een bewaarde sleutel gaat niet stilzwijgend mee naar een andere host.
            if let (KeyChange::Keep, true, Some(old)) = (&key, had_key, existing) {
                let old_url = Url::parse(&old.base_url).ok();
                if old_url.as_ref().and_then(|u| u.host_str()) != url.host_str() {
                    return Err(AppError::new("key_host_changed", "Het adres wijst nu naar een andere server. Vul de sleutel opnieuw in, of haal hem weg, zodat je oude sleutel daar niet terechtkomt."));
                }
            }
            let mut provider = existing.cloned().unwrap_or(Provider { id: id.clone(), name: String::new(), kind: input.kind, base_url: String::new(), has_key: false, models: vec![], chatgpt: None });
            provider.name = name;
            provider.kind = input.kind;
            provider.base_url = url.to_string().trim_end_matches('/').to_string();
            provider.has_key = has_key;
            match state.providers.iter_mut().find(|p| p.id == id) {
                Some(slot) => *slot = provider.clone(),
                None => state.providers.push(provider.clone()),
            }
            // Eerst de sleutelhanger: als die weigert, verandert er niets in het bestand.
            match &key {
                KeyChange::Set { value } => self.secrets.set(&account(&id), value)?,
                KeyChange::Clear => self.secrets.delete(&account(&id))?,
                KeyChange::Keep => {}
            }
            Ok(provider)
        })?;
        Ok(provider)
    }

    pub fn delete_provider(&self, id: &str) -> Result<(), AppError> {
        self.change(|state| {
            let before = state.providers.len();
            let was_chatgpt = state.providers.iter().any(|p| p.id == id && p.kind == ApiKind::ChatgptPlan);
            state.providers.retain(|p| p.id != id);
            if state.providers.len() == before {
                return Err(not_found());
            }
            // Eerst de sleutel: mislukt dat, dan blijft de provider staan en is de sleutel niet onvindbaar.
            self.secrets.delete(&account(id))?;
            if was_chatgpt {
                self.hub.delete_credentials(id)?;
            }
            Ok(())
        })
    }

    pub fn upsert_model(&self, provider_id: &str, input: ModelInput) -> Result<Provider, AppError> {
        let id = input.id.trim().to_string();
        if id.is_empty() || id.len() > 300 || id.chars().any(char::is_control) {
            return Err(AppError::new("invalid_model", "Vul de naam van het model in, precies zoals de provider die gebruikt."));
        }
        if input.context_tokens == Some(0) {
            return Err(AppError::new("invalid_model", "De context moet groter zijn dan nul, of leeg als die onbekend is."));
        }
        self.change(|state| {
            let provider = provider_mut(state, provider_id)?;
            match provider.models.iter_mut().find(|m| m.id == id) {
                Some(model) => {
                    model.user_edited |= model.supports_images != input.supports_images || model.context_tokens != input.context_tokens;
                    model.supports_images = input.supports_images;
                    model.context_tokens = input.context_tokens;
                    model.enabled = input.enabled;
                }
                None => {
                    provider.models.push(Model { id, display_name: None, supports_images: input.supports_images, context_tokens: input.context_tokens, enabled: input.enabled, manual: true, user_edited: true });
                    sort_models(provider);
                }
            }
            Ok(provider.clone())
        })
    }

    pub fn delete_model(&self, provider_id: &str, model_id: &str) -> Result<Provider, AppError> {
        self.change(|state| {
            let provider = provider_mut(state, provider_id)?;
            provider.models.retain(|m| m.id != model_id);
            Ok(provider.clone())
        })
    }

    /// Verwerkt de lijst van de provider. Eigen aanpassingen en zelf toegevoegde modellen blijven staan.
    pub fn merge_fetched(&self, provider_id: &str, fetched: Vec<FetchedModel>) -> Result<Provider, AppError> {
        self.change(|state| {
            let provider = provider_mut(state, provider_id)?;
            let enable_new = fetched.len() <= AUTO_ENABLE_LIMIT;
            let order: Vec<String> = fetched.iter().map(|f| f.id.clone()).collect();
            provider.models.retain(|m| m.manual || m.user_edited || fetched.iter().any(|f| f.id == m.id));
            for f in fetched {
                match provider.models.iter_mut().find(|m| m.id == f.id) {
                    Some(model) => {
                        model.display_name = f.display_name.or(model.display_name.take());
                        if !model.user_edited {
                            model.supports_images = f.supports_images.or(model.supports_images);
                            model.context_tokens = f.context_tokens.or(model.context_tokens);
                        }
                    }
                    None => provider.models.push(Model { id: f.id, display_name: f.display_name, supports_images: f.supports_images, context_tokens: f.context_tokens, enabled: enable_new, manual: false, user_edited: false }),
                }
            }
            if provider.kind == ApiKind::ChatgptPlan {
                // De volgorde van de server blijft staan; eigen modellen komen erachter.
                provider.models.sort_by_key(|m| order.iter().position(|id| *id == m.id).unwrap_or(usize::MAX));
            }
            sort_models(provider);
            Ok(provider.clone())
        })
    }

    pub fn select(&self, selection: Option<ModelRef>) -> Result<(), AppError> {
        self.change(|state| {
            if let Some(chosen) = &selection {
                let known = state.providers.iter().any(|p| p.id == chosen.provider_id && p.models.iter().any(|m| m.id == chosen.model_id));
                if !known {
                    return Err(AppError::new("unknown_model", "Dit model staat niet (meer) in de lijst."));
                }
            }
            state.selection.active = selection;
            Ok(())
        })
    }

    /// Het model voor een actie: de eigen keuze voor die actie, anders de keuze bovenaan het paneel.
    #[allow(dead_code)] // Wordt gebruikt zodra stap 3 de eerste actie toevoegt.
    pub fn model_for_action(&self, action: &str) -> Option<ModelRef> {
        let selection = self.state.lock().unwrap().selection.clone();
        selection.per_action.get(action).cloned().or(selection.active)
    }

    /// Alleen hier komt een sleutel de sleutelhanger uit, en alleen om in een `Endpoint` naar de AI-laag te gaan.
    pub fn endpoint(&self, provider_id: &str) -> Result<Endpoint, AppError> {
        let (kind, base_url, has_key, chatgpt_account) = {
            let state = self.state.lock().unwrap();
            let p = state.providers.iter().find(|p| p.id == provider_id).ok_or_else(not_found)?;
            (p.kind, p.base_url.clone(), p.has_key, p.chatgpt.clone())
        };
        if kind == ApiKind::ChatgptPlan {
            let account = chatgpt_account.ok_or_else(chatgpt::signed_out)?;
            if !has_key {
                return Err(if account.session_lost { chatgpt::session_revoked() } else { chatgpt::signed_out() });
            }
            if !account.plan_enabled {
                return Err(chatgpt::plan_disabled());
            }
            // Altijd het vaste adres, niet wat in het bestand staat: de tokens gaan alleen naar OpenAI.
            let session = Session::new(self.hub.clone(), provider_id.to_string(), account.client_id, self.sink.clone());
            return Ok(Endpoint::chatgpt(self.hub.api_base(), Arc::new(session)));
        }
        let url = normalize_base_url(&base_url, kind)?;
        let key = if has_key {
            ai::check_key_transport(&url)?;
            let key = self.secrets.get(&account(provider_id))?;
            Some(key.ok_or_else(|| AppError::new("key_missing", "De sleutel van deze provider staat niet meer in de sleutelhanger. Vul hem opnieuw in."))?)
        } else {
            None
        };
        Ok(Endpoint::new(kind, url, key))
    }

    /// Alles wat de AI-laag nodig heeft om een bewaard model aan te roepen.
    pub fn target(&self, chosen: &ModelRef) -> Result<Target, AppError> {
        let model = {
            let state = self.state.lock().unwrap();
            let p = state.providers.iter().find(|p| p.id == chosen.provider_id).ok_or_else(not_found)?;
            p.models.iter().find(|m| m.id == chosen.model_id).cloned()
        }
        .ok_or_else(|| AppError::new("unknown_model", "Dit model staat niet (meer) in de lijst."))?;
        Ok(Target { endpoint: self.endpoint(&chosen.provider_id)?, model: model.id, supports_images: model.supports_images, context_tokens: model.context_tokens })
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    /// Wat de login moet weten over een bestaande koppeling. Zonder ID gaat het om een nieuwe registratie.
    pub fn login_request(&self, provider_id: Option<&str>, ask_consent: bool) -> Result<LoginRequest, AppError> {
        let Some(id) = provider_id else { return Ok(LoginRequest { returning: None, ask_consent }) };
        let state = self.state.lock().unwrap();
        let provider = state.providers.iter().find(|p| p.id == id).ok_or_else(not_found)?;
        let account = provider.chatgpt.as_ref().ok_or_else(not_found)?;
        Ok(LoginRequest { returning: Some(Returning { client_id: account.client_id.clone(), subject: account.subject.clone(), email: account.email.clone() }), ask_consent })
    }

    /// Bewaart een gecontroleerde login. Pas hier raakt die een bestaande koppeling. Geeft ook terug of de
    /// bevestiging over het abonnement nog getoond moet worden.
    pub fn finish_login(&self, provider_id: Option<&str>, result: LoginResult) -> Result<(Provider, bool), AppError> {
        let id = provider_id.map(String::from).unwrap_or_else(crate::store::new_id);
        let plan_enabled = result.credentials.plan_enabled();
        let api_base = self.hub.api_base().to_string().trim_end_matches('/').to_string();
        self.change(|state| {
            let account = ChatgptAccount { client_id: result.client_id, subject: result.subject, email: result.email, plan_enabled, session_lost: false };
            if !state.providers.iter().any(|p| p.id == id) {
                let name = unique_chatgpt_name(state, account.email.as_deref());
                state.providers.push(Provider { id: id.clone(), name, kind: ApiKind::ChatgptPlan, base_url: api_base, has_key: true, models: vec![], chatgpt: None });
            }
            let provider = provider_mut(state, &id)?;
            provider.has_key = true;
            provider.chatgpt = Some(account);
            let provider = provider.clone();
            self.hub.store_credentials(&id, &result.credentials)?;
            Ok((provider, plan_enabled && !state.chatgpt_welcome_seen))
        })
    }

    /// Na uitloggen: de tokens zijn weg, de koppeling met de client-ID blijft voor een volgende login.
    pub fn finish_logout(&self, provider_id: &str) -> Result<Provider, AppError> {
        self.change(|state| {
            let provider = provider_mut(state, provider_id)?;
            provider.has_key = false;
            if let Some(account) = provider.chatgpt.as_mut() {
                account.session_lost = false;
            }
            Ok(provider.clone())
        })
    }

    pub fn is_chatgpt(&self, provider_id: &str) -> bool {
        self.state.lock().unwrap().providers.iter().any(|p| p.id == provider_id && p.kind == ApiKind::ChatgptPlan)
    }

    pub fn mark_welcome_seen(&self) -> Result<(), AppError> {
        self.change(|state| {
            state.chatgpt_welcome_seen = true;
            Ok(())
        })
    }
}

/// Een herkenbare naam, ook als iemand twee koppelingen met hetzelfde e-mailadres heeft.
fn unique_chatgpt_name(state: &ProvidersFile, email: Option<&str>) -> String {
    let base = email.map_or("ChatGPT".to_string(), |e| format!("ChatGPT ({e})"));
    let taken = |name: &str| state.providers.iter().any(|p| p.name == name);
    if !taken(&base) {
        return base;
    }
    (2..).map(|n| format!("{base} {n}")).find(|name| !taken(name)).expect("oneindige reeks")
}

fn not_found() -> AppError {
    AppError::new("provider_not_found", "Deze provider bestaat niet meer.")
}

fn provider_mut<'a>(state: &'a mut ProvidersFile, id: &str) -> Result<&'a mut Provider, AppError> {
    state.providers.iter_mut().find(|p| p.id == id).ok_or_else(not_found)
}

fn sort_models(provider: &mut Provider) {
    if provider.kind == ApiKind::ChatgptPlan {
        return;
    }
    provider.models.sort_by_key(|m| m.id.to_lowercase());
}

fn remove_dangling_selection(state: &mut ProvidersFile) {
    let exists = |r: &ModelRef| state.providers.iter().any(|p| p.id == r.provider_id && p.models.iter().any(|m| m.id == r.model_id));
    let active = state.selection.active.clone().filter(|r| exists(r));
    let per_action = state.selection.per_action.clone().into_iter().filter(|(_, r)| exists(r)).collect();
    state.selection.active = active;
    state.selection.per_action = per_action;
}

#[cfg(test)]
mod tests {
    use super::secrets::MemorySecrets;
    use super::*;

    const KEY: &str = "nep-sleutel-QX7Z-niet-echt";

    fn store(dir: &std::path::Path) -> (ProviderStore, Arc<MemorySecrets>) {
        let secrets = Arc::new(MemorySecrets::default());
        (ProviderStore::open(dir.to_path_buf(), secrets.clone()).unwrap(), secrets)
    }

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deepdive-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn input(id: Option<&str>, url: &str) -> ProviderInput {
        ProviderInput { id: id.map(String::from), name: "Test".into(), kind: ApiKind::OpenaiCompatible, base_url: url.into() }
    }

    fn set(key: &str) -> KeyChange {
        KeyChange::Set { value: ApiKey::new(key) }
    }

    fn fetched(id: &str, context: Option<u32>) -> FetchedModel {
        FetchedModel { id: id.into(), display_name: None, supports_images: None, context_tokens: context }
    }

    #[test]
    fn key_only_lives_in_the_secret_store() {
        let dir = tmp();
        let (store, secrets) = store(&dir);
        let p = store.save_provider(input(None, "https://api.example.com/v1/"), set(KEY)).unwrap();
        assert!(p.has_key);
        assert_eq!(p.base_url, "https://api.example.com/v1");
        assert_eq!(secrets.0.lock().unwrap().get(&account(&p.id)).unwrap(), KEY);
        let on_disk = std::fs::read_to_string(dir.join("providers.json")).unwrap();
        assert!(!on_disk.contains(KEY));
        assert!(on_disk.contains("\"hasKey\": true"));
        let shown = serde_json::to_string(&store.snapshot()).unwrap();
        assert!(!shown.contains(KEY), "de frontend-weergave bevat de sleutel");
        assert!(!format!("{:?}", store.endpoint(&p.id).unwrap()).contains(KEY), "Debug toont de sleutel");
        assert_eq!(store.endpoint(&p.id).unwrap().api_key.unwrap().expose(), KEY);
    }

    #[test]
    fn providers_survive_a_restart_and_keep_their_key_reference() {
        let dir = tmp();
        let secrets = Arc::new(MemorySecrets::default());
        let first = ProviderStore::open(dir.clone(), secrets.clone()).unwrap();
        let p = first.save_provider(input(None, "http://localhost:11434/v1"), set(KEY)).unwrap();
        first.upsert_model(&p.id, ModelInput { id: "m".into(), supports_images: Some(true), context_tokens: Some(1000), enabled: true }).unwrap();
        first.select(Some(ModelRef { provider_id: p.id.clone(), model_id: "m".into() })).unwrap();
        drop(first);
        let second = ProviderStore::open(dir, secrets).unwrap();
        let state = second.snapshot();
        assert_eq!(state.providers[0].models[0].context_tokens, Some(1000));
        assert_eq!(state.selection.active.unwrap().model_id, "m");
        assert_eq!(second.endpoint(&p.id).unwrap().api_key.unwrap().expose(), KEY);
    }

    #[test]
    fn deleting_removes_the_key_and_the_selection() {
        let dir = tmp();
        let (store, secrets) = store(&dir);
        let p = store.save_provider(input(None, "https://api.example.com/v1"), set(KEY)).unwrap();
        store.upsert_model(&p.id, ModelInput { id: "m".into(), supports_images: None, context_tokens: None, enabled: true }).unwrap();
        store.select(Some(ModelRef { provider_id: p.id.clone(), model_id: "m".into() })).unwrap();
        store.delete_provider(&p.id).unwrap();
        assert!(secrets.0.lock().unwrap().is_empty());
        assert!(store.snapshot().selection.active.is_none());
    }

    #[test]
    fn key_can_be_cleared_and_is_not_carried_to_another_host() {
        let dir = tmp();
        let (store, secrets) = store(&dir);
        let p = store.save_provider(input(None, "https://a.example.com/v1"), set(KEY)).unwrap();
        // Zelfde host mag.
        store.save_provider(input(Some(&p.id), "https://a.example.com/v2"), KeyChange::Keep).unwrap();
        let err = store.save_provider(input(Some(&p.id), "https://b.example.com/v1"), KeyChange::Keep).unwrap_err();
        assert_eq!(err.kind, "key_host_changed");
        assert!(store.snapshot().providers[0].base_url.contains("a.example.com"));
        let p = store.save_provider(input(Some(&p.id), "https://b.example.com/v1"), KeyChange::Clear).unwrap();
        assert!(!p.has_key);
        assert!(secrets.0.lock().unwrap().is_empty());
        assert!(store.endpoint(&p.id).unwrap().api_key.is_none());
    }

    #[test]
    fn key_needs_https_unless_local() {
        let dir = tmp();
        let (store, _) = store(&dir);
        assert_eq!(store.save_provider(input(None, "http://example.com/v1"), set(KEY)).unwrap_err().kind, "insecure_key");
        store.save_provider(input(None, "http://example.com/v1"), KeyChange::Keep).unwrap();
        store.save_provider(input(None, "http://127.0.0.1:1234/v1"), set(KEY)).unwrap();
        store.save_provider(input(None, "http://localhost:1234/v1"), set(KEY)).unwrap();
    }

    #[test]
    fn missing_key_in_keychain_is_reported() {
        let dir = tmp();
        let (store, secrets) = store(&dir);
        let p = store.save_provider(input(None, "https://a.example.com/v1"), set(KEY)).unwrap();
        secrets.0.lock().unwrap().clear();
        assert_eq!(store.endpoint(&p.id).unwrap_err().kind, "key_missing");
    }

    #[test]
    fn address_validation() {
        let ok = |s, k| normalize_base_url(s, k).unwrap().to_string();
        assert_eq!(ok("https://api.anthropic.com/v1/", ApiKind::Anthropic), "https://api.anthropic.com/");
        assert_eq!(ok(" http://localhost:11434/v1/ ", ApiKind::OpenaiCompatible), "http://localhost:11434/v1");
        for bad in ["", "localhost:11434", "ftp://a.nl", "https://user:geheim@a.nl/v1", "https://a.nl/v1?key=geheim", "https://a.nl/#x"] {
            let err = normalize_base_url(bad, ApiKind::OpenaiCompatible).unwrap_err();
            assert_eq!(err.kind, "invalid_address", "{bad}");
            assert!(!err.message.contains("geheim"));
        }
    }

    #[test]
    fn key_input_is_checked_without_echoing() {
        assert_eq!(clean_key(&ApiKey::new("  abc \n")).unwrap().expose(), "abc");
        for bad in ["", "   ", "ab cd", "é"] {
            assert!(clean_key(&ApiKey::new(bad)).is_err());
        }
        assert!(!clean_key(&ApiKey::new("geheim stuk")).unwrap_err().message.contains("geheim"));
    }

    #[test]
    fn refresh_keeps_own_changes() {
        let dir = tmp();
        let (store, _) = store(&dir);
        let id = store.save_provider(input(None, "http://localhost:1/v1"), KeyChange::Keep).unwrap().id;
        store.merge_fetched(&id, vec![fetched("a", Some(10)), fetched("b", Some(20)), fetched("weg", Some(30))]).unwrap();
        store.upsert_model(&id, ModelInput { id: "a".into(), supports_images: Some(true), context_tokens: Some(99), enabled: false }).unwrap();
        store.upsert_model(&id, ModelInput { id: "eigen".into(), supports_images: None, context_tokens: None, enabled: true }).unwrap();
        // Alleen aan/uit zetten telt niet als aanpassing van de mogelijkheden.
        store.upsert_model(&id, ModelInput { id: "b".into(), supports_images: None, context_tokens: Some(20), enabled: false }).unwrap();
        store.select(Some(ModelRef { provider_id: id.clone(), model_id: "weg".into() })).unwrap();

        let p = store.merge_fetched(&id, vec![fetched("a", Some(11)), fetched("b", Some(21)), fetched("nieuw", None)]).unwrap();
        let names: Vec<_> = p.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(names, ["a", "b", "eigen", "nieuw"]);
        assert_eq!(p.models[0].context_tokens, Some(99));
        assert!(!p.models[0].enabled);
        assert_eq!(p.models[1].context_tokens, Some(21));
        assert!(!p.models[1].enabled, "de eigen keuze aan/uit blijft staan");
        assert!(store.snapshot().selection.active.is_none(), "het verdwenen model is niet meer gekozen");
    }

    #[test]
    fn long_lists_stay_out_of_the_picker() {
        let dir = tmp();
        let (store, _) = store(&dir);
        let id = store.save_provider(input(None, "http://localhost:1/v1"), KeyChange::Keep).unwrap().id;
        let many = (0..AUTO_ENABLE_LIMIT + 1).map(|i| fetched(&format!("m{i}"), None)).collect();
        assert!(store.merge_fetched(&id, many).unwrap().models.iter().all(|m| !m.enabled));
    }

    #[test]
    fn action_falls_back_to_the_panel_choice() {
        let dir = tmp();
        let (store, _) = store(&dir);
        let id = store.save_provider(input(None, "http://localhost:1/v1"), KeyChange::Keep).unwrap().id;
        for m in ["sterk", "snel"] {
            store.upsert_model(&id, ModelInput { id: m.into(), supports_images: None, context_tokens: None, enabled: true }).unwrap();
        }
        store.select(Some(ModelRef { provider_id: id.clone(), model_id: "snel".into() })).unwrap();
        assert_eq!(store.model_for_action("blauwdruk").unwrap().model_id, "snel");
        store.change(|s| {
            s.selection.per_action.insert("blauwdruk".into(), ModelRef { provider_id: id.clone(), model_id: "sterk".into() });
            Ok(())
        }).unwrap();
        assert_eq!(store.model_for_action("blauwdruk").unwrap().model_id, "sterk");
        assert_eq!(store.model_for_action("uitleg").unwrap().model_id, "snel");
        store.delete_model(&id, "sterk").unwrap();
        assert_eq!(store.model_for_action("blauwdruk").unwrap().model_id, "snel");
    }

    #[test]
    fn a_broken_file_is_kept_aside() {
        let dir = tmp();
        std::fs::write(dir.join("providers.json"), "{kapot").unwrap();
        let (store, _) = store(&dir);
        assert!(store.snapshot().providers.is_empty());
        assert!(dir.join("providers.json.kapot").exists());
    }
}
