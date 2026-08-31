//! Live stream notifications (MIT reimpl Chatterino NotificationController).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::auth;
use super::helix;
use super::settings::AppSettings;
use super::state::Shared;
use super::streamer_mode;

const POLL_TICK: Duration = Duration::from_secs(1);
const POLL_EVERY_TICKS: u32 = 60;

static NOTIFY_SHUTDOWN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveNotify {
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub flash: bool,
    pub play_sound: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sound_path: String,
    pub toast: bool,
    pub open_url: String,
    pub open_from_toast: String,
}

#[derive(Debug, Clone, Default)]
pub struct NotifyCfg {
    pub flash: bool,
    pub play_sound_selected: bool,
    pub play_sound_any: bool,
    pub suppress_initial: bool,
    pub toast: bool,
    pub custom_sound: bool,
    pub sound_path: String,
    pub open_from_toast: String,
    pub selected: HashSet<String>,
}

impl NotifyCfg {
    pub fn from_settings(data: &AppSettings) -> Self {
        let knobs = &data.knobs;
        let mut selected = HashSet::new();
        for row in &data.notify_channels {
            let ch = row
                .channel
                .trim()
                .trim_start_matches('#')
                .to_ascii_lowercase();
            if !ch.is_empty() {
                selected.insert(ch);
            }
        }
        let custom = knob_bool(knobs, "notifications.notificationCustomSound", false);
        let path = knob_str(knobs, "notifications.notificationPathSound");
        let sound_path = if custom && !path.is_empty() && !path.starts_with("qrc:") {
            path
        } else {
            String::new()
        };
        let open_from_toast = {
            let v = knob_str(knobs, "notifications.openFromToast");
            if v.is_empty() {
                "OpenInBrowser".into()
            } else {
                v
            }
        };
        Self {
            flash: knob_bool(knobs, "notifications.notificationFlashTaskbar", false),
            play_sound_selected: knob_bool(knobs, "notifications.notificationPlaySound", false),
            play_sound_any: knob_bool(knobs, "notifications.notificationOnAnyChannel", false),
            suppress_initial: knob_bool(
                knobs,
                "notifications.suppressInitialLiveNotification",
                false,
            ),
            toast: knob_bool(knobs, "notifications.notificationToast", false),
            custom_sound: custom && !sound_path.is_empty(),
            sound_path,
            open_from_toast,
            selected,
        }
    }
}

fn knob_bool(knobs: &std::collections::BTreeMap<String, Value>, key: &str, default: bool) -> bool {
    knobs.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn knob_str(knobs: &std::collections::BTreeMap<String, Value>, key: &str) -> String {
    knobs
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn suppress_streamer(shared: &Shared) -> bool {
    let knob = shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("streamerMode.suppressLiveNotifications")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);
    knob && streamer_mode::is_enabled(shared)
}

#[derive(Default)]
pub struct LiveNotifyState {
    /// Last known live flag per channel login.
    live: HashMap<String, bool>,
    /// First poll after app start (for suppressInitial).
    initial_pass: bool,
    cfg: NotifyCfg,
}

impl LiveNotifyState {
    pub fn rebuild_cfg(&mut self, data: &AppSettings) {
        self.cfg = NotifyCfg::from_settings(data);
    }

    pub fn cached_live(&self, channel: &str) -> Option<bool> {
        self.live.get(channel).copied()
    }
}

/// Decide effects for offline→live. Returns None when suppressed or no effects.
pub fn build_live_notify(
    channel: &str,
    title: Option<&str>,
    cfg: &NotifyCfg,
    is_initial: bool,
    streamer_suppress: bool,
) -> Option<LiveNotify> {
    if streamer_suppress {
        return None;
    }
    if cfg.suppress_initial && is_initial {
        return None;
    }
    let ch = channel.trim().trim_start_matches('#').to_ascii_lowercase();
    if ch.is_empty() {
        return None;
    }
    let in_selected = cfg.selected.contains(&ch);
    let mut play_sound = false;
    if cfg.play_sound_selected && in_selected {
        play_sound = true;
    }
    if !play_sound && cfg.play_sound_any {
        play_sound = true;
    }
    let flash = cfg.flash && in_selected;
    let toast = cfg.toast && in_selected;
    // Stock: flash/toast/selected-sound only for notified channels; any-channel is sound only.
    // If flash is on but channel not selected, still allow any-sound path alone.
    if !flash && !play_sound && !toast {
        return None;
    }
    // Flash taskbar applies to selected channels only (stock). If only any-sound, no flash.
    let flash = flash;
    let sound_path = if play_sound && cfg.custom_sound {
        cfg.sound_path.clone()
    } else {
        String::new()
    };
    Some(LiveNotify {
        channel: ch.clone(),
        title: title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        flash,
        play_sound,
        sound_path,
        toast,
        open_url: format!("https://www.twitch.tv/{ch}"),
        open_from_toast: cfg.open_from_toast.clone(),
    })
}

/// Offline→live (or first live sighting) that should fire notify effects.
fn should_emit_on_live_edge(prev: Option<bool>, live: bool) -> bool {
    live && prev != Some(true)
}

/// Apply a live snapshot for one channel. Emits notify on offline→live when appropriate.
/// Returns whether the cached live flag changed.
pub fn observe_live(
    shared: &Shared,
    app: &AppHandle,
    channel: &str,
    live: bool,
    title: Option<&str>,
) -> bool {
    let ch = channel.trim().trim_start_matches('#').to_ascii_lowercase();
    if ch.is_empty() {
        return false;
    }
    let Ok(mut state) = shared.live_notify.lock() else {
        return false;
    };
    let prev = state.live.get(&ch).copied();
    let is_initial = !state.initial_pass && prev.is_none();
    let changed = prev != Some(live);
    state.live.insert(ch.clone(), live);
    if !should_emit_on_live_edge(prev, live) {
        return changed;
    }
    let cfg = state.cfg.clone();
    let initial = is_initial || (!state.initial_pass && cfg.suppress_initial && prev.is_none());
    drop(state);
    let streamer = suppress_streamer(shared);
    if let Some(payload) = build_live_notify(&ch, title, &cfg, initial, streamer) {
        let _ = app.emit("chat:live_notify", payload);
    }
    changed
}

pub fn mark_initial_pass_done(shared: &Shared) {
    if let Ok(mut state) = shared.live_notify.lock() {
        state.initial_pass = true;
    }
}

pub fn rebuild(shared: &Shared, data: &AppSettings) {
    if let Ok(mut state) = shared.live_notify.lock() {
        state.rebuild_cfg(data);
    }
}

pub fn start(app: AppHandle, shared: Shared) {
    tauri::async_runtime::spawn(async move {
        run_poller(app, shared).await;
    });
}

pub fn shutdown() {
    NOTIFY_SHUTDOWN.store(true, Ordering::SeqCst);
}

async fn run_poller(app: AppHandle, shared: Shared) {
    let mut ticks: u32 = 0;
    let mut last_fingerprint = String::new();
    let mut last_open: HashSet<String> = HashSet::new();
    // Session-open logins that got Helix before the hub buffer existed.
    let mut awaiting_buffer: HashSet<String> = HashSet::new();
    let mut fresh_backoff_ticks: u32 = 0;
    // First pass after a short delay so settings are loaded.
    loop {
        if NOTIFY_SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(POLL_TICK).await;
        if NOTIFY_SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        ticks = ticks.saturating_add(1);
        if fresh_backoff_ticks > 0 {
            fresh_backoff_ticks = fresh_backoff_ticks.saturating_sub(1);
        }

        let session_open = session_open_logins(&shared);
        let session_open_set: HashSet<String> = session_open.iter().cloned().collect();
        awaiting_buffer.retain(|ch| session_open_set.contains(ch));

        // Apply cached Helix live to tabs whose buffers appeared after the last poll.
        flush_awaiting_buffers(&app, &shared, &mut awaiting_buffer);

        let freshly_open = freshly_opened(&last_open, &session_open);
        let channels = channels_to_poll(&shared, &session_open);
        let fingerprint = channels.join("\0");
        let set_changed = fingerprint != last_fingerprint;
        let interval = ticks == 1 || ticks % POLL_EVERY_TICKS == 0;
        let force_fresh = !freshly_open.is_empty() && fresh_backoff_ticks == 0;
        if !interval && !set_changed && !force_fresh {
            continue;
        }

        match poll_once(&app, &shared, &channels, &session_open, &freshly_open).await {
            PollOutcome::Empty => {
                last_fingerprint = fingerprint;
                last_open = session_open_set;
                fresh_backoff_ticks = 0;
                mark_initial_pass_done(&shared);
            }
            PollOutcome::Failed => {
                // Advance fingerprint so permanent Auth fail does not force-poll every
                // few seconds; keep last_open so brand-new tabs still retry with backoff.
                last_fingerprint = fingerprint;
                if !freshly_open.is_empty() {
                    fresh_backoff_ticks = 5;
                }
            }
            PollOutcome::Ok { missing_buffers } => {
                last_fingerprint = fingerprint;
                last_open = session_open_set;
                fresh_backoff_ticks = 0;
                for ch in missing_buffers {
                    awaiting_buffer.insert(ch);
                }
                mark_initial_pass_done(&shared);
            }
        }
    }
}

fn normalize_login(raw: &str) -> Option<String> {
    let ch = raw.trim().trim_start_matches('#').to_ascii_lowercase();
    if ch.is_empty() {
        None
    } else {
        Some(ch)
    }
}

/// Logins in `current` that were absent from `previous` (new open tabs).
pub fn freshly_opened(previous: &HashSet<String>, current: &[String]) -> HashSet<String> {
    current
        .iter()
        .filter(|ch| !previous.contains(*ch))
        .cloned()
        .collect()
}

/// Whether `chat:channel_live` should fire for tab chrome after a Helix observation.
/// Active channel chrome is owned by `live_status` (always-emit + system notices).
pub fn should_emit_open_tab_live(
    is_open_tab: bool,
    has_channel: bool,
    is_active: bool,
    hub_live_changed: bool,
    freshly_open: bool,
) -> bool {
    if !is_open_tab || !has_channel || is_active {
        return false;
    }
    hub_live_changed || freshly_open
}

/// Session open-tab logins (UI source of truth for tab chrome), not IRC `joined`.
fn session_open_logins(shared: &Shared) -> Vec<String> {
    let mut set = HashSet::new();
    if let Ok(session) = shared.session.lock() {
        for ch in &session.data.open {
            if let Some(n) = normalize_login(ch) {
                set.insert(n);
            }
        }
    }
    let mut out: Vec<String> = set.into_iter().collect();
    out.sort();
    out
}

fn channels_to_poll(shared: &Shared, session_open: &[String]) -> Vec<String> {
    let mut set = HashSet::new();
    if let Ok(state) = shared.live_notify.lock() {
        for ch in &state.cfg.selected {
            if let Some(n) = normalize_login(ch) {
                set.insert(n);
            }
        }
    }
    for ch in session_open {
        set.insert(ch.clone());
    }
    // Hub buffers cover join races before session.open is rewritten.
    if let Ok(hub) = shared.hub.lock() {
        for ch in hub.channels() {
            if let Some(n) = normalize_login(&ch) {
                set.insert(n);
            }
        }
    }
    let mut out: Vec<String> = set.into_iter().filter(|s| !s.is_empty()).collect();
    out.sort();
    out
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

enum PollOutcome {
    Empty,
    Failed,
    Ok { missing_buffers: Vec<String> },
}

/// When Helix ran before `hub.buffer` existed, apply cached live once the buffer appears.
fn flush_awaiting_buffers(app: &AppHandle, shared: &Shared, awaiting: &mut HashSet<String>) {
    if awaiting.is_empty() {
        return;
    }
    let show_title = show_title_in_live_message(shared);
    let ready: Vec<String> = {
        let Ok(hub) = shared.hub.lock() else {
            return;
        };
        awaiting
            .iter()
            .filter(|ch| hub.has_channel(ch))
            .cloned()
            .collect()
    };
    if ready.is_empty() {
        return;
    }
    for ch in ready {
        awaiting.remove(&ch);
        let live = shared
            .live_notify
            .lock()
            .ok()
            .and_then(|state| state.cached_live(&ch))
            .unwrap_or(false);
        let mut emit_tab_live = false;
        let mut close_stream_log = false;
        let mut notice: Option<(String, String)> = None;
        if let Ok(mut hub) = shared.hub.lock() {
            let is_active = hub
                .active
                .as_deref()
                .is_some_and(|a| a.eq_ignore_ascii_case(&ch));
            if is_active || !hub.has_channel(&ch) {
                continue;
            }
            let changed = hub.set_channel_live(&ch, live);
            if changed {
                notice = Some((
                    super::live_status::stream_status_notice_text(&ch, live, None, show_title),
                    super::live_status::stream_status_notice_msg_id(&ch, live, None, show_title),
                ));
                if !live {
                    close_stream_log = true;
                }
            }
            emit_tab_live = should_emit_open_tab_live(true, true, false, changed, true);
        }
        if close_stream_log {
            super::logging::close_stream_file(shared, &ch);
        }
        if let Some((text, msg_id)) = notice {
            shared.post_channel_notice_ex(app, &ch, text, Some(msg_id));
        }
        if emit_tab_live {
            let payload = super::live_status::channel_live_payload(
                &ch,
                &if live {
                    helix::StreamStatus {
                        live: true,
                        ..helix::StreamStatus::offline()
                    }
                } else {
                    helix::StreamStatus::offline()
                },
            );
            let _ = app.emit("chat:channel_live", payload);
        }
    }
}

async fn poll_once(
    app: &AppHandle,
    shared: &Shared,
    channels: &[String],
    session_open: &[String],
    freshly_open: &HashSet<String>,
) -> PollOutcome {
    if channels.is_empty() {
        return PollOutcome::Empty;
    }
    let open_set: HashSet<&str> = session_open.iter().map(String::as_str).collect();
    let token = auth::oauth_token(shared);
    let client_id = auth::resolved_client_id(shared);
    let Some(live_map) =
        helix::fetch_streams_by_logins(channels, token.as_deref(), &client_id).await
    else {
        return PollOutcome::Failed;
    };
    let show_title = show_title_in_live_message(shared);
    let mut missing_buffers = Vec::new();
    for ch in channels {
        let status = live_map.get(ch);
        let live = status.is_some_and(|s| s.live);
        let title = status.and_then(|s| s.stream_title.as_deref());
        let is_open_tab = open_set.contains(ch.as_str());
        // Active hub + system notices: live_status. Inactive open tabs: update hub,
        // post the same live/offline notice into that channel's scrollback, emit tab chrome
        // on change or when the tab just opened (live may already be known from notify lists).
        let mut emit_tab_live = false;
        let mut close_stream_log = false;
        let mut notice: Option<(String, String)> = None;
        let mut saw_open_without_buffer = false;
        if let Ok(mut hub) = shared.hub.lock() {
            let is_active = hub
                .active
                .as_deref()
                .is_some_and(|a| a.eq_ignore_ascii_case(ch));
            let has_channel = hub.has_channel(ch);
            if is_open_tab && !has_channel {
                saw_open_without_buffer = true;
            }
            let mut hub_live_changed = false;
            if is_open_tab && has_channel && !is_active {
                if live {
                    hub.set_stream_meta(
                        ch,
                        status.and_then(|s| s.game_name.clone()),
                        status.and_then(|s| s.stream_title.clone()),
                        status.and_then(|s| s.stream_id.clone()),
                    );
                }
                hub_live_changed = hub.set_channel_live(ch, live);
                if hub_live_changed {
                    notice = Some((
                        super::live_status::stream_status_notice_text(ch, live, title, show_title),
                        super::live_status::stream_status_notice_msg_id(
                            ch, live, title, show_title,
                        ),
                    ));
                    if !live {
                        close_stream_log = true;
                    }
                }
            }
            emit_tab_live = should_emit_open_tab_live(
                is_open_tab,
                has_channel,
                is_active,
                hub_live_changed,
                freshly_open.contains(ch),
            );
        }
        if saw_open_without_buffer {
            missing_buffers.push(ch.clone());
        }
        if close_stream_log {
            super::logging::close_stream_file(shared, ch);
        }
        if let Some((text, msg_id)) = notice {
            shared.post_channel_notice_ex(app, ch, text, Some(msg_id));
        }
        if emit_tab_live {
            let resolved = status.cloned().unwrap_or_else(helix::StreamStatus::offline);
            let payload = super::live_status::channel_live_payload(ch, &resolved);
            let _ = app.emit("chat:channel_live", payload);
        }
        observe_live(shared, app, ch, live, title);
    }
    PollOutcome::Ok { missing_buffers }
}

/// Called from active-channel live_status poller on status fetch.
pub fn on_active_channel_status(
    shared: &Shared,
    app: &AppHandle,
    channel: &str,
    live: bool,
    title: Option<&str>,
) {
    observe_live(shared, app, channel, live, title);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_selected(ch: &str) -> NotifyCfg {
        let mut selected = HashSet::new();
        selected.insert(ch.to_string());
        NotifyCfg {
            flash: true,
            play_sound_selected: true,
            play_sound_any: false,
            suppress_initial: false,
            toast: true,
            custom_sound: false,
            sound_path: String::new(),
            open_from_toast: "OpenInBrowser".into(),
            selected,
        }
    }

    #[test]
    fn selected_channel_gets_all_effects() {
        let n = build_live_notify("xqc", Some("hi"), &cfg_selected("xqc"), false, false).unwrap();
        assert!(n.flash && n.play_sound && n.toast);
        assert_eq!(n.open_url, "https://www.twitch.tv/xqc");
    }

    #[test]
    fn unlisted_with_any_sound_only() {
        let mut cfg = cfg_selected("other");
        cfg.play_sound_any = true;
        cfg.flash = true;
        cfg.toast = true;
        let n = build_live_notify("xqc", None, &cfg, false, false).unwrap();
        assert!(!n.flash);
        assert!(!n.toast);
        assert!(n.play_sound);
    }

    #[test]
    fn suppress_initial_blocks() {
        let cfg = cfg_selected("xqc");
        let mut cfg2 = cfg.clone();
        cfg2.suppress_initial = true;
        assert!(build_live_notify("xqc", None, &cfg2, true, false).is_none());
        assert!(build_live_notify("xqc", None, &cfg2, false, false).is_some());
    }

    #[test]
    fn streamer_suppress_blocks() {
        assert!(build_live_notify("xqc", None, &cfg_selected("xqc"), false, true).is_none());
    }

    #[test]
    fn live_edge_emit_gate() {
        assert!(!should_emit_on_live_edge(Some(true), true));
        assert!(should_emit_on_live_edge(Some(false), true));
        assert!(should_emit_on_live_edge(None, true));
        assert!(!should_emit_on_live_edge(Some(false), false));
        assert!(!should_emit_on_live_edge(Some(true), false));
    }

    #[test]
    fn no_effects_when_all_off() {
        let cfg = NotifyCfg::default();
        assert!(build_live_notify("xqc", None, &cfg, false, false).is_none());
    }

    #[test]
    fn normalize_login_strips_hash_and_case() {
        assert_eq!(normalize_login(" #XQC ").as_deref(), Some("xqc"));
        assert!(normalize_login("  ").is_none());
        assert!(normalize_login("#").is_none());
    }

    #[test]
    fn tab_live_emit_gates() {
        assert!(!should_emit_open_tab_live(false, true, false, true, false));
        assert!(!should_emit_open_tab_live(true, false, false, true, false));
        assert!(should_emit_open_tab_live(true, true, false, true, false));
        assert!(should_emit_open_tab_live(true, true, false, false, true));
        assert!(!should_emit_open_tab_live(true, true, false, false, false));
        // Active chrome is live_status-only (no duplicate emit).
        assert!(!should_emit_open_tab_live(true, true, true, false, true));
        assert!(!should_emit_open_tab_live(true, true, true, true, false));
    }

    #[test]
    fn freshly_opened_detects_new_tabs_only() {
        let prev = HashSet::from(["xqc".to_string()]);
        let cur = vec!["xqc".into(), "lirik".into()];
        let fresh = freshly_opened(&prev, &cur);
        assert!(fresh.contains("lirik"));
        assert!(!fresh.contains("xqc"));
        assert!(freshly_opened(&prev, &["xqc".into()]).is_empty());
    }
}
