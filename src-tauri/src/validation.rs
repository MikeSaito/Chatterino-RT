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
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const LOAD_PERIOD: Duration = Duration::from_millis(50);
const MAX_LOAD_BATCH: u64 = 100;

fn due_messages(rate: u32, seconds: u32, elapsed: Duration) -> u64 {
    let total = u64::from(rate) * u64::from(seconds);
    let due = elapsed.as_nanos() * u128::from(rate) / 1_000_000_000;
    due.min(u128::from(total)) as u64
}

fn batch_count(rate: u32, seconds: u32, elapsed: Duration, generated: u64) -> u64 {
    due_messages(rate, seconds, elapsed)
        .saturating_sub(generated)
        .min(MAX_LOAD_BATCH)
}

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
    elapsed_ms: u64,
    max_tick_delay_ms: u64,
    max_batch_messages: u64,
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
        let started = tokio::time::Instant::now();
        let mut timer = tokio::time::interval_at(started + LOAD_PERIOD, LOAD_PERIOD);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut generated = 0;
        let total = u64::from(rate) * u64::from(seconds);
        while generated < total {
            let scheduled = timer.tick().await;
            let now = tokio::time::Instant::now();
            let count = batch_count(rate, seconds, now - started, generated);
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
            progress.elapsed_ms = started.elapsed().as_millis() as u64;
            progress.max_tick_delay_ms = progress
                .max_tick_delay_ms
                .max(now.saturating_duration_since(scheduled).as_millis() as u64);
            progress.max_batch_messages = progress.max_batch_messages.max(count);
        }
        source.0.lock().unwrap().running = false;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pacing_uses_elapsed_time_instead_of_wakeup_count() {
        // A late wakeup owes the messages for all elapsed time, including skipped ticks.
        assert_eq!(batch_count(200, 10, Duration::from_millis(63), 0), 12);
        assert_eq!(batch_count(200, 10, Duration::from_millis(126), 12), 13);
        assert_eq!(batch_count(200, 10, Duration::from_millis(189), 25), 12);
        assert_eq!(batch_count(50, 10, Duration::from_millis(63), 0), 3);
    }

    #[test]
    fn pacing_does_not_emit_early_or_exceed_requested_total() {
        assert_eq!(batch_count(50, 1, Duration::ZERO, 0), 0);
        assert_eq!(batch_count(50, 1, Duration::from_millis(19), 0), 0);
        assert_eq!(batch_count(50, 1, Duration::from_millis(20), 0), 1);
        assert_eq!(batch_count(50, 1, Duration::from_secs(5), 48), 2);
        assert_eq!(batch_count(50, 1, Duration::from_secs(5), 50), 0);
        assert_eq!(batch_count(50, 1, Duration::from_millis(500), 30), 0);
    }

    #[test]
    fn catchup_batches_are_bounded_after_a_long_stall() {
        assert_eq!(batch_count(200, 10, Duration::from_secs(5), 0), 100);
        assert_eq!(batch_count(200, 10, Duration::from_secs(5), 100), 100);
        assert_eq!(due_messages(200, 10, Duration::from_secs(60)), 2000);
    }
}
