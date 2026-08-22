//! Helix stream live polling for active channel (Chatterino LiveController). MIT reimpl.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::auth;
use super::helix;
use super::state::Shared;
use super::types::ChannelLive;

const ACTIVE_TICK: Duration = Duration::from_secs(1);

static LIVE_SHUTDOWN: AtomicBool = AtomicBool::new(false);

pub fn start(app: AppHandle, shared: Shared) {
    tauri::async_runtime::spawn(async move {
        run_poller(app, shared).await;
    });
}

pub fn shutdown() {
    LIVE_SHUTDOWN.store(true, Ordering::SeqCst);
}

async fn run_poller(app: AppHandle, shared: Shared) {
    let mut last_active: Option<String> = None;
    let mut ticks: u32 = 0;
    loop {
        if LIVE_SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(ACTIVE_TICK).await;
        if LIVE_SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        let active = shared
            .hub
            .lock()
            .ok()
            .and_then(|hub| hub.active.clone());
        let changed = active != last_active;
        if changed {
            last_active = active.clone();
            ticks = 0;
        }
        ticks = ticks.saturating_add(1);
        let should_poll = changed || ticks == 1 || ticks % 30 == 0;
        if !should_poll {
            continue;
        }
        let Some(channel) = active else {
            continue;
        };
        poll_channel(&app, &shared, &channel).await;
    }
}

async fn poll_channel(app: &AppHandle, shared: &Shared, channel: &str) {
    let still_active = shared
        .hub
        .lock()
        .ok()
        .and_then(|hub| hub.active.clone())
        .is_some_and(|ch| ch == channel);
    if !still_active {
        return;
    }
    let token = auth::oauth_token(shared);
    let client_id = auth::resolved_client_id(shared);
    let Some(live) = helix::fetch_channel_live(channel, token.as_deref(), &client_id).await
    else {
        return;
    };
    let changed = {
        let Ok(mut hub) = shared.hub.lock() else {
            return;
        };
        if hub.active.as_deref() != Some(channel) {
            return;
        }
        hub.set_channel_live(channel, live)
    };
    if !changed {
        return;
    }
    let _ = app.emit(
        "chat:channel_live",
        ChannelLive {
            channel: channel.to_string(),
            live,
        },
    );
}
