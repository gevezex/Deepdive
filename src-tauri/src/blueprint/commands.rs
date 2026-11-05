//! De ingang voor de interface. De voortgang gaat over een kanaal; het eindresultaat is het antwoord op de opdracht.

use super::{saved, stream::{Partial, StructureStream}, Blueprint, Live, Options, RunReport, Stage};
use crate::ai::StreamEvent;
use crate::error::AppError;
use crate::providers::{ModelRef, ProviderStore};
use crate::store::Store;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;

/// Niet vaker een teken van leven dan dit: het scherm hoeft niet per woord bij te werken.
const ALIVE_EVERY: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobEvent {
    /// Een aanroep begint. Bij poging 2 is wat er tot nu toe getoond is niet meer geldig.
    #[serde(rename_all = "camelCase")]
    Attempt { stage: Stage, attempt: u32 },
    /// Het model leeft. `thinking`: het stuurt nog alleen denkstappen en nog geen antwoord.
    #[serde(rename_all = "camelCase")]
    Alive { stage: Stage, chars: u64, thinking: bool },
    /// Een veld uit laag 1, nog niet gecontroleerd.
    Field { name: String, value: Value },
    /// Een blok uit laag 2, nog niet gecontroleerd.
    Block { value: Value },
    /// Doel en diagram zijn gecontroleerd en bewaard. De kritische laag komt nog.
    Structure { blueprint: Box<Blueprint> },
}

/// De blauwdrukken die nu worden gemaakt, per bron.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, watch::Sender<bool>>>);

struct JobGuard<'a> {
    jobs: &'a Jobs,
    source_id: String,
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        self.jobs.0.lock().unwrap().remove(&self.source_id);
    }
}

impl Jobs {
    fn begin(&self, source_id: &str) -> Result<(JobGuard<'_>, watch::Receiver<bool>), AppError> {
        let mut map = self.0.lock().unwrap();
        if map.contains_key(source_id) {
            return Err(AppError::new("blueprint_busy", "Voor dit stuk wordt al een blauwdruk gemaakt."));
        }
        let (sender, receiver) = watch::channel(false);
        map.insert(source_id.to_string(), sender);
        Ok((JobGuard { jobs: self, source_id: source_id.to_string() }, receiver))
    }

    fn cancel(&self, source_id: &str) {
        if let Some(sender) = self.0.lock().unwrap().get(source_id) {
            let _ = sender.send(true);
        }
    }
}

/// Zet de gebeurtenissen van het maken om naar wat de interface nodig heeft.
struct Relay {
    channel: Channel<JobEvent>,
    stream: StructureStream,
    chars: u64,
    has_text: bool,
    last_alive: Option<Instant>,
}

impl Relay {
    fn new(channel: Channel<JobEvent>) -> Self {
        Self { channel, stream: StructureStream::default(), chars: 0, has_text: false, last_alive: None }
    }

    fn send(&self, event: JobEvent) {
        // Een gesloten kanaal betekent dat er niemand meer kijkt. Het resultaat wordt toch bewaard.
        let _ = self.channel.send(event);
    }

    fn on_chunk(&mut self, stage: Stage, event: &StreamEvent) {
        let thinking = match event {
            StreamEvent::Text { text } => {
                self.has_text = true;
                self.chars += text.len() as u64;
                if stage == Stage::Structure {
                    for part in self.stream.feed(text) {
                        self.send(match part {
                            Partial::Field { name, value } => JobEvent::Field { name, value },
                            Partial::Block(value) => JobEvent::Block { value },
                        });
                    }
                }
                false
            }
            StreamEvent::Reasoning { text } => {
                self.chars += text.len() as u64;
                !self.has_text
            }
            StreamEvent::Done { .. } => return,
        };
        if self.last_alive.is_none_or(|at| at.elapsed() >= ALIVE_EVERY) {
            self.last_alive = Some(Instant::now());
            self.send(JobEvent::Alive { stage, chars: self.chars, thinking });
        }
    }

    fn on_attempt(&mut self, stage: Stage, attempt: u32) {
        self.stream = StructureStream::default();
        self.chars = 0;
        self.has_text = false;
        self.last_alive = None;
        self.send(JobEvent::Attempt { stage, attempt });
    }
}

fn no_model() -> AppError {
    AppError::new("no_model", "Er is nog geen model gekozen.")
}

/// Maakt samenvatting en blauwdruk. `critique_of` is een bewaarde blauwdruk met dit model waarvan alleen de
/// kritische laag ontbreekt: die wordt dan aangevuld.
#[tauri::command]
pub async fn generate_blueprint(
    store: State<'_, Store>,
    providers: State<'_, ProviderStore>,
    jobs: State<'_, Jobs>,
    source_id: String,
    critique_of: Option<ModelRef>,
    on_event: Channel<JobEvent>,
) -> Result<Blueprint, AppError> {
    let (_guard, cancel) = jobs.begin(&source_id)?;
    let source = store.get(&source_id)?;
    let chosen = match &critique_of {
        Some(chosen) => chosen.clone(),
        None => providers.model_for_action("blueprint").ok_or_else(no_model)?,
    };
    let target = providers.target(&chosen)?;
    crate::ai::prepare(&target).await?;
    let options = Options::default();
    let mut report = RunReport::default();
    let store: &Store = &store;
    let relay = std::sync::Arc::new(Mutex::new(Relay::new(on_event)));
    let on = {
        let relay = relay.clone();
        move |live: Live<'_>| {
            let mut relay = relay.lock().unwrap();
            match live {
                Live::Attempt { stage, attempt } => relay.on_attempt(stage, attempt),
                Live::Chunk { stage, event } => relay.on_chunk(stage, event),
                Live::StructureReady(draft) => {
                    // Meteen bewaren: wat er ook met de tweede aanroep gebeurt, de eerste hoeft niet opnieuw.
                    let _ = saved::save(store, draft);
                    relay.send(JobEvent::Structure { blueprint: Box::new(draft.clone()) });
                }
            }
        }
    };

    let result = match critique_of {
        Some(chosen) => {
            let previous = saved::find(store, &source_id, &chosen.provider_id, &chosen.model_id, super::PROMPT_VERSION).ok_or_else(|| AppError::new("not_found", "Deze blauwdruk is niet meer bewaard. Maak hem opnieuw."))?;
            super::redo_critique(&target, &source, &options, previous, &mut report, cancel, on).await
        }
        None => super::generate_live(&target, &chosen.provider_id, &source, &options, &mut report, cancel, on).await,
    };
    let blueprint = result?;
    saved::save(store, &blueprint)?;
    Ok(blueprint)
}

/// Breekt af. Het antwoord op `generate_blueprint` zegt daarna wat er overblijft.
#[tauri::command]
pub async fn cancel_blueprint(jobs: State<'_, Jobs>, source_id: String) -> Result<(), AppError> {
    jobs.cancel(&source_id);
    Ok(())
}

/// Alles wat voor deze bron bewaard is. Roept geen model aan.
#[tauri::command]
pub async fn saved_blueprints(store: State<'_, Store>, source_id: String) -> Result<Vec<Blueprint>, AppError> {
    saved::all(&store, &source_id)
}
