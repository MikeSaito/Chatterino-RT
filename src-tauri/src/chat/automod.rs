// SPDX-FileCopyrightText: 2017 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of Chatterino AutoMod PubSub queue + Helix manage action.
// No C++/Qt source or assets are copied.

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::commands::ApiError;
use super::state::{BatchSend, Shared};
use super::types::{AutomodRange, ChatEvent, ChatPipe, ChatSendWait};

const PUBSUB_URL: &str = "wss://pubsub-edge.twitch.tv";
const HELIX_AUTOMOD_MESSAGE: &str = "https://api.twitch.tv/helix/moderation/automod/message";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
const HTTP_ATTEMPTS: u32 = 3;
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const WS_PING_INTERVAL: Duration = Duration::from_secs(240);
const WANTED_POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_WS_FRAME: usize = 64 * 1024;

static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static NONCE_SEQ: AtomicU64 = AtomicU64::new(1);
static STATUS_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutomodWanted {
    channel_login: String,
    channel_id: String,
    moderator_id: String,
    token: String,
    client_id: String,
}

#[derive(Debug, Default)]
struct ScopeCache {
    token: String,
    user_id: Option<String>,
    scopes_ok: bool,
}

#[derive(Debug)]
struct ParsedAutomod {
    channel_id: Option<String>,
    event: ChatEvent,
}

pub fn start(app: AppHandle, shared: Shared) -> Result<(), String> {
    SHUTDOWN.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        run_loop(app, shared).await;
    });
    Ok(())
}

pub fn shutdown() {
    SHUTDOWN.store(true, Ordering::SeqCst);
}

pub async fn manage_message(
    app: AppHandle,
    shared: Shared,
    msg_id: String,
    action: String,
) -> Result<(), ApiError> {
    let msg_id = validate_msg_id(&msg_id)?;
    let action = normalize_action(&action)?;
    let (token, client_id, user_id) = action_creds(&shared).await?;
    let outcome = post_manage_message(&token, &client_id, &user_id, &msg_id, &action).await;
    match outcome {
        Ok(()) => {
            let status = if action == "ALLOW" {
                "allowed"
            } else {
                "denied"
            };
            publish_status(&app, &shared, &msg_id, status);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

async fn run_loop(app: AppHandle, shared: Shared) {
    let mut backoff = Duration::from_secs(1);
    let mut scope_cache = ScopeCache::default();
    loop {
        if shutting_down() {
            break;
        }
        let wanted = resolve_wanted(&shared, &mut scope_cache).await;
        let Some(wanted) = wanted else {
            sleep_or_shutdown(WANTED_POLL_INTERVAL).await;
            backoff = Duration::from_secs(1);
            continue;
        };
        match connect_session(&app, &shared, wanted, &mut scope_cache).await {
            SessionEnd::Shutdown => break,
            SessionEnd::Reconnect { wait } => {
                if wait {
                    sleep_or_shutdown(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                } else {
                    backoff = Duration::from_secs(1);
                }
            }
        }
    }
}

enum SessionEnd {
    Shutdown,
    Reconnect { wait: bool },
}

async fn connect_session(
    app: &AppHandle,
    shared: &Shared,
    wanted: AutomodWanted,
    scope_cache: &mut ScopeCache,
) -> SessionEnd {
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
        return SessionEnd::Reconnect { wait: true };
    };
    let (mut write, mut read) = stream.split();
    if listen(&mut write, &wanted).await.is_err() {
        let _ = send_ws(&mut write, Message::Close(None)).await;
        return SessionEnd::Reconnect { wait: true };
    }
    let mut ping_at = tokio::time::interval(WS_PING_INTERVAL);
    ping_at.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut poll_at = tokio::time::interval(WANTED_POLL_INTERVAL);
    poll_at.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        if shutting_down() {
            let _ = send_ws(&mut write, Message::Close(None)).await;
            return SessionEnd::Shutdown;
        }
        tokio::select! {
            _ = ping_at.tick() => {
                if send_ws(&mut write, Message::Text(json!({"type":"PING"}).to_string().into())).await.is_err() {
                    return SessionEnd::Reconnect { wait: true };
                }
            }
            _ = poll_at.tick() => {
                match resolve_wanted(shared, scope_cache).await {
                    Some(next) if next == wanted => {}
                    _ => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Reconnect { wait: false };
                    }
                }
            }
            msg = read.next() => {
                match msg {
                    None => return SessionEnd::Reconnect { wait: true },
                    Some(Ok(Message::Text(text))) => {
                        if !handle_pubsub_text(app, shared, &wanted, text.as_ref()) {
                            return SessionEnd::Reconnect { wait: true };
                        }
                    }
                    Some(Ok(Message::Binary(bin))) => {
                        if let Ok(text) = std::str::from_utf8(&bin) {
                            if !handle_pubsub_text(app, shared, &wanted, text) {
                                return SessionEnd::Reconnect { wait: true };
                            }
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        if send_ws(&mut write, Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect { wait: true };
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) => return SessionEnd::Reconnect { wait: true },
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

async fn listen<S>(write: &mut S, wanted: &AutomodWanted) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    let topic = format!(
        "automod-queue.{}.{}",
        wanted.moderator_id, wanted.channel_id
    );
    let nonce = format!(
        "crt-{}-{}",
        unix_ms(),
        NONCE_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let payload = json!({
        "type": "LISTEN",
        "nonce": nonce,
        "data": {
            "topics": [topic],
            "auth_token": wanted.token,
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

async fn resolve_wanted(shared: &Shared, cache: &mut ScopeCache) -> Option<AutomodWanted> {
    let channel_login = shared.hub.lock().ok().and_then(|h| h.active.clone())?;
    let channel_id = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(&channel_login).map(str::to_string))?;
    if !valid_twitch_id(&channel_id) {
        return None;
    }
    let token = super::auth::oauth_token(shared)?;
    if cache.token != token {
        *cache = validate_automod_token(&token).await.unwrap_or_default();
        cache.token = token.clone();
        if let Some(user_id) = cache.user_id.clone() {
            super::auth::set_cached_twitch_user_id(shared, user_id);
        }
    }
    if !cache.scopes_ok {
        return None;
    }
    let moderator_id = cache
        .user_id
        .clone()
        .or_else(|| super::auth::resolved_twitch_user_id(shared))?;
    let role = shared
        .hub
        .lock()
        .ok()?
        .viewer_role(&channel_login, Some(&moderator_id));
    if !(role.is_mod || role.is_broadcaster) {
        return None;
    }
    Some(AutomodWanted {
        channel_login,
        channel_id,
        moderator_id,
        token,
        client_id: super::auth::resolved_client_id(shared),
    })
}

async fn validate_automod_token(token: &str) -> Result<ScopeCache, ()> {
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = Duration::from_millis(200);
    for attempt in 0..HTTP_ATTEMPTS {
        match client
            .get(VALIDATE_URL)
            .header("Authorization", format!("OAuth {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let Ok(v) = resp.json::<Value>().await else {
                    return Err(());
                };
                let scopes: HashSet<String> = v
                    .get("scopes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
                let scopes_ok = scopes.contains("channel:moderate")
                    && scopes.contains("moderator:manage:automod");
                let user_id = v
                    .get("user_id")
                    .and_then(Value::as_str)
                    .filter(|s| valid_twitch_id(s))
                    .map(str::to_string);
                return Ok(ScopeCache {
                    token: token.to_string(),
                    user_id,
                    scopes_ok,
                });
            }
            _ => {}
        }
        if attempt + 1 < HTTP_ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(())
}

fn handle_pubsub_text(app: &AppHandle, shared: &Shared, wanted: &AutomodWanted, raw: &str) -> bool {
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
            let topic_ok = data
                .get("topic")
                .and_then(Value::as_str)
                .is_some_and(|topic| topic.ends_with(&format!(".{}", wanted.channel_id)));
            if !topic_ok {
                return true;
            }
            let Some(message) = data.get("message").and_then(Value::as_str) else {
                return true;
            };
            if let Some(parsed) = parse_pubsub_automod(message, &wanted.channel_login) {
                if parsed
                    .channel_id
                    .as_deref()
                    .is_some_and(|id| id != wanted.channel_id)
                {
                    return true;
                }
                ingest_event(app, shared, &wanted.channel_login, parsed.event);
            }
            true
        }
        _ => true,
    }
}

fn parse_pubsub_automod(raw: &str, channel_login: &str) -> Option<ParsedAutomod> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    let event_type = value
        .get("type")
        .or_else(|| value.get("event_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let data = value.get("data").unwrap_or(&value);
    let status = automod_status(data, event_type)?;
    let message_id = first_string(
        data,
        &[
            "message_id",
            "msg_id",
            "id",
            "message.id",
            "message.message_id",
            "automod_message_id",
        ],
    )?;
    let id = format!("automod_{message_id}");
    if status != "pending" {
        return Some(ParsedAutomod {
            channel_id: first_string(
                data,
                &[
                    "channel_id",
                    "broadcaster_user_id",
                    "broadcaster.id",
                    "message.channel_id",
                ],
            ),
            event: ChatEvent::AutomodStatus {
                id: format!("{id}:{status}:{}", unix_ms()),
                timestamp_ms: unix_ms(),
                target_id: id,
                status,
            },
        });
    }
    let text = first_string(
        data,
        &[
            "message",
            "message_text",
            "text",
            "content.text",
            "message.text",
            "message.content.text",
        ],
    )?;
    let author_login = first_string(
        data,
        &[
            "sender.login",
            "sender.user_login",
            "user_login",
            "user.login",
            "message.sender.login",
            "message.user_login",
        ],
    )
    .unwrap_or_else(|| channel_login.to_string());
    let author_display_name = first_string(
        data,
        &[
            "sender.display_name",
            "sender.user_name",
            "user_name",
            "display_name",
            "user.display_name",
            "message.sender.display_name",
        ],
    )
    .unwrap_or_else(|| author_login.clone());
    let author_user_id = first_string(
        data,
        &[
            "sender.id",
            "sender.user_id",
            "user_id",
            "user.id",
            "message.sender.id",
            "message.user_id",
        ],
    )
    .unwrap_or_default();
    Some(ParsedAutomod {
        channel_id: first_string(
            data,
            &[
                "channel_id",
                "broadcaster_user_id",
                "broadcaster.id",
                "message.channel_id",
            ],
        ),
        event: ChatEvent::AutomodHeld {
            id,
            timestamp_ms: unix_ms(),
            message_id,
            channel_id: first_string(
                data,
                &[
                    "channel_id",
                    "broadcaster_user_id",
                    "broadcaster.id",
                    "message.channel_id",
                ],
            )
            .unwrap_or_default(),
            author_user_id,
            author_login,
            author_display_name,
            caught_ranges: extract_ranges(data, &text),
            reason: first_string(
                data,
                &[
                    "reason",
                    "reason_code",
                    "content_classification.category",
                    "classification.category",
                    "message.reason",
                ],
            ),
            text,
            status,
        },
    })
}

fn automod_status(data: &Value, event_type: &str) -> Option<String> {
    let raw = first_string(
        data,
        &[
            "status",
            "message.status",
            "moderation_status",
            "automod_status",
            "action",
        ],
    )
    .unwrap_or_else(|| event_type.to_string());
    let raw = raw.to_ascii_lowercase();
    if raw.contains("allow") || raw.contains("approve") || raw == "allowed" {
        return Some("allowed".into());
    }
    if raw.contains("deny") || raw.contains("reject") || raw == "denied" {
        return Some("denied".into());
    }
    if raw.contains("hold") || raw.contains("caught") || raw.contains("pending") {
        return Some("pending".into());
    }
    None
}

fn first_string(value: &Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut cur = value;
        let mut ok = true;
        for part in path.split('.') {
            match cur.get(part) {
                Some(next) => cur = next,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        if let Some(s) = cur.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            return Some(s.to_string());
        }
        if let Some(n) = cur.as_u64() {
            return Some(n.to_string());
        }
    }
    None
}

fn extract_ranges(data: &Value, text: &str) -> Vec<AutomodRange> {
    let mut ranges = Vec::new();
    collect_ranges(data.get("fragments"), text, &mut ranges);
    collect_ranges(data.pointer("/message/fragments"), text, &mut ranges);
    collect_ranges(data.pointer("/content/fragments"), text, &mut ranges);
    collect_terms(data.get("terms"), text, &mut ranges);
    collect_terms(
        data.pointer("/content_classification/terms"),
        text,
        &mut ranges,
    );
    ranges.sort_by_key(|r| (r.start, r.end));
    ranges.dedup();
    ranges
}

fn collect_ranges(value: Option<&Value>, text: &str, out: &mut Vec<AutomodRange>) {
    let Some(arr) = value.and_then(Value::as_array) else {
        return;
    };
    for item in arr {
        let flagged = item
            .get("automod")
            .or_else(|| item.get("is_flagged"))
            .or_else(|| item.get("flagged"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !flagged {
            continue;
        }
        let start = item
            .get("start")
            .or_else(|| item.get("offset"))
            .and_then(Value::as_u64);
        let end = item.get("end").and_then(Value::as_u64).or_else(|| {
            let len = item.get("length").and_then(Value::as_u64)?;
            Some(start?.saturating_add(len))
        });
        if let (Some(start), Some(end)) = (start, end) {
            push_range(out, text, start, end);
        } else if let Some(term) = item
            .get("text")
            .or_else(|| item.get("term"))
            .and_then(Value::as_str)
        {
            collect_term(term, text, out);
        }
    }
}

fn collect_terms(value: Option<&Value>, text: &str, out: &mut Vec<AutomodRange>) {
    match value {
        Some(Value::Array(arr)) => {
            for item in arr {
                if let Some(s) = item
                    .as_str()
                    .or_else(|| item.get("term").and_then(Value::as_str))
                {
                    collect_term(s, text, out);
                }
            }
        }
        Some(Value::String(s)) => collect_term(s, text, out),
        _ => {}
    }
}

fn collect_term(term: &str, text: &str, out: &mut Vec<AutomodRange>) {
    let needle = term.trim();
    if needle.is_empty() {
        return;
    }
    let text_lower = text.to_lowercase();
    let needle_lower = needle.to_lowercase();
    let mut from = 0usize;
    while let Some(pos) = text_lower[from..].find(&needle_lower) {
        let start = from + pos;
        let end = start + needle_lower.len();
        push_range(out, text, start as u64, end as u64);
        from = end;
    }
}

fn push_range(out: &mut Vec<AutomodRange>, text: &str, start: u64, end: u64) {
    let Ok(start) = u32::try_from(start) else {
        return;
    };
    let Ok(end) = u32::try_from(end) else {
        return;
    };
    if start >= end || end as usize > text.len() {
        return;
    }
    if !text.is_char_boundary(start as usize) || !text.is_char_boundary(end as usize) {
        return;
    }
    out.push(AutomodRange { start, end });
}

async fn action_creds(shared: &Shared) -> Result<(String, String, String), ApiError> {
    let Some(token) = super::auth::oauth_token(shared) else {
        return Err(ApiError::coded(
            "error.auth.required",
            "Twitch login required",
        ));
    };
    let user_id = super::auth::ensure_twitch_user_id(shared)
        .await
        .ok_or_else(|| ApiError::coded("error.auth.required", "Twitch login required"))?;
    Ok((token, super::auth::resolved_client_id(shared), user_id))
}

async fn post_manage_message(
    token: &str,
    client_id: &str,
    user_id: &str,
    msg_id: &str,
    action: &str,
) -> Result<(), ApiError> {
    let body = json!({
        "user_id": user_id,
        "msg_id": msg_id,
        "action": action,
    });
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..HTTP_ATTEMPTS {
        match client
            .post(HELIX_AUTOMOD_MESSAGE)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.json::<Value>().await.unwrap_or(Value::Null);
                return Err(map_helix_error(status, &body));
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < HTTP_ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(ApiError::coded_params(
        "error.automod.network",
        "Failed to manage AutoMod message",
        BTreeMap::from([("reason".into(), last)]),
    ))
}

fn map_helix_error(status: u16, body: &Value) -> ApiError {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("AutoMod request failed")
        .to_string();
    let code = match status {
        400 => "error.automod.alreadyProcessed",
        401 => "error.automod.scope",
        403 => "error.automod.forbidden",
        404 => "error.automod.notFound",
        _ => "error.automod.failed",
    };
    ApiError::coded_params(code, message, BTreeMap::new())
}

fn validate_msg_id(raw: &str) -> Result<String, ApiError> {
    let id = raw.trim();
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    if ok {
        Ok(id.to_string())
    } else {
        Err(ApiError::coded(
            "error.automod.invalidMessage",
            "invalid AutoMod message id",
        ))
    }
}

fn normalize_action(raw: &str) -> Result<String, ApiError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "allow" | "approved" | "approve" => Ok("ALLOW".into()),
        "deny" | "denied" | "reject" => Ok("DENY".into()),
        _ => Err(ApiError::coded(
            "error.automod.invalidAction",
            "invalid AutoMod action",
        )),
    }
}

fn publish_status(app: &AppHandle, shared: &Shared, msg_id: &str, status: &str) {
    let id = format!(
        "automod_{msg_id}:{status}:{}",
        STATUS_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let event = ChatEvent::AutomodStatus {
        id,
        timestamp_ms: unix_ms(),
        target_id: format!("automod_{msg_id}"),
        status: status.to_string(),
    };
    let channel = shared.hub.lock().ok().and_then(|h| h.active.clone());
    if let Some(channel) = channel {
        ingest_event(app, shared, &channel, event);
    }
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

fn valid_twitch_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())
}

fn shutting_down() -> bool {
    SHUTDOWN.load(Ordering::SeqCst)
}

async fn sleep_or_shutdown(dur: Duration) {
    tokio::time::sleep(dur).await;
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_held_message_with_flagged_fragment() {
        let raw = r#"{
            "type":"automod_caught_message",
            "data":{
                "message_id":"abc-123",
                "channel_id":"42",
                "sender":{"login":"sever_ok","display_name":"sever_ok","user_id":"9"},
                "message":{"text":"normal rude word"},
                "fragments":[{"text":"rude","start":7,"end":11,"automod":true}]
            }
        }"#;
        let parsed = parse_pubsub_automod(raw, "channel").unwrap();
        assert_eq!(parsed.channel_id.as_deref(), Some("42"));
        match parsed.event {
            ChatEvent::AutomodHeld {
                id,
                author_login,
                text,
                caught_ranges,
                status,
                ..
            } => {
                assert_eq!(id, "automod_abc-123");
                assert_eq!(author_login, "sever_ok");
                assert_eq!(text, "normal rude word");
                assert_eq!(caught_ranges, vec![AutomodRange { start: 7, end: 11 }]);
                assert_eq!(status, "pending");
            }
            _ => panic!("expected automod held"),
        }
    }

    #[test]
    fn parses_update_as_status_event() {
        let raw =
            r#"{"type":"automod_message_update","data":{"message_id":"abc","status":"DENIED"}}"#;
        let parsed = parse_pubsub_automod(raw, "channel").unwrap();
        match parsed.event {
            ChatEvent::AutomodStatus {
                target_id, status, ..
            } => {
                assert_eq!(target_id, "automod_abc");
                assert_eq!(status, "denied");
            }
            _ => panic!("expected status"),
        }
    }
}
