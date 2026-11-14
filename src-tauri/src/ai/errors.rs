//! Van wat er misgaat naar een melding die de lezer begrijpt. Alles wat van buiten komt gaat eerst door
//! `redact`, want sommige providers herhalen de sleutel in hun foutmelding.
//! Bij een ChatGPT-abonnement houden we status, foutcode en verzoek-ID vast in de details, zoals OpenAI vraagt.

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

static KEY_LIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bsk-[a-z0-9_*.\-]{6,}|\beyJ[a-z0-9_\-]{8,}(\.[a-z0-9_\-]*)*|\bbearer\s+\S+|\b(x-api-key|api[_-]?key|authorization)(\W{1,3})[^\s,}]+").unwrap());
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
    AppError::new("internal", crate::i18n::tr("The connection could not be prepared.", "De verbinding kon niet worden voorbereid.", "Bağlantı hazırlanamadı.")).with_detail(detail.to_string())
}

pub fn from_send(e: &reqwest::Error, ctx: &ErrorContext) -> AppError {
    if e.is_timeout() {
        return timed_out(ctx);
    }
    let detail = clean(&e.to_string(), ctx);
    if ctx.endpoint.is_local() {
        return AppError::new("unreachable_local", crate::i18n::tr("The local server at {host} is not responding. Is Ollama or LM Studio running, and is the port correct?", "De lokale server op {host} reageert niet. Staat Ollama of LM Studio aan, en klopt de poort?", "{host} adresindeki yerel sunucu yanıt vermiyor. Ollama veya LM Studio açık mı, port doğru mu?").replace("{host}", &host(ctx))).with_detail(detail);
    }
    AppError::new("unreachable", crate::i18n::tr("{host} cannot be reached. Check the address and your internet connection.", "{host} is niet bereikbaar. Controleer het adres en je internetverbinding.", "{host} adresine ulaşılamıyor. Adresi ve internet bağlantınızı kontrol edin.").replace("{host}", &host(ctx))).with_detail(detail)
}

pub fn timed_out(ctx: &ErrorContext) -> AppError {
    let message = if ctx.endpoint.is_local() {
        crate::i18n::tr("The local server at {host} did not respond in time. The model may still be loading, or it may be too heavy for this computer.", "De lokale server op {host} antwoordde niet op tijd. Mogelijk is het model nog aan het laden of is het te zwaar voor deze computer.", "{host} adresindeki yerel sunucu zamanında yanıt vermedi. Model hâlâ yükleniyor olabilir ya da bu bilgisayar için fazla ağır olabilir.")
    } else {
        crate::i18n::tr("{host} did not respond in time. Please try again later.", "{host} antwoordde niet op tijd. Probeer het later opnieuw.", "{host} zamanında yanıt vermedi. Lütfen daha sonra tekrar deneyin.")
    };
    AppError::new("timeout", message.replace("{host}", &host(ctx)))
}

pub fn stream_cut(detail: &str, ctx: &ErrorContext) -> AppError {
    AppError::new("stream_cut", crate::i18n::tr("The answer was cut off halfway. Please try again.", "Het antwoord werd halverwege afgebroken. Probeer het opnieuw.", "Yanıt yarıda kesildi. Lütfen tekrar deneyin.")).with_detail(clean(detail, ctx))
}

pub fn bad_response(detail: impl AsRef<str>, ctx: &ErrorContext) -> AppError {
    AppError::new("bad_response", crate::i18n::tr("{host} sent a response Deepdive does not understand. Check that the API type and the address are correct.", "{host} gaf een antwoord dat Deepdive niet begrijpt. Controleer of de soort API en het adres kloppen.", "{host}, Deepdive'ın anlamadığı bir yanıt verdi. API türünün ve adresin doğru olduğunu kontrol edin.").replace("{host}", &host(ctx))).with_detail(clean(detail.as_ref(), ctx))
}

pub async fn from_response(response: reqwest::Response, ctx: &ErrorContext<'_>) -> AppError {
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        let target = response.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_else(|| crate::i18n::tr("unknown", "onbekend", "bilinmiyor"));
        let to = crate::i18n::tr("to", "naar", "→");
        return AppError::new("redirect", crate::i18n::tr("This address redirects to another address. Deepdive does not follow it, so your key cannot end up somewhere else. Enter the correct address.", "Dit adres stuurt door naar een ander adres. Deepdive volgt dat niet, zodat je sleutel niet ergens anders terechtkomt. Vul het juiste adres in.", "Bu adres başka bir adrese yönlendiriyor. Anahtarınız başka bir yere gitmesin diye Deepdive bu yönlendirmeyi izlemiyor. Doğru adresi girin.")).with_detail(clean(&format!("{status} {to} {target}"), ctx));
    }
    let request_id = response.headers().get("x-request-id").and_then(|v| v.to_str().ok()).map(String::from);
    let mut body = response.text().await.unwrap_or_default();
    if body.len() > MAX_ERROR_BODY {
        let mut end = MAX_ERROR_BODY;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
    }
    let error = from_status(status, &body, ctx);
    match (ctx.endpoint.kind, request_id) {
        (ApiKind::ChatgptPlan, Some(id)) => {
            let label = crate::i18n::tr("request ID", "verzoek-ID", "istek kimliği");
            let detail = format!("{} ({label}: {})", error.detail.clone().unwrap_or_default(), clean(&id, ctx));
            error.with_detail(detail)
        }
        _ => error,
    }
}

pub fn from_status(status: u16, body: &str, ctx: &ErrorContext) -> AppError {
    let json: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let said = provider_message(&json).unwrap_or_default();
    let shown = clean(&said, ctx);
    let detail = clean(&format!("HTTP {status}: {body}"), ctx);
    let model = ctx.model.map(String::from).unwrap_or_else(|| crate::i18n::tr("this model", "dit model", "bu model"));
    let unknown_model = || AppError::new("unknown_model", crate::i18n::tr("The provider does not know model \"{model}\". Check the name, fetch the models again, or install the model.", "De provider kent model \"{model}\" niet. Controleer de naam, haal de modellen opnieuw op of installeer het model.", "Sağlayıcı \"{model}\" modelini tanımıyor. Adı kontrol edin, modelleri yeniden getirin ya da modeli yükleyin.").replace("{model}", &model)).with_detail(detail.clone());
    let about_model = ctx.model.is_some() && MODEL_PROBLEM.is_match(body);

    if ctx.endpoint.kind == ApiKind::ChatgptPlan {
        let code = json.pointer("/error/code").and_then(Value::as_str);
        let param = json.pointer("/error/param").and_then(Value::as_str);
        if let Some(error) = code.and_then(|c| chatgpt_code(c, param)) {
            return error.with_detail(detail);
        }
        let error = match status {
            401 => Some(AppError::new("chatgpt_rejected", crate::i18n::tr("ChatGPT does not accept this sign-in. Check that you are signed in with the right account, and sign in again if needed.", "ChatGPT accepteert deze aanmelding niet. Controleer of je met het juiste account bent ingelogd en log zo nodig opnieuw in.", "ChatGPT bu oturumu kabul etmiyor. Doğru hesapla giriş yaptığınızı kontrol edin ve gerekirse yeniden giriş yapın."))),
            403 if !about_model => Some(AppError::new("chatgpt_forbidden", crate::i18n::tr("ChatGPT does not allow this request, for example because of your region or a policy.", "ChatGPT staat dit verzoek niet toe, bijvoorbeeld door je regio of door beleid.", "ChatGPT bu isteğe izin vermiyor; örneğin bölgeniz ya da bir politika nedeniyle."))),
            503 if !about_model => Some(AppError::new("chatgpt_unavailable", crate::i18n::tr("Using your ChatGPT subscription is temporarily unavailable. You are still signed in; please try again later.", "Het gebruik van je ChatGPT-abonnement is tijdelijk niet beschikbaar. Je blijft ingelogd; probeer het later opnieuw.", "ChatGPT aboneliğinizin kullanımı geçici olarak kullanılamıyor. Oturumunuz açık kalıyor; lütfen daha sonra tekrar deneyin."))),
            _ => None,
        };
        if let Some(error) = error {
            return error.with_detail(detail);
        }
    }

    let error = match status {
        401 => {
            if ctx.endpoint.api_key.is_some() {
                AppError::new("auth", crate::i18n::tr("The API key is not accepted. Check that you entered the right key and that it is still valid.", "De API-sleutel wordt niet geaccepteerd. Controleer of je de juiste sleutel hebt ingevuld en of die nog geldig is.", "API anahtarı kabul edilmiyor. Doğru anahtarı girdiğinizi ve anahtarın hâlâ geçerli olduğunu kontrol edin."))
            } else {
                AppError::new("auth", crate::i18n::tr("This provider requires an API key, and none has been set yet.", "Deze provider vraagt om een API-sleutel, en er is er nog geen ingesteld.", "Bu sağlayıcı bir API anahtarı istiyor, ancak henüz bir anahtar ayarlanmadı."))
            }
        }
        403 if about_model => unknown_model(),
        403 => AppError::new("forbidden", crate::i18n::tr("This key has no access to this service or this model.", "Deze sleutel heeft geen toegang tot deze dienst of dit model.", "Bu anahtarın bu hizmete veya bu modele erişimi yok.")),
        402 => AppError::new("quota", crate::i18n::tr("Your credit with this provider has run out. Top it up with the provider.", "Je tegoed bij deze provider is op. Vul het aan bij de provider.", "Bu sağlayıcıdaki krediniz bitti. Sağlayıcıdan kredi yükleyin.")),
        429 if QUOTA_PROBLEM.is_match(body) => AppError::new("quota", crate::i18n::tr("Your credit with this provider has run out. Top it up with the provider.", "Je tegoed bij deze provider is op. Vul het aan bij de provider.", "Bu sağlayıcıdaki krediniz bitti. Sağlayıcıdan kredi yükleyin.")),
        429 => AppError::new("rate_limited", crate::i18n::tr("You have reached this provider's rate limit. Wait a moment and try again.", "Je hebt de limiet van deze provider bereikt. Wacht even en probeer het opnieuw.", "Bu sağlayıcının istek sınırına ulaştınız. Biraz bekleyip tekrar deneyin.")),
        404 if ctx.model.is_some() && (about_model || said.to_lowercase().contains("model")) => unknown_model(),
        404 => {
            let hint = match ctx.endpoint.kind {
                ApiKind::OpenaiCompatible => crate::i18n::tr(" With an OpenAI-compatible API, the address usually ends in /v1.", " Bij een OpenAI-compatibele API eindigt het adres meestal op /v1.", " OpenAI uyumlu bir API'de adres genellikle /v1 ile biter."),
                ApiKind::Anthropic | ApiKind::ChatgptPlan => String::new(),
            };
            AppError::new("bad_address", crate::i18n::tr("The expected API is not at this address.", "Op dit adres staat niet de verwachte API.", "Bu adreste beklenen API yok.") + &hint)
        }
        408 | 504 => timed_out(ctx),
        _ if about_model => unknown_model(),
        _ if CONTEXT_PROBLEM.is_match(body) => AppError::new("context_too_large", crate::i18n::tr("This is too much text for model \"{model}\". Choose a model with more context.", "Dit is te veel tekst voor model \"{model}\". Kies een model met meer context.", "Bu metin \"{model}\" modeli için fazla uzun. Daha geniş bağlamlı bir model seçin.").replace("{model}", &model)),
        503 | 529 => AppError::new("overloaded", crate::i18n::tr("The provider is temporarily overloaded. Please try again shortly.", "De provider is tijdelijk overbelast. Probeer het zo opnieuw.", "Sağlayıcı geçici olarak aşırı yüklü. Birazdan tekrar deneyin.")),
        500..=599 => AppError::new("server", crate::i18n::tr("The provider is having an outage. Please try again later.", "De provider heeft een storing. Probeer het later opnieuw.", "Sağlayıcıda bir arıza var. Lütfen daha sonra tekrar deneyin.")),
        _ if !shown.is_empty() => AppError::new("rejected", crate::i18n::tr("The provider refused the request: ", "De provider weigerde het verzoek: ", "Sağlayıcı isteği reddetti: ") + &shown),
        _ => AppError::new("rejected", crate::i18n::tr("The provider refused the request (error code {status}).", "De provider weigerde het verzoek (foutcode {status}).", "Sağlayıcı isteği reddetti (hata kodu {status}).").replace("{status}", &status.to_string())),
    };
    error.with_detail(detail)
}

/// De foutcodes waarvoor OpenAI een eigen herstelstap voorschrijft.
fn chatgpt_code(code: &str, param: Option<&str>) -> Option<AppError> {
    Some(match code {
        "subscription_sharing_user_not_eligible" => AppError::new("chatgpt_not_eligible", crate::i18n::tr("Your ChatGPT subscription cannot be used in this app, for example because of your plan, your workspace or a policy. Use another provider, such as your own API key.", "Je ChatGPT-abonnement kan niet in deze app worden gebruikt, bijvoorbeeld door je abonnement, je werkruimte of beleid. Gebruik een andere provider, zoals een eigen API-sleutel.", "ChatGPT aboneliğiniz bu uygulamada kullanılamıyor; örneğin planınız, çalışma alanınız ya da bir politika nedeniyle. Kendi API anahtarınız gibi başka bir sağlayıcı kullanın.")),
        "subscription_sharing_usage_limit_exceeded" => AppError::new("chatgpt_usage_limit", crate::i18n::tr("You have reached the usage limit, either of your ChatGPT subscription or the one specific to Deepdive. Check the limit under Manage usage.", "Je hebt de gebruikslimiet bereikt: van je ChatGPT-abonnement of specifiek voor Deepdive. Bekijk de limiet bij Manage usage.", "Kullanım sınırına ulaştınız: ChatGPT aboneliğinizin sınırı ya da Deepdive'a özel sınır. Sınırı Manage usage bölümünden kontrol edin.")),
        "subscription_sharing_usage_unavailable" => AppError::new("chatgpt_usage_unavailable", crate::i18n::tr("ChatGPT could not check your usage right now. You are still signed in; please try again later.", "ChatGPT kon je gebruik nu niet controleren. Je blijft ingelogd; probeer het later opnieuw.", "ChatGPT şu anda kullanımınızı kontrol edemedi. Oturumunuz açık kalıyor; lütfen daha sonra tekrar deneyin.")),
        "subscription_sharing_unsupported_capability" => {
            let what = param.map(|p| format!(" ({}: {p})", crate::i18n::tr("part", "onderdeel", "bölüm"))).unwrap_or_default();
            AppError::new("chatgpt_unsupported", crate::i18n::tr("This is not supported when using your ChatGPT subscription{what}. Choose another model or remove the attachment.", "Dit wordt niet ondersteund bij gebruik van je ChatGPT-abonnement{what}. Kies een ander model of haal de bijlage weg.", "ChatGPT aboneliğiniz kullanılırken bu desteklenmiyor{what}. Başka bir model seçin ya da eki kaldırın.").replace("{what}", &what))
        }
        "subscription_sharing_route_not_supported" => AppError::new("chatgpt_route", crate::i18n::tr("Deepdive is using a route here that ChatGPT does not support. This is a bug in the app; please report it.", "Deepdive gebruikt hier een route die ChatGPT niet ondersteunt. Dit is een fout in de app; meld hem gerust.", "Deepdive burada ChatGPT'nin desteklemediği bir yol kullanıyor. Bu uygulamadaki bir hata; lütfen bildirin.")),
        "subscription_sharing_invalid_user" => AppError::new("chatgpt_invalid_user", crate::i18n::tr("ChatGPT could not verify your account. Sign in again if this keeps happening.", "ChatGPT kon je account niet controleren. Log opnieuw in als dit blijft gebeuren.", "ChatGPT hesabınızı doğrulayamadı. Bu tekrarlanırsa yeniden giriş yapın.")),
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => AppError::new("chatgpt_not_authorized", crate::i18n::tr("This connection is not authorized for this request. Check with this provider that using your subscription is turned on.", "Deze koppeling heeft geen toestemming voor dit verzoek. Controleer bij deze provider of het gebruik van je abonnement aan staat.", "Bu bağlantının bu istek için izni yok. Bu sağlayıcıda aboneliğinizin kullanımının açık olduğunu kontrol edin.")),
        "subscription_sharing_user_unavailable" => AppError::new("chatgpt_user_unavailable", crate::i18n::tr("Your account details are temporarily unavailable. You are still signed in; please try again later.", "Je accountgegevens zijn tijdelijk niet beschikbaar. Je blijft ingelogd; probeer het later opnieuw.", "Hesap bilgileriniz geçici olarak kullanılamıyor. Oturumunuz açık kalıyor; lütfen daha sonra tekrar deneyin.")),
        _ => return None,
    })
}

/// Een fout die pas tijdens de stream komt, zoals een limiet nadat het antwoord al begonnen is.
pub fn chatgpt_stream_error(code: Option<&str>, param: Option<&str>, message: Option<&str>, raw: &str, ctx: &ErrorContext) -> AppError {
    let detail = clean(raw, ctx);
    if let Some(error) = code.and_then(|c| chatgpt_code(c, param)) {
        return error.with_detail(detail);
    }
    let shown = message.map(|m| clean(m, ctx)).filter(|m| !m.is_empty());
    AppError::new("chatgpt_failed", shown.map_or(crate::i18n::tr("The model could not give an answer. Please try again.", "Het model kon geen antwoord geven. Probeer het opnieuw.", "Model bir yanıt veremedi. Lütfen tekrar deneyin."), |m| crate::i18n::tr("The model could not give an answer: ", "Het model kon geen antwoord geven: ", "Model bir yanıt veremedi: ") + &m)).with_detail(detail)
}

/// Fouten waarbij een nieuw toegangstoken kan helpen.
pub fn is_chatgpt_rejection(error: &AppError) -> bool {
    matches!(error.kind, "chatgpt_rejected" | "chatgpt_invalid_user")
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
