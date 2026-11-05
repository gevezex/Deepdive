//! Van wat er misgaat naar een melding die de lezer begrijpt. Alles wat van buiten komt gaat eerst door
//! `redact`, want sommige providers herhalen de sleutel in hun foutmelding.

use super::{ApiKind, Endpoint};
use crate::error::AppError;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const MAX_DETAIL: usize = 500;
const MAX_ERROR_BODY: usize = 64 * 1024;

pub struct ErrorContext<'a> {
    pub endpoint: &'a Endpoint,
    /// Alleen gevuld als er om een bepaald model is gevraagd.
    pub model: Option<&'a str>,
}

static KEY_LIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bsk-[a-z0-9_*.\-]{6,}|\bbearer\s+\S+|\b(x-api-key|api[_-]?key|authorization)(\W{1,3})[^\s,}]+").unwrap());
static MODEL_PROBLEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)model_not_found|(unknown|invalid|no such|unsupported) model|not a valid model|model\b.*\b(not found|does not exist|doesn't exist|not exist|unknown|invalid|not available|try pulling)").unwrap()
});
static CONTEXT_PROBLEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)context[ _]length|maximum context|too many tokens|prompt is too long|context window").unwrap());
static QUOTA_PROBLEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)insufficient_quota|exceeded your current quota|credit|billing").unwrap());

/// Haalt de sleutel en alles wat erop lijkt uit tekst van buiten.
pub fn redact(text: &str, key: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        out = out.replace(key, "***");
    }
    KEY_LIKE
        .replace_all(&out, |c: &regex::Captures| match (c.get(1), c.get(2)) {
            (Some(name), Some(sep)) => format!("{}{}***", name.as_str(), sep.as_str()),
            _ => "***".to_string(),
        })
        .into_owned()
}

fn clean(text: &str, ctx: &ErrorContext) -> String {
    let safe = redact(text, ctx.endpoint.api_key.as_ref().map(|k| k.expose()));
    safe.chars().take(MAX_DETAIL).collect()
}

fn host(ctx: &ErrorContext) -> String {
    let url = &ctx.endpoint.base_url;
    match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => url.to_string(),
    }
}

/// Zoekt de eigenlijke melding in de vormen die providers gebruiken.
pub fn provider_message(body: &Value) -> Option<String> {
    let error = body.get("error");
    let text = error.and_then(|e| e.get("message")).and_then(Value::as_str)
        .or_else(|| error.and_then(Value::as_str))
        .or_else(|| body.get("message").and_then(Value::as_str))
        .or_else(|| body.get("detail").and_then(Value::as_str));
    text.map(String::from)
}

pub fn internal(detail: &str) -> AppError {
    AppError::new("internal", "De verbinding kon niet worden voorbereid.").with_detail(detail.to_string())
}

pub fn from_send(e: &reqwest::Error, ctx: &ErrorContext) -> AppError {
    if e.is_timeout() {
        return timed_out(ctx);
    }
    let detail = clean(&e.to_string(), ctx);
    if ctx.endpoint.is_local() {
        return AppError::new("unreachable_local", format!("De lokale server op {} reageert niet. Staat Ollama of LM Studio aan, en klopt de poort?", host(ctx))).with_detail(detail);
    }
    AppError::new("unreachable", format!("{} is niet bereikbaar. Controleer het adres en je internetverbinding.", host(ctx))).with_detail(detail)
}

pub fn timed_out(ctx: &ErrorContext) -> AppError {
    let message = if ctx.endpoint.is_local() {
        format!("De lokale server op {} antwoordde niet op tijd. Mogelijk is het model nog aan het laden of is het te zwaar voor deze computer.", host(ctx))
    } else {
        format!("{} antwoordde niet op tijd. Probeer het later opnieuw.", host(ctx))
    };
    AppError::new("timeout", message)
}

pub fn stream_cut(detail: &str, ctx: &ErrorContext) -> AppError {
    AppError::new("stream_cut", "Het antwoord werd halverwege afgebroken. Probeer het opnieuw.").with_detail(clean(detail, ctx))
}

pub fn bad_response(detail: impl AsRef<str>, ctx: &ErrorContext) -> AppError {
    AppError::new("bad_response", format!("{} gaf een antwoord dat Deepdive niet begrijpt. Controleer of de soort API en het adres kloppen.", host(ctx))).with_detail(clean(detail.as_ref(), ctx))
}

pub async fn from_response(response: reqwest::Response, ctx: &ErrorContext<'_>) -> AppError {
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        let target = response.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or("onbekend").to_string();
        return AppError::new("redirect", "Dit adres stuurt door naar een ander adres. Deepdive volgt dat niet, zodat je sleutel niet ergens anders terechtkomt. Vul het juiste adres in.").with_detail(clean(&format!("{status} naar {target}"), ctx));
    }
    let mut body = response.text().await.unwrap_or_default();
    if body.len() > MAX_ERROR_BODY {
        let mut end = MAX_ERROR_BODY;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
    }
    from_status(status, &body, ctx)
}

pub fn from_status(status: u16, body: &str, ctx: &ErrorContext) -> AppError {
    let json: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let said = provider_message(&json).unwrap_or_default();
    let shown = clean(&said, ctx);
    let detail = clean(&format!("HTTP {status}: {body}"), ctx);
    let model = ctx.model.unwrap_or("dit model");
    let unknown_model = || AppError::new("unknown_model", format!("De provider kent model \"{model}\" niet. Controleer de naam, haal de modellen opnieuw op of installeer het model.")).with_detail(detail.clone());
    let about_model = ctx.model.is_some() && MODEL_PROBLEM.is_match(body);

    let error = match status {
        401 => {
            if ctx.endpoint.api_key.is_some() {
                AppError::new("auth", "De API-sleutel wordt niet geaccepteerd. Controleer of je de juiste sleutel hebt ingevuld en of die nog geldig is.")
            } else {
                AppError::new("auth", "Deze provider vraagt om een API-sleutel, en er is er nog geen ingesteld.")
            }
        }
        403 if about_model => unknown_model(),
        403 => AppError::new("forbidden", "Deze sleutel heeft geen toegang tot deze dienst of dit model."),
        402 => AppError::new("quota", "Je tegoed bij deze provider is op. Vul het aan bij de provider."),
        429 if QUOTA_PROBLEM.is_match(body) => AppError::new("quota", "Je tegoed bij deze provider is op. Vul het aan bij de provider."),
        429 => AppError::new("rate_limited", "Je hebt de limiet van deze provider bereikt. Wacht even en probeer het opnieuw."),
        404 if ctx.model.is_some() && (about_model || said.to_lowercase().contains("model")) => unknown_model(),
        404 => {
            let hint = match ctx.endpoint.kind {
                ApiKind::OpenaiCompatible => " Bij een OpenAI-compatibele API eindigt het adres meestal op /v1.",
                ApiKind::Anthropic => "",
            };
            AppError::new("bad_address", format!("Op dit adres staat niet de verwachte API.{hint}"))
        }
        408 | 504 => timed_out(ctx),
        _ if about_model => unknown_model(),
        _ if CONTEXT_PROBLEM.is_match(body) => AppError::new("context_too_large", format!("Dit is te veel tekst voor model \"{model}\". Kies een model met meer context.")),
        503 | 529 => AppError::new("overloaded", "De provider is tijdelijk overbelast. Probeer het zo opnieuw."),
        500..=599 => AppError::new("server", "De provider heeft een storing. Probeer het later opnieuw."),
        _ if !shown.is_empty() => AppError::new("rejected", format!("De provider weigerde het verzoek: {shown}")),
        _ => AppError::new("rejected", format!("De provider weigerde het verzoek (foutcode {status}).")),
    };
    error.with_detail(detail)
}

/// Een geslaagde HTTP-status, maar geen stream: een fout in JSON, of bijvoorbeeld een webpagina.
pub fn from_non_stream_body(body: &str, ctx: &ErrorContext) -> AppError {
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if json.get("error").is_some() {
            let status = json.pointer("/error/code").and_then(Value::as_u64).map_or(400, |c| c as u16);
            return from_status(status, body, ctx);
        }
    }
    let start: String = body.chars().take(200).collect();
    bad_response(start, ctx)
}
