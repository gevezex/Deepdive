//! De Responses API, voor het gebruik van een ChatGPT-abonnement. Volgt de preview-eisen van OpenAI: altijd
//! `store: false` en `stream: true`, de hele geschiedenis in `input`, de systeemtekst in `instructions` en geen
//! velden die deze route weigert (daarom gaat ook `max_tokens` niet mee).

use super::errors::{self, ErrorContext};
use super::{sse, ChatRequest, Endpoint, FetchedModel, Part, Role, StopReason, StreamEvent};
use crate::error::AppError;
use serde_json::{json, Value};

pub fn chat_body(model: &str, request: &ChatRequest) -> Value {
    let input: Vec<Value> = request.messages.iter().map(input_item).collect();
    let mut body = json!({ "model": model, "input": input, "store": false, "stream": true });
    if let Some(system) = request.system.as_deref().filter(|s| !s.is_empty()) {
        body["instructions"] = json!(system);
    }
    body
}

fn input_item(message: &super::Message) -> Value {
    let content = match (message.role, message.parts.as_slice()) {
        (_, [Part::Text(text)]) => json!(text),
        // Een eerder antwoord bestaat alleen uit tekst; input_text en input_image horen bij de gebruiker.
        (Role::Assistant, parts) => json!(parts.iter().filter_map(|p| if let Part::Text(t) = p { Some(t.as_str()) } else { None }).collect::<Vec<_>>().join("\n")),
        (Role::User, parts) => json!(parts
            .iter()
            .map(|p| match p {
                Part::Text(text) => json!({ "type": "input_text", "text": text }),
                Part::Image { media_type, base64 } => json!({ "type": "input_image", "image_url": format!("data:{media_type};base64,{base64}") }),
            })
            .collect::<Vec<_>>()),
    };
    json!({ "role": message.role, "content": content })
}

fn authorized(http: reqwest::RequestBuilder, ep: &Endpoint) -> reqwest::RequestBuilder {
    match &ep.api_key {
        Some(token) => http.bearer_auth(token.expose()),
        None => http,
    }
}

pub fn chat_request(client: &reqwest::Client, ep: &Endpoint, model: &str, request: &ChatRequest) -> reqwest::RequestBuilder {
    authorized(client.post(ep.url("responses")), ep).json(&chat_body(model, request))
}

pub async fn list_models(client: &reqwest::Client, ep: &Endpoint, ctx: &ErrorContext<'_>) -> Result<Vec<FetchedModel>, AppError> {
    let page = super::get_json(authorized(client.get(ep.url("models")), ep), ctx).await?;
    if page.get("models").and_then(Value::as_array).is_none() {
        return Err(errors::bad_response("Geen lijst met modellen in het antwoord.", ctx));
    }
    Ok(parse_models(&page))
}

/// Alleen modellen die bedoeld zijn om te tonen, in de volgorde van de server.
pub fn parse_models(page: &Value) -> Vec<FetchedModel> {
    let Some(models) = page.get("models").and_then(Value::as_array) else { return vec![] };
    models
        .iter()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let id = m.get("slug")?.as_str()?.to_string();
            let images = m.get("input_modalities").and_then(Value::as_array).map(|list| list.iter().any(|v| v == "image"));
            let context = m.get("context_window").and_then(Value::as_u64);
            Some(FetchedModel { id, display_name: m.get("display_name").and_then(Value::as_str).map(String::from), supports_images: images, context_tokens: context.map(|n| n as u32) })
        })
        .collect()
}

#[derive(Default)]
pub struct Decoder {
    refused: bool,
}

impl Decoder {
    pub fn handle(&mut self, event: &sse::Event, ctx: &ErrorContext) -> Result<Vec<StreamEvent>, AppError> {
        if event.data.trim() == "[DONE]" {
            return Ok(vec![]);
        }
        let value: Value = serde_json::from_str(&event.data).map_err(|_| errors::bad_response(&event.data, ctx))?;
        let kind = value.get("type").and_then(Value::as_str).or(event.name.as_deref()).unwrap_or("");
        let delta = || value.get("delta").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
        Ok(match kind {
            "response.output_text.delta" => delta().map(|text| StreamEvent::Text { text }).into_iter().collect(),
            "response.refusal.delta" => {
                self.refused = true;
                delta().map(|text| StreamEvent::Text { text }).into_iter().collect()
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => delta().map(|text| StreamEvent::Reasoning { text }).into_iter().collect(),
            "response.completed" => vec![self.done(&value, if self.refused { StopReason::Refusal } else { StopReason::End })],
            "response.incomplete" => {
                let stop = match value.pointer("/response/incomplete_details/reason").and_then(Value::as_str) {
                    Some("max_output_tokens") => StopReason::Length,
                    Some("content_filter") => StopReason::Refusal,
                    _ => StopReason::Other,
                };
                vec![self.done(&value, stop)]
            }
            "response.failed" => return Err(stream_error(value.pointer("/response/error"), &event.data, ctx)),
            "error" => return Err(stream_error(value.get("error").or(Some(&value)), &event.data, ctx)),
            _ => vec![],
        })
    }

    fn done(&self, value: &Value, stop: StopReason) -> StreamEvent {
        let count = |name: &str| value.pointer(&format!("/response/usage/{name}")).and_then(Value::as_u64).map(|n| n as u32);
        StreamEvent::Done { stop, input_tokens: count("input_tokens"), output_tokens: count("output_tokens") }
    }

    /// Alleen een eindgebeurtenis telt als af. Gaat de verbinding eerder dicht, dan was het antwoord niet af.
    pub fn finish(&mut self) -> Option<StreamEvent> {
        None
    }
}

fn stream_error(error: Option<&Value>, raw: &str, ctx: &ErrorContext) -> AppError {
    let text = |name: &str| error.and_then(|e| e.get(name)).and_then(Value::as_str);
    errors::chatgpt_stream_error(text("code"), text("param"), text("message"), raw, ctx)
}
