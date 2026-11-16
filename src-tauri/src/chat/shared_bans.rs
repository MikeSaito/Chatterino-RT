//! Shared chat ban / timeout awareness via EventSub `channel.moderate` v2.
//! MIT reimpl of Chatterino EventSub MessageHandlers shared-chat suffix.
//! Helix shared_chat session remains in `shared_chat.rs`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::auth;
use super::eventsub::{self, RecentNotifications, Subscription, EVENTSUB_WS};
use super::state::{BatchSend, Shared};
use super::types::{ChatEvent, ChatPipe, ChatSendWait};

const HELIX: &str = "https://api.twitch.tv/helix";
const RECONNECT_MAX: Duration = Duration::from_secs(30);
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";

/// Scopes required for channel.moderate (read OR manage pairs accepted by Twitch).
const REQUIRED_SCOPE_GROUPS: &[&[&str]] = &[
    &[
        "moderator:read:blocked_terms",
        "moderator:manage:blocked_terms",
    ],
    &[
        "moderator:read:chat_settings",
        "moderator:manage:chat_settings",
    ],
    &[
        "moderator:read:unban_requests",
        "moderator:manage:unban_requests",
    ],
    &[
        "moderator:read:banned_users",
        "moderator:manage:banned_users",
    ],
    &[
        "moderator:read:chat_messages",
        "moderator:manage:chat_messages",
    ],
    &["moderator:read:warnings", "moderator:manage:warnings"],
    &["moderator:read:moderators"],
    &["moderator:read:vips"],
];

static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static EVENT_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub enum SharedBansCmd {
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

#[derive(Debug, Clone)]
enum SharedAction {
    Ban {
        user_login: String,
    },
    Timeout {
        user_login: String,
        duration_sec: Option<u32>,
    },
    Unban {
        user_login: String,
    },
    Untimeout {
        user_login: String,
    },
    Delete {
        user_login: String,
    },
    Warn {
        user_login: String,
        user_name: String,
        reason: String,
        /// Shared-chat source login; `None` for local-channel warn.
        source: Option<String>,
    },
}

pub fn start(app: AppHandle, shared: Shared) -> Result<(), String> {
    SHUTDOWN.store(false, Ordering::SeqCst);
    shared.shared_bans_shutdown.store(false, Ordering::SeqCst);
    let (tx, rx) = mpsc::unbounded_channel::<SharedBansCmd>();
    {
        let mut slot = shared.shared_bans_tx.lock().map_err(|e| e.to_string())?;
        *slot = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_loop(app, shared, rx).await;
    });
    Ok(())
}

pub fn shutdown() {
    SHUTDOWN.store(true, Ordering::SeqCst);
}

async fn run_loop(app: AppHandle, shared: Shared, mut rx: mpsc::UnboundedReceiver<SharedBansCmd>) {
    let mut active: Option<String> = None;
    let mut backoff = Duration::from_secs(1);
    let mut seen = RecentNotifications::default();
    loop {
        if SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        let Some(login) = active.clone() else {
            match rx.recv().await {
                None | Some(SharedBansCmd::Shutdown) => break,
                Some(SharedBansCmd::SetChannel(login)) => {
                    active = Some(login);
                    backoff = Duration::from_secs(1);
                }
                Some(SharedBansCmd::ClearChannel) | Some(SharedBansCmd::Relogin) => {}
            }
            continue;
        };
        let Some(wanted) = resolve_wanted(&shared, &login).await else {
            match wait_for_change(&mut rx, &mut active, Duration::from_secs(5)).await {
                WaitEnd::Shutdown => break,
                WaitEnd::Changed => {
                    backoff = Duration::from_secs(1);
                }
                WaitEnd::Tick => {}
            }
            continue;
        };
        let end = connect_eventsub(&app, &shared, wanted, &mut rx, &mut active, &mut seen).await;
        match end {
            SessionEnd::Shutdown => break,
            SessionEnd::Changed => {
                backoff = Duration::from_secs(1);
            }
            SessionEnd::AuthDenied => match wait_until_change(&mut rx, &mut active).await {
                WaitEnd::Shutdown => break,
                WaitEnd::Changed => backoff = Duration::from_secs(1),
                WaitEnd::Tick => {}
            },
            SessionEnd::Reconnect => {
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

enum WaitEnd {
    Shutdown,
    Changed,
    Tick,
}

enum SessionEnd {
    Reconnect,
    AuthDenied,
    Changed,
    Shutdown,
}

async fn wait_for_change(
    rx: &mut mpsc::UnboundedReceiver<SharedBansCmd>,
    active: &mut Option<String>,
    dur: Duration,
) -> WaitEnd {
    tokio::select! {
        cmd = rx.recv() => apply_cmd(active, cmd),
        _ = tokio::time::sleep(dur) => WaitEnd::Tick,
    }
}

async fn wait_until_change(
    rx: &mut mpsc::UnboundedReceiver<SharedBansCmd>,
    active: &mut Option<String>,
) -> WaitEnd {
    apply_cmd(active, rx.recv().await)
}

fn apply_cmd(active: &mut Option<String>, cmd: Option<SharedBansCmd>) -> WaitEnd {
    match cmd {
        None | Some(SharedBansCmd::Shutdown) => WaitEnd::Shutdown,
        Some(SharedBansCmd::SetChannel(login)) => {
            *active = Some(login);
            WaitEnd::Changed
        }
        Some(SharedBansCmd::ClearChannel) => {
            *active = None;
            WaitEnd::Changed
        }
        Some(SharedBansCmd::Relogin) => WaitEnd::Changed,
    }
}

async fn connect_eventsub(
    app: &AppHandle,
    shared: &Shared,
    wanted: Wanted,
    rx: &mut mpsc::UnboundedReceiver<SharedBansCmd>,
    active: &mut Option<String>,
    seen: &mut RecentNotifications,
) -> SessionEnd {
    let is_current = || eventsub::is_current(shared, &wanted.login, &wanted.token);
    let connection = async {
        let Some(mut session) = eventsub::open_eventsub(EVENTSUB_WS).await else {
            return SessionEnd::Reconnect;
        };
        if !is_current() {
            return SessionEnd::Changed;
        }
        match post_subscription(&wanted, &session.id).await {
            Subscription::Ready => {}
            Subscription::AuthDenied => return SessionEnd::AuthDenied,
            Subscription::Retry => return SessionEnd::Reconnect,
        }
        let result = eventsub::listen_eventsub(
            &mut session,
            |url| async move { eventsub::open_eventsub(&url).await },
            is_current,
            |frame| {
                let Some((topic, event)) =
                    seen.receive(frame, &wanted.broadcaster_id, &wanted.moderator_id, "2")
                else {
                    return;
                };
                if topic == "channel.moderate" {
                    if let Some((action, source, moderator)) =
                        parse_shared_moderation(event, &wanted.login)
                    {
                        publish_shared_mod(app, shared, &wanted.login, action, source, moderator);
                    }
                }
            },
        )
        .await;
        if result.is_err() {
            SessionEnd::Reconnect
        } else {
            SessionEnd::Changed
        }
    };
    tokio::select! {
        biased;
        command = rx.recv() => match apply_cmd(active, command) {
            WaitEnd::Shutdown => SessionEnd::Shutdown,
            WaitEnd::Changed | WaitEnd::Tick => SessionEnd::Changed,
        },
        end = connection => end,
    }
}

fn parse_shared_moderation(
    event: &Value,
    channel_login: &str,
) -> Option<(SharedAction, String, String)> {
    let broadcaster = event
        .get("broadcaster_user_login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if !broadcaster.is_empty() && broadcaster != channel_login {
        return None;
    }
    let source_id = event
        .get("source_broadcaster_user_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let source_login = event
        .get("source_broadcaster_user_login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase());
    let broadcaster_id = event
        .get("broadcaster_user_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let is_shared = match (source_id, source_login.as_deref()) {
        (Some(sid), Some(slogin)) if sid != broadcaster_id => Some(slogin.to_string()),
        _ => None,
    };
    let action = event.get("action").and_then(Value::as_str).unwrap_or("");
    let moderator = event
        .get("moderator_user_login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if moderator.is_empty() {
        return None;
    }

    let shared_forced = matches!(
        action,
        "shared_chat_ban"
            | "shared_chat_timeout"
            | "shared_chat_unban"
            | "shared_chat_untimeout"
            | "shared_chat_delete"
            | "shared_chat_warn"
    );
    let allow_local_warn = matches!(action, "warn");
    let source = match (is_shared, shared_forced, allow_local_warn) {
        (Some(s), _, _) => Some(s),
        (None, true, _) => Some(source_login.unwrap_or_else(|| broadcaster.clone())),
        (None, false, true) => None,
        (None, false, false) => return None,
    };

    let parsed = match action {
        "ban" | "shared_chat_ban" => {
            let obj = event.get("ban").or_else(|| event.get("shared_chat_ban"))?;
            SharedAction::Ban {
                user_login: obj_login(obj)?,
            }
        }
        "timeout" | "shared_chat_timeout" => {
            let obj = event
                .get("timeout")
                .or_else(|| event.get("shared_chat_timeout"))?;
            SharedAction::Timeout {
                user_login: obj_login(obj)?,
                duration_sec: duration_from_expires(obj),
            }
        }
        "unban" | "shared_chat_unban" => {
            let obj = event
                .get("unban")
                .or_else(|| event.get("shared_chat_unban"))?;
            SharedAction::Unban {
                user_login: obj_login(obj)?,
            }
        }
        "untimeout" | "shared_chat_untimeout" => {
            let obj = event
                .get("untimeout")
                .or_else(|| event.get("shared_chat_untimeout"))?;
            SharedAction::Untimeout {
                user_login: obj_login(obj)?,
            }
        }
        "delete" | "shared_chat_delete" => {
            let obj = event
                .get("delete")
                .or_else(|| event.get("shared_chat_delete"))?;
            SharedAction::Delete {
                user_login: obj_login(obj)?,
            }
        }
        "warn" | "shared_chat_warn" => {
            let obj = event
                .get("warn")
                .or_else(|| event.get("shared_chat_warn"))?;
            let user_login = obj_login(obj)?;
            let user_name = obj
                .get("user_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(user_login.as_str())
                .to_string();
            let reason = obj
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .chars()
                .filter(|c| *c != '\0' && *c != '\r' && *c != '\n')
                .take(500)
                .collect::<String>();
            SharedAction::Warn {
                user_login,
                user_name,
                reason,
                source: source.clone(),
            }
        }
        _ => return None,
    };
    // Ban/timeout/… require shared source; warn stores Option on the action.
    let source_out = match &parsed {
        SharedAction::Warn { .. } => String::new(),
        _ => source?,
    };
    Some((parsed, source_out, moderator))
}

fn obj_login(obj: &Value) -> Option<String> {
    obj.get("user_login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
}

fn duration_from_expires(obj: &Value) -> Option<u32> {
    let expires = obj.get("expires_at").and_then(Value::as_str)?;
    let end = chrono::DateTime::parse_from_rfc3339(expires).ok()?;
    let now = chrono::Utc::now();
    let secs = end.signed_duration_since(now).num_seconds().max(0) as u32;
    Some(secs.max(1))
}

fn publish_shared_mod(
    app: &AppHandle,
    shared: &Shared,
    channel: &str,
    action: SharedAction,
    source: String,
    moderator: String,
) {
    match action {
        SharedAction::Ban { user_login } => {
            let event =
                clearchat_event(None, Some(user_login), None, Some(source), Some(moderator));
            ingest_event(app, shared, channel, event);
        }
        SharedAction::Timeout {
            user_login,
            duration_sec,
        } => {
            let event = clearchat_event(
                None,
                Some(user_login),
                duration_sec,
                Some(source),
                Some(moderator),
            );
            ingest_event(app, shared, channel, event);
        }
        SharedAction::Unban { user_login } => {
            // English `text` is search/log fallback; UI localizes via `msg_id` payload.
            let text = format!("{moderator} unbanned {user_login} in {source}.");
            let msg_id =
                shared_notice_msg_id("shared_chat_unban", &moderator, &user_login, &source);
            ingest_event(app, shared, channel, shared_mod_notice(text, msg_id));
        }
        SharedAction::Untimeout { user_login } => {
            let text = format!("{moderator} untimedout {user_login} in {source}.");
            let msg_id =
                shared_notice_msg_id("shared_chat_untimeout", &moderator, &user_login, &source);
            ingest_event(app, shared, channel, shared_mod_notice(text, msg_id));
        }
        SharedAction::Warn {
            user_login,
            user_name,
            reason,
            source: warn_source,
        } => {
            // Local warn by this account already emits a Helix success notice; skip EventSub dup.
            if warn_source.is_none() {
                let self_login = auth::resolved_login_token(shared).map(|(l, _)| l);
                if self_login
                    .as_deref()
                    .is_some_and(|me| me.eq_ignore_ascii_case(&moderator))
                {
                    return;
                }
            }
            let display = if user_name.is_empty() {
                user_login.as_str()
            } else {
                user_name.as_str()
            };
            let text = match (&warn_source, reason.is_empty()) {
                (Some(src), false) => {
                    format!("{moderator} has warned {display} in {src}: {reason}")
                }
                (Some(src), true) => format!("{moderator} has warned {display} in {src}."),
                (None, false) => format!("{moderator} has warned {display}: {reason}"),
                (None, true) => format!("{moderator} has warned {display}."),
            };
            let msg_id =
                warn_notice_msg_id(&moderator, &user_login, warn_source.as_deref(), &reason);
            ingest_event(app, shared, channel, shared_mod_notice(text, msg_id));
        }
        // Shared delete: IRC CLEARMSG already yields the deletion row; skip duplicate notice.
        SharedAction::Delete { .. } => {}
    }
}

fn clearchat_event(
    id: Option<String>,
    target_login: Option<String>,
    duration_sec: Option<u32>,
    source_login: Option<String>,
    moderator_login: Option<String>,
) -> ChatEvent {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let id = id.unwrap_or_else(|| format!("sb-{ts}-{seq}"));
    ChatEvent::Clearchat {
        id,
        timestamp_ms: ts,
        target_login,
        duration_sec,
        stack_count: 1,
        source_login,
        moderator_login,
    }
}

/// `kind|mod|login|source` — Twitch logins are [a-z0-9_], so `|` is a safe delimiter.
fn shared_notice_msg_id(kind: &str, moderator: &str, login: &str, source: &str) -> String {
    let clean = |s: &str| {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect::<String>()
    };
    format!(
        "{kind}|{}|{}|{}",
        clean(moderator),
        clean(login),
        clean(source)
    )
}

/// Local: `warn|mod|login|reason…` — Shared: `shared_chat_warn|mod|login|source|reason…`
/// (reason may contain `|`; UI joins remainder).
fn warn_notice_msg_id(moderator: &str, login: &str, source: Option<&str>, reason: &str) -> String {
    let clean = |s: &str| {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect::<String>()
    };
    let mod_c = clean(moderator);
    let login_c = clean(login);
    match source {
        Some(src) => format!(
            "shared_chat_warn|{}|{}|{}|{}",
            mod_c,
            login_c,
            clean(src),
            reason
        ),
        None => format!("warn|{mod_c}|{login_c}|{reason}"),
    }
}

fn shared_mod_notice(text: String, msg_id: String) -> ChatEvent {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    ChatEvent::Notice {
        id: format!("sb-{ts}-{seq}"),
        timestamp_ms: ts,
        text,
        msg_id: Some(msg_id),
        timeout_remaining_sec: None,
    }
}

fn ingest_event(app: &AppHandle, shared: &Shared, channel: &str, event: ChatEvent) {
    let self_login = auth::resolved_login_token(shared).map(|(l, _)| l);
    let sim = super::similarity::cfg_from_shared(shared);
    let stack_style = super::timeout_stack::style_from_shared(shared);
    let stream_id = super::logging::resolve_stream_id(shared, channel);
    let mut logged: Vec<ChatEvent> = Vec::new();
    let batch = shared.hub.lock().ok().and_then(|mut hub| {
        hub.ingest_logged(
            channel,
            event,
            self_login.as_deref(),
            &sim,
            stack_style,
            |ev| {
                logged.push(ev.clone());
            },
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
    for (channel_id, wait_text) in updates {
        let _ = app.emit(
            "chat:send-wait",
            ChatSendWait {
                channel_id,
                text: wait_text,
            },
        );
    }
}

async fn post_subscription(wanted: &Wanted, session_id: &str) -> Subscription {
    let body = json!({
        "type": "channel.moderate",
        "version": "2",
        "condition": {
            "broadcaster_user_id": wanted.broadcaster_id,
            "moderator_user_id": wanted.moderator_id,
        },
        "transport": { "method": "websocket", "session_id": session_id },
    });
    eventsub::subscribe(&wanted.client_id, &wanted.token, &body).await
}

async fn resolve_wanted(shared: &Shared, login: &str) -> Option<Wanted> {
    let token = auth::oauth_token(shared)?;
    let token = token.trim().trim_start_matches("oauth:").to_string();
    if token.is_empty() || token == "YOUR_API_KEY_HERE" {
        return None;
    }
    let client_id = auth::resolved_client_id(shared);
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return None;
    }
    let moderator_id = auth::ensure_twitch_user_id(shared).await?;
    if !scopes_ok(&token, &client_id).await {
        return None;
    }
    let profile = super::helix::fetch_user_profile(login, Some(&token), &client_id).await?;
    Some(Wanted {
        login: login.to_string(),
        broadcaster_id: profile.id,
        moderator_id,
        token,
        client_id,
    })
}

async fn scopes_ok(token: &str, client_id: &str) -> bool {
    let client = super::http_client::build(Duration::from_secs(8));
    let Ok(resp) = client
        .get(VALIDATE_URL)
        .header("Authorization", format!("OAuth {token}"))
        .header("Client-Id", client_id)
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
    let scopes: Vec<String> = v
        .get("scopes")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    REQUIRED_SCOPE_GROUPS.iter().all(|group| {
        group
            .iter()
            .any(|need| scopes.iter().any(|have| have == need))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shared_chat_timeout() {
        let event = json!({
            "broadcaster_user_id": "1",
            "broadcaster_user_login": "host",
            "source_broadcaster_user_id": "2",
            "source_broadcaster_user_login": "srcchan",
            "moderator_user_login": "mod",
            "action": "shared_chat_timeout",
            "shared_chat_timeout": {
                "user_login": "bad",
                "expires_at": "2099-01-01T00:00:00Z"
            }
        });
        let (action, source, moderator) = parse_shared_moderation(&event, "host").expect("parsed");
        assert_eq!(source, "srcchan");
        assert_eq!(moderator, "mod");
        match action {
            SharedAction::Timeout { user_login, .. } => assert_eq!(user_login, "bad"),
            _ => panic!("timeout"),
        }
    }

    #[test]
    fn ignores_local_ban_without_source() {
        let event = json!({
            "broadcaster_user_id": "1",
            "broadcaster_user_login": "host",
            "source_broadcaster_user_id": null,
            "moderator_user_login": "mod",
            "action": "ban",
            "ban": { "user_login": "bad" }
        });
        assert!(parse_shared_moderation(&event, "host").is_none());
    }

    #[test]
    fn parse_local_warn() {
        let event = json!({
            "broadcaster_user_id": "1",
            "broadcaster_user_login": "host",
            "moderator_user_login": "mod",
            "action": "warn",
            "warn": {
                "user_id": "9",
                "user_login": "bob",
                "user_name": "Bob",
                "reason": "be nice",
                "chat_rules_cited": null
            }
        });
        let (action, _, moderator) = parse_shared_moderation(&event, "host").expect("parsed");
        assert_eq!(moderator, "mod");
        match action {
            SharedAction::Warn {
                user_login,
                user_name,
                reason,
                source,
            } => {
                assert_eq!(user_login, "bob");
                assert_eq!(user_name, "Bob");
                assert_eq!(reason, "be nice");
                assert!(source.is_none());
            }
            _ => panic!("warn"),
        }
        assert_eq!(
            warn_notice_msg_id("mod", "bob", None, "be|nice"),
            "warn|mod|bob|be|nice"
        );
    }

    #[test]
    fn parse_shared_warn() {
        let event = json!({
            "broadcaster_user_id": "1",
            "broadcaster_user_login": "host",
            "source_broadcaster_user_id": "2",
            "source_broadcaster_user_login": "srcchan",
            "moderator_user_login": "mod",
            "action": "warn",
            "warn": {
                "user_login": "bob",
                "user_name": "Bob",
                "reason": "spam"
            }
        });
        let (action, _, _) = parse_shared_moderation(&event, "host").expect("parsed");
        match action {
            SharedAction::Warn { source, .. } => assert_eq!(source.as_deref(), Some("srcchan")),
            _ => panic!("shared warn"),
        }
        assert_eq!(
            warn_notice_msg_id("mod", "bob", Some("src"), "spam"),
            "shared_chat_warn|mod|bob|src|spam"
        );
    }

    #[test]
    fn shared_notice_msg_id_pipe_payload() {
        assert_eq!(
            shared_notice_msg_id("shared_chat_unban", "mod", "bob", "src"),
            "shared_chat_unban|mod|bob|src"
        );
        assert_eq!(
            shared_notice_msg_id("shared_chat_untimeout", "mod", "bob", "src"),
            "shared_chat_untimeout|mod|bob|src"
        );
    }
}
