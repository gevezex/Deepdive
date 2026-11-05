//! "Inloggen met ChatGPT": de gebruiker koppelt een eigen ChatGPT-account en abonnement. Er is geen gedeelde
//! sleutel en geen server. Volgt OpenAI's beschrijving voor open-source en lokaal gehoste apps, die nog in
//! preview is: https://developers.openai.com/siwc/token-sharing-open-source
//!
//! Tokens staan alleen in de sleutelhanger, als één geheel per koppeling. Ze hebben geen `Serialize` richting
//! de frontend en een afgeschermde `Debug`. De rest van de app ziet alleen `Session::access_token`, en dat
//! gaat rechtstreeks naar de AI-laag.

mod login;
#[cfg(test)]
mod tests;

pub use login::{LoginRequest, LoginResult, Returning};

use crate::ai::{errors::redact, is_loopback, ApiKey};
use crate::error::AppError;
use crate::providers::secrets::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const AUTH_BASE: &str = "https://auth.openai.com";
const API_BASE: &str = "https://api.openai.com/v1";
/// De `resource` uit OpenAI's documentatie. Blijft gelijk, ook tegen de nepserver.
const RESOURCE: &str = "https://api.openai.com/v1";
pub const USAGE_URL: &str = "https://chatgpt.com/settings/usage";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
/// Zo lang voor het verlopen van het toegangstoken wordt het vernieuwd.
const REFRESH_MARGIN_SECS: i64 = 300;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(not(test))]
const REVOKE_BACKOFF: [Duration; 2] = [Duration::from_millis(500), Duration::from_secs(2)];
#[cfg(test)]
const REVOKE_BACKOFF: [Duration; 2] = [Duration::from_millis(5), Duration::from_millis(5)];

/// Opent een adres in de browser van het systeem.
pub type Opener = Arc<dyn Fn(&str) -> Result<(), AppError> + Send + Sync>;

#[derive(Clone)]
pub struct Config {
    pub auth_base: Url,
    pub api_base: Url,
    pub opener: Opener,
    pub preferred_port: u16,
}

impl Config {
    pub fn production() -> Self {
        Self { auth_base: Url::parse(AUTH_BASE).expect("vast adres"), api_base: Url::parse(API_BASE).expect("vast adres"), opener: Arc::new(open_in_system_browser), preferred_port: 1455 }
    }

    /// In een release-build staan de adressen vast, zodat niets de tokens ergens anders heen kan sturen. Alleen
    /// debug-builds kunnen voor de end-to-endtest naar een lokale nepserver wijzen.
    pub fn for_app() -> Self {
        #[allow(unused_mut)]
        let mut config = Self::production();
        #[cfg(debug_assertions)]
        {
            let local = |name: &str| std::env::var(name).ok().and_then(|v| Url::parse(&v).ok()).filter(is_loopback);
            if let Some(url) = local("DEEPDIVE_CHATGPT_AUTH_BASE") {
                config.auth_base = url;
            }
            if let Some(url) = local("DEEPDIVE_CHATGPT_API_BASE") {
                config.api_base = url;
            }
            if let Ok(file) = std::env::var("DEEPDIVE_CHATGPT_BROWSER_FILE") {
                config.preferred_port = 0;
                config.opener = Arc::new(move |url: &str| {
                    let tmp = format!("{file}.tmp");
                    std::fs::write(&tmp, url).and_then(|()| std::fs::rename(&tmp, &file)).map_err(AppError::storage)
                });
            }
        }
        config
    }

    fn auth(&self, path: &str) -> String {
        format!("{}{path}", self.auth_base.as_str().trim_end_matches('/'))
    }
}

fn open_in_system_browser(url: &str) -> Result<(), AppError> {
    let failed = |detail: String| AppError::new("chatgpt_browser", "De browser kon niet worden geopend. Probeer het opnieuw.").with_detail(detail);
    let status = std::process::Command::new("open").arg(url).status().map_err(|e| failed(e.to_string()))?;
    status.success().then_some(()).ok_or_else(|| failed(status.to_string()))
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Eén koppeling in de sleutelhanger. Alles wordt samen vervangen, zodat een verlopen toegangstoken nooit
/// naast een al vervangen vernieuwingstoken kan staan.
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub issuer: String,
    pub subject: String,
    pub client_id: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at: i64,
    pub earliest_refresh_at: Option<i64>,
    pub saved_at: i64,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credentials(***)")
    }
}

impl Credentials {
    pub fn plan_enabled(&self) -> bool {
        self.scopes.iter().any(|s| s == PLAN_SCOPE)
    }

    fn should_refresh(&self, at: i64) -> bool {
        at >= self.expires_at || (at >= self.expires_at - REFRESH_MARGIN_SECS && self.earliest_refresh_at.is_none_or(|t| at >= t))
    }
}

/// Het antwoord van het token-adres. Heeft bewust geen `Debug`.
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    earliest_refresh_at: Option<Value>,
}

impl TokenResponse {
    fn scopes(&self) -> Option<Vec<String>> {
        self.scope.as_ref().map(|s| s.split_whitespace().map(String::from).collect())
    }
    fn expires_at(&self) -> i64 {
        now() + self.expires_in.unwrap_or(3600)
    }
    fn earliest_refresh(&self) -> Option<i64> {
        self.earliest_refresh_at.as_ref().and_then(Value::as_i64)
    }
}

enum TokenError {
    /// Het token-adres weigerde, met zijn foutcode voor zover die er is.
    Refused { status: u16, code: Option<String>, detail: String },
    /// Netwerkfout of serverstoring: tijdelijk, de gegevens blijven staan.
    Temporary(String),
}

/// Wat er aan de koppeling verandert door iets wat tijdens gebruik blijkt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountChange {
    SessionLost,
    PlanDisabled,
}

pub type AccountSink = Arc<dyn Fn(&str, AccountChange) + Send + Sync>;

/// De gedeelde kant van het inloggen: de sleutelhanger, de installatie-ID en het slot op vernieuwen.
pub struct Hub {
    config: Config,
    secrets: Arc<dyn SecretStore>,
    root: PathBuf,
    /// Eén vernieuwing tegelijk: een vernieuwingstoken is na gebruik ongeldig.
    token_lock: tokio::sync::Mutex<()>,
    active_login: Mutex<Option<Arc<tokio::sync::Notify>>>,
    /// Een uitgegeven client-ID waarvan de eerste code-uitwisseling mislukte: de volgende poging hergebruikt die.
    unclaimed_client: Mutex<Option<String>>,
}

pub fn keychain_account(provider_id: &str) -> String {
    format!("chatgpt:{provider_id}")
}

impl Hub {
    pub fn new(config: Config, secrets: Arc<dyn SecretStore>, root: PathBuf) -> Self {
        Self { config, secrets, root, token_lock: Default::default(), active_login: Mutex::new(None), unclaimed_client: Mutex::new(None) }
    }

    pub fn api_base(&self) -> Url {
        self.config.api_base.clone()
    }

    pub fn open_usage(&self) -> Result<(), AppError> {
        (self.config.opener)(USAGE_URL)
    }

    fn client(&self) -> Result<reqwest::Client, AppError> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(HTTP_TIMEOUT)
            .user_agent(concat!("Deepdive/", env!("CARGO_PKG_VERSION")));
        if is_loopback(&self.config.auth_base) {
            builder = builder.no_proxy();
        }
        builder.build().map_err(|e| AppError::new("internal", "De verbinding kon niet worden voorbereid.").with_detail(e.to_string()))
    }

    /// De stabiele, anonieme ID van deze installatie. Wordt één keer gemaakt, vóór de eerste login. Is geen
    /// geheim en zegt niets over de gebruiker.
    pub fn host_id(&self) -> Result<String, AppError> {
        std::fs::create_dir_all(&self.root).map_err(AppError::storage)?;
        let path = self.root.join("chatgpt-host-id");
        if let Ok(text) = std::fs::read_to_string(&path) {
            let text = text.trim();
            if text.strip_prefix("urn:uuid:").and_then(|u| uuid::Uuid::parse_str(u).ok()).is_some_and(|u| u.get_version_num() == 4) {
                return Ok(text.to_string());
            }
        }
        let id = format!("urn:uuid:{}", uuid::Uuid::new_v4().hyphenated());
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &id).map_err(AppError::storage)?;
        std::fs::rename(tmp, path).map_err(AppError::storage)?;
        Ok(id)
    }

    pub fn store_credentials(&self, provider_id: &str, credentials: &Credentials) -> Result<(), AppError> {
        let text = serde_json::to_string(credentials).map_err(AppError::storage)?;
        self.secrets.set(&keychain_account(provider_id), &ApiKey::new(text))
    }

    fn load_credentials(&self, provider_id: &str) -> Result<Option<Credentials>, AppError> {
        // Een onleesbare inhoud telt als niet ingelogd; de foutmelding herhaalt de inhoud niet.
        Ok(self.secrets.get(&keychain_account(provider_id))?.and_then(|text| serde_json::from_str(text.expose()).ok()))
    }

    pub fn delete_credentials(&self, provider_id: &str) -> Result<(), AppError> {
        self.secrets.delete(&keychain_account(provider_id))
    }

    /// Stuurt een formulier naar het token-adres van OpenAI.
    async fn post_token(&self, form: &[(&str, &str)]) -> Result<TokenResponse, TokenError> {
        let client = self.client().map_err(|e| TokenError::Temporary(e.message))?;
        let response = client.post(self.config.auth("/api/accounts/oauth/token")).form(form).send().await.map_err(|e| TokenError::Temporary(redact(&e.to_string(), None)))?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|e| TokenError::Temporary(redact(&e.to_string(), None)))?;
        if (200..300).contains(&status) {
            return serde_json::from_str(&body).map_err(|_| TokenError::Temporary("Het token-antwoord is onleesbaar.".into()));
        }
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let code = value.get("error").and_then(Value::as_str).or_else(|| value.pointer("/error/code").and_then(Value::as_str)).or_else(|| value.get("code").and_then(Value::as_str)).map(String::from);
        if status >= 500 {
            return Err(TokenError::Temporary(format!("HTTP {status}")));
        }
        Err(TokenError::Refused { status, code, detail: redact(&body, None).chars().take(500).collect() })
    }

    /// Haalt de vaste adressen op uit OpenAI's OpenID-document en controleert dat dit de verwachte uitgever is.
    async fn discovery(&self) -> Result<Discovery, AppError> {
        let failed = |detail: String| AppError::new("chatgpt_login_failed", "De inloggegevens van OpenAI konden niet worden opgehaald. Controleer je internetverbinding en probeer het opnieuw.").with_detail(detail);
        let client = self.client()?;
        let response = client.get(self.config.auth("/.well-known/openid-configuration")).send().await.map_err(|e| failed(redact(&e.to_string(), None)))?;
        let found: Discovery = response.error_for_status().map_err(|e| failed(e.to_string()))?.json().await.map_err(|e| failed(e.to_string()))?;
        if found.issuer != self.config.auth_base.as_str().trim_end_matches('/') {
            return Err(failed(format!("onverwachte uitgever: {}", found.issuer)));
        }
        for address in [Some(&found.jwks_uri), found.revocation_endpoint.as_ref()].into_iter().flatten() {
            let safe = Url::parse(address).is_ok_and(|u| u.scheme() == "https" || is_loopback(&u));
            if !safe {
                return Err(failed(format!("onveilig adres: {address}")));
            }
        }
        Ok(found)
    }

    /// Trekt de sessie in bij OpenAI en wist de tokens hier. Geeft terug of OpenAI het intrekken bevestigde;
    /// de tokens gaan hoe dan ook weg. De client-ID en de installatie-ID blijven voor een volgende login.
    pub async fn logout(&self, provider_id: &str) -> Result<bool, AppError> {
        let _guard = self.token_lock.lock().await;
        let credentials = self.load_credentials(provider_id)?;
        let confirmed = match &credentials {
            None => true,
            Some(Credentials { refresh_token: Some(token), client_id, .. }) => self.revoke(token, client_id).await,
            Some(_) => false,
        };
        self.delete_credentials(provider_id)?;
        Ok(confirmed)
    }

    async fn revoke(&self, refresh_token: &str, client_id: &str) -> bool {
        let Ok(found) = self.discovery().await else { return false };
        let Some(endpoint) = found.revocation_endpoint else { return false };
        let Ok(client) = self.client() else { return false };
        let form = [("token", refresh_token), ("token_type_hint", "refresh_token"), ("client_id", client_id)];
        let mut backoff = REVOKE_BACKOFF.iter();
        loop {
            match client.post(&endpoint).form(&form).send().await {
                Ok(r) if r.status().is_success() => return true,
                Ok(r) if !r.status().is_server_error() => return false,
                _ => match backoff.next() {
                    Some(delay) => tokio::time::sleep(*delay).await,
                    None => return false,
                },
            }
        }
    }
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
}

pub fn signed_out() -> AppError {
    AppError::new("chatgpt_signed_out", "Je bent niet ingelogd bij ChatGPT. Log in via Providers om deze modellen te gebruiken.")
}

pub fn plan_disabled() -> AppError {
    AppError::new("chatgpt_plan_disabled", "Het gebruik van je ChatGPT-abonnement staat uit voor Deepdive. Schakel het in bij Providers, of gebruik een eigen API-sleutel.")
}

pub fn session_revoked() -> AppError {
    AppError::new("chatgpt_session_revoked", "Je ChatGPT-sessie is ingetrokken of verlopen. Log opnieuw in via Providers.")
}

/// De toegang tot één koppeling, voor de AI-laag.
pub struct Session {
    hub: Arc<Hub>,
    provider_id: String,
    client_id: String,
    sink: AccountSink,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("provider_id", &self.provider_id).finish_non_exhaustive()
    }
}

impl Session {
    pub fn new(hub: Arc<Hub>, provider_id: String, client_id: String, sink: AccountSink) -> Self {
        Self { hub, provider_id, client_id, sink }
    }

    /// De gegevens van deze koppeling. Tokens van een andere client worden nooit gebruikt.
    fn load(&self) -> Result<Credentials, AppError> {
        let credentials = self.hub.load_credentials(&self.provider_id)?.filter(|c| c.client_id == self.client_id);
        let Some(credentials) = credentials else {
            (self.sink)(&self.provider_id, AccountChange::SessionLost);
            return Err(session_revoked());
        };
        if !credentials.plan_enabled() {
            (self.sink)(&self.provider_id, AccountChange::PlanDisabled);
            return Err(plan_disabled());
        }
        Ok(credentials)
    }

    /// Een geldig toegangstoken, zo nodig eerst vernieuwd. Lukt vernieuwen tijdelijk niet terwijl het oude
    /// token nog geldt, dan werkt het oude nog even.
    pub async fn access_token(&self) -> Result<ApiKey, AppError> {
        let _guard = self.hub.token_lock.lock().await;
        let credentials = self.load()?;
        let at = now();
        if !credentials.should_refresh(at) {
            return Ok(ApiKey::new(credentials.access_token));
        }
        match self.refresh(&credentials).await {
            Ok(fresh) => Ok(ApiKey::new(fresh.access_token)),
            Err(e) if e.kind == "chatgpt_unreachable" && at < credentials.expires_at => Ok(ApiKey::new(credentials.access_token)),
            Err(e) => Err(e),
        }
    }

    /// De dienst weigerde dit token. Als een ander verzoek het intussen al verving, volstaat dat nieuwe token.
    pub async fn renew_rejected(&self, rejected: Option<&ApiKey>) -> Result<ApiKey, AppError> {
        let _guard = self.hub.token_lock.lock().await;
        let credentials = self.load()?;
        if rejected.is_some_and(|r| r.expose() != credentials.access_token) {
            return Ok(ApiKey::new(credentials.access_token));
        }
        Ok(ApiKey::new(self.refresh(&credentials).await?.access_token))
    }

    async fn refresh(&self, credentials: &Credentials) -> Result<Credentials, AppError> {
        let Some(refresh_token) = credentials.refresh_token.as_deref() else {
            return Err(self.lose_session());
        };
        let form = [("grant_type", "refresh_token"), ("client_id", credentials.client_id.as_str()), ("refresh_token", refresh_token), ("resource", RESOURCE)];
        let response = match self.hub.post_token(&form).await {
            Ok(response) => response,
            Err(TokenError::Temporary(detail)) => {
                return Err(AppError::new("chatgpt_unreachable", "Je ChatGPT-sessie kon nu niet worden vernieuwd. Je blijft ingelogd; controleer je internetverbinding en probeer het opnieuw.").with_detail(detail));
            }
            Err(TokenError::Refused { code, detail, status }) => {
                return match code.as_deref() {
                    Some("invalid_grant" | "invalid_refresh_token" | "token_expired" | "refresh_token_expired" | "refresh_token_invalidated" | "refresh_token_reused") => {
                        // Een andere instantie van de app kan het token net hebben vervangen.
                        match self.hub.load_credentials(&self.provider_id)? {
                            Some(latest) if latest.refresh_token != credentials.refresh_token && latest.client_id == self.client_id => Ok(latest),
                            _ => Err(self.lose_session()),
                        }
                    }
                    Some("invalid_client") => Err(AppError::new("chatgpt_client_invalid", "Deze ChatGPT-koppeling is niet meer geldig. Verwijder deze provider en log opnieuw in.").with_detail(detail)),
                    _ => Err(AppError::new("chatgpt_unreachable", "Je ChatGPT-sessie kon nu niet worden vernieuwd. Je blijft ingelogd; probeer het later opnieuw.").with_detail(format!("HTTP {status}: {detail}"))),
                };
            }
        };
        let fresh = Credentials {
            refresh_token: response.refresh_token.clone().or_else(|| credentials.refresh_token.clone()),
            scopes: response.scopes().unwrap_or_else(|| credentials.scopes.clone()),
            expires_at: response.expires_at(),
            earliest_refresh_at: response.earliest_refresh(),
            saved_at: now(),
            access_token: response.access_token,
            ..credentials.clone()
        };
        self.hub.store_credentials(&self.provider_id, &fresh)?;
        if !fresh.plan_enabled() {
            (self.sink)(&self.provider_id, AccountChange::PlanDisabled);
            return Err(plan_disabled());
        }
        Ok(fresh)
    }

    /// De sessie is bevestigd ongeldig: de onbruikbare tokens gaan weg en de gebruiker moet opnieuw inloggen.
    fn lose_session(&self) -> AppError {
        if let Err(e) = self.hub.delete_credentials(&self.provider_id) {
            return e;
        }
        (self.sink)(&self.provider_id, AccountChange::SessionLost);
        session_revoked()
    }
}
