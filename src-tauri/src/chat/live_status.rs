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

fn channel_live_payload(channel: &str, status: &helix::StreamStatus) -> ChannelLive {
    ChannelLive {
        channel: channel.to_string(),
        live: status.live,
        viewer_count: status.live.then(|| status.viewer_count).flatten(),
        game_name: status
            .live
            .then(|| status.game_name.clone())
            .flatten(),
        stream_title: status
            .live
            .then(|| status.stream_title.clone())
            .flatten(),
        started_at: status
            .live
            .then(|| status.started_at.clone())
            .flatten(),
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
    let Some(status) =
        helix::fetch_channel_stream(channel, token.as_deref(), &client_id).await
    else {
        return;
    };
    let live_changed = {
        let Ok(mut hub) = shared.hub.lock() else {
            return;
        };
        if hub.active.as_deref() != Some(channel) {
            return;
        }
        if status.live {
            hub.set_stream_meta(
                channel,
                status.game_name.clone().filter(|s| !s.is_empty()),
                status.stream_title.clone().filter(|s| !s.is_empty()),
                status.stream_id.clone().filter(|s| !s.is_empty()),
            );
        }
        hub.set_channel_live(channel, status.live)
    };
    if live_changed && !status.live {
        super::logging::close_stream_file(shared, channel);
    }
    if live_changed {
        let show_title = show_title_in_live_message(shared);
        let text = stream_status_notice_text(
            channel,
            status.live,
            status.stream_title.as_deref(),
            show_title,
        );
        shared.post_channel_notice(app, channel, text);
    }
    let payload = channel_live_payload(channel, &status);
    if status.live || live_changed {
        let _ = app.emit("chat:channel_live", payload);
    }
}

fn show_title_in_live_message(shared: &Shared) -> bool {
    shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("misc.showTitleInLiveMessage")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false)
}

/// Stock Chatterino live/offline system line (MessageBuilder makeLiveMessage).
pub fn stream_status_notice_text(
    channel: &str,
    live: bool,
    stream_title: Option<&str>,
    show_title: bool,
) -> String {
    if !live {
        return format!("{channel} is now offline.");
    }
    if show_title {
        if let Some(title) = stream_title.map(str::trim).filter(|s| !s.is_empty()) {
            return format!("{channel} is live: {title}");
        }
    }
    format!("{channel} is live!")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_without_title_knob() {
        assert_eq!(
            stream_status_notice_text("xqc", true, Some("Ranked"), false),
            "xqc is live!"
        );
    }

    #[test]
    fn live_with_title_knob() {
        assert_eq!(
            stream_status_notice_text("xqc", true, Some("Ranked"), true),
            "xqc is live: Ranked"
        );
    }

    #[test]
    fn live_title_knob_empty_falls_back() {
        assert_eq!(
            stream_status_notice_text("xqc", true, Some("  "), true),
            "xqc is live!"
        );
        assert_eq!(
            stream_status_notice_text("xqc", true, None, true),
            "xqc is live!"
        );
    }

    #[test]
    fn offline_ignores_title() {
        assert_eq!(
            stream_status_notice_text("xqc", false, Some("Ranked"), true),
            "xqc is now offline."
        );
    }
}
