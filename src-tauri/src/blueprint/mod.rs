//! De blauwdruk: uit een vaste kopie van een bron en een model komt een gecontroleerd `Blueprint`-object.
//!
//! Twee aanroepen, in deze volgorde. De eerste levert doel, boodschap en diagram; die velden staan vooraan in het
//! antwoord, zodat de interface ze tijdens het streamen eerder kan tonen. De tweede levert de kritische laag en
//! krijgt de gecontroleerde structuur als vaststaand gegeven. Zo kan die laag het diagram niet tegenspreken: hij
//! kan er alleen met bestaande ids naar verwijzen. Beide beginnen met dezelfde systeemtekst en bron, zodat een
//! provider met prompt-caching de bron maar één keer hoeft te verwerken.
//!
//! `commands` is de ingang voor de interface, `saved` de opslag per bron, model en promptversie, en `stream` leest
//! doel en blokken uit het antwoord terwijl het nog binnenkomt.

pub mod commands;
mod saved;
mod schema;
mod stream;
#[cfg(test)]
mod tests;
mod validate;

pub use schema::*;
pub use validate::SourceIndex;

use crate::ai::{self, ChatRequest, Message, Part, Role, StopReason, StreamEvent, Target};
use crate::error::AppError;
use crate::model::{CompletenessVerdict, Source};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::future::Future;
use std::ops::ControlFlow;
use std::time::Instant;
use tokio::sync::watch;

const SYSTEM: &str = include_str!("prompts/system.md");
const STRUCTURE_TASK: &str = include_str!("prompts/structure.md");
const CRITIQUE_TASK: &str = include_str!("prompts/critique.md");
const MAX_TOKENS: u32 = 48_000;
/// Voorzichtige schatting: Engels zit rond de 4 tekens per token, Nederlands iets lager.
const CHARS_PER_TOKEN: f64 = 3.5;
/// Ruimte voor het antwoord en de structuur in de tweede aanroep.
const RESERVED_TOKENS: u64 = 24_000;
const BAD_ANSWER_ECHO_CHARS: usize = 20_000;

#[derive(Debug, Clone)]
pub struct Options {
    /// De taal van de beschrijvende velden, zoals het in een zin past: "Nederlands", "Engels".
    pub language: String,
}

impl Default for Options {
    fn default() -> Self {
        Self { language: "Nederlands".into() }
    }
}

/// Wat één aanroep van het model opleverde.
#[derive(Debug, Clone)]
pub struct Reply {
    pub text: String,
    pub stop: StopReason,
    pub seconds: f32,
    pub first_text_seconds: Option<f32>,
    /// Wanneer doel, boodschap en aanleiding binnen waren. Alleen bij de eerste aanroep.
    pub goal_ready_seconds: Option<f32>,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub reasoning_chars: u32,
}

/// Meting van één aanroep. De test bewaart deze getallen; de app heeft ze niet nodig om te werken.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallReport {
    pub stage: &'static str,
    pub attempt: u32,
    pub seconds: f32,
    pub first_text_seconds: Option<f32>,
    pub goal_ready_seconds: Option<f32>,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub reasoning_chars: u32,
    pub stop: StopReason,
    pub schema_ok: bool,
    pub schema_error: Option<String>,
    pub error_kind: Option<&'static str>,
    /// Alleen de testhaak leest dit.
    #[serde(skip)]
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub raw: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub estimated_input_tokens: u64,
    pub context_tokens: Option<u32>,
    pub calls: Vec<CallReport>,
}

/// Welke van de twee aanroepen bezig is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Structure,
    Critique,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Structure => "structure",
            Stage::Critique => "critique",
        }
    }
}

/// Wat er tijdens het maken gebeurt, voor wie het wil volgen.
pub enum Live<'a> {
    /// Een aanroep begint. Poging 2 betekent dat het vorige antwoord niet aan het schema voldeed.
    Attempt { stage: Stage, attempt: u32 },
    Chunk { stage: Stage, event: &'a StreamEvent },
    /// Doel en diagram zijn gecontroleerd. De kritische laag ontbreekt nog.
    StructureReady(&'a Blueprint),
}

/// Maakt de blauwdruk met het gekozen model, zonder dat iemand meekijkt. `report` is ook bij een fout gevuld met wat
/// er tot dan is gebeurd.
#[cfg(debug_assertions)]
pub async fn generate(target: &Target, provider_id: &str, source: &Source, options: &Options, report: &mut RunReport) -> Result<Blueprint, AppError> {
    let (_keep, cancel) = watch::channel(false);
    generate_live(target, provider_id, source, options, report, cancel, |_| {}).await
}

/// Als `generate`, met voortgang en de mogelijkheid om af te breken.
pub async fn generate_live(
    target: &Target,
    provider_id: &str,
    source: &Source,
    options: &Options,
    report: &mut RunReport,
    cancel: watch::Receiver<bool>,
    on: impl FnMut(Live<'_>) + Send,
) -> Result<Blueprint, AppError> {
    report.context_tokens = target.context_tokens;
    let model = target.model.clone();
    run(source, options, &model, provider_id, target.context_tokens, report, &mut LiveModel { target, cancel, on }).await
}

/// Doet alleen de kritische laag opnieuw, op een structuur die al bewaard is. Scheelt bij een lokaal model minuten.
pub async fn redo_critique(
    target: &Target,
    source: &Source,
    options: &Options,
    mut previous: Blueprint,
    report: &mut RunReport,
    cancel: watch::Receiver<bool>,
    on: impl FnMut(Live<'_>) + Send,
) -> Result<Blueprint, AppError> {
    report.context_tokens = target.context_tokens;
    previous.issues.retain(|i| !matches!(i.code.as_str(), CRITIQUE_FAILED | CRITIQUE_CANCELLED));
    let start = Instant::now();
    let frame = Frame::new(source, options);
    let index = SourceIndex::new(&source.blocks);
    add_critique(&frame, &mut previous, &index, report, &mut LiveModel { target, cancel, on }).await?;
    previous.seconds += start.elapsed().as_secs_f32();
    previous.created_at = now();
    Ok(previous)
}

/// De plek waar de kern een model aanroept. Een eigen trait en geen closure: Tauri-opdrachten moeten `Send` zijn.
pub(crate) trait Caller: Send {
    fn call(&mut self, request: ChatRequest, stage: Stage, attempt: u32) -> impl Future<Output = Result<Reply, AppError>> + Send;
    /// Doel en diagram zijn gecontroleerd. Standaard hoeft daar niemand iets mee.
    fn structure_ready(&mut self, _draft: &Blueprint) {}
}

struct LiveModel<'a, F> {
    target: &'a Target,
    cancel: watch::Receiver<bool>,
    on: F,
}

impl<F: FnMut(Live<'_>) + Send> Caller for LiveModel<'_, F> {
    async fn call(&mut self, request: ChatRequest, stage: Stage, attempt: u32) -> Result<Reply, AppError> {
        (self.on)(Live::Attempt { stage, attempt });
        call_model(self.target, &request, stage, &mut self.cancel, &mut self.on).await
    }

    fn structure_ready(&mut self, draft: &Blueprint) {
        (self.on)(Live::StructureReady(draft));
    }
}

/// Wordt pas wakker als er is afgebroken; als niemand meer kan afbreken, nooit.
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    if cancel.wait_for(|stop| *stop).await.is_err() {
        std::future::pending::<()>().await;
    }
}

async fn call_model(target: &Target, request: &ChatRequest, stage: Stage, cancel: &mut watch::Receiver<bool>, on: &mut (impl FnMut(Live<'_>) + Send)) -> Result<Reply, AppError> {
    let start = Instant::now();
    let track_goal = stage == Stage::Structure;
    let mut reply = Reply { text: String::new(), stop: StopReason::Other, seconds: 0.0, first_text_seconds: None, goal_ready_seconds: None, input_tokens: None, output_tokens: None, reasoning_chars: 0 };
    let streaming = ai::stream_chat(target, request, |event| {
        on(Live::Chunk { stage, event: &event });
        match event {
            StreamEvent::Text { text } => {
                reply.first_text_seconds.get_or_insert(start.elapsed().as_secs_f32());
                reply.text.push_str(&text);
                if track_goal && reply.goal_ready_seconds.is_none() && reply.text.contains("\"summary\"") {
                    reply.goal_ready_seconds = Some(start.elapsed().as_secs_f32());
                }
            }
            StreamEvent::Reasoning { text } => reply.reasoning_chars += text.chars().count() as u32,
            StreamEvent::Done { stop, input_tokens, output_tokens } => {
                reply.stop = stop;
                reply.input_tokens = input_tokens;
                reply.output_tokens = output_tokens;
            }
        }
        ControlFlow::Continue(())
    });
    // Afbreken laat de lopende aanroep vallen. Dat sluit de verbinding, zodat ook een lokaal model kan stoppen.
    tokio::select! {
        result = streaming => result?,
        _ = cancelled(cancel) => return Err(AppError::new(CANCELLED, "Afgebroken.")),
    }
    reply.seconds = start.elapsed().as_secs_f32();
    Ok(reply)
}

pub const CANCELLED: &str = "cancelled";
pub const CRITIQUE_FAILED: &str = "critique_failed";
pub const CRITIQUE_CANCELLED: &str = "critique_cancelled";

/// De kern, los van het netwerk.
pub(crate) async fn run(
    source: &Source,
    options: &Options,
    model: &str,
    provider_id: &str,
    context_tokens: Option<u32>,
    report: &mut RunReport,
    caller: &mut impl Caller,
) -> Result<Blueprint, AppError> {
    if !source.text_ready || source.blocks.is_empty() {
        return Err(AppError::new("no_text", "Deze bron heeft nog geen tekst om een blauwdruk van te maken."));
    }
    let start = Instant::now();
    let frame = Frame::new(source, options);
    report.estimated_input_tokens = frame.estimated_tokens();
    if let Some(limit) = context_tokens {
        if report.estimated_input_tokens + RESERVED_TOKENS > u64::from(limit) {
            return Err(AppError::new(
                "context_too_large",
                format!("Deze bron is ongeveer {} tokens en past niet in dit model ({limit}). Kies een model met meer context. Er is niets weggelaten of verstuurd.", report.estimated_input_tokens),
            ));
        }
    }

    let index = SourceIndex::new(&source.blocks);
    let mut issues = vec![];
    let mut checks = Checks::default();

    let mut structure: Structure = ask(&frame, frame.structure_task(), Stage::Structure, validate::structure_errors, report, caller).await?;
    validate::check_structure(&mut structure, &index, &mut issues, &mut checks);

    let mut blueprint = Blueprint {
        schema_version: SCHEMA_VERSION,
        source: source_status(source),
        model: model.to_string(),
        provider_id: provider_id.to_string(),
        prompt_version: PROMPT_VERSION,
        language: options.language.clone(),
        created_at: now(),
        seconds: start.elapsed().as_secs_f32(),
        structure,
        critique: None,
        issues,
        checks,
    };
    caller.structure_ready(&blueprint);
    add_critique(&frame, &mut blueprint, &index, report, caller).await?;
    blueprint.seconds = start.elapsed().as_secs_f32();
    Ok(blueprint)
}

/// De tweede aanroep. Mislukt die of breekt de lezer af, dan blijft de structuur gewoon staan, met een melding.
async fn add_critique(frame: &Frame, blueprint: &mut Blueprint, index: &SourceIndex, report: &mut RunReport, caller: &mut impl Caller) -> Result<(), AppError> {
    let task = frame.critique_task(&blueprint.structure)?;
    match ask::<Critique>(frame, task, Stage::Critique, |_| vec![], report, caller).await {
        Ok(mut critique) => {
            validate::check_critique(&mut critique, &blueprint.structure, index, &mut blueprint.issues, &mut blueprint.checks);
            blueprint.critique = Some(critique);
        }
        Err(e) if e.kind == CANCELLED => {
            blueprint.issues.push(Issue { code: CRITIQUE_CANCELLED.into(), path: "critique".into(), detail: "De kritische laag is afgebroken.".into() });
        }
        Err(e) => {
            blueprint.issues.push(Issue { code: CRITIQUE_FAILED.into(), path: "critique".into(), detail: e.message.clone() });
        }
    }
    Ok(())
}

fn now() -> String {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

pub fn source_status(source: &Source) -> SourceStatus {
    let likely_incomplete = source.completeness.verdict == CompletenessVerdict::LikelyIncomplete;
    SourceStatus {
        source_id: source.id.clone(),
        completeness: source.completeness.verdict,
        likely_incomplete,
        accepted_by_user: source.completeness.accepted_by_user,
        warning: likely_incomplete.then(|| format!("Deze blauwdruk gaat over een waarschijnlijk onvolledig stuk. {}", source.completeness.reason).trim().to_string()),
        block_count: source.blocks.len() as u32,
        word_count: source.word_count,
    }
}

/// Eén aanroep met hooguit één herkansing als het antwoord geen geldig schema heeft.
async fn ask<T: DeserializeOwned + Send>(
    frame: &Frame,
    task: String,
    stage: Stage,
    extra_errors: impl Fn(&T) -> Vec<String> + Send,
    report: &mut RunReport,
    caller: &mut impl Caller,
) -> Result<T, AppError> {
    let mut request = frame.request(&task);
    for attempt in 1..=2 {
        let reply = match caller.call(request.clone(), stage, attempt).await {
            Ok(reply) => reply,
            Err(e) => {
                report.calls.push(CallReport { stage: stage.name(), attempt, seconds: 0.0, first_text_seconds: None, goal_ready_seconds: None, input_tokens: None, output_tokens: None, reasoning_chars: 0, stop: StopReason::Other, schema_ok: false, schema_error: None, error_kind: Some(e.kind), raw: String::new() });
                return Err(e);
            }
        };
        let parsed = parse::<T>(&reply.text).and_then(|value| {
            let errors = extra_errors(&value);
            if errors.is_empty() { Ok(value) } else { Err(errors.join(" ")) }
        });
        let (schema_ok, schema_error) = match &parsed {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e.clone())),
        };
        report.calls.push(CallReport { stage: stage.name(), attempt, seconds: reply.seconds, first_text_seconds: reply.first_text_seconds, goal_ready_seconds: reply.goal_ready_seconds, input_tokens: reply.input_tokens, output_tokens: reply.output_tokens, reasoning_chars: reply.reasoning_chars, stop: reply.stop, schema_ok, schema_error, error_kind: None, raw: reply.text.clone() });
        match parsed {
            Ok(value) => return Ok(value),
            Err(error) if attempt == 1 && reply.stop != StopReason::Length => {
                let echo: String = reply.text.chars().take(BAD_ANSWER_ECHO_CHARS).collect();
                request.messages.push(Message { role: Role::Assistant, parts: vec![Part::Text(echo)] });
                request.messages.push(Message { role: Role::User, parts: vec![Part::Text(format!("Dit antwoord voldoet niet aan het gevraagde JSON-schema: {error}\nGeef het hele object opnieuw, met alleen de toegestane waarden en zonder tekst eromheen."))] });
            }
            Err(error) => return Err(AppError::new("blueprint_schema", "Het model gaf geen bruikbare blauwdruk terug.").with_detail(error)),
        }
    }
    unreachable!("de lus eindigt altijd met een return")
}

/// Leest het JSON-object uit een antwoord. Sommige modellen zetten er ondanks de opdracht tekst of een codeblok omheen.
pub fn parse<T: DeserializeOwned>(text: &str) -> Result<T, String> {
    let body = text.rsplit_once("</think>").map_or(text, |(_, rest)| rest);
    let (Some(start), Some(end)) = (body.find('{'), body.rfind('}')) else {
        return Err("Er staat geen JSON-object in het antwoord.".into());
    };
    if end < start {
        return Err("Er staat geen JSON-object in het antwoord.".into());
    }
    serde_json::from_str(&body[start..=end]).map_err(|e| e.to_string())
}

/// De vaste omlijsting van een aanroep: systeemtekst en bron, die voor beide aanroepen gelijk zijn.
struct Frame {
    system: String,
    source_text: String,
}

impl Frame {
    fn new(source: &Source, options: &Options) -> Self {
        Self { system: SYSTEM.replace("{{LANGUAGE}}", &options.language), source_text: source_prompt(source, &uuid::Uuid::new_v4().simple().to_string()) }
    }

    fn estimated_tokens(&self) -> u64 {
        let chars = self.system.chars().count() + self.source_text.chars().count() + STRUCTURE_TASK.chars().count().max(CRITIQUE_TASK.chars().count());
        (chars as f64 / CHARS_PER_TOKEN).ceil() as u64
    }

    fn structure_task(&self) -> String {
        STRUCTURE_TASK.to_string()
    }

    fn critique_task(&self, structure: &Structure) -> Result<String, AppError> {
        let json = serde_json::to_string(structure).map_err(|e| AppError::new("internal", "De structuur kon niet worden doorgegeven.").with_detail(e.to_string()))?;
        Ok(CRITIQUE_TASK.replace("{{STRUCTURE}}", &json))
    }

    fn request(&self, task: &str) -> ChatRequest {
        ChatRequest { system: Some(self.system.clone()), messages: vec![Message { role: Role::User, parts: vec![Part::Text(self.source_text.clone()), Part::Text(task.to_string())] }], max_tokens: MAX_TOKENS }
    }
}

/// De bron als tekst voor het model. De markering heeft een willekeurig deel, dat niemand vooraf in een stuk kan
/// zetten, zodat tekst uit de bron de markering niet kan sluiten en dan als instructie kan lijken.
pub fn source_prompt(source: &Source, nonce: &str) -> String {
    let tag = format!("bron-{nonce}");
    let mut out = String::new();
    if source.completeness.verdict == CompletenessVerdict::LikelyIncomplete {
        out.push_str(&format!(
            "Let op: de app beoordeelt deze kopie als waarschijnlijk onvolledig ({}). Maak de blauwdruk van wat er staat en beweer niets over het deel dat ontbreekt. Reken een ontbrekend einde of ontbrekend bewijs niet aan als gat in het betoog; het kan aan de kopie liggen.\n\n",
            source.completeness.reason
        ));
    }
    out.push_str(&format!("<{tag}>\n"));
    out.push_str(&format!("Titel: {}\n", source.title));
    for (label, value) in [("Auteur", &source.author), ("Site", &source.site_name), ("Gepubliceerd", &source.published), ("Taal", &source.lang)] {
        if let Some(value) = value {
            out.push_str(&format!("{label}: {value}\n"));
        }
    }
    out.push('\n');
    for block in &source.blocks {
        let text = block.text.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!("¶{} [{}] {}\n", block.n, block.kind, text));
    }
    out.push_str(&format!("</{tag}>\n"));
    out
}
