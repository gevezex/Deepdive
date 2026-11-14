//! De ingang voor de interface. Het antwoord gaat stukje voor stukje over een kanaal; het eindresultaat is het
//! bewaarde gesprek.

use super::{clean_question, highlights, load, now, request, save, Action, Selection, Thread, Turn};
use crate::ai::{Role, StreamEvent};
use crate::error::AppError;
use crate::providers::ProviderStore;
use crate::store::{new_id, Store};
use serde::Serialize;
use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AskEvent {
    /// Het gesprek bestaat. Bij een nieuwe vraag staat het antwoord nog leeg.
    Started { thread: Box<Thread> },
    /// Het model leeft, maar stuurt nog alleen denkstappen.
    Thinking,
    Text { text: String },
}

/// De vragen die nu lopen, op het verzoeknummer van de interface, om te kunnen stoppen.
#[derive(Default)]
pub struct Asks(Mutex<HashMap<String, watch::Sender<bool>>>);

struct AskGuard<'a> {
    asks: &'a Asks,
    request: String,
}

impl Drop for AskGuard<'_> {
    fn drop(&mut self) {
        self.asks.0.lock().unwrap().remove(&self.request);
    }
}

impl Asks {
    fn begin(&self, request: &str) -> (AskGuard<'_>, watch::Receiver<bool>) {
        let (sender, receiver) = watch::channel(false);
        self.0.lock().unwrap().insert(request.to_string(), sender);
        (AskGuard { asks: self, request: request.to_string() }, receiver)
    }
}

fn no_model() -> AppError {
    AppError::new("no_model", "Er is nog geen model gekozen. Kies er een bovenaan dit paneel.")
}

/// Een nieuwe vraag over een selectie (`action` en `selection`), of een vervolgvraag in een gesprek (`thread_id`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ask_professor(
    store: State<'_, Store>,
    providers: State<'_, ProviderStore>,
    asks: State<'_, Asks>,
    source_id: String,
    request_id: String,
    thread_id: Option<String>,
    action: Option<Action>,
    selection: Option<Selection>,
    question: Option<String>,
    on_event: Channel<AskEvent>,
) -> Result<Thread, AppError> {
    let source = store.get(&source_id)?;
    let question = question.filter(|q| !q.trim().is_empty()).map(|q| clean_question(&q)).transpose()?;
    let chosen = providers.model_for_action("ask").ok_or_else(no_model)?;
    let target = providers.target(&chosen)?;

    let mut thread = match thread_id {
        Some(id) => {
            let mut thread = load(&store, &source_id, &id)?;
            let q = question.clone().ok_or_else(|| AppError::new("empty_question", "Typ eerst een vraag."))?;
            // Een gestopt antwoord blijft staan zoals het was; de vervolgvraag komt erachter.
            if thread.turns.last().is_some_and(|t| t.role == Role::User) {
                thread.turns.push(Turn { role: Role::Assistant, text: "(geen antwoord)".into() });
            }
            thread.turns.push(Turn { role: Role::User, text: q });
            thread
        }
        None => {
            let action = action.ok_or_else(|| AppError::new("internal", "Er is geen actie gekozen."))?;
            let selection = selection.ok_or_else(|| AppError::new("empty_selection", "Selecteer eerst een stuk tekst."))?.cleaned()?;
            if action == Action::Ask && question.is_none() {
                return Err(AppError::new("empty_question", "Typ eerst een vraag."));
            }
            let at = now();
            Thread {
                id: new_id(),
                source_id: source_id.clone(),
                action,
                selection,
                turns: vec![Turn { role: Role::User, text: question.clone().unwrap_or_default() }],
                provider_id: chosen.provider_id.clone(),
                model: chosen.model_id.clone(),
                created_at: at.clone(),
                updated_at: at,
                stopped: false,
            }
        }
    };
    let chat = request(&source, &thread, &new_id());
    thread.provider_id = chosen.provider_id.clone();
    thread.model = chosen.model_id.clone();
    let _ = on_event.send(AskEvent::Started { thread: Box::new(thread.clone()) });

    let (_guard, mut stop) = asks.begin(&request_id);
    crate::ai::prepare(&target).await?;
    let mut answer = String::new();
    let mut said_thinking = false;
    let streaming = crate::ai::stream_chat(&target, &chat, |event| {
        match event {
            StreamEvent::Text { text } => {
                answer.push_str(&text);
                let _ = on_event.send(AskEvent::Text { text });
            }
            StreamEvent::Reasoning { .. } if answer.is_empty() && !said_thinking => {
                said_thinking = true;
                let _ = on_event.send(AskEvent::Thinking);
            }
            _ => {}
        }
        ControlFlow::Continue(())
    });
    // Stoppen wacht niet op het volgende stukje: de verbinding gaat meteen dicht, ook als het model nog nadenkt.
    let result = tokio::select! {
        r = streaming => r,
        _ = stop.wait_for(|s| *s) => Ok(()),
    };
    let stopped = *stop.borrow();
    match result {
        Err(e) if !stopped => {
            // Een vervolgvraag zonder antwoord gaat niet in het bewaarde gesprek; een nieuw gesprek wordt niet bewaard.
            return Err(e);
        }
        _ => {}
    }
    if answer.trim().is_empty() && !stopped {
        return Err(AppError::new("empty_answer", "Het model gaf geen antwoord. Probeer het opnieuw of kies een ander model."));
    }
    thread.turns.push(Turn { role: Role::Assistant, text: answer });
    thread.stopped = stopped;
    thread.updated_at = now();
    save(&store, &thread)?;
    Ok(thread)
}

#[tauri::command]
pub async fn cancel_ask(asks: State<'_, Asks>, request_id: String) -> Result<(), AppError> {
    if let Some(stop) = asks.0.lock().unwrap().get(&request_id) {
        let _ = stop.send(true);
    }
    Ok(())
}

#[tauri::command]
pub async fn list_threads(store: State<'_, Store>, source_id: String) -> Result<Vec<Thread>, AppError> {
    super::all(&store, &source_id)
}

#[tauri::command]
pub async fn delete_thread(store: State<'_, Store>, source_id: String, thread_id: String) -> Result<(), AppError> {
    super::remove(&store, &source_id, &thread_id)
}

#[tauri::command]
pub async fn list_highlights(store: State<'_, Store>, source_id: String) -> Result<Vec<highlights::Highlight>, AppError> {
    highlights::all(&store, &source_id)
}

#[tauri::command]
pub async fn save_highlight(store: State<'_, Store>, source_id: String, highlight: highlights::Highlight) -> Result<Vec<highlights::Highlight>, AppError> {
    highlights::upsert(&store, &source_id, highlight)
}

#[tauri::command]
pub async fn delete_highlight(store: State<'_, Store>, source_id: String, highlight_id: String) -> Result<Vec<highlights::Highlight>, AppError> {
    highlights::remove(&store, &source_id, &highlight_id)
}
