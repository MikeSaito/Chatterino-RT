//! Channel pinned chat message via Helix GET /chat/pins.
//!
//! Requires signed-in broadcaster/moderator and OAuth scope
//! `moderator:read:chat_messages` (or manage). Anon and non-mod viewers get
//! Helix 403 — no banner. Polls while the active channel grants mod rights.
//! `behaviour.alwaysShowPinnedMessage` only skips the 30s UI auto-hide; it does
//! not fetch pins for viewers.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use url::Url;

use super::state::Shared;

const HELIX: &str = "https://api.twitch.tv/helix";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
const CHAT_PINNED_EVENT: &str = "chat:pinned";
const ATTEMPTS: u32 = 3;
const RETRY_BASE: Duration = Duration::from_millis(250);
const POLL_WHEN_MOD: Duration = Duration::from_secs(5);
const POLL_WAIT_ROLE: Duration = Duration::from_secs(4);
const POLL_NEED_SCOPE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub enum PinsCmd {
    SetChannel(String),
    ClearChannel,
    Relogin,
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
    scopes_ok: bool,
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

async fn run_loop(app: AppHandle, shared: Shared, mut rx: mpsc::UnboundedReceiver<PinsCmd>) {
    let mut active: Option<String> = None;
    let mut last_emitted: Option<PinnedMessage> = None;
    let mut last_access: Option<PinAccess> = None;
    let mut fail_streak: u32 = 0;
    let mut scope_cache = ScopeCache::default();
    loop {
        if shared.pins_shutdown.load(Ordering::SeqCst) {
            break;
        }
        let Some(login) = active.clone() else {
            match rx.recv().await {
                None | Some(PinsCmd::Shutdown) => break,
                Some(PinsCmd::SetChannel(login)) => {
                    emit_clear(&app, &login);
                    last_emitted = None;
                    last_access = None;
                    fail_streak = 0;
                    scope_cache = ScopeCache::default();
                    active = Some(login);
                }
                Some(PinsCmd::ClearChannel) | Some(PinsCmd::Relogin) => {}
            }
            continue;
        };

        match resolve_wanted(&shared, &login, &mut scope_cache).await {
            Resolve::Anon => {
                clear_emitted(&app, &login, &mut last_emitted);
                set_access(&app, &login, PinAccess::Anon, &mut last_access);
                fail_streak = 0;
                match wait_for_change(&mut rx, &mut active, &app, POLL_WAIT_ROLE).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                        last_access = None;
                        fail_streak = 0;
                        scope_cache = ScopeCache::default();
                    }
                    WaitEnd::Tick => {}
                }
            }
            Resolve::Viewer => {
                clear_emitted(&app, &login, &mut last_emitted);
                set_access(&app, &login, PinAccess::Viewer, &mut last_access);
                fail_streak = 0;
                match wait_for_change(&mut rx, &mut active, &app, POLL_WAIT_ROLE).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                        last_access = None;
                        fail_streak = 0;
                        scope_cache = ScopeCache::default();
                    }
                    WaitEnd::Tick => {}
                }
            }
            Resolve::NeedScope => {
                clear_emitted(&app, &login, &mut last_emitted);
                set_access(&app, &login, PinAccess::NeedScope, &mut last_access);
                fail_streak = 0;
                match wait_for_change(&mut rx, &mut active, &app, POLL_NEED_SCOPE).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                        last_access = None;
                        fail_streak = 0;
                        scope_cache = ScopeCache::default();
                    }
                    WaitEnd::Tick => {
                        // Re-validate scopes after backoff (token may have been refreshed).
                        scope_cache = ScopeCache::default();
                    }
                }
            }
            Resolve::Pending => {
                fail_streak = 0;
                match wait_for_change(&mut rx, &mut active, &app, POLL_WAIT_ROLE).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                        last_access = None;
                        fail_streak = 0;
                        scope_cache = ScopeCache::default();
                    }
                    WaitEnd::Tick => {}
                }
            }
            Resolve::Ready(wanted) => {
                match fetch_pin(&wanted).await {
                    FetchPin::Ok(pin) => {
                        fail_streak = 0;
                        let next = pin.filter(|p| !pin_expired(p));
                        if next != last_emitted {
                            last_emitted = next.clone();
                            let _ = app.emit(
                                CHAT_PINNED_EVENT,
                                PinnedPayload {
                                    channel: login.clone(),
                                    pin: next,
                                    access: Some(PinAccess::Ok),
                                },
                            );
                            last_access = Some(PinAccess::Ok);
                        } else if let Some(ref p) = last_emitted {
                            if pin_expired(p) {
                                emit_clear(&app, &login);
                                last_emitted = None;
                                last_access = Some(PinAccess::Ok);
                            } else if last_access != Some(PinAccess::Ok) {
                                set_access(&app, &login, PinAccess::Ok, &mut last_access);
                            }
                        } else if last_access != Some(PinAccess::Ok) {
                            set_access(&app, &login, PinAccess::Ok, &mut last_access);
                        }
                    }
                    FetchPin::Forbidden => {
                        fail_streak = 0;
                        clear_emitted(&app, &login, &mut last_emitted);
                        // Scopes already validated for Ready; 403 means not allowed on
                        // this channel (stale IRC role), not a missing-scope trap.
                        set_access(&app, &login, PinAccess::Viewer, &mut last_access);
                        match wait_for_change(&mut rx, &mut active, &app, POLL_WAIT_ROLE).await {
                            WaitEnd::Shutdown => break,
                            WaitEnd::Changed => {
                                last_emitted = None;
                                last_access = None;
                                fail_streak = 0;
                                scope_cache = ScopeCache::default();
                            }
                            WaitEnd::Tick => {}
                        }
                        continue;
                    }
                    FetchPin::Unauthorized => {
                        fail_streak = 0;
                        clear_emitted(&app, &login, &mut last_emitted);
                        set_access(&app, &login, PinAccess::Anon, &mut last_access);
                        scope_cache = ScopeCache::default();
                        match wait_for_change(&mut rx, &mut active, &app, POLL_NEED_SCOPE).await {
                            WaitEnd::Shutdown => break,
                            WaitEnd::Changed => {
                                last_emitted = None;
                                last_access = None;
                                fail_streak = 0;
                            }
                            WaitEnd::Tick => {}
                        }
                        continue;
                    }
                    FetchPin::Fail => {
                        fail_streak = fail_streak.saturating_add(1);
                        if fail_streak >= 3 && last_emitted.is_some() {
                            clear_emitted(&app, &login, &mut last_emitted);
                        }
                    }
                }
                match wait_for_change(&mut rx, &mut active, &app, POLL_WHEN_MOD).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                        last_access = None;
                        fail_streak = 0;
                        scope_cache = ScopeCache::default();
                    }
                    WaitEnd::Tick => {}
                }
            }
        }
    }
}

fn clear_emitted(app: &AppHandle, channel: &str, last: &mut Option<PinnedMessage>) {
    if last.is_some() {
        emit_clear(app, channel);
        *last = None;
    }
}

fn set_access(
    app: &AppHandle,
    channel: &str,
    access: PinAccess,
    last: &mut Option<PinAccess>,
) {
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
    /// Network/validate unknown — retry soon without alarming NeedScope UI.
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
    match pin_scopes_ok(&token, scope_cache).await {
        ScopeCheck::Ok => {}
        ScopeCheck::Missing => return Resolve::NeedScope,
        ScopeCheck::Unknown => return Resolve::Pending,
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
    Ok,
    Missing,
    Unknown,
}

async fn pin_scopes_ok(token: &str, cache: &mut ScopeCache) -> ScopeCheck {
    if cache.token == token {
        return if cache.scopes_ok {
            ScopeCheck::Ok
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
                let scopes_ok = scopes.contains("moderator:read:chat_messages")
                    || scopes.contains("moderator:manage:chat_messages");
                *cache = ScopeCache {
                    token: token.to_string(),
                    scopes_ok,
                };
                return if scopes_ok {
                    ScopeCheck::Ok
                } else {
                    ScopeCheck::Missing
                };
            }
            Ok(resp) if resp.status().as_u16() == 401 => {
                *cache = ScopeCache {
                    token: token.to_string(),
                    scopes_ok: false,
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

enum WaitEnd {
    Tick,
    Changed,
    Shutdown,
}

async fn wait_for_change(
    rx: &mut mpsc::UnboundedReceiver<PinsCmd>,
    active: &mut Option<String>,
    app: &AppHandle,
    delay: Duration,
) -> WaitEnd {
    tokio::select! {
        _ = tokio::time::sleep(delay) => WaitEnd::Tick,
        cmd = rx.recv() => apply_cmd(active, app, cmd),
    }
}

fn apply_cmd(active: &mut Option<String>, app: &AppHandle, cmd: Option<PinsCmd>) -> WaitEnd {
    match cmd {
        None | Some(PinsCmd::Shutdown) => WaitEnd::Shutdown,
        Some(PinsCmd::SetChannel(login)) => {
            if active.as_deref() != Some(login.as_str()) {
                if let Some(prev) = active.as_deref() {
                    emit_clear(app, prev);
                }
                emit_clear(app, &login);
            }
            *active = Some(login);
            WaitEnd::Changed
        }
        Some(PinsCmd::ClearChannel) => {
            if let Some(prev) = active.take() {
                emit_clear(app, &prev);
            }
            WaitEnd::Changed
        }
        Some(PinsCmd::Relogin) => {
            if let Some(prev) = active.as_deref() {
                emit_clear(app, prev);
            }
            WaitEnd::Changed
        }
    }
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

fn pin_expired(pin: &PinnedMessage) -> bool {
    let Some(ends) = pin.ends_at.as_deref() else {
        return false;
    };
    match chrono::DateTime::parse_from_rfc3339(ends) {
        Ok(dt) => chrono::Utc::now() >= dt.with_timezone(&chrono::Utc),
        Err(_) => false,
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
}
