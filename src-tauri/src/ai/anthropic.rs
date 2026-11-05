//! De Anthropic-API: POST /v1/messages en GET /v1/models. Het basisadres bevat geen /v1.

use super::errors::{self, ErrorContext};
use super::{sse, ChatRequest, Endpoint, FetchedModel, Part, StopReason, StreamEvent};
use crate::error::AppError;
use reqwest::header::HeaderValue;
use serde_json::{json, Value};

const API_VERSION: &str = "2023-06-01";
const MAX_PAGES: usize = 20;

fn authorized(http: reqwest::RequestBuilder, ep: &Endpoint) -> Result<reqwest::RequestBuilder, AppError> {
    let http = http.header("anthropic-version", API_VERSION);
    let Some(key) = &ep.api_key else { return Ok(http) };
    let mut value = HeaderValue::from_str(key.expose()).map_err(|_| AppError::new("key_invalid", "De opgeslagen API-sleutel bevat ongeldige tekens. Vul hem opnieuw in."))?;
    value.set_sensitive(true);
    Ok(http.header("x-api-key", value))
}

pub fn chat_body(model: &str, request: &ChatRequest) -> Value {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|m| {
            let content: Vec<Value> = m
                .parts
                .iter()
                .map(|p| match p {
                    Part::Text(text) => json!({ "type": "text", "text": text }),
                    Part::Image { media_type, base64 } => json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": base64 } }),
                })
                .collect();
            json!({ "role": m.role, "content": content })
        })
        .collect();
    let mut body = json!({ "model": model, "max_tokens": request.max_tokens, "stream": true, "messages": messages });
    if let Some(system) = &request.system {
        body["system"] = json!(system);
    }
    body
}

pub fn chat_request(client: &reqwest::Client, ep: &Endpoint, model: &str, request: &ChatRequest) -> Result<reqwest::RequestBuilder, AppError> {
    Ok(authorized(client.post(ep.url("v1/messages")), ep)?.json(&chat_body(model, request)))
}

pub async fn list_models(client: &reqwest::Client, ep: &Endpoint, ctx: &ErrorContext<'_>) -> Result<Vec<FetchedModel>, AppError> {
    let mut models = vec![];
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut http = client.get(ep.url("v1/models")).query(&[("limit", "1000")]);
        if let Some(id) = &after {
            http = http.query(&[("after_id", id)]);
        }
        let page = super::get_json(authorized(http, ep)?, ctx).await?;
        models.extend(parse_models(&page));
        after = page.get("last_id").and_then(Value::as_str).map(String::from);
        if !page.get("has_more").and_then(Value::as_bool).unwrap_or(false) || after.is_none() {
            break;
        }
    }
    Ok(models)
}

pub fn parse_models(page: &Value) -> Vec<FetchedModel> {
    let Some(data) = page.get("data").and_then(Value::as_array) else { return vec![] };
    data.iter()
        .filter_map(|m| {
            Some(FetchedModel {
                id: m.get("id")?.as_str()?.to_string(),
                display_name: m.get("display_name").and_then(Value::as_str).map(String::from),
                supports_images: m.pointer("/capabilities/image_input/supported").and_then(Value::as_bool),
                context_tokens: m.get("max_input_tokens").and_then(Value::as_u64).map(|n| n as u32),
            })
        })
        .collect()
}

#[derive(Default)]
pub struct Decoder {
    stop: Option<StopReason>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
}

impl Decoder {
    pub fn handle(&mut self, event: &sse::Event, ctx: &ErrorContext) -> Result<Vec<StreamEvent>, AppError> {
        let value: Value = serde_json::from_str(&event.data).map_err(|_| errors::bad_response(&event.data, ctx))?;
        let kind = event.name.as_deref().or_else(|| value.get("type").and_then(Value::as_str)).unwrap_or("");
        let count = |pointer: &str| value.pointer(pointer).and_then(Value::as_u64).map(|n| n as u32);
        match kind {
            "message_start" => self.input_tokens = count("/message/usage/input_tokens"),
            "content_block_delta" => {
                let text = value.pointer("/delta/text").and_then(Value::as_str);
                let thinking = value.pointer("/delta/thinking").and_then(Value::as_str);
                if let Some(text) = text {
                    return Ok(vec![StreamEvent::Text { text: text.to_string() }]);
                }
                if let Some(text) = thinking {
                    return Ok(vec![StreamEvent::Reasoning { text: text.to_string() }]);
                }
            }
            "message_delta" => {
                self.stop = value.pointer("/delta/stop_reason").and_then(Value::as_str).map(stop_reason).or(self.stop);
                self.output_tokens = count("/usage/output_tokens").or(self.output_tokens);
            }
            "message_stop" => return Ok(vec![self.done()]),
            "error" => {
                let status = match value.pointer("/error/type").and_then(Value::as_str).unwrap_or("") {
                    "authentication_error" => 401,
                    "permission_error" => 403,
                    "not_found_error" => 404,
                    "rate_limit_error" => 429,
                    "overloaded_error" => 529,
                    "invalid_request_error" => 400,
                    _ => 500,
                };
                return Err(errors::from_status(status, &event.data, ctx));
            }
            _ => {}
        }
        Ok(vec![])
    }

    fn done(&self) -> StreamEvent {
        StreamEvent::Done { stop: self.stop.unwrap_or(StopReason::End), input_tokens: self.input_tokens, output_tokens: self.output_tokens }
    }

    pub fn finish(&mut self) -> Option<StreamEvent> {
        self.stop.is_some().then(|| self.done())
    }
}

fn stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" | "stop_sequence" => StopReason::End,
        "max_tokens" => StopReason::Length,
        "refusal" => StopReason::Refusal,
        _ => StopReason::Other,
    }
}
