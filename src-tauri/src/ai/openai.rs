//! OpenAI-compatibele API's: OpenAI, OpenRouter, Ollama en LM Studio. Het basisadres eindigt meestal op /v1.

use super::errors::{self, ErrorContext};
use super::{sse, ChatRequest, Endpoint, FetchedModel, Part, StopReason, StreamEvent};
use crate::error::AppError;
use serde_json::{json, Value};

pub fn chat_body(ep: &Endpoint, model: &str, request: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = vec![];
    if let Some(system) = &request.system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for m in &request.messages {
        let content = match m.parts.as_slice() {
            // Gewone tekst als tekst: niet elke lokale server kent de lijstvorm.
            [Part::Text(text)] => json!(text),
            parts => json!(parts
                .iter()
                .map(|p| match p {
                    Part::Text(text) => json!({ "type": "text", "text": text }),
                    Part::Image { media_type, base64 } => json!({ "type": "image_url", "image_url": { "url": format!("data:{media_type};base64,{base64}") } }),
                })
                .collect::<Vec<_>>()),
        };
        messages.push(json!({ "role": m.role, "content": content }));
    }
    let mut body = json!({ "model": model, "stream": true, "messages": messages });
    // OpenAI zelf weigert max_tokens bij nieuwere modellen; de rest kent juist alleen max_tokens.
    let limit = if ep.base_url.host_str() == Some("api.openai.com") { "max_completion_tokens" } else { "max_tokens" };
    body[limit] = json!(request.max_tokens);
    body
}

fn authorized(http: reqwest::RequestBuilder, ep: &Endpoint) -> reqwest::RequestBuilder {
    match &ep.api_key {
        Some(key) => http.bearer_auth(key.expose()),
        None => http,
    }
}

pub fn chat_request(client: &reqwest::Client, ep: &Endpoint, model: &str, request: &ChatRequest) -> reqwest::RequestBuilder {
    authorized(client.post(ep.url("chat/completions")), ep).json(&chat_body(ep, model, request))
}

pub async fn list_models(client: &reqwest::Client, ep: &Endpoint, ctx: &ErrorContext<'_>) -> Result<Vec<FetchedModel>, AppError> {
    let page = super::get_json(authorized(client.get(ep.url("models")), ep), ctx).await?;
    if page.get("data").and_then(Value::as_array).is_none() {
        return Err(errors::bad_response("Geen lijst met modellen in het antwoord.", ctx));
    }
    Ok(parse_models(&page))
}

pub fn parse_models(page: &Value) -> Vec<FetchedModel> {
    let Some(data) = page.get("data").and_then(Value::as_array) else { return vec![] };
    data.iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            if is_not_for_chat(&id) {
                return None;
            }
            let context = m.get("context_length").or_else(|| m.get("max_context_length")).and_then(Value::as_u64);
            let images = m.pointer("/architecture/input_modalities").and_then(Value::as_array).map(|list| list.iter().any(|v| v == "image"));
            Some(FetchedModel {
                id,
                display_name: m.get("name").and_then(Value::as_str).map(String::from),
                supports_images: images,
                context_tokens: context.map(|n| n as u32),
            })
        })
        .collect()
}

fn is_not_for_chat(id: &str) -> bool {
    let id = id.to_lowercase();
    ["embed", "whisper", "tts", "dall-e", "moderation"].iter().any(|word| id.contains(word))
}

#[derive(Default)]
pub struct Decoder {
    stop: Option<StopReason>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
}

impl Decoder {
    pub fn handle(&mut self, event: &sse::Event, ctx: &ErrorContext) -> Result<Vec<StreamEvent>, AppError> {
        if event.data.trim() == "[DONE]" {
            return Ok(vec![self.done()]);
        }
        let value: Value = serde_json::from_str(&event.data).map_err(|_| errors::bad_response(&event.data, ctx))?;
        if value.get("error").is_some() {
            let status = value.pointer("/error/code").and_then(Value::as_u64).filter(|c| (400..600).contains(c)).map_or(500, |c| c as u16);
            return Err(errors::from_status(status, &event.data, ctx));
        }
        if let Some(usage) = value.get("usage") {
            let count = |name: &str| usage.get(name).and_then(Value::as_u64).map(|n| n as u32);
            self.input_tokens = count("prompt_tokens").or(self.input_tokens);
            self.output_tokens = count("completion_tokens").or(self.output_tokens);
        }
        let mut events = vec![];
        let Some(choice) = value.pointer("/choices/0") else { return Ok(events) };
        let delta = choice.get("delta");
        let field = |name: &str| delta.and_then(|d| d.get(name)).and_then(Value::as_str).filter(|s| !s.is_empty());
        if let Some(text) = field("reasoning_content").or_else(|| field("reasoning")) {
            events.push(StreamEvent::Reasoning { text: text.to_string() });
        }
        if let Some(text) = field("content") {
            events.push(StreamEvent::Text { text: text.to_string() });
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.stop = Some(stop_reason(reason));
        }
        Ok(events)
    }

    fn done(&self) -> StreamEvent {
        StreamEvent::Done { stop: self.stop.unwrap_or(StopReason::End), input_tokens: self.input_tokens, output_tokens: self.output_tokens }
    }

    /// Niet elke server stuurt [DONE]. Een opgegeven reden om te stoppen is dan ook een net einde.
    pub fn finish(&mut self) -> Option<StreamEvent> {
        self.stop.is_some().then(|| self.done())
    }
}

fn stop_reason(reason: &str) -> StopReason {
    match reason {
        "stop" => StopReason::End,
        "length" => StopReason::Length,
        "content_filter" => StopReason::Refusal,
        _ => StopReason::Other,
    }
}
