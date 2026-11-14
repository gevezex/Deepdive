//! De login zelf: de browser openen, de lokale callback opvangen, de code inwisselen en het antwoord controleren.
//! Een nieuwe poging raakt een bestaande koppeling pas nadat de identiteit is gecontroleerd.

use super::{now, Credentials, Discovery, Hub, TokenError, RESOURCE};
use crate::ai::errors::redact;
use crate::error::AppError;
use base64::Engine;
use jsonwebtoken::{decode, decode_header, jwk::Jwk, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};
use url::Url;

const REGISTRATION_CLIENT: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "Deepdive";
const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CALLBACK_PATH: &str = "/auth/callback";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST: usize = 16 * 1024;
const CLOCK_TOLERANCE_SECS: u64 = 30;

fn page(title: String, text: String) -> String {
    let lang = crate::i18n::ui().code();
    format!("<!doctype html><html lang=\"{lang}\"><meta charset=\"utf-8\"><title>Deepdive</title><body style=\"font-family:system-ui;margin:4em auto;max-width:30em\"><h1>{title}</h1><p>{text}</p></body></html>")
}

fn page_done() -> String {
    page(crate::i18n::tr("Done", "Klaar", "Tamam"), crate::i18n::tr("You can close this window and return to Deepdive.", "Je kunt dit venster sluiten en teruggaan naar Deepdive.", "Bu pencereyi kapatıp Deepdive'a dönebilirsiniz."))
}

fn page_wrong() -> String {
    page(crate::i18n::tr("This does not belong to this sign-in", "Dit hoort niet bij deze login", "Bu, bu girişe ait değil"), crate::i18n::tr("Go back to Deepdive and try again.", "Ga terug naar Deepdive en probeer het opnieuw.", "Deepdive'a dönüp tekrar deneyin."))
}

/// Een account dat al eerder is gekoppeld.
#[derive(Debug, Clone)]
pub struct Returning {
    pub client_id: String,
    pub subject: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LoginRequest {
    pub returning: Option<Returning>,
    /// De gebruiker kiest er zelf voor om het abonnement alsnog in te schakelen.
    pub ask_consent: bool,
}

#[derive(Debug)]
pub struct LoginResult {
    pub client_id: String,
    pub subject: String,
    pub email: Option<String>,
    pub credentials: Credentials,
}

fn failed(en: &str, nl: &str, tr: &str) -> AppError {
    AppError::new("chatgpt_login_failed", crate::i18n::tr(en, nl, tr))
}

/// Willekeurig uit de cryptografische bron van het systeem, wat `Uuid::new_v4` gebruikt.
fn random_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Luistert op de voorkeurspoort en anders op een vrije poort. Alleen de poort mag verschillen.
async fn bind(preferred: u16) -> Result<(TcpListener, String), AppError> {
    let listener = match TcpListener::bind(("127.0.0.1", preferred)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| failed("Deepdive could not open a local port for signing in.", "Deepdive kon geen lokale poort openen voor de login.", "Deepdive, giriş için yerel bir port açamadı.").with_detail(e.to_string()))?,
    };
    let port = listener.local_addr().map_err(|e| failed("Deepdive could not open a local port for signing in.", "Deepdive kon geen lokale poort openen voor de login.", "Deepdive, giriş için yerel bir port açamadı.").with_detail(e.to_string()))?.port();
    Ok((listener, format!("http://127.0.0.1:{port}{CALLBACK_PATH}")))
}

struct Callback {
    params: HashMap<String, String>,
    socket: TcpStream,
}

async fn respond(socket: &mut TcpStream, status: &str, page: &str) {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n", page.len());
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(page.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// Leest de eerste regel van een aanvraag. Antwoordt zelf op alles wat de callback niet is.
async fn read_callback(mut socket: TcpStream, found: mpsc::Sender<Callback>) {
    let mut data = Vec::new();
    let mut buf = [0u8; 2048];
    let finished = tokio::time::timeout(READ_TIMEOUT, async {
        while !data.windows(2).any(|w| w == b"\r\n") && data.len() < MAX_REQUEST {
            match socket.read(&mut buf).await {
                Ok(0) | Err(_) => return false,
                Ok(n) => data.extend_from_slice(&buf[..n]),
            }
        }
        true
    })
    .await;
    if !matches!(finished, Ok(true)) {
        return;
    }
    let text = String::from_utf8_lossy(&data);
    let target = text.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|rest| rest.split(' ').next());
    let parsed = target.and_then(|t| Url::parse(&format!("http://127.0.0.1{t}")).ok()).filter(|u| u.path() == CALLBACK_PATH);
    match parsed {
        Some(url) => {
            let params = url.query_pairs().into_owned().collect();
            let _ = found.send(Callback { params, socket }).await;
        }
        None => respond(&mut socket, "404 Not Found", &page_wrong()).await,
    }
}

/// Wacht op de callback die bij deze poging hoort. Iets met een verkeerde `state` kan de login niet verstoren.
async fn wait_for_callback(listener: TcpListener, state: &str, cancel: &Notify) -> Result<HashMap<String, String>, AppError> {
    let (sender, mut found) = mpsc::channel::<Callback>(8);
    let deadline = tokio::time::sleep(LOGIN_TIMEOUT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return Err(AppError::new("chatgpt_login_timeout", crate::i18n::tr("Signing in took too long and was stopped. Please try again.", "Het inloggen duurde te lang en is gestopt. Probeer het opnieuw.", "Giriş çok uzun sürdü ve durduruldu. Lütfen tekrar deneyin."))),
            _ = cancel.notified() => return Err(AppError::new("chatgpt_login_cancelled", crate::i18n::tr("Signing in was stopped.", "Het inloggen is gestopt.", "Giriş durduruldu."))),
            accepted = listener.accept() => {
                if let Ok((socket, _)) = accepted {
                    tokio::spawn(read_callback(socket, sender.clone()));
                }
            }
            Some(mut callback) = found.recv() => {
                if callback.params.get("state").map(String::as_str) != Some(state) {
                    respond(&mut callback.socket, "400 Bad Request", &page_wrong()).await;
                    continue;
                }
                respond(&mut callback.socket, "200 OK", &page_done()).await;
                return Ok(callback.params);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct IdClaims {
    sub: String,
    nonce: Option<String>,
    email: Option<String>,
    #[allow(dead_code)] // Moet aanwezig zijn; de waarde zelf gebruiken we niet.
    iat: i64,
    sid: Option<Value>,
}

impl Hub {
    fn begin_login(&self) -> Arc<Notify> {
        let cancel = Arc::new(Notify::new());
        if let Some(previous) = self.active_login.lock().unwrap().replace(cancel.clone()) {
            previous.notify_one();
        }
        cancel
    }

    /// Stopt een login die op de browser wacht.
    pub fn cancel_login(&self) {
        if let Some(active) = self.active_login.lock().unwrap().take() {
            active.notify_one();
        }
    }

    pub async fn login(&self, request: LoginRequest) -> Result<LoginResult, AppError> {
        // Eerst de installatie-ID: die moet vaststaan voor de eerste login.
        let host_id = self.host_id()?;
        let cancel = self.begin_login();
        let (listener, redirect_uri) = bind(self.config.preferred_port).await?;
        let state = random_token();
        let nonce = random_token();
        let verifier = format!("{}{}", random_token(), random_token());

        let unclaimed = self.unclaimed_client.lock().unwrap().clone();
        let known_client = request.returning.as_ref().map(|r| r.client_id.clone()).or(unclaimed);
        let authorize = self.authorize_url(&request, known_client.as_deref(), &host_id, &redirect_uri, &state, &nonce, &pkce_challenge(&verifier))?;
        (self.config.opener)(&authorize)?;

        let params = wait_for_callback(listener, &state, &cancel).await?;
        if let Some(error) = params.get("error") {
            return Err(callback_error(error, params.get("error_description").map(String::as_str)));
        }
        let code = params.get("code").filter(|c| !c.is_empty()).ok_or_else(|| failed("OpenAI did not return a sign-in code. Please try again.", "OpenAI gaf geen inlogcode terug. Probeer het opnieuw.", "OpenAI bir giriş kodu döndürmedi. Lütfen tekrar deneyin."))?;
        let client_id = resolve_client(known_client.as_deref(), params.get("client_id").map(String::as_str))?;

        let form = [("grant_type", "authorization_code"), ("client_id", client_id.as_str()), ("code", code), ("code_verifier", verifier.as_str()), ("redirect_uri", redirect_uri.as_str()), ("resource", RESOURCE)];
        let response = match self.post_token(&form).await {
            Ok(response) => response,
            Err(error) => {
                if matches!(&error, TokenError::Refused { code: Some(c), .. } if c == "invalid_grant") && request.returning.is_none() {
                    // Volgens OpenAI: code weggooien en opnieuw beginnen, met de client-ID die al is uitgegeven.
                    *self.unclaimed_client.lock().unwrap() = Some(client_id.clone());
                }
                return Err(exchange_error(error));
            }
        };

        let id_token = response.id_token.as_deref().ok_or_else(|| failed("OpenAI did not return an ID token. Please try again.", "OpenAI gaf geen ID-token terug. Probeer het opnieuw.", "OpenAI bir kimlik belirteci (ID token) döndürmedi. Lütfen tekrar deneyin."))?;
        let discovery = self.discovery().await?;
        let claims = self.validate_id_token(id_token, &discovery, &client_id, &nonce).await?;
        if let Some(returning) = &request.returning {
            if returning.subject != claims.sub {
                return Err(AppError::new("chatgpt_wrong_account", crate::i18n::tr("You signed in with a different ChatGPT account than the one that belongs to this provider. Nothing was changed. Add that account as a separate provider.", "Je logde in met een ander ChatGPT-account dan bij deze provider hoort. Er is niets veranderd. Voeg dat account toe als aparte provider.", "Bu sağlayıcıya ait olandan farklı bir ChatGPT hesabıyla giriş yaptınız. Hiçbir şey değişmedi. O hesabı ayrı bir sağlayıcı olarak ekleyin.")));
            }
        }
        self.unclaimed_client.lock().unwrap().take();
        // Alleen de toegekende scopes uit het token-antwoord tellen, niet die uit de callback.
        let credentials = Credentials {
            issuer: discovery.issuer,
            subject: claims.sub.clone(),
            client_id: client_id.clone(),
            refresh_token: response.refresh_token.clone(),
            scopes: response.scopes().unwrap_or_default(),
            expires_at: response.expires_at(),
            earliest_refresh_at: response.earliest_refresh(),
            saved_at: now(),
            access_token: response.access_token,
        };
        Ok(LoginResult { client_id, subject: claims.sub, email: claims.email, credentials })
    }

    #[allow(clippy::too_many_arguments)]
    fn authorize_url(&self, request: &LoginRequest, known_client: Option<&str>, host_id: &str, redirect_uri: &str, state: &str, nonce: &str, challenge: &str) -> Result<String, AppError> {
        let mut url = Url::parse(&self.config.auth("/api/accounts/authorize")).map_err(|e| failed("The sign-in address is invalid.", "Het inlogadres klopt niet.", "Giriş adresi geçersiz.").with_detail(e.to_string()))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("client_id", known_client.unwrap_or(REGISTRATION_CLIENT));
            if known_client.is_none() {
                query.append_pair("agent_name_hint", AGENT_NAME);
            }
            query.append_pair("ext_agent_host_id", host_id);
            // Bewust geen id_token_hint: dit adres komt in de browsergeschiedenis, en daar hoort geen token.
            if let Some(email) = request.returning.as_ref().and_then(|r| r.email.as_deref()) {
                query.append_pair("login_hint", email);
            }
            if request.ask_consent {
                query.append_pair("prompt", "consent");
            }
            query.append_pair("response_type", "code");
            query.append_pair("redirect_uri", redirect_uri);
            query.append_pair("scope", SCOPES);
            query.append_pair("resource", RESOURCE);
            query.append_pair("state", state);
            query.append_pair("nonce", nonce);
            query.append_pair("code_challenge_method", "S256");
            query.append_pair("code_challenge", challenge);
        }
        Ok(url.into())
    }

    async fn validate_id_token(&self, token: &str, discovery: &Discovery, client_id: &str, nonce: &str) -> Result<IdClaims, AppError> {
        let invalid = |detail: String| AppError::new("chatgpt_id_token", crate::i18n::tr("OpenAI's response could not be verified, so you are not signed in. Please try again.", "Het antwoord van OpenAI kon niet worden gecontroleerd, dus je bent niet ingelogd. Probeer het opnieuw.", "OpenAI'nin yanıtı doğrulanamadı, bu yüzden giriş yapılmadı. Lütfen tekrar deneyin.")).with_detail(detail);
        let header = decode_header(token).map_err(|e| invalid(format!("{}: {:?}", crate::i18n::tr("header", "kop", "başlık"), e.kind())))?;
        // Alleen ondertekening met een publieke sleutel. Nooit "none" of een gedeeld geheim.
        if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
            return Err(invalid(format!("{} {:?}", crate::i18n::tr("algorithm", "algoritme", "algoritma"), header.alg)));
        }
        let client = self.client()?;
        let response = client.get(&discovery.jwks_uri).send().await.map_err(|e| invalid(format!("{}: {}", crate::i18n::tr("keys", "sleutels", "anahtarlar"), redact(&e.to_string(), None))))?;
        let keys: Value = response.json().await.map_err(|e| invalid(format!("{}: {e}", crate::i18n::tr("keys", "sleutels", "anahtarlar"))))?;
        let keys = keys.get("keys").and_then(Value::as_array).cloned().unwrap_or_default();
        let matching = keys.iter().find(|k| header.kid.as_deref().is_some_and(|kid| k.get("kid").and_then(Value::as_str) == Some(kid))).or(if header.kid.is_none() && keys.len() == 1 { keys.first() } else { None });
        let jwk: Jwk = matching.cloned().and_then(|k| serde_json::from_value(k).ok()).ok_or_else(|| invalid(crate::i18n::tr("no matching key", "geen passende sleutel", "eşleşen anahtar yok")))?;
        let key = DecodingKey::from_jwk(&jwk).map_err(|e| invalid(format!("{}: {:?}", crate::i18n::tr("key", "sleutel", "anahtar"), e.kind())))?;

        let mut validation = Validation::new(header.alg);
        validation.set_audience(&[client_id]);
        validation.set_issuer(&[&discovery.issuer]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = CLOCK_TOLERANCE_SECS;
        let claims = decode::<IdClaims>(token, &key, &validation).map_err(|e| invalid(format!("{:?}", e.kind())))?.claims;
        if claims.nonce.as_deref() != Some(nonce) {
            return Err(invalid(crate::i18n::tr("nonce does not match", "nonce klopt niet", "nonce eşleşmiyor")));
        }
        if claims.sub.is_empty() {
            return Err(invalid(crate::i18n::tr("no subject", "geen subject", "subject yok")));
        }
        if claims.sid.as_ref().is_some_and(|sid| sid.as_str().is_none_or(|s| s.trim().is_empty())) {
            return Err(invalid(crate::i18n::tr("invalid session ID", "ongeldige sessie-ID", "geçersiz oturum kimliği")));
        }
        Ok(claims)
    }
}

/// De client-ID die bij deze poging hoort. Een terugkerend account houdt zijn eigen ID.
fn resolve_client(known: Option<&str>, from_callback: Option<&str>) -> Result<String, AppError> {
    match (known, from_callback) {
        (Some(known), Some(given)) if known != given => Err(AppError::new("chatgpt_wrong_account", crate::i18n::tr("OpenAI returned a different connection than the one that belongs to this provider. Nothing was changed. Please try again.", "OpenAI gaf een andere koppeling terug dan bij deze provider hoort. Er is niets veranderd. Probeer het opnieuw.", "OpenAI, bu sağlayıcıya ait olandan farklı bir bağlantı döndürdü. Hiçbir şey değişmedi. Lütfen tekrar deneyin."))),
        (Some(known), _) => Ok(known.to_string()),
        (None, Some(given)) if !given.is_empty() && given != REGISTRATION_CLIENT => Ok(given.to_string()),
        (None, _) => Err(failed("Registration with OpenAI was not completed. Please try again.", "De registratie bij OpenAI is niet afgerond. Probeer het opnieuw.", "OpenAI kaydı tamamlanmadı. Lütfen tekrar deneyin.")),
    }
}

fn callback_error(code: &str, description: Option<&str>) -> AppError {
    if code == "access_denied" {
        return AppError::new("chatgpt_consent_denied", crate::i18n::tr("You did not give permission, so Deepdive will not use your ChatGPT subscription. You can try again later, or use your own API key or a local model.", "Je hebt geen toestemming gegeven, dus Deepdive gebruikt je ChatGPT-abonnement niet. Je kunt het later opnieuw proberen, of een eigen API-sleutel of lokaal model gebruiken.", "İzin vermediniz, bu yüzden Deepdive ChatGPT aboneliğinizi kullanmayacak. Daha sonra tekrar deneyebilir ya da kendi API anahtarınızı veya yerel bir model kullanabilirsiniz."));
    }
    let detail = format!("{code}: {}", description.unwrap_or(""));
    failed("OpenAI cancelled the sign-in. Please try again.", "OpenAI brak het inloggen af. Probeer het opnieuw.", "OpenAI girişi yarıda kesti. Lütfen tekrar deneyin.").with_detail(redact(&detail, None).chars().take(500).collect::<String>())
}

fn exchange_error(error: TokenError) -> AppError {
    match error {
        TokenError::Temporary(detail) => failed("OpenAI cannot be reached right now. Check your internet connection and try again.", "OpenAI is nu niet bereikbaar. Controleer je internetverbinding en probeer het opnieuw.", "OpenAI'ye şu anda ulaşılamıyor. İnternet bağlantınızı kontrol edip tekrar deneyin.").with_detail(detail),
        TokenError::Refused { code: Some(code), .. } if code == "invalid_grant" => failed("The sign-in code is no longer valid. Please try again.", "De inlogcode is niet meer geldig. Probeer het opnieuw.", "Giriş kodu artık geçerli değil. Lütfen tekrar deneyin."),
        TokenError::Refused { status, detail, .. } => failed("OpenAI refused the sign-in. Please try again.", "OpenAI weigerde de login. Probeer het opnieuw.", "OpenAI girişi reddetti. Lütfen tekrar deneyin.").with_detail(format!("HTTP {status}: {detail}")),
    }
}
