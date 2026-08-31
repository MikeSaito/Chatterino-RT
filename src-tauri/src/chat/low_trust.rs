//! Twitch Low Trust / Suspicious Users (Chatterino EventSub + Helix reimpl).
//!
//! - EventSub `channel.suspicious_user.message` (restricted only) → header + body rows
//! - EventSub `channel.suspicious_user.update` → system notice
//! - Helix POST/DELETE `/moderation/suspicious_users` for `/monitor` `/restrict` / un-*
//! - `/lowtrust [channel]` opens Twitch moderator Low Trust popout

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use super::commands::ApiError;
use super::state::{BatchSend, Shared};
use super::types::{ChatEvent, ChatPipe, ChatSendWait};

const HELIX: &str = "https://api.twitch.tv/helix";
const EVENTSUB_WS: &str = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
const ATTEMPTS: u32 = 3;
const RETRY_BASE: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(30);
const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_WS_FRAME: usize = 64 * 1024;
/// EventSub keepalive_timeout_seconds=30 plus grace before forced reconnect.
const KEEPALIVE_STALE: Duration = Duration::from_secs(45);

const SUB_TYPES: &[&str] = &[
    "channel.suspicious_user.message",
    "channel.suspicious_user.update",
];

const READ_SCOPE: &str = "moderator:read:suspicious_users";
const MANAGE_SCOPE: &str = "moderator:manage:suspicious_users";

static EVENT_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub enum LowTrustCmd {
    SetChannel(String),
    ClearChannel,
    Relogin,
    Shutdown,
}

#[derive(Debug, Clone)]
struct Wanted {
    login: String,
    broadcaster_id: String,
    moderator_id: String,
    token: String,
    client_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LowTrustStatus {
    None,
    Monitored,
    Restricted,
}

impl LowTrustStatus {
    fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "restricted" => Self::Restricted,
            "active_monitoring" | "monitored" => Self::Monitored,
            _ => Self::None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Restricted => "restricted",
            Self::Monitored => "monitored",
            Self::None => "none",
        }
    }

    fn helix_treat(self) -> Option<&'static str> {
        match self {
            Self::Restricted => Some("RESTRICTED"),
            Self::Monitored => Some("ACTIVE_MONITORING"),
            Self::None => None,
        }
    }
}

pub fn start(app: AppHandle, shared: Shared) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<LowTrustCmd>();
    {
        let mut slot = shared.low_trust_tx.lock().map_err(|e| e.to_string())?;
        *slot = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_loop(app, shared, rx).await;
    });
    Ok(())
}

async fn run_loop(app: AppHandle, shared: Shared, mut rx: mpsc::UnboundedReceiver<LowTrustCmd>) {
    let mut active: Option<String> = None;
    let mut backoff = Duration::from_secs(1);
    let mut ws_url = EVENTSUB_WS.to_string();
    loop {
        if shared.low_trust_shutdown.load(Ordering::SeqCst) {
            break;
        }
        let Some(login) = active.clone() else {
            match rx.recv().await {
                None | Some(LowTrustCmd::Shutdown) => break,
                Some(LowTrustCmd::SetChannel(login)) => {
                    active = Some(login);
                    ws_url = EVENTSUB_WS.to_string();
                    backoff = Duration::from_secs(1);
                }
                Some(LowTrustCmd::ClearChannel) | Some(LowTrustCmd::Relogin) => {}
            }
            continue;
        };
        let Some(wanted) = resolve_wanted(&shared, &login).await else {
            match wait_for_change(&mut rx, &mut active, Duration::from_secs(15)).await {
                WaitEnd::Shutdown => break,
                WaitEnd::Changed => {
                    backoff = Duration::from_secs(1);
                    ws_url = EVENTSUB_WS.to_string();
                }
                WaitEnd::Tick => continue,
            }
            continue;
        };
        let end = connect_eventsub(&app, &shared, wanted, &mut rx, &mut active, &ws_url).await;
        match end {
            SessionEnd::Shutdown => break,
            SessionEnd::Changed => {
                backoff = Duration::from_secs(1);
                ws_url = EVENTSUB_WS.to_string();
            }
            SessionEnd::AuthDenied => {
                ws_url = EVENTSUB_WS.to_string();
                match wait_until_change(&mut rx, &mut active).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => backoff = Duration::from_secs(1),
                    WaitEnd::Tick => {}
                }
            }
            SessionEnd::ReconnectTo(url) => {
                ws_url = url;
                backoff = Duration::from_secs(1);
            }
            SessionEnd::Reconnect => {
                ws_url = EVENTSUB_WS.to_string();
                let wait = backoff.min(RECONNECT_MAX);
                match wait_for_change(&mut rx, &mut active, wait).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => backoff = Duration::from_secs(1),
                    WaitEnd::Tick => {
                        backoff = (backoff * 2).min(RECONNECT_MAX);
                    }
                }
            }
        }
    }
}

async fn resolve_wanted(shared: &Shared, login: &str) -> Option<Wanted> {
    let token = super::auth::oauth_token(shared)?;
    let token = token.trim().trim_start_matches("oauth:").to_string();
    if token.is_empty() || token == "YOUR_API_KEY_HERE" {
        return None;
    }
    let client_id = super::auth::resolved_client_id(shared);
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return None;
    }
    let moderator_id = super::auth::ensure_twitch_user_id(shared).await?;
    if !scopes_ok(&token).await {
        return None;
    }
    let role = shared
        .hub
        .lock()
        .ok()
        .map(|hub| hub.viewer_role(login, Some(moderator_id.as_str())))?;
    if !role.is_mod && !role.is_broadcaster {
        return None;
    }
    let broadcaster_id = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(login).map(str::to_string))?;
    if broadcaster_id.is_empty() || !broadcaster_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(Wanted {
        login: login.to_string(),
        broadcaster_id,
        moderator_id,
        token,
        client_id,
    })
}

async fn scopes_ok(token: &str) -> bool {
    let client = super::http_client::build(Duration::from_secs(8));
    let Ok(resp) = client
        .get(VALIDATE_URL)
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await
    else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let Ok(v) = resp.json::<Value>().await else {
        return false;
    };
    let scopes: HashSet<&str> = v
        .get("scopes")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect::<HashSet<_>>())
        .unwrap_or_default();
    scopes.contains(READ_SCOPE) || scopes.contains(MANAGE_SCOPE)
}

enum WaitEnd {
    Shutdown,
    Changed,
    Tick,
}

enum SessionEnd {
    Shutdown,
    Changed,
    AuthDenied,
    Reconnect,
    ReconnectTo(String),
}

async fn wait_for_change(
    rx: &mut mpsc::UnboundedReceiver<LowTrustCmd>,
    active: &mut Option<String>,
    wait: Duration,
) -> WaitEnd {
    tokio::select! {
        cmd = rx.recv() => apply_cmd(active, cmd),
        _ = tokio::time::sleep(wait) => WaitEnd::Tick,
    }
}

async fn wait_until_change(
    rx: &mut mpsc::UnboundedReceiver<LowTrustCmd>,
    active: &mut Option<String>,
) -> WaitEnd {
    apply_cmd(active, rx.recv().await)
}

fn apply_cmd(active: &mut Option<String>, cmd: Option<LowTrustCmd>) -> WaitEnd {
    match cmd {
        None | Some(LowTrustCmd::Shutdown) => WaitEnd::Shutdown,
        Some(LowTrustCmd::SetChannel(login)) => {
            *active = Some(login);
            WaitEnd::Changed
        }
        Some(LowTrustCmd::ClearChannel) => {
            *active = None;
            WaitEnd::Changed
        }
        Some(LowTrustCmd::Relogin) => WaitEnd::Changed,
    }
}

async fn connect_eventsub(
    app: &AppHandle,
    shared: &Shared,
    wanted: Wanted,
    rx: &mut mpsc::UnboundedReceiver<LowTrustCmd>,
    active: &mut Option<String>,
    ws_url: &str,
) -> SessionEnd {
    let Ok(parsed) = Url::parse(ws_url) else {
        return SessionEnd::Reconnect;
    };
    if parsed.scheme() != "wss" || parsed.host_str() != Some("eventsub.wss.twitch.tv") {
        return SessionEnd::Reconnect;
    }
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_FRAME))
        .read_buffer_size(32 * 1024);
    let Ok(Ok((ws, _))) = tokio::time::timeout(
        Duration::from_secs(12),
        tokio_tungstenite::connect_async_with_config(ws_url, Some(cfg), false),
    )
    .await
    else {
        return SessionEnd::Reconnect;
    };
    let (mut write, mut read) = ws.split();
    let mut session_ready = false;
    let mut last_server_msg = std::time::Instant::now();
    loop {
        tokio::select! {
            cmd = rx.recv() => {
                match apply_cmd(active, cmd) {
                    WaitEnd::Shutdown => return SessionEnd::Shutdown,
                    WaitEnd::Changed => return SessionEnd::Changed,
                    WaitEnd::Tick => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if last_server_msg.elapsed() >= KEEPALIVE_STALE {
                    return SessionEnd::Reconnect;
                }
            }
            msg = read.next() => {
                let Some(msg) = msg else {
                    return SessionEnd::Reconnect;
                };
                let Ok(msg) = msg else {
                    return SessionEnd::Reconnect;
                };
                last_server_msg = std::time::Instant::now();
                match msg {
                    Message::Text(text) => {
                        match handle_eventsub_text(app, shared, &wanted, text.as_str(), &mut session_ready).await {
                            EventAction::None => {}
                            EventAction::Reconnect => return SessionEnd::Reconnect,
                            EventAction::ReconnectTo(u) => return SessionEnd::ReconnectTo(u),
                            EventAction::AuthDenied => return SessionEnd::AuthDenied,
                            EventAction::Subscribed => {}
                        }
                    }
                    Message::Ping(p) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Message::Close(_) => return SessionEnd::Reconnect,
                    _ => {}
                }
            }
        }
    }
}

enum EventAction {
    None,
    Reconnect,
    ReconnectTo(String),
    AuthDenied,
    Subscribed,
}

async fn handle_eventsub_text(
    app: &AppHandle,
    shared: &Shared,
    wanted: &Wanted,
    text: &str,
    session_ready: &mut bool,
) -> EventAction {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return EventAction::None;
    };
    let msg_type = value
        .pointer("/metadata/message_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    match msg_type {
        "session_welcome" => {
            let Some(session_id) = value.pointer("/payload/session/id").and_then(Value::as_str)
            else {
                return EventAction::Reconnect;
            };
            match create_subscriptions(wanted, session_id).await {
                SubResult::Ok => {
                    *session_ready = true;
                    EventAction::Subscribed
                }
                SubResult::AuthDenied => EventAction::AuthDenied,
                SubResult::Retry => EventAction::Reconnect,
            }
        }
        "session_keepalive" => EventAction::None,
        "session_reconnect" => {
            let url = value
                .pointer("/payload/session/reconnect_url")
                .and_then(Value::as_str)
                .and_then(clean_reconnect_url);
            match url {
                Some(url) => EventAction::ReconnectTo(url),
                None => EventAction::Reconnect,
            }
        }
        "notification" if *session_ready => {
            let sub_type = value
                .pointer("/payload/subscription/type")
                .and_then(Value::as_str)
                .unwrap_or("");
            let event = value.pointer("/payload/event").unwrap_or(&Value::Null);
            let ts = value
                .pointer("/metadata/message_timestamp")
                .and_then(Value::as_str)
                .map(parse_iso_ms)
                .unwrap_or_else(unix_ms);
            match sub_type {
                "channel.suspicious_user.message" => {
                    handle_suspicious_message(app, shared, wanted, event, ts);
                }
                "channel.suspicious_user.update" => {
                    handle_suspicious_update(app, shared, wanted, event, ts);
                }
                _ => {}
            }
            EventAction::None
        }
        "revocation" => EventAction::Reconnect,
        _ => EventAction::None,
    }
}

enum SubResult {
    Ok,
    AuthDenied,
    Retry,
}

enum SubAttempt {
    Ok,
    AuthDenied,
    Retry,
}

async fn create_subscriptions(wanted: &Wanted, session_id: &str) -> SubResult {
    let mut ok = 0u32;
    let mut denied = 0u32;
    for sub_type in SUB_TYPES {
        match post_eventsub_subscription(wanted, session_id, sub_type).await {
            SubAttempt::Ok => ok += 1,
            SubAttempt::AuthDenied => denied += 1,
            SubAttempt::Retry => {}
        }
    }
    if ok == SUB_TYPES.len() as u32 {
        SubResult::Ok
    } else if denied == SUB_TYPES.len() as u32 {
        SubResult::AuthDenied
    } else {
        SubResult::Retry
    }
}

async fn post_eventsub_subscription(
    wanted: &Wanted,
    session_id: &str,
    sub_type: &str,
) -> SubAttempt {
    let body = json!({
        "type": sub_type,
        "version": "1",
        "condition": {
            "broadcaster_user_id": wanted.broadcaster_id,
            "moderator_user_id": wanted.moderator_id,
        },
        "transport": { "method": "websocket", "session_id": session_id },
    });
    let client = super::http_client::build(Duration::from_secs(12));
    let url = format!("{HELIX}/eventsub/subscriptions");
    let mut delay = RETRY_BASE;
    for attempt in 0..ATTEMPTS {
        match client
            .post(&url)
            .header("Client-Id", &wanted.client_id)
            .header("Authorization", format!("Bearer {}", wanted.token))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 409 => {
                return SubAttempt::Ok;
            }
            Ok(resp) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
                return SubAttempt::AuthDenied;
            }
            Ok(_) | Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    SubAttempt::Retry
}

fn handle_suspicious_message(
    app: &AppHandle,
    shared: &Shared,
    wanted: &Wanted,
    event: &Value,
    timestamp_ms: u64,
) {
    // Stock: monitored chats arrive over IRC; only Restricted is shown from EventSub.
    let status = LowTrustStatus::parse(
        event
            .get("low_trust_status")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    if status != LowTrustStatus::Restricted {
        return;
    }
    let channel = event
        .get("broadcaster_user_login")
        .and_then(Value::as_str)
        .unwrap_or(wanted.login.as_str())
        .to_ascii_lowercase();
    if channel != wanted.login {
        return;
    }
    let login = event
        .get("user_login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let display_name = event
        .get("user_name")
        .and_then(Value::as_str)
        .unwrap_or(login.as_str())
        .to_string();
    let user_id = event
        .get("user_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let message = event.get("message").unwrap_or(&Value::Null);
    let message_id = message
        .get("message_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let text = message
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let detail = build_header_detail(status, event);
    let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let body_id = if message_id.is_empty() {
        format!("lt-b-{seq}")
    } else {
        message_id.clone()
    };
    let header = ChatEvent::LowTrustHeader {
        id: format!("lt-h-{body_id}-{seq}"),
        timestamp_ms,
        status: status.wire().to_string(),
        detail,
    };
    let (link_spans, mention_spans) = super::spans::decorate_text_spans(&text, &[]);
    let body = ChatEvent::LowTrustMessage {
        id: body_id,
        timestamp_ms,
        message_id: if message_id.is_empty() {
            format!("lt-msg-{seq}")
        } else {
            message_id
        },
        user_id,
        login,
        display_name,
        text,
        status: status.wire().to_string(),
        channel_login: channel.clone(),
        link_spans,
        mention_spans,
    };
    ingest_event(app, shared, &channel, header);
    ingest_event(app, shared, &channel, body);
}

fn handle_suspicious_update(
    app: &AppHandle,
    shared: &Shared,
    wanted: &Wanted,
    event: &Value,
    timestamp_ms: u64,
) {
    let channel = event
        .get("broadcaster_user_login")
        .and_then(Value::as_str)
        .unwrap_or(wanted.login.as_str())
        .to_ascii_lowercase();
    if channel != wanted.login {
        return;
    }
    let mod_name = event
        .get("moderator_user_name")
        .and_then(Value::as_str)
        .or_else(|| event.get("moderator_user_login").and_then(Value::as_str))
        .unwrap_or("moderator");
    let user_name = event
        .get("user_name")
        .and_then(Value::as_str)
        .or_else(|| event.get("user_login").and_then(Value::as_str))
        .unwrap_or("user");
    let status = LowTrustStatus::parse(
        event
            .get("low_trust_status")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let text = match status {
        LowTrustStatus::None => {
            format!("{mod_name} removed {user_name} from the suspicious user list.")
        }
        LowTrustStatus::Monitored => {
            format!("{mod_name} added {user_name} as a monitored suspicious chatter.")
        }
        LowTrustStatus::Restricted => {
            format!("{mod_name} added {user_name} as a restricted suspicious chatter.")
        }
    };
    let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    ingest_event(
        app,
        shared,
        &channel,
        ChatEvent::Notice {
            id: format!("lt-u-{seq}"),
            timestamp_ms,
            text,
            msg_id: Some("suspicious_user_update".into()),
            timeout_remaining_sec: None,
        },
    );
}

fn build_header_detail(status: LowTrustStatus, event: &Value) -> String {
    let mut detail = match status {
        LowTrustStatus::Restricted => "Restricted".to_string(),
        LowTrustStatus::Monitored => "Monitored".to_string(),
        LowTrustStatus::None => "None".to_string(),
    };
    let types: Vec<&str> = event
        .get("types")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let has_ban_evader = types.iter().any(|t| {
        matches!(
            t.to_ascii_lowercase().as_str(),
            "ban_evader" | "banevaderdetector"
        )
    });
    if has_ban_evader {
        let eval = event
            .get("ban_evasion_evaluation")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let label = if eval == "likely" {
            "likely"
        } else {
            "possible"
        };
        detail.push_str(&format!(". Detected as {label} ban evader"));
    }
    let has_shared = types.iter().any(|t| {
        matches!(
            t.to_ascii_lowercase().as_str(),
            "shared_channel_ban" | "sharedchannelban"
        )
    });
    if has_shared {
        let n = event
            .get("shared_ban_channel_ids")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        detail.push_str(&format!(". Banned in {n} shared channels"));
    }
    detail
}

fn ingest_event(app: &AppHandle, shared: &Shared, channel: &str, event: ChatEvent) {
    let self_login = super::auth::resolved_login_token(shared).map(|(l, _)| l);
    let sim = super::similarity::cfg_from_shared(shared);
    let stack_style = super::timeout_stack::style_from_shared(shared);
    let stream_id = super::logging::resolve_stream_id(shared, channel);
    let mut logged = Vec::new();
    let batch = shared.hub.lock().ok().and_then(|mut hub| {
        hub.ingest_logged(
            channel,
            event,
            self_login.as_deref(),
            &sim,
            stack_style,
            |ev| logged.push(ev.clone()),
        )
    });
    for ev in &logged {
        super::logging::try_log(shared, channel, ev, &stream_id);
    }
    if let Some(batch) = batch {
        match shared.send_batch(&batch) {
            BatchSend::Delivered => {}
            BatchSend::EncodeError | BatchSend::NoSubscriber => {
                let n = u32::try_from(batch.events.len()).unwrap_or(u32::MAX).max(1);
                shared.note_undelivered(&batch.channel_id, n);
                let _ = app.emit(
                    "chat:pipe",
                    ChatPipe {
                        ok: false,
                        channel: Some(batch.channel_id.clone()),
                    },
                );
            }
        }
    }
    let updates = shared
        .hub
        .lock()
        .ok()
        .map(|mut hub| hub.poll_send_waits())
        .unwrap_or_default();
    for (channel_id, text) in updates {
        let _ = app.emit("chat:send-wait", ChatSendWait { channel_id, text });
    }
}

fn clean_reconnect_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "wss" || url.host_str() != Some("eventsub.wss.twitch.tv") {
        return None;
    }
    if url.port().is_some_and(|p| p != 443) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if url.fragment().is_some() {
        return None;
    }
    let path = url.path();
    if path != "/ws" && path != "/ws/" {
        return None;
    }
    Some(url.to_string())
}

fn parse_iso_ms(raw: &str) -> u64 {
    // Accept RFC3339-ish; fallback to now.
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return dt.timestamp_millis().max(0) as u64;
    }
    unix_ms()
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// --- Slash commands + Helix manage -------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LowTrustSlash {
    OpenFeed { channel: Option<String> },
    Monitor { login: String },
    Restrict { login: String },
    Unmonitor { login: String },
    Unrestrict { login: String },
    UsageMonitor,
    UsageRestrict,
    UsageUnmonitor,
    UsageUnrestrict,
    UsageLowtrust,
}

pub fn parse_low_trust_slash(text: &str) -> Option<LowTrustSlash> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let first = t.chars().next()?;
    if first != '/' && first != '.' {
        return None;
    }
    let rest = t[first.len_utf8()..].trim_start();
    let mut parts = rest.split_whitespace();
    let cmd = parts.next()?.to_ascii_lowercase();
    let arg = parts.next().map(|s| s.trim_start_matches(['#', '@']));
    match cmd.as_str() {
        "lowtrust" => {
            if parts.next().is_some() {
                return Some(LowTrustSlash::UsageLowtrust);
            }
            match arg {
                None => Some(LowTrustSlash::OpenFeed { channel: None }),
                Some(ch) if valid_login(ch) => Some(LowTrustSlash::OpenFeed {
                    channel: Some(ch.to_ascii_lowercase()),
                }),
                Some(_) => Some(LowTrustSlash::UsageLowtrust),
            }
        }
        "monitor" => match arg {
            Some(u) if valid_login(u) && parts.next().is_none() => Some(LowTrustSlash::Monitor {
                login: u.to_ascii_lowercase(),
            }),
            _ => Some(LowTrustSlash::UsageMonitor),
        },
        "restrict" => match arg {
            Some(u) if valid_login(u) && parts.next().is_none() => Some(LowTrustSlash::Restrict {
                login: u.to_ascii_lowercase(),
            }),
            _ => Some(LowTrustSlash::UsageRestrict),
        },
        "unmonitor" => match arg {
            Some(u) if valid_login(u) && parts.next().is_none() => Some(LowTrustSlash::Unmonitor {
                login: u.to_ascii_lowercase(),
            }),
            _ => Some(LowTrustSlash::UsageUnmonitor),
        },
        "unrestrict" => match arg {
            Some(u) if valid_login(u) && parts.next().is_none() => {
                Some(LowTrustSlash::Unrestrict {
                    login: u.to_ascii_lowercase(),
                })
            }
            _ => Some(LowTrustSlash::UsageUnrestrict),
        },
        _ => None,
    }
}

fn valid_login(raw: &str) -> bool {
    !raw.is_empty() && raw.len() <= 25 && raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub async fn handle_low_trust_slash(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    cmd: LowTrustSlash,
) -> Result<(), ApiError> {
    match cmd {
        LowTrustSlash::UsageLowtrust => {
            state.post_channel_notice(
                app,
                channel,
                "Usage: /lowtrust [channel]. You can also use the command without arguments in any Twitch channel to open its suspicious user activity feed. Only the broadcaster and moderators have permission to view this feed.".into(),
            );
            Ok(())
        }
        LowTrustSlash::UsageMonitor => {
            state.post_channel_notice(
                app,
                channel,
                r#"Usage: "/monitor <username>" - Mark a user as monitored."#.into(),
            );
            Ok(())
        }
        LowTrustSlash::UsageRestrict => {
            state.post_channel_notice(
                app,
                channel,
                r#"Usage: "/restrict <username>" - Mark a user as restricted."#.into(),
            );
            Ok(())
        }
        LowTrustSlash::UsageUnmonitor => {
            state.post_channel_notice(
                app,
                channel,
                r#"Usage: "/unmonitor <username>" - Remove a user from suspicious treatment."#
                    .into(),
            );
            Ok(())
        }
        LowTrustSlash::UsageUnrestrict => {
            state.post_channel_notice(
                app,
                channel,
                r#"Usage: "/unrestrict <username>" - Remove a user from suspicious treatment."#
                    .into(),
            );
            Ok(())
        }
        LowTrustSlash::OpenFeed { channel: target } => {
            let login = match target {
                Some(t) => t,
                None => {
                    if channel.is_empty() {
                        state.post_channel_notice(
                            app,
                            channel,
                            "Usage: /lowtrust [channel]. You can also use the command without arguments in any Twitch channel to open its suspicious user activity feed. Only the broadcaster and moderators have permission to view this feed.".into(),
                        );
                        return Ok(());
                    }
                    channel.to_ascii_lowercase()
                }
            };
            let url = format!("https://www.twitch.tv/popout/moderator/{login}/low-trust-users");
            let allowed = super::spans::allowed_chat_url(&url)
                .map_err(|message| ApiError::coded("error.url.invalid", message))?;
            tauri_plugin_opener::open_url(&allowed, None::<&str>)
                .map_err(|e| ApiError::internal(&e.to_string()))
        }
        LowTrustSlash::Monitor { login } => {
            treat_user(
                app,
                state,
                channel,
                &login,
                LowTrustStatus::Monitored,
                "monitor",
            )
            .await
        }
        LowTrustSlash::Restrict { login } => {
            treat_user(
                app,
                state,
                channel,
                &login,
                LowTrustStatus::Restricted,
                "restrict",
            )
            .await
        }
        LowTrustSlash::Unmonitor { login } => {
            untreating_user(app, state, channel, &login, "unmonitor").await
        }
        LowTrustSlash::Unrestrict { login } => {
            untreating_user(app, state, channel, &login, "unrestrict").await
        }
    }
}

async fn treat_user(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    target_login: &str,
    status: LowTrustStatus,
    command: &str,
) -> Result<(), ApiError> {
    let Some((_mod_login, token)) = super::auth::resolved_login_token(state) else {
        state.post_channel_notice(
            app,
            channel,
            format!("You must be logged in to {command} someone!"),
        );
        return Ok(());
    };
    let client_id = super::auth::resolved_client_id(state);
    let Some(moderator_id) = super::auth::ensure_twitch_user_id(state).await else {
        state.post_channel_notice(
            app,
            channel,
            format!("You must be logged in to {command} someone!"),
        );
        return Ok(());
    };
    let Some(room_id) = state
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(channel).map(str::to_string))
    else {
        state.post_channel_notice(
            app,
            channel,
            format!("The /{command} command only works in Twitch channels"),
        );
        return Ok(());
    };
    let Some(profile) =
        super::helix::fetch_user_profile(target_login, Some(&token), &client_id).await
    else {
        state.post_channel_notice(app, channel, format!("Failed to query user to {command}"));
        return Ok(());
    };
    let helix_status = status.helix_treat().unwrap_or("ACTIVE_MONITORING");
    match add_suspicious_user(
        &room_id,
        &moderator_id,
        &profile.id,
        helix_status,
        &token,
        &client_id,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(msg) => {
            state.post_channel_notice(app, channel, format!("Failed to {command} user - {msg}"));
            Err(ApiError::coded("error.lowtrust.manage", msg))
        }
    }
}

async fn untreating_user(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    target_login: &str,
    command: &str,
) -> Result<(), ApiError> {
    let Some((_mod_login, token)) = super::auth::resolved_login_token(state) else {
        state.post_channel_notice(
            app,
            channel,
            format!("You must be logged in to {command} someone!"),
        );
        return Ok(());
    };
    let client_id = super::auth::resolved_client_id(state);
    let Some(moderator_id) = super::auth::ensure_twitch_user_id(state).await else {
        state.post_channel_notice(
            app,
            channel,
            format!("You must be logged in to {command} someone!"),
        );
        return Ok(());
    };
    let Some(room_id) = state
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(channel).map(str::to_string))
    else {
        state.post_channel_notice(
            app,
            channel,
            format!("The /{command} command only works in Twitch channels"),
        );
        return Ok(());
    };
    let Some(profile) =
        super::helix::fetch_user_profile(target_login, Some(&token), &client_id).await
    else {
        state.post_channel_notice(app, channel, format!("Failed to query user to {command}"));
        return Ok(());
    };
    match remove_suspicious_user(&room_id, &moderator_id, &profile.id, &token, &client_id).await {
        Ok(()) => Ok(()),
        Err(msg) => {
            state.post_channel_notice(app, channel, format!("Failed to {command} user - {msg}"));
            Err(ApiError::coded("error.lowtrust.manage", msg))
        }
    }
}

async fn add_suspicious_user(
    broadcaster_id: &str,
    moderator_id: &str,
    user_id: &str,
    status: &str,
    token: &str,
    client_id: &str,
) -> Result<(), String> {
    let url = format!(
        "{HELIX}/moderation/suspicious_users?broadcaster_id={broadcaster_id}&moderator_id={moderator_id}"
    );
    let body = json!({ "user_id": user_id, "status": status });
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .post(&url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if resp.status().is_success() {
                    return Ok(());
                }
                let message = resp
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| format!("http {code}"));
                if (400..500).contains(&code) {
                    return Err(message);
                }
                last = message;
            }
            Err(e) => {
                last = super::http_client::format_reqwest_error_brief(&e);
            }
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(last)
}

async fn remove_suspicious_user(
    broadcaster_id: &str,
    moderator_id: &str,
    user_id: &str,
    token: &str,
    client_id: &str,
) -> Result<(), String> {
    let url = format!(
        "{HELIX}/moderation/suspicious_users?broadcaster_id={broadcaster_id}&moderator_id={moderator_id}&user_id={user_id}"
    );
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .delete(&url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if resp.status().is_success() {
                    return Ok(());
                }
                let message = resp
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| format!("http {code}"));
                if (400..500).contains(&code) {
                    return Err(message);
                }
                last = message;
            }
            Err(e) => {
                last = super::http_client::format_reqwest_error_brief(&e);
            }
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_variants() {
        assert_eq!(
            LowTrustStatus::parse("restricted"),
            LowTrustStatus::Restricted
        );
        assert_eq!(
            LowTrustStatus::parse("active_monitoring"),
            LowTrustStatus::Monitored
        );
        assert_eq!(LowTrustStatus::parse("none"), LowTrustStatus::None);
    }

    #[test]
    fn parse_slash_commands() {
        assert_eq!(
            parse_low_trust_slash("/monitor bob"),
            Some(LowTrustSlash::Monitor {
                login: "bob".into()
            })
        );
        assert_eq!(
            parse_low_trust_slash("/restrict @Alice"),
            Some(LowTrustSlash::Restrict {
                login: "alice".into()
            })
        );
        assert_eq!(
            parse_low_trust_slash("/lowtrust"),
            Some(LowTrustSlash::OpenFeed { channel: None })
        );
        assert_eq!(
            parse_low_trust_slash("/lowtrust xqc"),
            Some(LowTrustSlash::OpenFeed {
                channel: Some("xqc".into())
            })
        );
        assert_eq!(
            parse_low_trust_slash("/unmonitor"),
            Some(LowTrustSlash::UsageUnmonitor)
        );
        assert!(parse_low_trust_slash("/ban bob").is_none());
    }

    #[test]
    fn header_detail_ban_evader() {
        let event = json!({
            "types": ["ban_evader"],
            "ban_evasion_evaluation": "likely",
            "shared_ban_channel_ids": ["1", "2"],
        });
        let d = build_header_detail(LowTrustStatus::Restricted, &event);
        assert!(d.contains("Restricted"));
        assert!(d.contains("likely ban evader"));
    }

    #[test]
    fn reconnect_url_must_be_eventsub_wss() {
        assert!(clean_reconnect_url("wss://eventsub.wss.twitch.tv/ws?session_id=abc").is_some());
        assert!(clean_reconnect_url("https://eventsub.wss.twitch.tv/ws").is_none());
    }
}
