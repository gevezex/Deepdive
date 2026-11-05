//! De AI-laag: de enige plek in de app die met een AI-dienst praat.
//!
//! Latere stappen bouwen hierop met één ingang: `stream_chat(&target, request, callback)`. Een `Target` komt
//! uit `providers::ProviderStore::target`. Deze laag kent geen bronnen en geen opslag: wat in een verzoek
//! staat, bepaalt de aanroeper. De sleutel zit in `ApiKey` en verlaat deze laag alleen als HTTP-header.
//! Bij een ChatGPT-abonnement haalt deze laag per verzoek een geldig toegangstoken op bij de `Session`.

mod anthropic;
pub mod errors;
mod openai;
mod responses;
mod sse;
#[cfg(test)]
mod tests;

use crate::chatgpt::Session;
use crate::error::AppError;
use errors::ErrorContext;
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use std::ops::ControlFlow;
use std::sync::Arc;
use std::time::{Duration, Instant};
use url::{Host, Url};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// Een lokaal model kan lang laden voor het eerste woord komt, dus deze grens is ruim.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const CHECK_PROMPT: &str = "Antwoord met precies één woord: werkt";
const CHECK_MAX_TOKENS: u32 = 32;
const CHECK_SAMPLE_CHARS: usize = 40;
/// Een ChatGPT-abonnement kan tijdelijk niet beschikbaar zijn; daarna krijgt de lezer een melding.
#[cfg(not(test))]
const UNAVAILABLE_RETRIES: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];
#[cfg(test)]
const UNAVAILABLE_RETRIES: [Duration; 2] = [Duration::from_millis(5), Duration::from_millis(5)];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKind {
    Anthropic,
    OpenaiCompatible,
    /// De Responses API met het ChatGPT-abonnement van de gebruiker, na "Inloggen met ChatGPT".
    ChatgptPlan,
}

/// Een API-sleutel. Heeft bewust geen `Serialize` en een afgeschermde `Debug`, zodat hij niet per ongeluk
/// in een bestand, log of antwoord aan de frontend belandt.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey(***)")
    }
}

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub kind: ApiKind,
    pub base_url: Url,
    pub api_key: Option<ApiKey>,
    pub idle_timeout: Duration,
    /// Alleen bij ChatGPT: levert en vernieuwt het toegangstoken, dat pas vlak voor het verzoek in `api_key` komt.
    pub session: Option<Arc<Session>>,
}

impl Endpoint {
    pub fn new(kind: ApiKind, base_url: Url, api_key: Option<ApiKey>) -> Self {
        Self { kind, base_url, api_key, idle_timeout: IDLE_TIMEOUT, session: None }
    }

    pub fn chatgpt(base_url: Url, session: Arc<Session>) -> Self {
        Self { session: Some(session), ..Self::new(ApiKind::ChatgptPlan, base_url, None) }
    }

    /// Dit eindpunt met een geldig toegangstoken, als het er een nodig heeft.
    async fn authorized(&self) -> Result<Endpoint, AppError> {
        let mut ep = self.clone();
        if let Some(session) = &self.session {
            ep.api_key = Some(session.access_token().await?);
        }
        Ok(ep)
    }

    pub fn is_local(&self) -> bool {
        is_loopback(&self.base_url)
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base_url.as_str().trim_end_matches('/'))
    }

    fn client(&self) -> Result<reqwest::Client, AppError> {
        // Niet doorverwijzen: bij een omleiding naar een andere host zou de sleutel in x-api-key meereizen.
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("Deepdive/", env!("CARGO_PKG_VERSION")));
        if self.is_local() {
            builder = builder.no_proxy();
        }
        builder.build().map_err(|e| errors::internal(&e.to_string()))
    }
}

pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost") || d.to_ascii_lowercase().ends_with(".localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Een sleutel gaat alleen versleuteld over het netwerk; alleen binnen deze computer mag het zonder https.
pub fn check_key_transport(url: &Url) -> Result<(), AppError> {
    if url.scheme() == "https" || is_loopback(url) {
        return Ok(());
    }
    Err(AppError::new("insecure_key", "Een API-sleutel wordt alleen via https verstuurd. Gebruik een https-adres, of haal de sleutel weg als deze server er geen nodig heeft."))
}

/// Haalt alvast op wat een aanroep nodig heeft. Een verlopen login komt zo meteen aan het licht, en de wachttijd op een
/// melding van de sleutelhanger telt niet mee als duur van het model.
pub async fn prepare(target: &Target) -> Result<(), AppError> {
    target.endpoint.authorized().await.map(|_| ())
}

/// Het model waar een verzoek heen gaat, met wat de app over dat model weet.
#[derive(Debug, Clone)]
pub struct Target {
    pub endpoint: Endpoint,
    pub model: String,
    /// `None` betekent onbekend: dan probeert de app het en meldt ze wat de provider terugzegt.
    pub supports_images: Option<bool>,
    pub context_tokens: Option<u32>,
}

#[allow(dead_code)] // Assistant komt met de gesprekken in stap 4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[allow(dead_code)] // Image komt met het vragen over afbeeldingen in stap 4.
#[derive(Debug, Clone)]
pub enum Part {
    Text(String),
    Image { media_type: String, base64: String },
}

#[derive(Debug, Clone)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StopReason {
    End,
    Length,
    Refusal,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Text { text: String },
    /// De denkstappen van een model dat die meestuurt. Telt als teken van leven, is geen antwoord.
    Reasoning { text: String },
    #[serde(rename_all = "camelCase")]
    Done { stop: StopReason, input_tokens: Option<u32>, output_tokens: Option<u32> },
}

enum Decoder {
    Anthropic(anthropic::Decoder),
    Openai(openai::Decoder),
    Responses(responses::Decoder),
}

impl Decoder {
    fn new(kind: ApiKind) -> Self {
        match kind {
            ApiKind::Anthropic => Self::Anthropic(Default::default()),
            ApiKind::OpenaiCompatible => Self::Openai(Default::default()),
            ApiKind::ChatgptPlan => Self::Responses(Default::default()),
        }
    }
    fn handle(&mut self, event: &sse::Event, ctx: &ErrorContext) -> Result<Vec<StreamEvent>, AppError> {
        match self {
            Self::Anthropic(d) => d.handle(event, ctx),
            Self::Openai(d) => d.handle(event, ctx),
            Self::Responses(d) => d.handle(event, ctx),
        }
    }
    /// Sluit af als de verbinding dichtgaat. `None` betekent dat het antwoord niet af was.
    fn finish(&mut self) -> Option<StreamEvent> {
        match self {
            Self::Anthropic(d) => d.finish(),
            Self::Openai(d) => d.finish(),
            Self::Responses(d) => d.finish(),
        }
    }
}

/// Weigert vooraf wat dit model volgens de bekende gegevens niet kan.
pub fn check_capabilities(target: &Target, request: &ChatRequest) -> Result<(), AppError> {
    let parts = || request.messages.iter().flat_map(|m| &m.parts);
    if target.supports_images == Some(false) && parts().any(|p| matches!(p, Part::Image { .. })) {
        return Err(AppError::new("model_no_images", format!("Model \"{}\" kan geen afbeeldingen lezen. Kies een ander model bovenaan dit paneel.", target.model)));
    }
    if let Some(limit) = target.context_tokens {
        let chars = request.system.as_deref().map_or(0, str::len)
            + parts().map(|p| if let Part::Text(t) = p { t.len() } else { 0 }).sum::<usize>();
        // Ruwe schatting: ongeveer vier tekens per token.
        if chars / 4 > limit as usize {
            return Err(AppError::new("context_too_large", format!("Dit is te veel tekst voor model \"{}\", dat ongeveer {limit} tokens aankan. Kies een model met meer context of pas de waarde aan bij Providers.", target.model)));
        }
    }
    Ok(())
}

/// Stuurt een verzoek en geeft de stukken antwoord door zodra ze binnenkomen. De callback kan stoppen met
/// `ControlFlow::Break`; dan wordt de verbinding verbroken.
pub async fn stream_chat(target: &Target, request: &ChatRequest, mut on_event: impl FnMut(StreamEvent) -> ControlFlow<()>) -> Result<(), AppError> {
    check_capabilities(target, request)?;
    let mut authorized = target.endpoint.authorized().await?;
    let mut token_renewed = false;
    let mut retries = UNAVAILABLE_RETRIES.iter();
    let response = loop {
        let ep = &authorized;
        let ctx = ErrorContext { endpoint: ep, model: Some(&target.model) };
        let client = ep.client()?;
        let http = match ep.kind {
            ApiKind::Anthropic => anthropic::chat_request(&client, ep, &target.model, request)?,
            ApiKind::OpenaiCompatible => openai::chat_request(&client, ep, &target.model, request),
            ApiKind::ChatgptPlan => responses::chat_request(&client, ep, &target.model, request),
        };
        let wait = async { http.send().await };
        let response = match tokio::time::timeout(ep.idle_timeout, wait).await {
            Ok(result) => result.map_err(|e| errors::from_send(&e, &ctx))?,
            Err(_) => return Err(errors::timed_out(&ctx)),
        };
        let status = response.status();
        if status.is_success() {
            break response;
        }
        if let Some(session) = &ep.session {
            if status == reqwest::StatusCode::UNAUTHORIZED && !token_renewed {
                // Eén keer vernieuwen. Lukt dat niet omdat de sessie is ingetrokken, dan meldt de sessie dat.
                let renewed = session.renew_rejected(ep.api_key.as_ref()).await?;
                authorized.api_key = Some(renewed);
                token_renewed = true;
                continue;
            }
            if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                if let Some(delay) = retries.next() {
                    tokio::time::sleep(*delay).await;
                    continue;
                }
            }
        }
        return Err(errors::from_response(response, &ctx).await);
    };
    let ep = &authorized;
    let ctx = ErrorContext { endpoint: ep, model: Some(&target.model) };
    // Een server die de streaming negeert of een foutpagina geeft, antwoordt met iets anders dan SSE.
    let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if !content_type.is_empty() && !content_type.contains("event-stream") {
        let body = response.text().await.unwrap_or_default();
        return Err(errors::from_non_stream_body(&body, &ctx));
    }

    let mut parser = sse::Parser::default();
    let mut decoder = Decoder::new(ep.kind);
    let mut stream = response.bytes_stream();
    let mut emit = |events: Vec<StreamEvent>| -> ControlFlow<()> {
        for event in events {
            let done = matches!(event, StreamEvent::Done { .. });
            on_event(event)?;
            if done {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    };
    loop {
        let chunk = match tokio::time::timeout(ep.idle_timeout, stream.next()).await {
            Err(_) => return Err(errors::timed_out(&ctx)),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(errors::stream_cut(&e.to_string(), &ctx)),
            Ok(Some(Ok(bytes))) => bytes,
        };
        for event in parser.feed(&chunk).map_err(|d| errors::bad_response(d, &ctx))? {
            if emit(decoder.handle(&event, &ctx)?).is_break() {
                return Ok(());
            }
        }
    }
    if let Some(event) = parser.finish() {
        if emit(decoder.handle(&event, &ctx)?).is_break() {
            return Ok(());
        }
    }
    match decoder.finish() {
        Some(done) => {
            let _ = emit(vec![done]);
            Ok(())
        }
        None => Err(errors::stream_cut("De verbinding ging dicht voordat het antwoord af was.", &ctx)),
    }
}

/// Wat een provider over een model vertelt. Velden die hij niet noemt, blijven leeg.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchedModel {
    pub id: String,
    pub display_name: Option<String>,
    pub supports_images: Option<bool>,
    pub context_tokens: Option<u32>,
}

pub async fn list_models(ep: &Endpoint) -> Result<Vec<FetchedModel>, AppError> {
    let mut authorized = ep.authorized().await?;
    match list_models_once(&authorized).await {
        Err(e) if authorized.session.is_some() && errors::is_chatgpt_rejection(&e) => {
            let session = authorized.session.clone().expect("zojuist gecontroleerd");
            authorized.api_key = Some(session.renew_rejected(authorized.api_key.as_ref()).await?);
            list_models_once(&authorized).await
        }
        other => other,
    }
}

async fn list_models_once(ep: &Endpoint) -> Result<Vec<FetchedModel>, AppError> {
    let ctx = ErrorContext { endpoint: ep, model: None };
    let client = ep.client()?;
    let list = async {
        match ep.kind {
            ApiKind::Anthropic => anthropic::list_models(&client, ep, &ctx).await,
            ApiKind::OpenaiCompatible => openai::list_models(&client, ep, &ctx).await,
            ApiKind::ChatgptPlan => responses::list_models(&client, ep, &ctx).await,
        }
    };
    tokio::time::timeout(LIST_TIMEOUT, list).await.map_err(|_| errors::timed_out(&ctx))?
}

async fn get_json(http: reqwest::RequestBuilder, ctx: &ErrorContext<'_>) -> Result<serde_json::Value, AppError> {
    let response = http.send().await.map_err(|e| errors::from_send(&e, ctx))?;
    if !response.status().is_success() {
        return Err(errors::from_response(response, ctx).await);
    }
    let body = response.text().await.map_err(|e| errors::stream_cut(&e.to_string(), ctx))?;
    serde_json::from_str(&body).map_err(|_| errors::from_non_stream_body(&body, ctx))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    /// Leeg als de provider bereikbaar is maar er nog geen model is om mee te proberen.
    pub model: Option<String>,
    pub sample: String,
    pub first_token_ms: Option<u64>,
}

/// De knop "Test verbinding": een piepklein verzoek aan het opgegeven model, of anders aan het eerste model
/// dat de provider noemt. Stopt zodra duidelijk is dat er een antwoord komt.
pub async fn check_connection(ep: &Endpoint, model: Option<Target>, mut on_event: impl FnMut(&StreamEvent)) -> Result<ConnectionReport, AppError> {
    let target = match model {
        Some(t) => t,
        None => match list_models(ep).await?.into_iter().next() {
            Some(m) => Target { endpoint: ep.clone(), model: m.id, supports_images: m.supports_images, context_tokens: m.context_tokens },
            None => return Ok(ConnectionReport { model: None, sample: String::new(), first_token_ms: None }),
        },
    };
    let request = ChatRequest {
        system: None,
        messages: vec![Message { role: Role::User, parts: vec![Part::Text(CHECK_PROMPT.into())] }],
        max_tokens: CHECK_MAX_TOKENS,
    };
    let start = Instant::now();
    let mut first = None;
    let mut sample = String::new();
    stream_chat(&target, &request, |event| {
        first.get_or_insert_with(|| start.elapsed().as_millis() as u64);
        on_event(&event);
        if let StreamEvent::Text { text } = &event {
            sample.push_str(text);
            if sample.chars().count() >= CHECK_SAMPLE_CHARS {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    })
    .await?;
    Ok(ConnectionReport { model: Some(target.model), sample: sample.trim().to_string(), first_token_ms: first })
}
