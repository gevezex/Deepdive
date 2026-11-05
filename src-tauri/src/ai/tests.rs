//! De AI-laag tegen een lokale nepserver: echte HTTP en echte SSE, zonder echte provider.

use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;

const KEY: &str = "nep-sleutel-QX7Z-niet-echt";

#[derive(Clone)]
enum Step {
    Send(Vec<u8>),
    Wait(Arc<Notify>),
    Hang,
}

#[derive(Clone)]
struct Reply {
    head: String,
    steps: Vec<Step>,
}

fn reply(status: u16, content_type: &str, body: &str) -> Reply {
    Reply { head: format!("HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n"), steps: vec![Step::Send(body.as_bytes().to_vec())] }
}

fn sse(steps: Vec<Step>) -> Reply {
    Reply { head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n".into(), steps }
}

fn send(text: &str) -> Step {
    Step::Send(text.as_bytes().to_vec())
}

#[derive(Debug, Clone)]
struct Seen {
    head: String,
    body: String,
}

impl Seen {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|l| {
            let (n, v) = l.split_once(':')?;
            n.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap()
    }
}

/// Een nepserver die altijd hetzelfde antwoordt, of per aanvraag een antwoord op basis van de eerste regel.
async fn serve(route: impl Fn(&str) -> Reply + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    let route = Arc::new(route);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let log = log.clone();
            let route = route.clone();
            tokio::spawn(async move {
                let mut data = vec![];
                let mut buf = [0u8; 4096];
                let head_end = loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(p) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let head = String::from_utf8_lossy(&data[..head_end]).to_string();
                let length = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                while data.len() < head_end + length {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                }
                let seen = Seen { head: head.clone(), body: String::from_utf8_lossy(&data[head_end..]).to_string() };
                log.lock().unwrap().push(seen);
                let answer = route(head.lines().next().unwrap_or(""));
                if socket.write_all(answer.head.as_bytes()).await.is_err() {
                    return;
                }
                for step in answer.steps {
                    match step {
                        Step::Send(bytes) => {
                            if socket.write_all(&bytes).await.is_err() {
                                return;
                            }
                            let _ = socket.flush().await;
                        }
                        Step::Wait(gate) => gate.notified().await,
                        Step::Hang => std::future::pending::<()>().await,
                    }
                }
            });
        }
    });
    (base, seen)
}

fn endpoint(kind: ApiKind, base: &str) -> Endpoint {
    Endpoint::new(kind, Url::parse(base).unwrap(), Some(ApiKey::new(KEY)))
}

fn target(kind: ApiKind, base: &str) -> Target {
    Target { endpoint: endpoint(kind, base), model: "test-model".into(), supports_images: None, context_tokens: None }
}

fn hello() -> ChatRequest {
    ChatRequest { system: Some("Wees kort.".into()), messages: vec![Message { role: Role::User, parts: vec![Part::Text("Hallo".into())] }], max_tokens: 50 }
}

async fn collect(target: &Target) -> Result<Vec<StreamEvent>, AppError> {
    let mut events = vec![];
    stream_chat(target, &hello(), |e| {
        events.push(e);
        ControlFlow::Continue(())
    })
    .await?;
    Ok(events)
}

fn text_of(events: &[StreamEvent]) -> String {
    events.iter().filter_map(|e| if let StreamEvent::Text { text } = e { Some(text.as_str()) } else { None }).collect()
}

fn openai_chunk(text: &str) -> String {
    format!("data: {}\n\n", serde_json::json!({ "choices": [{ "delta": { "content": text }, "finish_reason": null }] }))
}

fn anthropic_chunk(text: &str) -> String {
    format!("event: content_block_delta\ndata: {}\n\n", serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } }))
}

const OPENAI_END: &str = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
const ANTHROPIC_START: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\n";
const ANTHROPIC_END: &str = "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

fn done(stop: StopReason) -> StreamEvent {
    StreamEvent::Done { stop, input_tokens: Some(7), output_tokens: Some(2) }
}

/// Het hart van de streamingtest: de server stuurt het tweede stuk pas nadat de callback het eerste heeft gezien.
/// Zou er ergens worden gebufferd tot het einde, dan loopt deze test vast op de tijdslimiet.
async fn streams_piece_by_piece(kind: ApiKind, base_suffix: &str, first: String, second: String, start: &str, end: &str) {
    let gate = Arc::new(Notify::new());
    let steps = vec![send(start), send(&first), Step::Wait(gate.clone()), send(&second), send(end)];
    let (base, seen) = serve(move |_| sse(steps.clone())).await;
    let target = target(kind, &format!("{base}{base_suffix}"));
    let mut events = vec![];
    let request = hello();
    let run = stream_chat(&target, &request, |e| {
        if matches!(&e, StreamEvent::Text { text } if text == "Hal") {
            gate.notify_one();
        }
        events.push(e);
        ControlFlow::Continue(())
    });
    tokio::time::timeout(Duration::from_secs(5), run).await.expect("het tweede stuk kwam pas na het eerste, dus er is niet gebufferd").unwrap();
    assert_eq!(events, vec![StreamEvent::Text { text: "Hal".into() }, StreamEvent::Text { text: "lo".into() }, done(StopReason::End)]);
    assert_eq!(seen.lock().unwrap()[0].json()["stream"], true);
}

#[tokio::test]
async fn openai_streams_piece_by_piece() {
    streams_piece_by_piece(ApiKind::OpenaiCompatible, "/v1", openai_chunk("Hal"), openai_chunk("lo"), "", OPENAI_END).await;
}

#[tokio::test]
async fn anthropic_streams_piece_by_piece() {
    streams_piece_by_piece(ApiKind::Anthropic, "", anthropic_chunk("Hal"), anthropic_chunk("lo"), ANTHROPIC_START, ANTHROPIC_END).await;
}

#[tokio::test]
async fn openai_request_has_the_right_shape() {
    let (base, seen) = serve(|_| sse(vec![send(OPENAI_END)])).await;
    collect(&target(ApiKind::OpenaiCompatible, &format!("{base}/v1"))).await.unwrap();
    let req = seen.lock().unwrap()[0].clone();
    assert!(req.head.starts_with("POST /v1/chat/completions "));
    assert_eq!(req.header("authorization").unwrap(), format!("Bearer {KEY}"));
    assert!(req.header("x-api-key").is_none());
    let body = req.json();
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["max_tokens"], 50);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["content"], "Hallo");
}

#[tokio::test]
async fn anthropic_request_has_the_right_shape() {
    let (base, seen) = serve(|_| sse(vec![send(ANTHROPIC_END)])).await;
    collect(&target(ApiKind::Anthropic, &base)).await.unwrap();
    let req = seen.lock().unwrap()[0].clone();
    assert!(req.head.starts_with("POST /v1/messages "));
    assert_eq!(req.header("x-api-key").unwrap(), KEY);
    assert_eq!(req.header("anthropic-version").unwrap(), "2023-06-01");
    assert!(req.header("authorization").is_none());
    let body = req.json();
    assert_eq!(body["system"], "Wees kort.");
    assert_eq!(body["max_tokens"], 50);
    assert_eq!(body["messages"][0]["content"][0]["text"], "Hallo");
}

#[test]
fn images_are_sent_in_each_dialect() {
    let request = ChatRequest {
        system: None,
        messages: vec![Message { role: Role::User, parts: vec![Part::Text("Wat zie je?".into()), Part::Image { media_type: "image/png".into(), base64: "QUJD".into() }] }],
        max_tokens: 5,
    };
    let a = anthropic::chat_body("m", &request);
    assert_eq!(a["messages"][0]["content"][1]["source"]["data"], "QUJD");
    assert_eq!(a["messages"][0]["content"][1]["source"]["media_type"], "image/png");
    let ep = endpoint(ApiKind::OpenaiCompatible, "http://localhost:1/v1");
    let o = openai::chat_body(&ep, "m", &request);
    assert_eq!(o["messages"][0]["content"][1]["image_url"]["url"], "data:image/png;base64,QUJD");
}

#[test]
fn openai_itself_gets_the_newer_token_limit() {
    let ep = endpoint(ApiKind::OpenaiCompatible, "https://api.openai.com/v1");
    let body = openai::chat_body(&ep, "m", &hello());
    assert_eq!(body["max_completion_tokens"], 50);
    assert!(body.get("max_tokens").is_none());
}

#[tokio::test]
async fn stopping_early_closes_the_stream() {
    let (base, _) = serve(|_| sse(vec![send(&openai_chunk("een")), Step::Hang])).await;
    let t = target(ApiKind::OpenaiCompatible, &base);
    let mut count = 0;
    let request = hello();
    let run = stream_chat(&t, &request, |_| {
        count += 1;
        ControlFlow::Break(())
    });
    tokio::time::timeout(Duration::from_secs(5), run).await.unwrap().unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn length_stop_and_missing_done_marker_are_a_clean_end() {
    let body = format!("{}data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"length\"}}]}}\n\n", openai_chunk("a"));
    let (base, _) = serve(move |_| sse(vec![send(&body)])).await;
    let events = collect(&target(ApiKind::OpenaiCompatible, &base)).await.unwrap();
    assert!(matches!(events.last(), Some(StreamEvent::Done { stop: StopReason::Length, .. })));
}

#[tokio::test]
async fn reasoning_is_kept_apart_from_the_answer() {
    let chunk = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"even denken\"}}]}\n\n".to_string() + &openai_chunk("ok") + OPENAI_END;
    let (base, _) = serve(move |_| sse(vec![send(&chunk)])).await;
    let events = collect(&target(ApiKind::OpenaiCompatible, &base)).await.unwrap();
    assert_eq!(events[0], StreamEvent::Reasoning { text: "even denken".into() });
    assert_eq!(text_of(&events), "ok");
}

async fn error_kind(kind: ApiKind, answer: Reply) -> AppError {
    let (base, _) = serve(move |_| answer.clone()).await;
    let err = collect(&target(kind, &base)).await.unwrap_err();
    assert_no_key(&err);
    err
}

fn assert_no_key(err: &AppError) {
    let all = format!("{} {:?}", err.message, err.detail);
    assert!(!all.contains(KEY), "de sleutel staat in de melding: {all}");
}

#[tokio::test]
async fn error_cases_get_clear_messages() {
    use ApiKind::*;
    let j = "application/json";
    let cases: Vec<(ApiKind, u16, &str, &str)> = vec![
        // OpenAI herhaalt een deel van de sleutel in de melding.
        (OpenaiCompatible, 401, r#"{"error":{"message":"Incorrect API key provided: nep-sleutel-QX7Z-niet-echt","code":"invalid_api_key"}}"#, "auth"),
        (Anthropic, 401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, "auth"),
        (OpenaiCompatible, 403, r#"{"error":{"message":"Forbidden"}}"#, "forbidden"),
        (OpenaiCompatible, 402, r#"{"error":{"message":"Insufficient credits"}}"#, "quota"),
        (OpenaiCompatible, 429, r#"{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}"#, "quota"),
        (Anthropic, 429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}"#, "rate_limited"),
        // Onbekend model zoals de verschillende diensten het zeggen.
        (OpenaiCompatible, 404, r#"{"error":{"message":"The model `x` does not exist","code":"model_not_found"}}"#, "unknown_model"),
        (OpenaiCompatible, 404, r#"{"error":{"message":"model 'x' not found, try pulling it first"}}"#, "unknown_model"),
        (OpenaiCompatible, 400, r#"{"error":{"message":"x is not a valid model ID","code":400}}"#, "unknown_model"),
        (Anthropic, 404, r#"{"type":"error","error":{"type":"not_found_error","message":"model: x"}}"#, "unknown_model"),
        // Verkeerd adres: 404 die niet over een model gaat.
        (OpenaiCompatible, 404, "404 page not found", "bad_address"),
        (OpenaiCompatible, 400, r#"{"error":{"message":"This model's maximum context length is 8192 tokens"}}"#, "context_too_large"),
        (Anthropic, 529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#, "overloaded"),
        (OpenaiCompatible, 500, r#"{"error":{"message":"boom"}}"#, "server"),
        (OpenaiCompatible, 400, r#"{"error":{"message":"Iets anders klopt niet"}}"#, "rejected"),
    ];
    for (api, status, body, expected) in cases {
        let err = error_kind(api, reply(status, j, body)).await;
        assert_eq!(err.kind, expected, "{status} {body}");
        assert!(!err.message.is_empty());
    }
}

#[tokio::test]
async fn missing_key_gets_its_own_message() {
    let (base, _) = serve(|_| reply(401, "application/json", r#"{"error":{"message":"no key"}}"#)).await;
    let mut t = target(ApiKind::OpenaiCompatible, &base);
    t.endpoint.api_key = None;
    let err = collect(&t).await.unwrap_err();
    assert_eq!(err.kind, "auth");
    assert!(err.message.contains("nog geen"));
}

#[tokio::test]
async fn errors_inside_a_stream_are_reported() {
    let openai = format!("{}data: {{\"error\":{{\"code\":429,\"message\":\"Rate limit\"}}}}\n\n", openai_chunk("a"));
    let anthropic = format!("{}event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}}}\n\n", anthropic_chunk("a"));
    assert_eq!(error_kind(ApiKind::OpenaiCompatible, sse(vec![send(&openai)])).await.kind, "rate_limited");
    assert_eq!(error_kind(ApiKind::Anthropic, sse(vec![send(&anthropic)])).await.kind, "overloaded");
}

#[tokio::test]
async fn a_cut_off_stream_is_not_a_clean_end() {
    assert_eq!(error_kind(ApiKind::OpenaiCompatible, sse(vec![send(&openai_chunk("half"))])).await.kind, "stream_cut");
    assert_eq!(error_kind(ApiKind::Anthropic, sse(vec![send(&anthropic_chunk("half"))])).await.kind, "stream_cut");
}

#[tokio::test]
async fn a_web_page_instead_of_an_api_is_recognised() {
    assert_eq!(error_kind(ApiKind::OpenaiCompatible, reply(200, "text/html", "<html>Welkom</html>")).await.kind, "bad_response");
    assert_eq!(error_kind(ApiKind::OpenaiCompatible, reply(200, "application/json", r#"{"error":{"message":"model x not found"}}"#)).await.kind, "unknown_model");
    assert_eq!(error_kind(ApiKind::OpenaiCompatible, sse(vec![send("data: {kapot\n\n")])).await.kind, "bad_response");
}

#[tokio::test]
async fn a_silent_server_times_out() {
    let (base, _) = serve(|_| sse(vec![Step::Hang])).await;
    let mut t = target(ApiKind::OpenaiCompatible, &base);
    t.endpoint.idle_timeout = Duration::from_millis(200);
    let err = collect(&t).await.unwrap_err();
    assert_eq!(err.kind, "timeout");
    assert!(err.message.contains("laden"), "bij een lokale server wordt het laden van het model genoemd");
}

#[tokio::test]
async fn a_local_server_that_is_off_is_named() {
    // Een poort die net vrij is gegeven: daar luistert niemand.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let err = collect(&target(ApiKind::OpenaiCompatible, &format!("http://localhost:{port}/v1"))).await.unwrap_err();
    assert_eq!(err.kind, "unreachable_local");
    assert!(err.message.contains(&port.to_string()));
    assert!(err.message.contains("Ollama"));
    assert_no_key(&err);
}

#[tokio::test]
async fn redirects_are_not_followed_so_the_key_stays_home() {
    let (other, other_seen) = serve(|_| sse(vec![send(ANTHROPIC_END)])).await;
    let location = format!("{other}/v1/messages");
    let (base, _) = serve(move |_| Reply { head: format!("HTTP/1.1 307 Temporary\r\nLocation: {location}\r\nConnection: close\r\n\r\n"), steps: vec![] }).await;
    let err = collect(&target(ApiKind::Anthropic, &base)).await.unwrap_err();
    assert_eq!(err.kind, "redirect");
    assert!(other_seen.lock().unwrap().is_empty(), "de andere server kreeg een verzoek");
}

#[test]
fn redaction_removes_keys_in_every_shape() {
    let text = format!("key {KEY} sk-abcdefgh123 Bearer xyz123 x-api-key: abc \"api_key\":\"geheim\"");
    let out = errors::redact(&text, Some(KEY));
    for leak in [KEY, "sk-abcdefgh123", "xyz123", ": abc", "geheim"] {
        assert!(!out.contains(leak), "{leak} in {out}");
    }
}

#[test]
fn capabilities_are_checked_before_sending() {
    let mut t = target(ApiKind::OpenaiCompatible, "http://localhost:1/v1");
    let with_image = ChatRequest { system: None, messages: vec![Message { role: Role::User, parts: vec![Part::Image { media_type: "image/png".into(), base64: "QQ==".into() }] }], max_tokens: 5 };
    assert!(check_capabilities(&t, &with_image).is_ok(), "onbekend mag proberen");
    t.supports_images = Some(false);
    assert_eq!(check_capabilities(&t, &with_image).unwrap_err().kind, "model_no_images");
    t.context_tokens = Some(10);
    let long = ChatRequest { system: None, messages: vec![Message { role: Role::User, parts: vec![Part::Text("woord ".repeat(100))] }], max_tokens: 5 };
    assert_eq!(check_capabilities(&t, &long).unwrap_err().kind, "context_too_large");
    assert!(check_capabilities(&t, &hello()).is_ok());
}

#[tokio::test]
async fn openai_models_are_listed_with_what_the_provider_tells() {
    let body = r#"{"data":[
        {"id":"llama3"},
        {"id":"nomic-embed-text"},
        {"id":"a/b","name":"Mooi model","context_length":200000,"architecture":{"input_modalities":["text","image"]}},
        {"id":"c/d","context_length":4096,"architecture":{"input_modalities":["text"]}}
    ]}"#;
    let (base, seen) = serve(move |_| reply(200, "application/json", body)).await;
    let models = list_models(&endpoint(ApiKind::OpenaiCompatible, &format!("{base}/v1"))).await.unwrap();
    assert!(seen.lock().unwrap()[0].head.starts_with("GET /v1/models "));
    assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["llama3", "a/b", "c/d"]);
    assert_eq!(models[0].supports_images, None);
    assert_eq!(models[1].supports_images, Some(true));
    assert_eq!(models[1].context_tokens, Some(200000));
    assert_eq!(models[1].display_name.as_deref(), Some("Mooi model"));
    assert_eq!(models[2].supports_images, Some(false));
}

#[tokio::test]
async fn anthropic_models_follow_the_pages() {
    let (base, seen) = serve(|line| {
        if line.contains("after_id=m1") {
            reply(200, "application/json", r#"{"data":[{"id":"m2"}],"has_more":false,"last_id":"m2"}"#)
        } else {
            reply(200, "application/json", r#"{"data":[{"id":"m1","display_name":"Een","max_input_tokens":1000,"capabilities":{"image_input":{"supported":true}}}],"has_more":true,"last_id":"m1"}"#)
        }
    })
    .await;
    let models = list_models(&endpoint(ApiKind::Anthropic, &base)).await.unwrap();
    assert_eq!(seen.lock().unwrap()[0].header("x-api-key").unwrap(), KEY);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].display_name.as_deref(), Some("Een"));
    assert_eq!(models[0].supports_images, Some(true));
    assert_eq!(models[0].context_tokens, Some(1000));
    assert_eq!(models[1].context_tokens, None);
}

#[tokio::test]
async fn listing_reports_errors_like_chatting() {
    let (base, _) = serve(|_| reply(401, "application/json", r#"{"error":{"message":"nope"}}"#)).await;
    assert_eq!(list_models(&endpoint(ApiKind::OpenaiCompatible, &base)).await.unwrap_err().kind, "auth");
    let (base, _) = serve(|_| reply(404, "text/plain", "404 model nergens")).await;
    assert_eq!(list_models(&endpoint(ApiKind::OpenaiCompatible, &base)).await.unwrap_err().kind, "bad_address", "bij het ophalen gaat een 404 over het adres");
    let (base, _) = serve(|_| reply(200, "text/html", "<html>")).await;
    assert_eq!(list_models(&endpoint(ApiKind::OpenaiCompatible, &base)).await.unwrap_err().kind, "bad_response");
}

#[tokio::test]
async fn connection_check_uses_the_given_model_and_shows_its_answer() {
    let body = openai_chunk("wer") + &openai_chunk("kt") + OPENAI_END;
    let (base, seen) = serve(move |_| sse(vec![send(&body)])).await;
    let t = target(ApiKind::OpenaiCompatible, &base);
    let mut pieces = 0;
    let ep = t.endpoint.clone();
    let report = check_connection(&ep, Some(t), |e| pieces += matches!(e, StreamEvent::Text { .. }) as u32).await.unwrap();
    assert_eq!(report.model.as_deref(), Some("test-model"));
    assert_eq!(report.sample, "werkt");
    assert!(report.first_token_ms.is_some());
    assert_eq!(pieces, 2);
    assert_eq!(seen.lock().unwrap().len(), 1, "alleen het kleine testverzoek");
}

#[tokio::test]
async fn connection_check_without_model_takes_the_first_from_the_list() {
    let (base, seen) = serve(|line| {
        if line.starts_with("GET") {
            reply(200, "application/json", r#"{"data":[{"id":"eerste"},{"id":"tweede"}]}"#)
        } else {
            sse(vec![send(&openai_chunk("werkt")), send(OPENAI_END)])
        }
    })
    .await;
    let report = check_connection(&endpoint(ApiKind::OpenaiCompatible, &base), None, |_| {}).await.unwrap();
    assert_eq!(report.model.as_deref(), Some("eerste"));
    assert_eq!(seen.lock().unwrap()[1].json()["model"], "eerste");
}

#[tokio::test]
async fn connection_check_without_any_model_still_says_it_is_reachable() {
    let (base, _) = serve(|_| reply(200, "application/json", r#"{"data":[]}"#)).await;
    let report = check_connection(&endpoint(ApiKind::OpenaiCompatible, &base), None, |_| {}).await.unwrap();
    assert!(report.model.is_none());
}

#[tokio::test]
async fn connection_check_stops_after_a_sample() {
    let body = openai_chunk(&"x".repeat(CHECK_SAMPLE_CHARS));
    let (base, _) = serve(move |_| sse(vec![send(&body), Step::Hang])).await;
    let t = target(ApiKind::OpenaiCompatible, &base);
    let ep = t.endpoint.clone();
    let run = check_connection(&ep, Some(t), |_| {});
    let report = tokio::time::timeout(Duration::from_secs(5), run).await.unwrap().unwrap();
    assert_eq!(report.sample.len(), CHECK_SAMPLE_CHARS);
}

/// De afscherming van de vaste kopie: deze bestanden bepalen of een opgeslagen pagina bij de AI-laag kan.
mod isolation {
    const CAPABILITY: &str = include_str!("../../capabilities/main.json");
    const CONFIG: &str = include_str!("../../tauri.conf.json");
    const INDEX: &str = include_str!("../../../index.html");

    #[test]
    fn only_the_main_window_may_call_commands() {
        let cap: serde_json::Value = serde_json::from_str(CAPABILITY).unwrap();
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        assert!(cap.get("webviews").is_none());
        assert!(cap.get("remote").is_none(), "pagina's van internet krijgen geen rechten");
        assert!(cap["permissions"].as_array().unwrap().iter().any(|p| p == "allow-test-connection"));
    }

    #[test]
    fn the_app_has_exactly_one_capability() {
        let files: Vec<_> = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn the_copy_runs_without_scripts_or_network() {
        let csp = crate::snapshot::CSP;
        assert!(csp.starts_with("default-src 'none'"));
        assert!(!csp.contains("script-src"), "geen scripts");
        assert!(!csp.contains("connect-src"), "geen netwerk");
        assert!(INDEX.contains(r#"id="source-frame" title="Vaste kopie van de bron" sandbox="""#), "de iframe is volledig afgeschermd");
    }

    #[test]
    fn the_interface_itself_cannot_reach_a_provider() {
        let config: serde_json::Value = serde_json::from_str(CONFIG).unwrap();
        let connect = config["app"]["security"]["csp"]["connect-src"].as_str().unwrap();
        assert_eq!(connect, "'self' ipc: http://ipc.localhost", "AI-aanroepen lopen alleen via Rust");
    }

    #[test]
    fn the_copy_cannot_read_the_provider_file() {
        let store = crate::store::Store::new(std::env::temp_dir().join(format!("deepdive-iso-{}", uuid::Uuid::new_v4().simple()))).unwrap();
        for bad in ["/providers.json", "/../providers.json", "/0123456789abcdef0123456789abcdef/../../providers.json", "/0123456789abcdef0123456789abcdef/assets/..%2F..%2F..%2Fproviders.json"] {
            assert!(store.snapshot_file(bad).is_none(), "{bad}");
        }
    }
}
