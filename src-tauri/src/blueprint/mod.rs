//! De blauwdruk: uit een vaste kopie van een bron en een model komt een gecontroleerd `Blueprint`-object.
//!
//! Twee aanroepen, in deze volgorde. De eerste levert doel, boodschap en diagram; die velden staan vooraan in het
//! antwoord, zodat de interface ze tijdens het streamen eerder kan tonen. De tweede levert de kritische laag en
//! krijgt de gecontroleerde structuur als vaststaand gegeven. Zo kan die laag het diagram niet tegenspreken: hij
//! kan er alleen met bestaande ids naar verwijzen. Beide beginnen met dezelfde systeemtekst en bron, zodat een
//! provider met prompt-caching de bron maar één keer hoeft te verwerken.

mod schema;
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
    #[serde(skip)]
    pub raw: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub estimated_input_tokens: u64,
    pub context_tokens: Option<u32>,
    pub calls: Vec<CallReport>,
}

/// Maakt de blauwdruk met het gekozen model. `report` is ook bij een fout gevuld met wat er tot dan is gebeurd.
pub async fn generate(target: &Target, source: &Source, options: &Options, report: &mut RunReport) -> Result<Blueprint, AppError> {
    report.context_tokens = target.context_tokens;
    let model = target.model.clone();
    run(source, options, &model, target.context_tokens, report, &mut LiveModel { target }).await
}

/// De plek waar de kern een model aanroept. Een eigen trait en geen closure: Tauri-opdrachten moeten `Send` zijn.
pub(crate) trait Caller: Send {
    /// `track_goal`: meet ook de tijd tot het doel binnen is.
    fn call(&mut self, request: ChatRequest, track_goal: bool) -> impl Future<Output = Result<Reply, AppError>> + Send;
}

struct LiveModel<'a> {
    target: &'a Target,
}

impl Caller for LiveModel<'_> {
    async fn call(&mut self, request: ChatRequest, track_goal: bool) -> Result<Reply, AppError> {
        call_model(self.target, &request, track_goal).await
    }
}

async fn call_model(target: &Target, request: &ChatRequest, track_goal: bool) -> Result<Reply, AppError> {
    let start = Instant::now();
    let mut reply = Reply { text: String::new(), stop: StopReason::Other, seconds: 0.0, first_text_seconds: None, goal_ready_seconds: None, input_tokens: None, output_tokens: None, reasoning_chars: 0 };
    ai::stream_chat(target, request, |event| {
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
    })
    .await?;
    reply.seconds = start.elapsed().as_secs_f32();
    Ok(reply)
}

/// De kern, los van het netwerk.
pub(crate) async fn run(
    source: &Source,
    options: &Options,
    model: &str,
    context_tokens: Option<u32>,
    report: &mut RunReport,
    caller: &mut impl Caller,
) -> Result<Blueprint, AppError> {
    if !source.text_ready || source.blocks.is_empty() {
        return Err(AppError::new("no_text", "Deze bron heeft nog geen tekst om een blauwdruk van te maken."));
    }
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

    let mut structure: Structure = ask(&frame, frame.structure_task(), "structure", true, validate::structure_errors, report, caller).await?;
    validate::check_structure(&mut structure, &index, &mut issues, &mut checks);

    let critique_task = frame.critique_task(&structure)?;
    let critique: Result<Critique, AppError> = ask(&frame, critique_task, "critique", false, |_| vec![], report, caller).await;
    let critique = match critique {
        Ok(mut critique) => {
            validate::check_critique(&mut critique, &structure, &index, &mut issues, &mut checks);
            Some(critique)
        }
        Err(e) => {
            issues.push(Issue { code: "critique_failed".into(), path: "critique".into(), detail: e.message.clone() });
            None
        }
    };

    Ok(Blueprint {
        schema_version: SCHEMA_VERSION,
        source: source_status(source),
        model: model.to_string(),
        language: options.language.clone(),
        created_at: now(),
        structure,
        critique,
        issues,
        checks,
    })
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
    stage: &'static str,
    track_goal: bool,
    extra_errors: impl Fn(&T) -> Vec<String> + Send,
    report: &mut RunReport,
    caller: &mut impl Caller,
) -> Result<T, AppError> {
    let mut request = frame.request(&task);
    for attempt in 1..=2 {
        let reply = match caller.call(request.clone(), track_goal).await {
            Ok(reply) => reply,
            Err(e) => {
                report.calls.push(CallReport { stage, attempt, seconds: 0.0, first_text_seconds: None, goal_ready_seconds: None, input_tokens: None, output_tokens: None, reasoning_chars: 0, stop: StopReason::Other, schema_ok: false, schema_error: None, error_kind: Some(e.kind), raw: String::new() });
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
        report.calls.push(CallReport { stage, attempt, seconds: reply.seconds, first_text_seconds: reply.first_text_seconds, goal_ready_seconds: reply.goal_ready_seconds, input_tokens: reply.input_tokens, output_tokens: reply.output_tokens, reasoning_chars: reply.reasoning_chars, stop: reply.stop, schema_ok, schema_error, error_kind: None, raw: reply.text.clone() });
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
