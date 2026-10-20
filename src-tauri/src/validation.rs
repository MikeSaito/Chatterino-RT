//! Offline source and commands compiled exclusively into the isolated validation app.
use crate::chat::{
    self,
    state::{BatchSend, IrcCmd, Shared},
    types::{ChatEvent, EmoteSpan},
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager, State};

pub const EMOTE_PREFIX: &str = "https://cdn.7tv.app/emote/validation-";
static MESSAGE_IDS: AtomicU64 = AtomicU64::new(0);
pub static FIXTURE_REQUESTS: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    running: bool,
    generated: u64,
    delivered: u64,
    failed: u64,
    fixture_requests: u64,
    release_build: bool,
    revision: String,
    dirty: bool,
}
#[derive(Clone, Default)]
pub struct Source(Arc<Mutex<Progress>>);

pub fn setup(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    if app.config().identifier != "com.mike.webtv-chats.validation" {
        return Err("validation requires its isolated app identifier".into());
    }
    chat::filters::init(app, shared)?;
    chat::session::init(app, shared)?;
    chat::settings::init(app, shared)?;
    {
        let mut settings = shared.settings.lock().map_err(|_| "settings lock")?;
        settings
            .data
            .knobs
            .insert("appearance.uiLayout".into(), serde_json::json!("Classic"));
        settings
            .data
            .knobs
            .insert("emotes.animateEmotes".into(), serde_json::json!(true));
    }
    chat::user_data::init(shared)?;
    shared.auth.lock().map_err(|_| "auth lock")?.current_login = Some("validation".into());
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    *shared.irc_tx.lock().map_err(|_| "irc lock")? = Some(tx);
    let app = app.clone();
    let shared = shared.clone();
    app.manage(Source::default());
    tauri::async_runtime::spawn(async move {
        while let Some(command) = rx.recv().await {
            match command {
                IrcCmd::Join(channel) => {
                    if let Ok(mut hub) = shared.hub.lock() {
                        hub.set_joined(&channel, true);
                    }
                    chat::auth::emit(&app, &shared);
                }
                IrcCmd::Shutdown => break,
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn validation_status(source: State<'_, Source>) -> Progress {
    let mut progress = source.0.lock().unwrap().clone();
    progress.fixture_requests = FIXTURE_REQUESTS.load(Ordering::Relaxed);
    progress.release_build = !cfg!(debug_assertions);
    progress.revision = env!("CRT_VALIDATION_REVISION").into();
    progress.dirty = env!("CRT_VALIDATION_DIRTY") != "false";
    progress
}
#[tauri::command]
pub fn validation_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn validation_start(
    state: State<'_, Shared>,
    source: State<'_, Source>,
    rate: u32,
    seconds: u32,
    animated: bool,
) -> Result<(), String> {
    if ![50, 200].contains(&rate) || !(1..=2000).contains(&seconds) {
        return Err("invalid validation load".into());
    }
    let channel = state
        .hub
        .lock()
        .map_err(|_| "hub lock")?
        .active
        .clone()
        .ok_or("join a validation channel first")?;
    {
        let mut progress = source.0.lock().map_err(|_| "source lock")?;
        if progress.running {
            return Err("validation load already running".into());
        }
        *progress = Progress {
            running: true,
            ..Default::default()
        };
    }
    let source = source.inner().clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(50));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut generated = 0;
        for tick in 1..=seconds as u64 * 20 {
            timer.tick().await;
            let count = tick * rate as u64 / 20 - generated;
            let mut batches = Vec::new();
            if let Ok(mut hub) = state.hub.lock() {
                for _ in 0..count {
                    generated += 1;
                    let id = MESSAGE_IDS.fetch_add(1, Ordering::Relaxed);
                    let line=format!("@id=validation-{id};user-id=9;display-name=Viewer;user-login=viewer;tmi-sent-ts={} :viewer!v@v PRIVMSG #{channel} :Dance Привет {generated} reproducible message stream",generated*5);
                    if let chat::parse::ParsedLine::Event { mut event, .. } =
                        chat::parse::parse_line(&line, generated * 5)
                    {
                        if animated {
                            if let ChatEvent::Privmsg { emote_spans, .. } = &mut event {
                                emote_spans.push(EmoteSpan {
                                    start: 0,
                                    end: 5,
                                    emote_id: format!("validation-{}", generated % 32),
                                    provider: "7tv".into(),
                                    url: format!("{EMOTE_PREFIX}{}/1x.gif", generated % 32),
                                    zero_width: false,
                                    display_width: None,
                                    display_height: None,
                                    bits_amount: None,
                                    bits_color: None,
                                });
                            }
                        }
                        if let Some(batch) = hub.ingest(
                            &channel,
                            event,
                            None,
                            &Default::default(),
                            Default::default(),
                        ) {
                            batches.push(batch);
                        }
                    }
                }
                batches.extend(hub.flush_all());
            }
            let mut delivered = 0;
            let mut failed = 0;
            for batch in batches {
                if matches!(state.send_batch(&batch), BatchSend::Delivered) {
                    delivered += batch.events.len() as u64;
                } else {
                    failed += batch.events.len() as u64;
                }
            }
            let mut progress = source.0.lock().unwrap();
            progress.generated = generated;
            progress.delivered += delivered;
            progress.failed += failed;
        }
        source.0.lock().unwrap().running = false;
    });
    Ok(())
}
