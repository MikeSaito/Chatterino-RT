//! Channel pinned chat message via Helix GET /chat/pins.
//!
//! Requires signed-in broadcaster/moderator and OAuth scope
//! `moderator:read:chat_messages` (or manage). Anon and non-mod viewers get
//! Helix 403 — no banner. Polls while the active channel grants mod rights.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use url::Url;

use super::state::Shared;

const HELIX: &str = "https://api.twitch.tv/helix";
const CHAT_PINNED_EVENT: &str = "chat:pinned";
const ATTEMPTS: u32 = 3;
const RETRY_BASE: Duration = Duration::from_millis(250);
const POLL_WHEN_MOD: Duration = Duration::from_secs(15);
const POLL_WAIT_ROLE: Duration = Duration::from_secs(4);

#[derive(Debug, Clone)]
pub enum PinsCmd {
    SetChannel(String),
    ClearChannel,
    Relogin,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPayload {
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<PinnedMessage>,
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
        },
    );
}

async fn run_loop(app: AppHandle, shared: Shared, mut rx: mpsc::UnboundedReceiver<PinsCmd>) {
    let mut active: Option<String> = None;
    let mut last_emitted: Option<PinnedMessage> = None;
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
                    active = Some(login);
                }
                Some(PinsCmd::ClearChannel) | Some(PinsCmd::Relogin) => {}
            }
            continue;
        };

        match resolve_wanted(&shared, &login).await {
            Resolve::NotEligible => {
                if last_emitted.is_some() {
                    emit_clear(&app, &login);
                    last_emitted = None;
                }
                match wait_for_change(&mut rx, &mut active, POLL_WAIT_ROLE).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                    }
                    WaitEnd::Tick => {}
                }
            }
            Resolve::AuthDenied => {
                if last_emitted.is_some() {
                    emit_clear(&app, &login);
                    last_emitted = None;
                }
                match wait_until_change(&mut rx, &mut active).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                    }
                    WaitEnd::Tick => {}
                }
            }
            Resolve::Ready(wanted) => {
                match fetch_pin(&wanted).await {
                    FetchPin::Ok(pin) => {
                        let next = pin.filter(|p| !pin_expired(p));
                        if next != last_emitted {
                            last_emitted = next.clone();
                            let _ = app.emit(
                                CHAT_PINNED_EVENT,
                                PinnedPayload {
                                    channel: login.clone(),
                                    pin: next,
                                },
                            );
                        } else if let Some(ref p) = last_emitted {
                            if pin_expired(p) {
                                emit_clear(&app, &login);
                                last_emitted = None;
                            }
                        }
                    }
                    FetchPin::Forbidden => {
                        if last_emitted.is_some() {
                            emit_clear(&app, &login);
                            last_emitted = None;
                        }
                    }
                    FetchPin::Unauthorized => {
                        if last_emitted.is_some() {
                            emit_clear(&app, &login);
                            last_emitted = None;
                        }
                        match wait_until_change(&mut rx, &mut active).await {
                            WaitEnd::Shutdown => break,
                            WaitEnd::Changed => {
                                last_emitted = None;
                            }
                            WaitEnd::Tick => {}
                        }
                        continue;
                    }
                    FetchPin::Fail => {}
                }
                match wait_for_change(&mut rx, &mut active, POLL_WHEN_MOD).await {
                    WaitEnd::Shutdown => break,
                    WaitEnd::Changed => {
                        last_emitted = None;
                    }
                    WaitEnd::Tick => {}
                }
            }
        }
    }
}

enum Resolve {
    NotEligible,
    AuthDenied,
    Ready(Wanted),
}

async fn resolve_wanted(shared: &Shared, login: &str) -> Resolve {
    let token = match super::auth::oauth_token(shared) {
        Some(t) => {
            let t = t.trim().trim_start_matches("oauth:").to_string();
            if t.is_empty() || t == "YOUR_API_KEY_HERE" {
                return Resolve::NotEligible;
            }
            t
        }
        None => return Resolve::NotEligible,
    };
    let client_id = super::auth::resolved_client_id(shared);
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return Resolve::NotEligible;
    }
    let Some(moderator_id) = super::auth::resolved_twitch_user_id(shared) else {
        return Resolve::NotEligible;
    };
    let role = shared
        .hub
        .lock()
        .ok()
        .map(|hub| hub.viewer_role(login, Some(moderator_id.as_str())));
    let Some(role) = role else {
        return Resolve::NotEligible;
    };
    if !(role.is_mod || role.is_broadcaster) {
        return Resolve::NotEligible;
    }
    let broadcaster_id = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(login).map(str::to_string));
    let broadcaster_id = match broadcaster_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            match super::helix::fetch_user_profile(login, Some(&token), &client_id).await {
                Some(p) => p.id,
                None => return Resolve::NotEligible,
            }
        }
    };
    Resolve::Ready(Wanted {
        broadcaster_id,
        moderator_id,
        token,
        client_id,
    })
}

enum WaitEnd {
    Tick,
    Changed,
    Shutdown,
}

async fn wait_for_change(
    rx: &mut mpsc::UnboundedReceiver<PinsCmd>,
    active: &mut Option<String>,
    delay: Duration,
) -> WaitEnd {
    tokio::select! {
        _ = tokio::time::sleep(delay) => WaitEnd::Tick,
        cmd = rx.recv() => apply_cmd(active, cmd),
    }
}

async fn wait_until_change(
    rx: &mut mpsc::UnboundedReceiver<PinsCmd>,
    active: &mut Option<String>,
) -> WaitEnd {
    apply_cmd(active, rx.recv().await)
}

fn apply_cmd(active: &mut Option<String>, cmd: Option<PinsCmd>) -> WaitEnd {
    match cmd {
        None | Some(PinsCmd::Shutdown) => WaitEnd::Shutdown,
        Some(PinsCmd::SetChannel(login)) => {
            *active = Some(login);
            WaitEnd::Changed
        }
        Some(PinsCmd::ClearChannel) => {
            *active = None;
            WaitEnd::Changed
        }
        Some(PinsCmd::Relogin) => WaitEnd::Changed,
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
    match chrono_parse(ends) {
        Some(ms) => now_ms() >= ms,
        None => false,
    }
}

fn chrono_parse(raw: &str) -> Option<u64> {
    // RFC3339 → unix ms via DateTime parsing without chrono crate: use httpdate-like
    // fallback through `time` is unavailable; approximate via `js_sys`-free Rust.
    // Prefer `chrono` if present; else parse with `httpdate`/`time`. Check deps.
    parse_rfc3339_ms(raw)
}

fn parse_rfc3339_ms(raw: &str) -> Option<u64> {
    // Minimal RFC3339 parser for Helix timestamps (…Z or ±offset).
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let bytes = s.as_bytes();
    let year = atoi4(&bytes[0..4])?;
    let month = atoi2(&bytes[5..7])?;
    let day = atoi2(&bytes[8..10])?;
    let hour = atoi2(&bytes[11..13])?;
    let min = atoi2(&bytes[14..16])?;
    let sec = atoi2(&bytes[17..19])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = 0u64;
    let mut idx = 19;
    if idx < bytes.len() && bytes[idx] == b'.' {
        idx += 1;
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac = &s[start..idx];
        let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
        ms = padded.parse().ok()?;
    }
    let (off_h, off_m) = if idx < bytes.len() && (bytes[idx] == b'Z' || bytes[idx] == b'z') {
        (0i32, 0i32)
    } else if idx < bytes.len() && (bytes[idx] == b'+' || bytes[idx] == b'-') {
        let sign = if bytes[idx] == b'-' { -1i32 } else { 1i32 };
        idx += 1;
        if idx + 4 > bytes.len() {
            return None;
        }
        let oh = atoi2(&bytes[idx..idx + 2])? as i32;
        let om = if bytes.get(idx + 2) == Some(&b':') {
            atoi2(&bytes[idx + 3..idx + 5])? as i32
        } else {
            atoi2(&bytes[idx + 2..idx + 4])? as i32
        };
        (sign * oh, sign * om)
    } else {
        (0, 0)
    };
    let days = days_from_civil(year as i32, month as i32, day as i32)?;
    let total_sec = days * 86400i64
        + hour as i64 * 3600
        + min as i64 * 60
        + sec as i64
        - (off_h as i64 * 3600 + off_m as i64 * 60);
    // Unix epoch offset: days_from_civil(1970,1,1) == 0 by construction.
    if total_sec < 0 {
        return None;
    }
    Some(total_sec as u64 * 1000 + ms)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Howard's civil_from_days inverse (proleptic Gregorian) → days since 1970-01-01.
fn days_from_civil(y: i32, m: i32, d: i32) -> Option<i64> {
    if m < 1 || m > 12 || d < 1 || d > 31 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u32;
    Some(era as i64 * 146097 + doe as i64 - 719468)
}

fn atoi2(b: &[u8]) -> Option<u32> {
    if b.len() < 2 {
        return None;
    }
    Some(((b[0] - b'0') as u32) * 10 + (b[1] - b'0') as u32)
}

fn atoi4(b: &[u8]) -> Option<u32> {
    if b.len() < 4 {
        return None;
    }
    Some(
        ((b[0] - b'0') as u32) * 1000
            + ((b[1] - b'0') as u32) * 100
            + ((b[2] - b'0') as u32) * 10
            + (b[3] - b'0') as u32,
    )
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
    fn rfc3339_z() {
        let ms = parse_rfc3339_ms("1970-01-01T00:00:00Z").expect("epoch");
        assert_eq!(ms, 0);
        let later = parse_rfc3339_ms("1970-01-01T00:00:01.500Z").expect("later");
        assert_eq!(later, 1500);
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
}
