//! De hele flow tegen een lokale nepserver: login, ID-token, vernieuwen, uitloggen en inferentie. De
//! RSA-sleutels worden per testrun door `openssl` gemaakt, zodat er geen privésleutel in de repository staat.

use super::*;
use crate::ai::{self, ApiKind, ChatRequest, Message, Part, Role, StreamEvent, Target};
use crate::providers::secrets::MemorySecrets;
use crate::providers::{KeyChange, ProviderInput, ProviderStore};
use base64::Engine;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::ops::ControlFlow;
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SUBJECT: &str = "sub-echt";
const CLIENT: &str = "oaiapp_nep";
const EMAIL: &str = "lezer@example.com";

struct Rsa {
    pem: Vec<u8>,
    n: String,
}

fn rsa() -> &'static [Rsa; 2] {
    static KEYS: OnceLock<[Rsa; 2]> = OnceLock::new();
    KEYS.get_or_init(|| {
        let make = || {
            let out = std::process::Command::new("openssl").args(["genrsa", "2048"]).output().expect("openssl");
            let pem = out.stdout;
            let mut child = std::process::Command::new("openssl").args(["rsa", "-noout", "-modulus"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), &pem).unwrap();
            let text = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
            let bytes = hex::decode(text.trim().strip_prefix("Modulus=").unwrap()).unwrap();
            Rsa { pem, n: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes) }
        };
        [make(), make()]
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Signer {
    Good,
    Attacker,
    SharedSecret,
}

#[derive(Debug, Clone)]
struct Seen {
    line: String,
    head: String,
    body: String,
}

impl Seen {
    fn form(&self) -> HashMap<String, String> {
        url::form_urlencoded::parse(self.body.as_bytes()).into_owned().collect()
    }
}

#[derive(Clone)]
struct Reply(u16, String, String);

fn json_reply(status: u16, body: serde_json::Value) -> Reply {
    Reply(status, "application/json".into(), body.to_string())
}

fn sse_reply(body: &str) -> Reply {
    Reply(200, "text/event-stream".into(), body.to_string())
}

struct MockState {
    base: String,
    seen: Vec<Seen>,
    nonce: String,
    client: String,
    patch: serde_json::Value,
    signer: Signer,
    scope: String,
    next_token: u32,
    /// Vaste antwoorden per pad, op volgorde; daarna het standaardantwoord.
    scripted: HashMap<String, VecDeque<Reply>>,
}

type Mock = Arc<Mutex<MockState>>;

fn id_token(state: &MockState) -> String {
    let now = now();
    let mut claims = json!({ "iss": state.base, "sub": SUBJECT, "aud": [state.client], "nonce": state.nonce, "email": EMAIL, "iat": now, "exp": now + 3600 });
    for (k, v) in state.patch.as_object().unwrap() {
        claims[k] = v.clone();
    }
    match state.signer {
        Signer::SharedSecret => encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(b"geheim")).unwrap(),
        signer => {
            let mut header = Header::new(Algorithm::RS256);
            header.kid = Some("k1".into());
            let key = &rsa()[usize::from(signer == Signer::Attacker)];
            encode(&header, &claims, &EncodingKey::from_rsa_pem(&key.pem).unwrap()).unwrap()
        }
    }
}

fn answer(state: &mut MockState, path: &str) -> Reply {
    if let Some(reply) = state.scripted.get_mut(path).and_then(VecDeque::pop_front) {
        return reply;
    }
    match path {
        "/.well-known/openid-configuration" => json_reply(200, json!({ "issuer": state.base, "jwks_uri": format!("{}/jwks", state.base), "revocation_endpoint": format!("{}/revoke", state.base) })),
        "/jwks" => json_reply(200, json!({ "keys": [{ "kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig", "n": rsa()[0].n, "e": "AQAB" }] })),
        "/api/accounts/oauth/token" => {
            state.next_token += 1;
            let n = state.next_token;
            json_reply(200, json!({ "access_token": format!("toegang-{n}"), "refresh_token": format!("vernieuw-{n}"), "id_token": id_token(state), "token_type": "Bearer", "expires_in": 3600, "scope": state.scope }))
        }
        "/revoke" => Reply(200, "text/plain".into(), String::new()),
        "/v1/models" => json_reply(200, json!({ "models": [
            { "slug": "z-model", "display_name": "Z", "visibility": "list" },
            { "slug": "verborgen", "display_name": "V", "visibility": "hide" },
            { "slug": "a-model", "display_name": "A", "visibility": "list" },
        ] })),
        "/v1/responses" => sse_reply(COMPLETED),
        _ => Reply(404, "text/plain".into(), "nee".into()),
    }
}

const COMPLETED: &str = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Wer\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"kt\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n";

async fn start_mock() -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mock: Mock = Arc::new(Mutex::new(MockState { base, seen: vec![], nonce: String::new(), client: CLIENT.into(), patch: json!({}), signer: Signer::Good, scope: format!("openid profile email offline_access resource.invoke {PLAN_SCOPE}"), next_token: 0, scripted: HashMap::new() }));
    let shared = mock.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mock = shared.clone();
            tokio::spawn(async move {
                let mut data = vec![];
                let mut buf = [0u8; 8192];
                let end = loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(p) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let head = String::from_utf8_lossy(&data[..end]).to_string();
                let length = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                while data.len() < end + length {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                }
                let line = head.lines().next().unwrap_or("").to_string();
                let path = line.split(' ').nth(1).unwrap_or("").split('?').next().unwrap_or("").to_string();
                let Reply(status, kind, body) = {
                    let mut state = mock.lock().unwrap();
                    state.seen.push(Seen { line, head, body: String::from_utf8_lossy(&data[end..]).to_string() });
                    answer(&mut state, &path)
                };
                let text = format!("HTTP/1.1 {status} X\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nx-request-id: req_nep\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(text.as_bytes()).await;
            });
        }
    });
    mock
}

/// Wat de nepbrowser met het inlogadres doet: de lijst met callbacks die hij opvraagt.
type Browser = Arc<dyn Fn(&HashMap<String, String>) -> Vec<Vec<(String, String)>> + Send + Sync>;

fn good_callback(q: &HashMap<String, String>, client: Option<&str>) -> Vec<(String, String)> {
    let mut out = vec![("code".to_string(), "code-1".to_string()), ("state".to_string(), q["state"].clone())];
    if let Some(client) = client {
        out.push(("client_id".to_string(), client.to_string()));
    }
    out
}

struct Fixture {
    mock: Mock,
    store: ProviderStore,
    secrets: Arc<MemorySecrets>,
    dir: PathBuf,
    /// De laatst geopende inlogadressen, als sleutel-waardeparen.
    authorized: Arc<Mutex<Vec<HashMap<String, String>>>>,
    browser: Arc<Mutex<Browser>>,
}

async fn fixture() -> Fixture {
    let mock = start_mock().await;
    let base = mock.lock().unwrap().base.clone();
    let dir = std::env::temp_dir().join(format!("deepdive-chatgpt-{}", uuid::Uuid::new_v4().simple()));
    let secrets = Arc::new(MemorySecrets::default());
    let authorized: Arc<Mutex<Vec<HashMap<String, String>>>> = Default::default();
    let browser: Arc<Mutex<Browser>> = Arc::new(Mutex::new(Arc::new(|q| vec![good_callback(q, Some(CLIENT))])));
    let opener: Opener = {
        let (mock, authorized, browser) = (mock.clone(), authorized.clone(), browser.clone());
        Arc::new(move |url: &str| {
            let parsed = Url::parse(url).unwrap();
            assert!(parsed.path().ends_with("/api/accounts/authorize"), "{url}");
            let q: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
            mock.lock().unwrap().nonce = q["nonce"].clone();
            authorized.lock().unwrap().push(q.clone());
            let calls = (browser.lock().unwrap())(&q);
            let redirect = q["redirect_uri"].clone();
            tokio::spawn(async move {
                let client = reqwest::Client::builder().no_proxy().build().unwrap();
                for call in calls {
                    let _ = client.get(&redirect).query(&call).send().await;
                }
            });
            Ok(())
        })
    };
    let config = Config { auth_base: Url::parse(&base).unwrap(), api_base: Url::parse(&format!("{base}/v1")).unwrap(), opener, preferred_port: 0 };
    let store = ProviderStore::open_with(dir.clone(), secrets.clone(), config).unwrap();
    Fixture { mock, store, secrets, dir, authorized, browser }
}

impl Fixture {
    fn set_browser(&self, browser: impl Fn(&HashMap<String, String>) -> Vec<Vec<(String, String)>> + Send + Sync + 'static) {
        *self.browser.lock().unwrap() = Arc::new(browser);
    }
    fn seen(&self, path: &str) -> Vec<Seen> {
        self.mock.lock().unwrap().seen.iter().filter(|s| s.line.split(' ').nth(1).unwrap_or("").starts_with(path)).cloned().collect()
    }
    fn script(&self, path: &str, replies: Vec<Reply>) {
        self.mock.lock().unwrap().scripted.insert(path.to_string(), replies.into());
    }
    async fn sign_in(&self) -> String {
        let result = self.store.hub().login(LoginRequest::default()).await.unwrap();
        self.store.finish_login(None, result).unwrap().0.id
    }
    fn stored(&self, id: &str) -> Option<Credentials> {
        self.secrets.0.lock().unwrap().get(&keychain_account(id)).map(|t| serde_json::from_str(t).unwrap())
    }
    /// Past de opgeslagen gegevens aan, bijvoorbeeld om een token bijna te laten verlopen.
    fn edit(&self, id: &str, change: impl FnOnce(&mut Credentials)) {
        let mut credentials = self.stored(id).unwrap();
        change(&mut credentials);
        self.store.hub().store_credentials(id, &credentials).unwrap();
    }
    fn provider(&self, id: &str) -> crate::providers::Provider {
        self.store.snapshot().providers.into_iter().find(|p| p.id == id).unwrap()
    }
    fn target(&self, id: &str) -> Target {
        Target { endpoint: self.store.endpoint(id).unwrap(), model: "a-model".into(), supports_images: None, context_tokens: None }
    }
}

fn request() -> ChatRequest {
    ChatRequest {
        system: Some("Wees kort.".into()),
        messages: vec![
            Message { role: Role::User, parts: vec![Part::Text("Eerste vraag".into())] },
            Message { role: Role::Assistant, parts: vec![Part::Text("Eerste antwoord".into())] },
            Message { role: Role::User, parts: vec![Part::Text("Wat staat hier?".into()), Part::Image { media_type: "image/png".into(), base64: "QUJD".into() }] },
        ],
        max_tokens: 50,
    }
}

async fn chat(target: &Target) -> (Vec<StreamEvent>, Result<(), crate::error::AppError>) {
    let mut events = vec![];
    let result = ai::stream_chat(target, &request(), |e| {
        events.push(e);
        ControlFlow::Continue(())
    })
    .await;
    (events, result)
}

fn text_of(events: &[StreamEvent]) -> String {
    events.iter().filter_map(|e| if let StreamEvent::Text { text } = e { Some(text.as_str()) } else { None }).collect()
}

// ---------- login ----------

#[tokio::test]
async fn first_sign_in_registers_and_stores_only_in_the_keychain() {
    let f = fixture().await;
    let id = f.sign_in().await;

    let q = f.authorized.lock().unwrap()[0].clone();
    assert_eq!(q["client_id"], "dynamic_agent_client");
    assert_eq!(q["agent_name_hint"], "Deepdive");
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["scope"], "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    assert_eq!(q["resource"], "https://api.openai.com/v1");
    assert_eq!(q["code_challenge_method"], "S256");
    assert!(!q.contains_key("id_token_hint") && !q.contains_key("prompt"));
    assert!(q["ext_agent_host_id"].starts_with("urn:uuid:"));
    let redirect = Url::parse(&q["redirect_uri"]).unwrap();
    assert_eq!((redirect.scheme(), redirect.host_str(), redirect.path()), ("http", Some("127.0.0.1"), "/auth/callback"));

    let token = f.seen("/api/accounts/oauth/token");
    assert_eq!(token.len(), 1);
    let form = token[0].form();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["client_id"], CLIENT, "de uitgegeven client, niet dynamic_agent_client");
    assert_eq!(form["redirect_uri"], q["redirect_uri"]);
    assert_eq!(form["resource"], "https://api.openai.com/v1");
    assert!(!form.contains_key("client_secret"));
    assert_eq!(login_challenge(&form["code_verifier"]), q["code_challenge"], "PKCE");

    let provider = f.provider(&id);
    let account = provider.chatgpt.as_ref().unwrap();
    assert_eq!(provider.kind, ApiKind::ChatgptPlan);
    assert!(provider.has_key && account.plan_enabled);
    assert_eq!((account.client_id.as_str(), account.subject.as_str(), account.email.as_deref()), (CLIENT, SUBJECT, Some(EMAIL)));

    // Nergens buiten de sleutelhanger.
    let stored = f.stored(&id).unwrap();
    assert_eq!(stored.access_token, "toegang-1");
    let shown = serde_json::to_string(&f.store.snapshot()).unwrap();
    let file = std::fs::read_to_string(f.dir.join("providers.json")).unwrap();
    let host = std::fs::read_to_string(f.dir.join("chatgpt-host-id")).unwrap();
    for text in [shown, file, host, format!("{stored:?}"), format!("{:?}", f.store.endpoint(&id).unwrap())] {
        assert!(!text.contains("toegang-1") && !text.contains("vernieuw-1"), "{text}");
    }
}

fn login_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[tokio::test]
async fn returning_sign_in_reuses_client_and_host_and_checks_the_account() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.store.hub().logout(&id).await.unwrap();
    f.store.finish_logout(&id).unwrap();
    assert!(f.stored(&id).is_none());

    f.set_browser(|q| vec![good_callback(q, None)]);
    let request = f.store.login_request(Some(&id), false).unwrap();
    let result = f.store.hub().login(request).await.unwrap();
    f.store.finish_login(Some(&id), result).unwrap();

    let (first, second) = { let a = f.authorized.lock().unwrap(); (a[0].clone(), a[1].clone()) };
    assert_eq!(second["client_id"], CLIENT);
    assert!(!second.contains_key("agent_name_hint"));
    assert_eq!(second["login_hint"], EMAIL);
    assert_eq!(second["ext_agent_host_id"], first["ext_agent_host_id"], "de installatie-ID blijft gelijk");
    assert_ne!(second["state"], first["state"]);
    assert_ne!(second["nonce"], first["nonce"]);
    assert_ne!(second["code_challenge"], first["code_challenge"]);
    assert_eq!(f.seen("/api/accounts/oauth/token")[1].form()["client_id"], CLIENT);
    assert_eq!(f.store.snapshot().providers.len(), 1, "geen nieuwe registratie");

    // Ander account: de bestaande tokens blijven staan.
    let before = f.stored(&id).unwrap().access_token;
    f.mock.lock().unwrap().patch = json!({ "sub": "iemand-anders" });
    let err = f.store.hub().login(f.store.login_request(Some(&id), false).unwrap()).await.unwrap_err();
    assert_eq!(err.kind, "chatgpt_wrong_account");
    assert_eq!(f.stored(&id).unwrap().access_token, before);
    f.mock.lock().unwrap().patch = json!({});

    // Andere client in de callback: geen code-uitwisseling.
    f.set_browser(|q| vec![good_callback(q, Some("oaiapp_ander"))]);
    let exchanges = f.seen("/api/accounts/oauth/token").len();
    let err = f.store.hub().login(f.store.login_request(Some(&id), false).unwrap()).await.unwrap_err();
    assert_eq!(err.kind, "chatgpt_wrong_account");
    assert_eq!(f.seen("/api/accounts/oauth/token").len(), exchanges);
    assert_eq!(f.stored(&id).unwrap().access_token, before);
}

#[tokio::test]
async fn bad_id_tokens_are_refused_and_nothing_is_stored() {
    let f = fixture().await;
    let cases: Vec<(&str, serde_json::Value, Signer)> = vec![
        ("handtekening", json!({}), Signer::Attacker),
        ("gedeeld geheim", json!({}), Signer::SharedSecret),
        ("uitgever", json!({ "iss": "https://nep.example.com" }), Signer::Good),
        ("doelgroep", json!({ "aud": ["oaiapp_ander"] }), Signer::Good),
        ("verlopen", json!({ "exp": now() - 3600 }), Signer::Good),
        ("nonce", json!({ "nonce": "verkeerd" }), Signer::Good),
        ("sid", json!({ "sid": "  " }), Signer::Good),
    ];
    for (name, patch, signer) in cases {
        {
            let mut state = f.mock.lock().unwrap();
            state.patch = patch;
            state.signer = signer;
        }
        let err = f.store.hub().login(LoginRequest::default()).await.unwrap_err();
        assert_eq!(err.kind, "chatgpt_id_token", "{name}");
        assert!(!err.detail.clone().unwrap_or_default().contains("toegang-"), "{name}");
    }
    assert!(f.secrets.0.lock().unwrap().is_empty());
    assert!(f.store.snapshot().providers.is_empty());
}

#[tokio::test]
async fn a_callback_with_the_wrong_state_does_not_disturb_the_login() {
    let f = fixture().await;
    f.set_browser(|q| {
        let stray = vec![("code".to_string(), "kwaad".to_string()), ("state".to_string(), "verkeerd".to_string()), ("client_id".to_string(), "oaiapp_kwaad".to_string())];
        vec![stray, good_callback(q, Some(CLIENT))]
    });
    f.sign_in().await;
    let forms = f.seen("/api/accounts/oauth/token");
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].form()["code"], "code-1");
    assert_eq!(forms[0].form()["client_id"], CLIENT);
}

#[tokio::test]
async fn declined_consent_stops_without_exchange_and_leaves_the_app_usable() {
    let f = fixture().await;
    f.set_browser(|q| vec![vec![("error".to_string(), "access_denied".to_string()), ("state".to_string(), q["state"].clone())]]);
    let err = f.store.hub().login(LoginRequest::default()).await.unwrap_err();
    assert_eq!(err.kind, "chatgpt_consent_denied");
    assert!(f.seen("/api/accounts/oauth/token").is_empty());
    assert!(f.store.snapshot().providers.is_empty());

    // Een API-sleutelprovider werkt gewoon door.
    let other = f.store.save_provider(ProviderInput { id: None, name: "Lokaal".into(), kind: ApiKind::OpenaiCompatible, base_url: "http://localhost:11434/v1".into() }, KeyChange::Keep).unwrap();
    assert!(f.store.endpoint(&other.id).unwrap().session.is_none());

    // Daarna kan de login alsnog slagen.
    f.set_browser(|q| vec![good_callback(q, Some(CLIENT))]);
    f.sign_in().await;
}

#[tokio::test]
async fn registration_without_issued_client_is_incomplete() {
    for given in [None, Some("dynamic_agent_client")] {
        let f = fixture().await;
        f.set_browser(move |q| vec![good_callback(q, given)]);
        let err = f.store.hub().login(LoginRequest::default()).await.unwrap_err();
        assert_eq!(err.kind, "chatgpt_login_failed");
        assert!(f.seen("/api/accounts/oauth/token").is_empty());
    }
}

#[tokio::test]
async fn invalid_grant_starts_over_with_the_issued_client() {
    let f = fixture().await;
    f.script("/api/accounts/oauth/token", vec![json_reply(400, json!({ "error": "invalid_grant" }))]);
    let err = f.store.hub().login(LoginRequest::default()).await.unwrap_err();
    assert_eq!(err.kind, "chatgpt_login_failed");
    f.set_browser(|q| vec![good_callback(q, None)]);
    f.sign_in().await;
    let second = f.authorized.lock().unwrap()[1].clone();
    assert_eq!(second["client_id"], CLIENT);
    assert!(!second.contains_key("agent_name_hint"));
}

#[tokio::test]
async fn logging_in_can_be_cancelled() {
    let f = fixture().await;
    f.set_browser(|_| vec![]);
    let hub = f.store.hub().clone();
    let waiting = tokio::spawn(async move { hub.login(LoginRequest::default()).await });
    while f.authorized.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    f.store.hub().cancel_login();
    assert_eq!(waiting.await.unwrap().unwrap_err().kind, "chatgpt_login_cancelled");
}

#[tokio::test]
async fn without_plan_scope_the_sign_in_stays_but_inference_is_off() {
    let f = fixture().await;
    f.mock.lock().unwrap().scope = "openid profile email offline_access".into();
    let id = f.sign_in().await;
    let provider = f.provider(&id);
    assert!(provider.has_key && !provider.chatgpt.as_ref().unwrap().plan_enabled);
    assert_eq!(f.store.endpoint(&id).unwrap_err().kind, "chatgpt_plan_disabled");
    assert!(f.seen("/v1/").is_empty());

    // De gebruiker kiest zelf voor inschakelen: dezelfde client, alle scopes, en expliciet toestemming vragen.
    f.mock.lock().unwrap().scope = format!("openid profile email offline_access resource.invoke {PLAN_SCOPE}");
    f.set_browser(|q| vec![good_callback(q, None)]);
    let result = f.store.hub().login(f.store.login_request(Some(&id), true).unwrap()).await.unwrap();
    f.store.finish_login(Some(&id), result).unwrap();
    let q = f.authorized.lock().unwrap()[1].clone();
    assert_eq!((q["client_id"].as_str(), q["prompt"].as_str()), (CLIENT, "consent"));
    assert!(q["scope"].contains(PLAN_SCOPE));
    assert!(f.provider(&id).chatgpt.unwrap().plan_enabled);
    assert!(f.store.endpoint(&id).is_ok());
}

#[tokio::test]
async fn a_chatgpt_provider_is_only_made_by_signing_in() {
    let f = fixture().await;
    let input = |id: Option<&str>, kind, url: &str| ProviderInput { id: id.map(String::from), name: "Nieuw".into(), kind, base_url: url.into() };
    assert_eq!(f.store.save_provider(input(None, ApiKind::ChatgptPlan, "https://kwaad.example.com/v1"), KeyChange::Keep).unwrap_err().kind, "chatgpt_only_login");
    let id = f.sign_in().await;
    assert_eq!(f.store.save_provider(input(Some(&id), ApiKind::OpenaiCompatible, "https://kwaad.example.com/v1"), KeyChange::Keep).unwrap_err().kind, "chatgpt_only_login");
    // De naam mag wijzigen, het adres niet.
    let renamed = f.store.save_provider(input(Some(&id), ApiKind::ChatgptPlan, "https://kwaad.example.com/v1"), KeyChange::Keep).unwrap();
    assert_eq!(renamed.name, "Nieuw");
    assert!(!renamed.base_url.contains("kwaad"));
    assert!(f.store.endpoint(&id).unwrap().base_url.as_str().ends_with("/v1"));
    assert!(!f.store.endpoint(&id).unwrap().base_url.as_str().contains("kwaad"));
}

#[tokio::test]
async fn two_registrations_stay_separate() {
    let f = fixture().await;
    let first = f.sign_in().await;
    f.mock.lock().unwrap().client = "oaiapp_tweede".into();
    f.set_browser(|q| vec![good_callback(q, Some("oaiapp_tweede"))]);
    let second = f.sign_in().await;
    assert_ne!(first, second);
    assert_ne!(f.provider(&first).name, f.provider(&second).name, "dezelfde e-mail, toch een eigen naam");
    assert_eq!(f.stored(&first).unwrap().client_id, CLIENT);
    assert_eq!(f.stored(&second).unwrap().client_id, "oaiapp_tweede");
    assert_ne!(f.stored(&first).unwrap().access_token, f.stored(&second).unwrap().access_token);
}

// ---------- vernieuwen ----------

#[tokio::test]
async fn refresh_near_expiry_replaces_everything_together() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.edit(&id, |c| c.expires_at = now() + 10);
    let session = f.store.endpoint(&id).unwrap().session.unwrap();
    assert_eq!(session.access_token().await.unwrap().expose(), "toegang-2");

    let refresh = f.seen("/api/accounts/oauth/token");
    let form = refresh[1].form();
    assert_eq!(form["grant_type"], "refresh_token");
    assert_eq!(form["client_id"], CLIENT);
    assert_eq!(form["refresh_token"], "vernieuw-1");
    assert_eq!(form["resource"], "https://api.openai.com/v1");
    assert!(!form.contains_key("scope"), "scope weglaten behoudt de toestemming");
    let stored = f.stored(&id).unwrap();
    assert_eq!((stored.access_token.as_str(), stored.refresh_token.as_deref()), ("toegang-2", Some("vernieuw-2")));
    assert!(stored.expires_at > now() + 3000);

    // Nog ruim geldig: geen nieuwe aanvraag.
    session.access_token().await.unwrap();
    assert_eq!(f.seen("/api/accounts/oauth/token").len(), 2);
}

#[tokio::test]
async fn concurrent_requests_refresh_only_once() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.edit(&id, |c| c.expires_at = now() - 1);
    let tasks: Vec<_> = (0..6)
        .map(|_| {
            let session = f.store.endpoint(&id).unwrap().session.unwrap();
            tokio::spawn(async move { session.access_token().await.unwrap().expose().to_string() })
        })
        .collect();
    for task in tasks {
        assert_eq!(task.await.unwrap(), "toegang-2");
    }
    assert_eq!(f.seen("/api/accounts/oauth/token").len(), 2, "één login en één vernieuwing");
}

#[tokio::test]
async fn an_unusable_refresh_token_ends_the_session_and_keeps_the_client() {
    for code in ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "token_expired", "invalid_refresh_token"] {
        let f = fixture().await;
        let id = f.sign_in().await;
        f.edit(&id, |c| c.expires_at = now() - 1);
        f.script("/api/accounts/oauth/token", vec![json_reply(400, json!({ "error": code }))]);
        let err = f.store.endpoint(&id).unwrap().session.unwrap().access_token().await.unwrap_err();
        assert_eq!(err.kind, "chatgpt_session_revoked", "{code}");
        assert!(f.stored(&id).is_none(), "{code}: onbruikbare tokens zijn gewist");
        let provider = f.provider(&id);
        let account = provider.chatgpt.unwrap();
        assert!(!provider.has_key && account.session_lost);
        assert_eq!(account.client_id, CLIENT, "de client blijft voor opnieuw inloggen");
        assert_eq!(f.store.endpoint(&id).unwrap_err().kind, "chatgpt_session_revoked");
    }
}

#[tokio::test]
async fn temporary_refresh_failures_keep_the_credentials() {
    let f = fixture().await;
    let id = f.sign_in().await;
    let session = f.store.endpoint(&id).unwrap().session.unwrap();

    // Bijna verlopen, maar nog geldig: het oude token blijft nog even werken.
    f.edit(&id, |c| c.expires_at = now() + 10);
    f.script("/api/accounts/oauth/token", vec![json_reply(503, json!({ "detail": "storing" }))]);
    assert_eq!(session.access_token().await.unwrap().expose(), "toegang-1");

    // Echt verlopen: een melding, maar niets gewist.
    f.edit(&id, |c| c.expires_at = now() - 1);
    f.script("/api/accounts/oauth/token", vec![json_reply(503, json!({ "detail": "storing" }))]);
    assert_eq!(session.access_token().await.unwrap_err().kind, "chatgpt_unreachable");
    assert_eq!(f.stored(&id).unwrap().refresh_token.as_deref(), Some("vernieuw-1"));
    assert!(f.provider(&id).has_key);

    // Verkeerde client: geen tokens wissen, wel melden.
    f.script("/api/accounts/oauth/token", vec![json_reply(401, json!({ "error": "invalid_client" }))]);
    assert_eq!(session.access_token().await.unwrap_err().kind, "chatgpt_client_invalid");
    assert!(f.stored(&id).is_some());
}

#[tokio::test]
async fn waits_for_earliest_refresh_while_the_token_is_valid() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.edit(&id, |c| {
        c.expires_at = now() + 10;
        c.earliest_refresh_at = Some(now() + 5);
    });
    let session = f.store.endpoint(&id).unwrap().session.unwrap();
    assert_eq!(session.access_token().await.unwrap().expose(), "toegang-1");
    assert_eq!(f.seen("/api/accounts/oauth/token").len(), 1);
}

#[tokio::test]
async fn refresh_that_drops_the_plan_scope_turns_the_plan_off() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.edit(&id, |c| c.expires_at = now() - 1);
    f.mock.lock().unwrap().scope = "openid profile email offline_access".into();
    assert_eq!(f.store.endpoint(&id).unwrap().session.unwrap().access_token().await.unwrap_err().kind, "chatgpt_plan_disabled");
    assert!(!f.provider(&id).chatgpt.unwrap().plan_enabled);
}

// ---------- uitloggen ----------

#[tokio::test]
async fn sign_out_revokes_and_clears_but_keeps_the_mapping() {
    let f = fixture().await;
    let id = f.sign_in().await;
    assert!(f.store.hub().logout(&id).await.unwrap());
    let provider = f.store.finish_logout(&id).unwrap();
    let form = f.seen("/revoke")[0].form();
    assert_eq!(form["token"], "vernieuw-1");
    assert_eq!(form["token_type_hint"], "refresh_token");
    assert_eq!(form["client_id"], CLIENT);
    assert!(f.stored(&id).is_none());
    assert!(!provider.has_key);
    assert_eq!(provider.chatgpt.unwrap().client_id, CLIENT);
    assert_eq!(f.store.endpoint(&id).unwrap_err().kind, "chatgpt_signed_out");
    assert!(f.dir.join("chatgpt-host-id").exists());
}

#[tokio::test]
async fn sign_out_retries_and_still_clears_when_revocation_stays_unconfirmed() {
    let f = fixture().await;
    let id = f.sign_in().await;
    let fail = || Reply(500, "text/plain".into(), "storing".into());
    f.script("/revoke", vec![fail(), fail(), fail()]);
    assert!(!f.store.hub().logout(&id).await.unwrap());
    assert_eq!(f.seen("/revoke").len(), 3, "begrensd opnieuw proberen");
    assert!(f.stored(&id).is_none());
}

#[tokio::test]
async fn deleting_the_provider_removes_its_tokens() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.store.delete_provider(&id).unwrap();
    assert!(f.secrets.0.lock().unwrap().is_empty());
}

// ---------- host-ID ----------

#[tokio::test]
async fn host_id_is_made_once_before_the_first_sign_in() {
    let f = fixture().await;
    assert!(!f.dir.join("chatgpt-host-id").exists());
    let id = f.store.hub().host_id().unwrap();
    assert_eq!(uuid::Uuid::parse_str(id.strip_prefix("urn:uuid:").unwrap()).unwrap().get_version_num(), 4);
    assert_eq!(f.store.hub().host_id().unwrap(), id);
    f.sign_in().await;
    assert_eq!(f.authorized.lock().unwrap()[0]["ext_agent_host_id"], id);
    // Een onbruikbare waarde wordt vervangen door een geldige.
    std::fs::write(f.dir.join("chatgpt-host-id"), "lezer@example.com").unwrap();
    assert!(f.store.hub().host_id().unwrap().starts_with("urn:uuid:"));
}

// ---------- inferentie ----------

#[tokio::test]
async fn chat_follows_the_preview_rules_behind_stream_chat() {
    let f = fixture().await;
    let id = f.sign_in().await;
    let (events, result) = chat(&f.target(&id)).await;
    result.unwrap();
    assert_eq!(text_of(&events), "Werkt");
    assert_eq!(events.last().unwrap(), &StreamEvent::Done { stop: ai::StopReason::End, input_tokens: Some(3), output_tokens: Some(2) });

    let sent = f.seen("/v1/responses");
    assert!(sent[0].line.starts_with("POST /v1/responses "));
    assert!(sent[0].head.to_lowercase().contains("authorization: bearer toegang-1"));
    let body: serde_json::Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body["store"], false);
    assert_eq!(body["stream"], true);
    assert_eq!(body["model"], "a-model");
    assert_eq!(body["instructions"], "Wees kort.");
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    for key in keys {
        assert!(["model", "input", "store", "stream", "instructions"].contains(&key), "niet toegestaan veld: {key}");
    }
    let input = body["input"].as_array().unwrap();
    assert_eq!(input.len(), 3, "de hele geschiedenis");
    assert!(input.iter().all(|i| i["role"] != "system"));
    assert_eq!(input[1], json!({ "role": "assistant", "content": "Eerste antwoord" }));
    assert_eq!(input[2]["content"][0], json!({ "type": "input_text", "text": "Wat staat hier?" }));
    assert_eq!(input[2]["content"][1], json!({ "type": "input_image", "image_url": "data:image/png;base64,QUJD" }));
}

#[tokio::test]
async fn a_rejected_token_is_renewed_once() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.script("/v1/responses", vec![json_reply(401, json!({ "detail": "nee" }))]);
    let (events, result) = chat(&f.target(&id)).await;
    result.unwrap();
    assert_eq!(text_of(&events), "Werkt");
    let sent = f.seen("/v1/responses");
    assert!(sent[1].head.to_lowercase().contains("bearer toegang-2"));

    // Blijft geweigerd: stoppen na één poging, met de details bewaard en zonder token.
    let refused = || json_reply(401, json!({ "error": { "code": "subscription_sharing_invalid_user", "message": "Bearer toegang-3 geweigerd" } }));
    f.script("/v1/responses", vec![refused(), refused(), refused()]);
    let (_, result) = chat(&f.target(&id)).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, "chatgpt_invalid_user");
    let detail = err.detail.unwrap();
    assert!(detail.contains("req_nep") && detail.contains("HTTP 401"), "{detail}");
    assert!(!detail.contains("toegang-3"), "{detail}");
    assert!(f.stored(&id).is_some(), "niet wissen zolang de sessie niet bevestigd ongeldig is");
}

#[tokio::test]
async fn a_revoked_session_is_reported_when_the_renewal_confirms_it() {
    let f = fixture().await;
    let id = f.sign_in().await;
    f.script("/v1/responses", vec![json_reply(401, json!({ "detail": "nee" }))]);
    f.script("/api/accounts/oauth/token", vec![json_reply(400, json!({ "error": "invalid_grant" }))]);
    let (_, result) = chat(&f.target(&id)).await;
    assert_eq!(result.unwrap_err().kind, "chatgpt_session_revoked");
    assert!(f.provider(&id).chatgpt.unwrap().session_lost);
}

#[tokio::test]
async fn structured_errors_get_their_own_recovery() {
    let f = fixture().await;
    let id = f.sign_in().await;
    let cases = [
        (403, "subscription_sharing_user_not_eligible", "chatgpt_not_eligible"),
        (429, "subscription_sharing_usage_limit_exceeded", "chatgpt_usage_limit"),
        (400, "subscription_sharing_unsupported_capability", "chatgpt_unsupported"),
        (403, "subscription_sharing_route_not_supported", "chatgpt_route"),
        (403, "chatpass_v2_scope_not_authorized", "chatgpt_not_authorized"),
        (403, "chatpass_v2_invalid_authorization_context", "chatgpt_not_authorized"),
    ];
    for (status, code, kind) in cases {
        let before = f.seen("/v1/responses").len();
        f.script("/v1/responses", vec![json_reply(status, json!({ "error": { "code": code, "param": "input[0]", "message": "x" } }))]);
        let (_, result) = chat(&f.target(&id)).await;
        let err = result.unwrap_err();
        assert_eq!(err.kind, kind, "{code}");
        assert_eq!(f.seen("/v1/responses").len(), before + 1, "{code}: niet herhalen");
        assert!(f.stored(&id).is_some());
    }
    // Vóór de stream kan ook een kale detail-vorm komen.
    f.script("/v1/responses", vec![json_reply(403, json!({ "detail": "regio" }))]);
    assert_eq!(chat(&f.target(&id)).await.1.unwrap_err().kind, "chatgpt_forbidden");
}

#[tokio::test]
async fn temporary_unavailability_retries_a_bounded_number_of_times() {
    let f = fixture().await;
    let id = f.sign_in().await;
    let busy = || json_reply(503, json!({ "error": { "code": "subscription_sharing_usage_unavailable" } }));
    f.script("/v1/responses", vec![busy()]);
    assert_eq!(text_of(&chat(&f.target(&id)).await.0), "Werkt");

    let before = f.seen("/v1/responses").len();
    f.script("/v1/responses", vec![busy(), busy(), busy(), busy()]);
    assert_eq!(chat(&f.target(&id)).await.1.unwrap_err().kind, "chatgpt_usage_unavailable");
    assert_eq!(f.seen("/v1/responses").len(), before + 3);
    assert!(f.stored(&id).is_some(), "gegevens blijven staan");
}

#[tokio::test]
async fn stream_endings_are_told_apart() {
    let f = fixture().await;
    let id = f.sign_in().await;
    let delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Half\"}\n\n";

    // Een limiet nadat het antwoord al begonnen is.
    f.script("/v1/responses", vec![sse_reply(&format!("{delta}data: {}\n\n", json!({ "type": "response.failed", "response": { "error": { "code": "subscription_sharing_usage_limit_exceeded", "message": "op" } } })))]);
    let (events, result) = chat(&f.target(&id)).await;
    assert_eq!(text_of(&events), "Half");
    assert_eq!(result.unwrap_err().kind, "chatgpt_usage_limit");

    // Afgebroken zonder eindgebeurtenis telt niet als klaar.
    f.script("/v1/responses", vec![sse_reply(delta)]);
    let (events, result) = chat(&f.target(&id)).await;
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::Done { .. })));
    assert_eq!(result.unwrap_err().kind, "stream_cut");

    // Onvolledig is geen fout, maar ook geen gewoon einde.
    f.script("/v1/responses", vec![sse_reply(&format!("{delta}data: {}\n\n", json!({ "type": "response.incomplete", "response": { "incomplete_details": { "reason": "max_output_tokens" } } })))]);
    let (events, result) = chat(&f.target(&id)).await;
    result.unwrap();
    assert!(matches!(events.last(), Some(StreamEvent::Done { stop: ai::StopReason::Length, .. })));

    // Een expliciete fout, ook zonder bekende code.
    f.script("/v1/responses", vec![sse_reply(&format!("data: {}\n\n", json!({ "type": "error", "code": "iets_anders", "message": "kapot" })))]);
    let err = chat(&f.target(&id)).await.1.unwrap_err();
    assert_eq!(err.kind, "chatgpt_failed");
    assert!(err.message.contains("kapot"));

    // Denkstappen en een weigering.
    f.script("/v1/responses", vec![sse_reply(&format!("data: {}\n\ndata: {}\n\ndata: {}\n\n", json!({ "type": "response.reasoning_summary_text.delta", "delta": "Hm" }), json!({ "type": "response.refusal.delta", "delta": "Liever niet" }), json!({ "type": "response.completed", "response": {} })))]);
    let (events, result) = chat(&f.target(&id)).await;
    result.unwrap();
    assert_eq!(events[0], StreamEvent::Reasoning { text: "Hm".into() });
    assert_eq!(text_of(&events), "Liever niet");
    assert!(matches!(events.last(), Some(StreamEvent::Done { stop: ai::StopReason::Refusal, .. })));
}

#[tokio::test]
async fn models_come_from_the_account_catalog_in_server_order() {
    let f = fixture().await;
    let id = f.sign_in().await;
    let endpoint = f.store.endpoint(&id).unwrap();
    let models = ai::list_models(&endpoint).await.unwrap();
    assert_eq!(f.seen("/v1/models")[0].head.to_lowercase().contains("bearer toegang-1"), true);
    let provider = f.store.merge_fetched(&id, models).unwrap();
    let shown: Vec<_> = provider.models.iter().map(|m| (m.id.as_str(), m.display_name.as_deref())).collect();
    assert_eq!(shown, [("z-model", Some("Z")), ("a-model", Some("A"))], "alleen zichtbare modellen, in servervolgorde");

    // De verbindingstest loopt via dezelfde ingang.
    let report = ai::check_connection(&endpoint, None, |_| {}).await.unwrap();
    assert_eq!((report.model.as_deref(), report.sample.as_str()), (Some("z-model"), "Werkt"));
}
