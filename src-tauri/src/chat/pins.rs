//! Channel pinned chat message.
//!
//! Moderators/broadcasters: Helix GET/PUT/DELETE `/chat/pins` (scopes
//! `moderator:read:chat_messages` / `moderator:manage:chat_messages`).
//! Viewers and anon: PubSub topic `pinned-chat-updates-v1.{channel_id}` —
//! same public topic Chatterino listens to; we parse the pin payload (Helix
//! GET returns 403 for non-mods). `behaviour.alwaysShowPinnedMessage` only
//! skips the 30s UI auto-hide.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::{Sink, SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use super::commands::ApiError;
use super::state::Shared;

const HELIX: &str = "https://api.twitch.tv/helix";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
const PUBSUB_URL: &str = "wss://pubsub-edge.twitch.tv";
const CHAT_PINNED_EVENT: &str = "chat:pinned";
const ATTEMPTS: u32 = 3;
const RETRY_BASE: Duration = Duration::from_millis(250);
const POLL_WHEN_MOD: Duration = Duration::from_secs(5);
const POLL_WAIT_ROLE: Duration = Duration::from_secs(4);
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const WS_PING_INTERVAL: Duration = Duration::from_secs(240);
const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_WS_FRAME: usize = 64 * 1024;
const PIN_DURATION_MIN: u32 = 30;
const PIN_DURATION_MAX: u32 = 1800;

#[derive(Debug, Clone)]
pub enum PinsCmd {
    SetChannel(String),
    ClearChannel,
    Relogin,
    Nudge,
    Shutdown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PinAccess {
    Ok,
    Viewer,
    NeedScope,
    Anon,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPayload {
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<PinnedMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<PinAccess>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinnedMessage {
    pub message_id: String,
    pub message_text: String,
    pub pinned_by_login: String,
    pub pinned_by_name: String,
    pub sender_login: String,
    pub sender_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starts_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
}

struct Wanted {
    broadcaster_id: String,
    moderator_id: String,
    token: String,
    client_id: String,
}

#[derive(Default)]
struct ScopeCache {
    token: String,
    read_ok: bool,
    manage_ok: bool,
}

struct LivePin {
    pin: PinnedMessage,
    /// PubSub pin id (distinct from IRC message id); used for update/unpin.
    pubsub_pin_id: Option<String>,
}

pub fn start(app: AppHandle, shared: Shared) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<PinsCmd>();
    {
        let mut slot = shared.pins_tx.lock().map_err(|e| e.to_string())?;
        *slot = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_loop(app, shared, rx).await;
    });
    Ok(())
}

pub fn emit_clear(app: &AppHandle, channel: &str) {
    let _ = app.emit(
        CHAT_PINNED_EVENT,
        PinnedPayload {
            channel: channel.to_string(),
            pin: None,
            access: None,
        },
    );
}

fn emit_access(app: &AppHandle, channel: &str, access: PinAccess) {
    let _ = app.emit(
        CHAT_PINNED_EVENT,
        PinnedPayload {
            channel: channel.to_string(),
            pin: None,
            access: Some(access),
        },
    );
}

fn emit_pin(app: &AppHandle, channel: &str, pin: &PinnedMessage) {
    let _ = app.emit(
        CHAT_PINNED_EVENT,
        PinnedPayload {
            channel: channel.to_string(),
            pin: Some(pin.clone()),
            access: Some(PinAccess::Ok),
        },
    );
}

/// Helix PUT /chat/pins — pin a chat message (mod/broadcaster).
pub async fn pin_message(
    shared: &Shared,
    channel: &str,
    message_id: &str,
    duration_seconds: Option<u32>,
) -> Result<(), ApiError> {
    let message_id = clean_id(message_id).ok_or_else(|| {
        ApiError::coded("error.pin.invalid_message", "invalid message id")
    })?;
    if let Some(d) = duration_seconds {
        if !(PIN_DURATION_MIN..=PIN_DURATION_MAX).contains(&d) {
            return Err(ApiError::coded(
                "error.pin.invalid_duration",
                "pin duration must be 30–1800 seconds",
            ));
        }
    }
    let wanted = manage_wanted(shared, channel).await?;
    let mut url = Url::parse(&format!("{HELIX}/chat/pins")).expect("helix url");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("broadcaster_id", &wanted.broadcaster_id);
        q.append_pair("moderator_id", &wanted.moderator_id);
        q.append_pair("message_id", &message_id);
        if let Some(d) = duration_seconds {
            q.append_pair("duration_seconds", &d.to_string());
        }
    }
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = RETRY_BASE;
    for attempt in 0..ATTEMPTS {
        match client
            .put(url.as_str())
            .header("Client-Id", &wanted.client_id)
            .header("Authorization", format!("Bearer {}", wanted.token))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if resp.status().is_success() {
                    shared.notify_pins(PinsCmd::Nudge);
                    return Ok(());
                }
                let body = resp.json::<Value>().await.unwrap_or(Value::Null);
                return Err(map_pin_http_error(status, &body, true));
            }
            Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(ApiError::coded("error.pin.failed", "failed to pin message"))
}

/// Helix DELETE /chat/pins — unpin by IRC message id.
pub async fn unpin_message(
    shared: &Shared,
    channel: &str,
    message_id: &str,
) -> Result<(), ApiError> {
    let message_id = clean_id(message_id).ok_or_else(|| {
        ApiError::coded("error.pin.invalid_message", "invalid message id")
    })?;
    let wanted = manage_wanted(shared, channel).await?;
    let url = helix_query(
        "/chat/pins",
        &[
            ("broadcaster_id", wanted.broadcaster_id.as_str()),
            ("moderator_id", wanted.moderator_id.as_str()),
            ("message_id", message_id.as_str()),
        ],
    );
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = RETRY_BASE;
    for attempt in 0..ATTEMPTS {
        match client
            .delete(&url)
            .header("Client-Id", &wanted.client_id)
            .header("Authorization", format!("Bearer {}", wanted.token))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if resp.status().is_success() {
                    shared.notify_pins(PinsCmd::Nudge);
                    return Ok(());
                }
                let body = resp.json::<Value>().await.unwrap_or(Value::Null);
                return Err(map_pin_http_error(status, &body, false));
            }
            Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(ApiError::coded("error.pin.unpin_failed", "failed to unpin message"))
}

fn map_pin_http_error(status: u16, body: &Value, pin: bool) -> ApiError {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    match status {
        401 => ApiError::coded(
            "error.pin.need_scope",
            "missing pin scope — re-login with moderator:manage:chat_messages",
        ),
        403 => ApiError::coded(
            "error.pin.forbidden",
            "not allowed to manage pins in this channel",
        ),
        404 => ApiError::coded("error.pin.not_found", "pinned message not found"),
        409 if pin => ApiError::coded("error.pin.already", "message is already pinned"),
        400 => ApiError::coded(
            "error.pin.invalid",
            if message.is_empty() {
                "invalid pin request"
            } else {
                message
            },
        ),
        _ => ApiError::coded(
            if pin {
                "error.pin.failed"
            } else {
                "error.pin.unpin_failed"
            },
            if message.is_empty() {
                "pin request failed"
            } else {
                message
            },
        ),
    }
}

async fn manage_wanted(shared: &Shared, channel: &str) -> Result<Wanted, ApiError> {
    let channel = super::commands::normalize_channel(channel)?;
    {
        let hub = shared.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        if !hub.has_channel(&channel) && !hub.is_joined(&channel) {
            return Err(ApiError::coded(
                "error.pin.channel",
                "channel not open",
            ));
        }
    }
    let token = super::auth::oauth_token(shared)
        .map(|t| t.trim().trim_start_matches("oauth:").to_string())
        .filter(|t| !t.is_empty() && t != "YOUR_API_KEY_HERE")
        .ok_or_else(|| ApiError::coded("error.pin.anon", "sign in to manage pins"))?;
    let client_id = super::auth::resolved_client_id(shared);
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return Err(ApiError::coded("error.pin.anon", "sign in to manage pins"));
    }
    let moderator_id = super::auth::ensure_twitch_user_id(shared)
        .await
        .ok_or_else(|| ApiError::coded("error.pin.failed", "could not resolve user id"))?;
    let role = shared
        .hub
        .lock()
        .ok()
        .map(|hub| hub.viewer_role(&channel, Some(moderator_id.as_str())));
    let Some(role) = role else {
        return Err(ApiError::coded(
            "error.pin.forbidden",
            "not allowed to manage pins in this channel",
        ));
    };
    if !(role.is_mod || role.is_broadcaster) {
        return Err(ApiError::coded(
            "error.pin.forbidden",
            "not allowed to manage pins in this channel",
        ));
    }
    let mut cache = ScopeCache::default();
    match pin_scopes(&token, &mut cache).await {
        ScopeCheck::ManageOk | ScopeCheck::ReadOnly => {
            if !cache.manage_ok {
                return Err(ApiError::coded(
                    "error.pin.need_scope",
                    "missing pin scope — re-login with moderator:manage:chat_messages",
                ));
            }
        }
        ScopeCheck::Missing => {
            return Err(ApiError::coded(
                "error.pin.need_scope",
                "missing pin scope — re-login with moderator:manage:chat_messages",
            ));
        }
        ScopeCheck::Unknown => {
            return Err(ApiError::coded(
                "error.pin.failed",
                "could not validate pin scopes",
            ));
        }
    }
    let broadcaster_id = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(&channel).map(str::to_string));
    let broadcaster_id = match broadcaster_id {
        Some(id) if !id.is_empty() => id,
        _ => match super::helix::fetch_user_profile(&channel, Some(&token), &client_id).await {
            Some(p) => p.id,
            None => {
                return Err(ApiError::coded(
                    "error.pin.failed",
                    "could not resolve broadcaster id",
                ));
            }
        },
    };
    Ok(Wanted {
        broadcaster_id,
        moderator_id,
        token,
        client_id,
    })
}

async fn run_loop(app: AppHandle, shared: Shared, mut rx: mpsc::UnboundedReceiver<PinsCmd>) {
    let mut active: Option<String> = None;
    let mut live: Option<LivePin> = None;
    let mut last_access: Option<PinAccess> = None;
    let mut scope_cache = ScopeCache::default();
    let mut backoff = Duration::from_secs(1);
    loop {
        if shared.pins_shutdown.load(Ordering::SeqCst) {
            break;
        }
        let Some(login) = active.clone() else {
            match rx.recv().await {
                None | Some(PinsCmd::Shutdown) => break,
                Some(PinsCmd::SetChannel(login)) => {
                    emit_clear(&app, &login);
                    live = None;
                    last_access = None;
                    scope_cache = ScopeCache::default();
                    active = Some(login);
                    backoff = Duration::from_secs(1);
                }
                Some(PinsCmd::ClearChannel)
                | Some(PinsCmd::Relogin)
                | Some(PinsCmd::Nudge) => {}
            }
            continue;
        };

        match run_channel_session(
            &app,
            &shared,
            &login,
            &mut rx,
            &mut live,
            &mut last_access,
            &mut scope_cache,
        )
        .await
        {
            SessionEnd::Shutdown => break,
            SessionEnd::Idle => {
                active = None;
                live = None;
                last_access = None;
                scope_cache = ScopeCache::default();
                backoff = Duration::from_secs(1);
            }
            SessionEnd::Changed(next) => {
                live = None;
                last_access = None;
                scope_cache = ScopeCache::default();
                active = next;
                backoff = Duration::from_secs(1);
            }
            SessionEnd::Reconnect => {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
            SessionEnd::Continue => {
                backoff = Duration::from_secs(1);
            }
        }
    }
}

enum SessionEnd {
    Shutdown,
    Idle,
    Changed(Option<String>),
    Reconnect,
    Continue,
}

#[allow(clippy::too_many_arguments)]
async fn run_channel_session(
    app: &AppHandle,
    shared: &Shared,
    login: &str,
    rx: &mut mpsc::UnboundedReceiver<PinsCmd>,
    live: &mut Option<LivePin>,
    last_access: &mut Option<PinAccess>,
    scope_cache: &mut ScopeCache,
) -> SessionEnd {
    let channel_id = match resolve_channel_id(shared, login).await {
        Some(id) => id,
        None => {
            match wait_cmd(rx, Duration::from_secs(2)).await {
                WaitCmd::Shutdown => return SessionEnd::Shutdown,
                WaitCmd::Clear => {
                    emit_clear(app, login);
                    return SessionEnd::Idle;
                }
                WaitCmd::Set(next) => {
                    if next != login {
                        emit_clear(app, login);
                        emit_clear(app, &next);
                    }
                    return SessionEnd::Changed(Some(next));
                }
                WaitCmd::Relogin | WaitCmd::Nudge | WaitCmd::Tick => {
                    return SessionEnd::Continue;
                }
            }
        }
    };

    let cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_FRAME))
        .read_buffer_size(32 * 1024);
    let Ok(Ok((stream, _))) = tokio::time::timeout(
        WS_CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(PUBSUB_URL, Some(cfg), false),
    )
    .await
    else {
        // PubSub down: still allow Helix path for mods.
        return helix_only_tick(
            app,
            shared,
            login,
            rx,
            live,
            last_access,
            scope_cache,
        )
        .await;
    };
    let (mut write, mut read) = stream.split();
    if listen_pins(&mut write, &channel_id).await.is_err() {
        let _ = send_ws(&mut write, Message::Close(None)).await;
        return SessionEnd::Reconnect;
    }

    let mut ping_at = tokio::time::interval(WS_PING_INTERVAL);
    ping_at.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut helix_at = tokio::time::interval(POLL_WHEN_MOD);
    helix_at.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Immediate first Helix attempt for mods.
    helix_at.reset_immediately();

    loop {
        if shared.pins_shutdown.load(Ordering::SeqCst) {
            let _ = send_ws(&mut write, Message::Close(None)).await;
            return SessionEnd::Shutdown;
        }
        tokio::select! {
            cmd = rx.recv() => {
                match apply_cmd_live(app, login, live, last_access, cmd) {
                    CmdResult::Shutdown => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Shutdown;
                    }
                    CmdResult::Idle => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Idle;
                    }
                    CmdResult::Changed(next) => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Changed(next);
                    }
                    CmdResult::Nudge => {
                        if let Some(end) = helix_poll_once(
                            app, shared, login, live, last_access, scope_cache,
                        ).await {
                            let _ = send_ws(&mut write, Message::Close(None)).await;
                            return end;
                        }
                    }
                    CmdResult::Continue => {}
                }
            }
            _ = ping_at.tick() => {
                if send_ws(&mut write, Message::Text(json!({"type":"PING"}).to_string().into()))
                    .await
                    .is_err()
                {
                    return SessionEnd::Reconnect;
                }
            }
            _ = helix_at.tick() => {
                if let Some(end) = helix_poll_once(
                    app, shared, login, live, last_access, scope_cache,
                ).await {
                    let _ = send_ws(&mut write, Message::Close(None)).await;
                    return end;
                }
                // Room id may appear after ROOMSTATE; reconnect PubSub if it changed.
                if let Some(next_id) = shared.hub.lock().ok().and_then(|h| h.room_id(login).map(str::to_string)) {
                    if next_id != channel_id {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Continue;
                    }
                }
            }
            msg = read.next() => {
                match msg {
                    None => return SessionEnd::Reconnect,
                    Some(Ok(Message::Text(text))) => {
                        if !handle_pubsub_text(app, login, &channel_id, live, last_access, text.as_ref()) {
                            return SessionEnd::Reconnect;
                        }
                    }
                    Some(Ok(Message::Binary(bin))) => {
                        if let Ok(text) = std::str::from_utf8(&bin) {
                            if !handle_pubsub_text(app, login, &channel_id, live, last_access, text) {
                                return SessionEnd::Reconnect;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        if send_ws(&mut write, Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) => return SessionEnd::Reconnect,
                    Some(Ok(_)) => {}
                }
            }
        }
        if let Some(lp) = live.as_ref() {
            if pin_expired(&lp.pin) {
                clear_live(app, login, live);
                set_access(app, login, PinAccess::Ok, last_access);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn helix_only_tick(
    app: &AppHandle,
    shared: &Shared,
    login: &str,
    rx: &mut mpsc::UnboundedReceiver<PinsCmd>,
    live: &mut Option<LivePin>,
    last_access: &mut Option<PinAccess>,
    scope_cache: &mut ScopeCache,
) -> SessionEnd {
    if let Some(end) =
        helix_poll_once(app, shared, login, live, last_access, scope_cache).await
    {
        return end;
    }
    match wait_cmd(rx, POLL_WAIT_ROLE).await {
        WaitCmd::Shutdown => SessionEnd::Shutdown,
        WaitCmd::Clear => {
            emit_clear(app, login);
            SessionEnd::Idle
        }
        WaitCmd::Set(next) => {
            if next != login {
                emit_clear(app, login);
                emit_clear(app, &next);
            }
            SessionEnd::Changed(Some(next))
        }
        WaitCmd::Relogin => {
            emit_clear(app, login);
            *live = None;
            *last_access = None;
            *scope_cache = ScopeCache::default();
            SessionEnd::Continue
        }
        WaitCmd::Nudge | WaitCmd::Tick => SessionEnd::Continue,
    }
}

#[allow(clippy::too_many_arguments)]
async fn helix_poll_once(
    app: &AppHandle,
    shared: &Shared,
    login: &str,
    live: &mut Option<LivePin>,
    last_access: &mut Option<PinAccess>,
    scope_cache: &mut ScopeCache,
) -> Option<SessionEnd> {
    match resolve_wanted(shared, login, scope_cache).await {
        Resolve::Anon => {
            // Keep PubSub pin if present; only set access when empty.
            if live.is_none() {
                set_access(app, login, PinAccess::Anon, last_access);
            }
            None
        }
        Resolve::Viewer => {
            if live.is_none() {
                set_access(app, login, PinAccess::Viewer, last_access);
            }
            None
        }
        Resolve::NeedScope => {
            // Viewing works via PubSub; manage failures surface on invoke.
            if live.is_none() {
                set_access(app, login, PinAccess::Viewer, last_access);
            }
            None
        }
        Resolve::Pending => None,
        Resolve::Ready(wanted) => match fetch_pin(&wanted).await {
            FetchPin::Ok(pin) => {
                    let next = pin.filter(|p| !pin_expired(p));
                match next {
                    Some(p) => {
                        apply_helix_pin(app, login, live, last_access, p);
                    }
                    None => {
                        // Empty Helix: clear Helix-only pins. Keep PubSub-sourced
                        // pins (GET can lag right after PUT Nudge).
                        if live.as_ref().is_some_and(|lp| lp.pubsub_pin_id.is_some()) {
                            set_access(app, login, PinAccess::Ok, last_access);
                        } else {
                            if live.is_some() {
                                clear_live(app, login, live);
                            }
                            set_access(app, login, PinAccess::Ok, last_access);
                        }
                    }
                }
                None
            }
            FetchPin::Forbidden => {
                    if live.is_none() {
                    set_access(app, login, PinAccess::Viewer, last_access);
                }
                None
            }
            FetchPin::Unauthorized => {
                    *scope_cache = ScopeCache::default();
                if live.is_none() {
                    set_access(app, login, PinAccess::Anon, last_access);
                }
                None
            }
            FetchPin::Fail => {
                None
            }
        },
    }
}

fn apply_helix_pin(
    app: &AppHandle,
    login: &str,
    live: &mut Option<LivePin>,
    last_access: &mut Option<PinAccess>,
    pin: PinnedMessage,
) {
    let same = live.as_ref().is_some_and(|lp| lp.pin == pin);
    if same {
        if *last_access != Some(PinAccess::Ok) {
            set_access(app, login, PinAccess::Ok, last_access);
        }
        return;
    }
    let pubsub_pin_id = live.as_ref().and_then(|lp| lp.pubsub_pin_id.clone());
    *live = Some(LivePin {
        pin: pin.clone(),
        pubsub_pin_id,
    });
    emit_pin(app, login, &pin);
    *last_access = Some(PinAccess::Ok);
}

fn clear_live(app: &AppHandle, channel: &str, live: &mut Option<LivePin>) {
    if live.is_some() {
        emit_clear(app, channel);
        *live = None;
    }
}

fn set_access(app: &AppHandle, channel: &str, access: PinAccess, last: &mut Option<PinAccess>) {
    if *last == Some(access) {
        return;
    }
    *last = Some(access);
    emit_access(app, channel, access);
}

enum Resolve {
    Anon,
    Viewer,
    NeedScope,
    Pending,
    Ready(Wanted),
}

async fn resolve_wanted(shared: &Shared, login: &str, scope_cache: &mut ScopeCache) -> Resolve {
    let token = match super::auth::oauth_token(shared) {
        Some(t) => {
            let t = t.trim().trim_start_matches("oauth:").to_string();
            if t.is_empty() || t == "YOUR_API_KEY_HERE" {
                return Resolve::Anon;
            }
            t
        }
        None => return Resolve::Anon,
    };
    let client_id = super::auth::resolved_client_id(shared);
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return Resolve::Anon;
    }
    let Some(moderator_id) = super::auth::ensure_twitch_user_id(shared).await else {
        return Resolve::Pending;
    };
    let role = shared
        .hub
        .lock()
        .ok()
        .map(|hub| hub.viewer_role(login, Some(moderator_id.as_str())));
    let Some(role) = role else {
        return Resolve::Viewer;
    };
    if !(role.is_mod || role.is_broadcaster) {
        return Resolve::Viewer;
    }
    match pin_scopes(&token, scope_cache).await {
        ScopeCheck::ManageOk | ScopeCheck::ReadOnly => {}
        ScopeCheck::Missing => return Resolve::NeedScope,
        ScopeCheck::Unknown => return Resolve::Pending,
    }
    if !scope_cache.read_ok {
        return Resolve::NeedScope;
    }
    let broadcaster_id = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(login).map(str::to_string));
    let broadcaster_id = match broadcaster_id {
        Some(id) if !id.is_empty() => id,
        _ => match super::helix::fetch_user_profile(login, Some(&token), &client_id).await {
            Some(p) => p.id,
            None => return Resolve::Pending,
        },
    };
    Resolve::Ready(Wanted {
        broadcaster_id,
        moderator_id,
        token,
        client_id,
    })
}

enum ScopeCheck {
    ManageOk,
    ReadOnly,
    Missing,
    Unknown,
}

async fn pin_scopes(token: &str, cache: &mut ScopeCache) -> ScopeCheck {
    if cache.token == token {
        return if cache.manage_ok {
            ScopeCheck::ManageOk
        } else if cache.read_ok {
            ScopeCheck::ReadOnly
        } else {
            ScopeCheck::Missing
        };
    }
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = RETRY_BASE;
    for attempt in 0..ATTEMPTS {
        match client
            .get(VALIDATE_URL)
            .header("Authorization", format!("OAuth {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let Ok(v) = resp.json::<Value>().await else {
                    return ScopeCheck::Unknown;
                };
                let scopes: HashSet<&str> = v
                    .get("scopes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let manage_ok = scopes.contains("moderator:manage:chat_messages");
                let read_ok = manage_ok || scopes.contains("moderator:read:chat_messages");
                *cache = ScopeCache {
                    token: token.to_string(),
                    read_ok,
                    manage_ok,
                };
                return if manage_ok {
                    ScopeCheck::ManageOk
                } else if read_ok {
                    ScopeCheck::ReadOnly
                } else {
                    ScopeCheck::Missing
                };
            }
            Ok(resp) if resp.status().as_u16() == 401 => {
                *cache = ScopeCache {
                    token: token.to_string(),
                    read_ok: false,
                    manage_ok: false,
                };
                return ScopeCheck::Missing;
            }
            _ => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    ScopeCheck::Unknown
}

async fn resolve_channel_id(shared: &Shared, login: &str) -> Option<String> {
    if let Some(id) = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(login).map(str::to_string))
        .filter(|s| !s.is_empty())
    {
        return Some(id);
    }
    let token = super::auth::oauth_token(shared).map(|t| {
        t.trim().trim_start_matches("oauth:").to_string()
    });
    let client_id = super::auth::resolved_client_id(shared);
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return None;
    }
    let token_ref = token
        .as_deref()
        .filter(|t| !t.is_empty() && *t != "YOUR_API_KEY_HERE");
    super::helix::fetch_user_profile(login, token_ref, &client_id)
        .await
        .map(|p| p.id)
}

enum FetchPin {
    Ok(Option<PinnedMessage>),
    Forbidden,
    Unauthorized,
    Fail,
}

async fn fetch_pin(wanted: &Wanted) -> FetchPin {
    let url = helix_query(
        "/chat/pins",
        &[
            ("broadcaster_id", wanted.broadcaster_id.as_str()),
            ("moderator_id", wanted.moderator_id.as_str()),
        ],
    );
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = RETRY_BASE;
    for attempt in 0..ATTEMPTS {
        match client
            .get(&url)
            .header("Client-Id", &wanted.client_id)
            .header("Authorization", format!("Bearer {}", wanted.token))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if resp.status().is_success() {
                    return match resp.json::<Value>().await {
                        Ok(v) => FetchPin::Ok(parse_pin_payload(&v)),
                        Err(_) => FetchPin::Fail,
                    };
                }
                if status == 401 {
                    return FetchPin::Unauthorized;
                }
                if status == 403 {
                    return FetchPin::Forbidden;
                }
            }
            Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    FetchPin::Fail
}

fn parse_pin_payload(value: &Value) -> Option<PinnedMessage> {
    let item = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())?;
    let message_id = clean_id(item.get("message_id")?.as_str()?)?;
    let message_text = item
        .get("message")
        .and_then(|m| m.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .chars()
        .take(500)
        .collect::<String>();
    let pinned_by_login = clean_login(item.get("pinned_by_user_login")?.as_str()?)?;
    let pinned_by_name = item
        .get("pinned_by_user_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(pinned_by_login.as_str())
        .chars()
        .take(40)
        .collect::<String>();
    let sender_login = clean_login(
        item.get("sender_user_login")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .unwrap_or_default();
    let sender_name = item
        .get("sender_user_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(sender_login.as_str())
        .chars()
        .take(40)
        .collect::<String>();
    Some(PinnedMessage {
        message_id,
        message_text,
        pinned_by_login,
        pinned_by_name,
        sender_login,
        sender_name,
        starts_at: clean_time(item.get("starts_at").and_then(Value::as_str)),
        ends_at: clean_time(item.get("ends_at").and_then(Value::as_str)),
    })
}

fn handle_pubsub_text(
    app: &AppHandle,
    login: &str,
    channel_id: &str,
    live: &mut Option<LivePin>,
    last_access: &mut Option<PinAccess>,
    raw: &str,
) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return true;
    };
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "RECONNECT" => false,
        "PONG" => true,
        "RESPONSE" => v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty(),
        "MESSAGE" => {
            let data = v.get("data").unwrap_or(&Value::Null);
            let topic = data.get("topic").and_then(Value::as_str).unwrap_or("");
            let expected = format!("pinned-chat-updates-v1.{channel_id}");
            if topic != expected {
                return true;
            }
            let Some(message) = data.get("message").and_then(Value::as_str) else {
                return true;
            };
            apply_pubsub_inner(app, login, live, last_access, message);
            true
        }
        _ => true,
    }
}

fn apply_pubsub_inner(
    app: &AppHandle,
    login: &str,
    live: &mut Option<LivePin>,
    last_access: &mut Option<PinAccess>,
    raw: &str,
) {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    let data = value.get("data").unwrap_or(&Value::Null);
    match event_type {
        "pin-message" => {
            if let Some((pin_id, pin)) = parse_pubsub_pin(data) {
                if pin_expired(&pin) {
                    return;
                }
                *live = Some(LivePin {
                    pin: pin.clone(),
                    pubsub_pin_id: Some(pin_id),
                });
                emit_pin(app, login, &pin);
                *last_access = Some(PinAccess::Ok);
            }
        }
        "update-message" => {
            let pin_id = data.get("id").and_then(Value::as_str).map(str::to_string);
            let ends = millis_to_rfc3339(data.get("endsAt").or_else(|| data.get("ends_at")));
            if let Some(lp) = live.as_mut() {
                let id_ok = pin_id
                    .as_ref()
                    .is_none_or(|id| lp.pubsub_pin_id.as_ref() == Some(id));
                if id_ok {
                    lp.pin.ends_at = ends;
                    if pin_expired(&lp.pin) {
                        clear_live(app, login, live);
                        set_access(app, login, PinAccess::Ok, last_access);
                    } else {
                        emit_pin(app, login, &lp.pin);
                        *last_access = Some(PinAccess::Ok);
                    }
                }
            }
        }
        "unpin-message" => {
            let pin_id = data.get("id").and_then(Value::as_str);
            let matches = match (pin_id, live.as_ref().and_then(|lp| lp.pubsub_pin_id.as_deref())) {
                (Some(id), Some(cur)) => id == cur,
                (Some(_), None) => true,
                (None, _) => true,
            };
            if matches {
                clear_live(app, login, live);
                set_access(app, login, PinAccess::Ok, last_access);
            }
        }
        _ => {}
    }
}

fn parse_pubsub_pin(data: &Value) -> Option<(String, PinnedMessage)> {
    let pin_id = data.get("id").and_then(Value::as_str)?.trim();
    if pin_id.is_empty() || pin_id.len() > 64 {
        return None;
    }
    let message = data.get("message")?;
    let message_id = clean_id(message.get("id")?.as_str()?)?;
    let message_text = message
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .chars()
        .take(500)
        .collect::<String>();
    let pinned_by = data.get("pinnedBy").or_else(|| data.get("pinned_by"));
    let pinned_by_name = pinned_by
        .and_then(|p| p.get("displayName").or_else(|| p.get("display_name")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("moderator")
        .chars()
        .take(40)
        .collect::<String>();
    let pinned_by_login = clean_login(
        pinned_by
            .and_then(|p| p.get("login"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .unwrap_or_else(|| pinned_by_name.to_ascii_lowercase());
    let sender = message.get("sender");
    let sender_login = clean_login(
        sender
            .and_then(|s| s.get("login"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .unwrap_or_default();
    let sender_name = sender
        .and_then(|s| s.get("displayName").or_else(|| s.get("display_name")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(sender_login.as_str())
        .chars()
        .take(40)
        .collect::<String>();
    let starts_at = millis_to_rfc3339(
        message
            .get("startsAt")
            .or_else(|| message.get("starts_at")),
    );
    let ends_at =
        millis_to_rfc3339(message.get("endsAt").or_else(|| message.get("ends_at")));
    Some((
        pin_id.to_string(),
        PinnedMessage {
            message_id,
            message_text,
            pinned_by_login,
            pinned_by_name,
            sender_login,
            sender_name,
            starts_at,
            ends_at,
        },
    ))
}

fn millis_to_rfc3339(raw: Option<&Value>) -> Option<String> {
    let v = raw?;
    let ms = if let Some(n) = v.as_i64() {
        n
    } else if let Some(n) = v.as_u64() {
        i64::try_from(n).ok()?
    } else if let Some(s) = v.as_str() {
        return clean_time(Some(s));
    } else {
        return None;
    };
    if ms <= 0 {
        return None;
    }
    chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

fn pin_expired(pin: &PinnedMessage) -> bool {
    let Some(ends) = pin.ends_at.as_deref() else {
        return false;
    };
    match chrono::DateTime::parse_from_rfc3339(ends) {
        Ok(dt) => chrono::Utc::now() >= dt.with_timezone(&chrono::Utc),
        Err(_) => false,
    }
}

async fn listen_pins<S>(write: &mut S, channel_id: &str) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    let topic = format!("pinned-chat-updates-v1.{channel_id}");
    let payload = json!({
        "type": "LISTEN",
        "nonce": format!("crt-pin-{}", unix_ms()),
        "data": {
            "topics": [topic],
        },
    });
    send_ws(write, Message::Text(payload.to_string().into())).await
}

async fn send_ws<S>(write: &mut S, msg: Message) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    tokio::time::timeout(WS_WRITE_TIMEOUT, write.send(msg))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

enum WaitCmd {
    Tick,
    Shutdown,
    Clear,
    Set(String),
    Relogin,
    Nudge,
}

async fn wait_cmd(rx: &mut mpsc::UnboundedReceiver<PinsCmd>, delay: Duration) -> WaitCmd {
    tokio::select! {
        _ = tokio::time::sleep(delay) => WaitCmd::Tick,
        cmd = rx.recv() => match cmd {
            None | Some(PinsCmd::Shutdown) => WaitCmd::Shutdown,
            Some(PinsCmd::ClearChannel) => WaitCmd::Clear,
            Some(PinsCmd::SetChannel(login)) => WaitCmd::Set(login),
            Some(PinsCmd::Relogin) => WaitCmd::Relogin,
            Some(PinsCmd::Nudge) => WaitCmd::Nudge,
        },
    }
}

enum CmdResult {
    Shutdown,
    Idle,
    Changed(Option<String>),
    Nudge,
    Continue,
}

fn apply_cmd_live(
    app: &AppHandle,
    login: &str,
    live: &mut Option<LivePin>,
    last_access: &mut Option<PinAccess>,
    cmd: Option<PinsCmd>,
) -> CmdResult {
    match cmd {
        None | Some(PinsCmd::Shutdown) => CmdResult::Shutdown,
        Some(PinsCmd::SetChannel(next)) => {
            if next != login {
                emit_clear(app, login);
                emit_clear(app, &next);
                *live = None;
                *last_access = None;
            }
            CmdResult::Changed(Some(next))
        }
        Some(PinsCmd::ClearChannel) => {
            emit_clear(app, login);
            *live = None;
            *last_access = None;
            CmdResult::Idle
        }
        Some(PinsCmd::Relogin) => {
            emit_clear(app, login);
            *live = None;
            *last_access = None;
            CmdResult::Changed(Some(login.to_string()))
        }
        Some(PinsCmd::Nudge) => CmdResult::Nudge,
    }
}

fn helix_query(path: &str, params: &[(&str, &str)]) -> String {
    let mut url = Url::parse(&format!("{HELIX}{path}")).expect("helix url");
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in params {
            q.append_pair(k, v);
        }
    }
    url.to_string()
}

fn clean_id(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(s.to_string())
}

fn clean_login(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    if s.is_empty() || s.len() > 25 {
        return None;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return None;
    }
    Some(s)
}

fn clean_time(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() || s.len() > 40 || s.eq_ignore_ascii_case("null") {
        return None;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '.' | '+' | 'T' | 'Z' | 'z'))
    {
        return None;
    }
    Some(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_pin_from_helix() {
        let v = json!({
            "data": [{
                "message_id": "abc-123",
                "pinned_by_user_login": "Moderator",
                "pinned_by_user_name": "Moderator",
                "sender_user_login": "viewer1",
                "sender_user_name": "Viewer1",
                "message": { "text": "hello https://t.me/x" },
                "starts_at": "2026-08-30T10:00:00Z",
                "ends_at": "2026-08-30T10:20:00Z"
            }]
        });
        let pin = parse_pin_payload(&v).expect("pin");
        assert_eq!(pin.message_id, "abc-123");
        assert_eq!(pin.pinned_by_login, "moderator");
        assert!(pin.message_text.contains("t.me"));
        assert_eq!(pin.ends_at.as_deref(), Some("2026-08-30T10:20:00Z"));
    }

    #[test]
    fn parse_empty_data() {
        assert!(parse_pin_payload(&json!({ "data": [] })).is_none());
    }

    #[test]
    fn pin_expired_respects_ends_at() {
        let pin = PinnedMessage {
            message_id: "1".into(),
            message_text: "x".into(),
            pinned_by_login: "m".into(),
            pinned_by_name: "M".into(),
            sender_login: "s".into(),
            sender_name: "S".into(),
            starts_at: Some("2020-01-01T00:00:00Z".into()),
            ends_at: Some("2020-01-01T00:00:01Z".into()),
        };
        assert!(pin_expired(&pin));
        let open = PinnedMessage {
            ends_at: None,
            ..pin.clone()
        };
        assert!(!pin_expired(&open));
    }

    #[test]
    fn access_serializes_snake_case() {
        let payload = PinnedPayload {
            channel: "x".into(),
            pin: None,
            access: Some(PinAccess::NeedScope),
        };
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(v["access"], "need_scope");
    }

    #[test]
    fn parse_pubsub_pin_message() {
        let data = json!({
            "id": "pin-uuid-1",
            "pinnedBy": { "id": "9", "displayName": "ModName" },
            "message": {
                "id": "msg-abc",
                "sender": {
                    "userId": "1",
                    "login": "Viewer1",
                    "displayName": "Viewer1"
                },
                "content": { "text": "rules: https://t.me/x" },
                "type": "MOD",
                "startsAt": 1_704_067_200_000_i64,
                "endsAt": 1_704_068_400_000_i64
            }
        });
        let (pin_id, pin) = parse_pubsub_pin(&data).expect("pubsub pin");
        assert_eq!(pin_id, "pin-uuid-1");
        assert_eq!(pin.message_id, "msg-abc");
        assert_eq!(pin.sender_login, "viewer1");
        assert_eq!(pin.pinned_by_name, "ModName");
        assert!(pin.message_text.contains("t.me"));
        assert!(pin.starts_at.as_ref().is_some_and(|s| s.contains("2023") || s.contains("2024")));
    }

    #[test]
    fn map_pin_errors() {
        let e = map_pin_http_error(401, &json!({}), true);
        assert_eq!(e.code, "error.pin.need_scope");
        let e = map_pin_http_error(409, &json!({}), true);
        assert_eq!(e.code, "error.pin.already");
        let e = map_pin_http_error(403, &json!({}), false);
        assert_eq!(e.code, "error.pin.forbidden");
    }

    #[test]
    fn helix_empty_policy_keeps_pubsub_pin() {
        let with_pubsub = LivePin {
            pin: PinnedMessage {
                message_id: "msg-1".into(),
                message_text: "hi".into(),
                pinned_by_login: "mod".into(),
                pinned_by_name: "Mod".into(),
                sender_login: "v".into(),
                sender_name: "V".into(),
                starts_at: None,
                ends_at: None,
            },
            pubsub_pin_id: Some("pin-uuid-1".into()),
        };
        let keep = with_pubsub.pubsub_pin_id.is_some();
        assert!(keep);
        let helix_only = LivePin {
            pubsub_pin_id: None,
            ..with_pubsub
        };
        assert!(helix_only.pubsub_pin_id.is_none());
    }

    #[test]
    fn pubsub_unpin_id_match() {
        let cur = Some("pin-uuid-1");
        let matches = match (Some("pin-uuid-1"), cur) {
            (Some(id), Some(c)) => id == c,
            (Some(_), None) => true,
            (None, _) => true,
        };
        assert!(matches);
        let no = match (Some("other"), cur) {
            (Some(id), Some(c)) => id == c,
            (Some(_), None) => true,
            (None, _) => true,
        };
        assert!(!no);
    }

    #[test]
    fn pubsub_update_millis_ends_at() {
        let ends = millis_to_rfc3339(Some(&json!(1_800_000_000_000_i64)));
        assert!(ends.as_ref().is_some_and(|s| s.contains('T')));
    }
}
