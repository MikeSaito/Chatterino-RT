// SPDX-FileCopyrightText: 2017 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Twitch AutoMod queue and Helix moderation actions.
// No C++/Qt source or assets are copied.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::commands::ApiError;
use super::eventsub::{self, listen_eventsub, open_eventsub, Subscription, EVENTSUB_WS};
use super::state::{BatchSend, Shared};
use super::types::{AutomodRange, ChatEvent, ChatPipe, ChatSendWait};

const HOLD_TOPIC: &str = "automod.message.hold";
const UPDATE_TOPIC: &str = "automod.message.update";
const HELIX_AUTOMOD_MESSAGE: &str = "https://api.twitch.tv/helix/moderation/automod/message";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
const HTTP_ATTEMPTS: u32 = 3;
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const WANTED_POLL_INTERVAL: Duration = Duration::from_secs(2);

static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
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
    identity: Option<(String, String)>,
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
    channel: String,
) -> Result<(), ApiError> {
    let msg_id = validate_msg_id(&msg_id)?;
    let action = normalize_action(&action)?;
    let channel = super::commands::normalize_channel(&channel)?;
    {
        let hub = shared.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        if !hub.has_channel(&channel) && !hub.is_joined(&channel) {
            return Err(ApiError::coded("error.automod.failed", "channel not open"));
        }
    }
    let (token, client_id, user_id) = action_creds(&shared).await?;
    let outcome = post_manage_message(&token, &client_id, &user_id, &msg_id, &action).await;
    match outcome {
        Ok(()) => {
            let status = if action == "ALLOW" {
                "allowed"
            } else {
                "denied"
            };
            // Status belongs to the channel that showed the held message (click time),
            // not whatever is active after a tab switch mid-flight.
            publish_status(&app, &shared, &channel, &msg_id, status);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

async fn run_loop(app: AppHandle, shared: Shared) {
    let mut backoff = Duration::from_secs(1);
    let mut scope_cache = ScopeCache::default();
    let mut seen = VecDeque::new();
    while !shutting_down() {
        let Some(wanted) = resolve_wanted(&shared, &mut scope_cache).await else {
            tokio::time::sleep(WANTED_POLL_INTERVAL).await;
            backoff = Duration::from_secs(1);
            continue;
        };
        let Some(mut session) = open_eventsub(EVENTSUB_WS).await else {
            wait_to_retry(&mut backoff).await;
            continue;
        };
        if !still_wanted(&shared, &wanted) {
            continue;
        }
        if create_subscriptions(&wanted, &session.id).await.is_err() {
            drop(session);
            wait_to_retry(&mut backoff).await;
            continue;
        }

        backoff = Duration::from_secs(1);
        let result = listen_eventsub(
            &mut session,
            |url| async move { open_eventsub(&url).await },
            || still_wanted(&shared, &wanted),
            |value| {
                if let Some((event_id, mut event)) = parse_notification(value, &wanted) {
                    if remember_notification(&mut seen, event_id, &mut event) {
                        ingest_event(&app, &shared, &wanted.channel_login, event);
                    }
                }
            },
        )
        .await;
        drop(session);
        if result.is_err() {
            wait_to_retry(&mut backoff).await;
        }
    }
}

async fn wait_to_retry(backoff: &mut Duration) {
    tokio::time::sleep(*backoff).await;
    *backoff = (*backoff * 2).min(Duration::from_secs(60));
}

async fn create_subscriptions(wanted: &AutomodWanted, session_id: &str) -> Result<(), ()> {
    let hold = subscription_body(wanted, session_id, HOLD_TOPIC);
    let update = subscription_body(wanted, session_id, UPDATE_TOPIC);
    let (hold, update) = tokio::join!(
        eventsub::subscribe(&wanted.client_id, &wanted.token, &hold),
        eventsub::subscribe(&wanted.client_id, &wanted.token, &update),
    );
    if hold == Subscription::Ready && update == Subscription::Ready {
        Ok(())
    } else {
        Err(())
    }
}

fn subscription_body(wanted: &AutomodWanted, session_id: &str, topic: &str) -> Value {
    json!({
        "type": topic,
        "version": "2",
        "condition": {
            "broadcaster_user_id": wanted.channel_id,
            "moderator_user_id": wanted.moderator_id,
        },
        "transport": { "method": "websocket", "session_id": session_id },
    })
}

struct SeenNotification {
    id: String,
    decision: Option<(String, String)>,
}

fn remember_notification(
    seen: &mut VecDeque<SeenNotification>,
    event_id: &str,
    event: &mut ChatEvent,
) -> bool {
    if seen.iter().any(|recent| recent.id == event_id) {
        return false;
    }
    let decision = match event {
        ChatEvent::AutomodStatus {
            target_id, status, ..
        } => Some((target_id.clone(), status.clone())),
        ChatEvent::AutomodHeld { id, status, .. } => {
            if let Some((_, decision)) = seen
                .iter()
                .rev()
                .filter_map(|recent| recent.decision.as_ref())
                .find(|(target_id, _)| target_id == id)
            {
                // Hold and update are delivered by different subscriptions.
                status.clone_from(decision);
            }
            None
        }
        _ => None,
    };
    if seen.len() == 512 {
        seen.pop_front();
    }
    seen.push_back(SeenNotification {
        id: event_id.to_string(),
        decision,
    });
    true
}

async fn resolve_wanted(shared: &Shared, cache: &mut ScopeCache) -> Option<AutomodWanted> {
    let (channel_login, channel_id) = {
        let hub = shared.hub.lock().ok()?;
        let login = hub.active.as_ref()?;
        let id = hub.room_id(login)?;
        (login.clone(), id.to_string())
    };
    if !valid_twitch_id(&channel_id) {
        return None;
    }
    let token = super::auth::oauth_token(shared)?;
    if cache.token != token {
        *cache = validate_automod_token(&token).await.ok()?;
    }
    let (moderator_id, client_id) = cache.identity.as_ref()?;
    let wanted = AutomodWanted {
        channel_login,
        channel_id,
        moderator_id: moderator_id.clone(),
        token,
        client_id: client_id.clone(),
    };
    still_wanted(shared, &wanted).then_some(wanted)
}

fn still_wanted(shared: &Shared, wanted: &AutomodWanted) -> bool {
    if shutting_down() || super::auth::oauth_token(shared).as_deref() != Some(&wanted.token) {
        return false;
    }
    let Ok(hub) = shared.hub.lock() else {
        return false;
    };
    if hub.active.as_deref() != Some(&wanted.channel_login)
        || hub.room_id(&wanted.channel_login) != Some(&wanted.channel_id)
    {
        return false;
    }
    let role = hub.viewer_role(&wanted.channel_login, Some(&wanted.moderator_id));
    role.is_mod || role.is_broadcaster
}

async fn validate_automod_token(token: &str) -> Result<ScopeCache, ()> {
    let response = super::http_client::build(WS_CONNECT_TIMEOUT)
        .get(VALIDATE_URL)
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?;
    let value = response.json::<Value>().await.map_err(|_| ())?;
    Ok(ScopeCache {
        token: token.to_string(),
        identity: automod_identity(&value),
    })
}

fn automod_identity(value: &Value) -> Option<(String, String)> {
    let scopes = value.get("scopes")?.as_array()?;
    if !scopes
        .iter()
        .any(|scope| scope.as_str() == Some("moderator:manage:automod"))
    {
        return None;
    }
    let user_id = value
        .get("user_id")?
        .as_str()
        .filter(|id| valid_twitch_id(id))?;
    let client_id = value
        .get("client_id")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    Some((user_id.to_string(), client_id.to_string()))
}

fn parse_notification<'a>(
    value: &'a Value,
    wanted: &AutomodWanted,
) -> Option<(&'a str, ChatEvent)> {
    let subscription = value.pointer("/payload/subscription")?;
    let condition = subscription.get("condition")?;
    let event = value.pointer("/payload/event")?;
    if subscription.get("version")?.as_str()? != "2"
        || condition.get("broadcaster_user_id")?.as_str()? != wanted.channel_id
        || condition.get("moderator_user_id")?.as_str()? != wanted.moderator_id
        || event.get("broadcaster_user_id")?.as_str()? != wanted.channel_id
    {
        return None;
    }
    let event_id = value.pointer("/metadata/message_id")?.as_str()?;
    if event_id.is_empty() {
        return None;
    }
    let message_id = validate_msg_id(event.get("message_id")?.as_str()?).ok()?;
    let id = format!("automod_{message_id}");
    let update_timestamp = || timestamp_ms(value.pointer("/metadata/message_timestamp"));
    let parsed = match subscription.get("type")?.as_str()? {
        HOLD_TOPIC => {
            let text = event.pointer("/message/text")?.as_str()?;
            let reason = event
                .pointer("/automod/category")
                .and_then(Value::as_str)
                .or_else(|| event.get("reason").and_then(Value::as_str));
            ChatEvent::AutomodHeld {
                id,
                timestamp_ms: parse_timestamp_ms(event.get("held_at"))
                    .unwrap_or_else(update_timestamp),
                message_id,
                channel_id: wanted.channel_id.clone(),
                author_user_id: event.get("user_id")?.as_str()?.to_string(),
                author_login: event.get("user_login")?.as_str()?.to_string(),
                author_display_name: event.get("user_name")?.as_str()?.to_string(),
                caught_ranges: extract_ranges(event, text),
                reason: reason.map(str::to_string),
                text: text.to_string(),
                status: "pending".to_string(),
            }
        }
        UPDATE_TOPIC => {
            let status = match event.get("status")?.as_str()?.to_ascii_lowercase().as_str() {
                "approved" => "allowed",
                "denied" => "denied",
                "expired" => "expired",
                _ => return None,
            };
            ChatEvent::AutomodStatus {
                id: format!("{id}:{status}:{event_id}"),
                timestamp_ms: update_timestamp(),
                target_id: id,
                status: status.to_string(),
            }
        }
        _ => return None,
    };
    Some((event_id, parsed))
}

fn timestamp_ms(value: Option<&Value>) -> u64 {
    parse_timestamp_ms(value).unwrap_or_else(unix_ms)
}

fn parse_timestamp_ms(value: Option<&Value>) -> Option<u64> {
    let timestamp = chrono::DateTime::parse_from_rfc3339(value?.as_str()?).ok()?;
    u64::try_from(timestamp.timestamp_millis()).ok()
}

fn extract_ranges(event: &Value, text: &str) -> Vec<AutomodRange> {
    let boundaries = event
        .pointer("/automod/boundaries")
        .and_then(Value::as_array);
    let terms = event
        .pointer("/blocked_term/terms_found")
        .and_then(Value::as_array);
    let mut ranges: Vec<_> = boundaries
        .into_iter()
        .flatten()
        .chain(
            terms
                .into_iter()
                .flatten()
                .filter_map(|term| term.get("boundary")),
        )
        .filter_map(|boundary| {
            let start = usize::try_from(boundary.get("start_pos")?.as_u64()?).ok()?;
            let end = usize::try_from(boundary.get("end_pos")?.as_u64()?).ok()?;
            // EventSub boundaries are inclusive. The renderer uses half-open UTF-16 ranges.
            if end < start || end >= text.chars().count() {
                return None;
            }
            Some(AutomodRange {
                start: super::parse::scalar_to_utf16(text, start) as u32,
                end: super::parse::scalar_to_utf16(text, end + 1) as u32,
            })
        })
        .collect();
    ranges.sort_by_key(|range| (range.start, range.end));
    ranges.dedup();
    ranges
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
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
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

fn publish_status(app: &AppHandle, shared: &Shared, channel: &str, msg_id: &str, status: &str) {
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
    if !channel.is_empty() {
        ingest_event(app, shared, channel, event);
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

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::eventsub::{parse_welcome, read_eventsub, reconnect_url, EventSubSession};
    use futures_util::{SinkExt, StreamExt};
    use std::cell::{Cell, RefCell};
    use tokio_tungstenite::tungstenite::protocol::Role;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::WebSocketStream;

    fn wanted() -> AutomodWanted {
        AutomodWanted {
            channel_login: "fixture".into(),
            channel_id: "42".into(),
            moderator_id: "7".into(),
            token: "fixture-token".into(),
            client_id: "fixture-client".into(),
        }
    }

    fn notification(topic: &str, event_id: &str, event: Value) -> Value {
        json!({
            "metadata": {
                "message_type": "notification",
                "message_id": event_id,
                "message_timestamp": "2025-01-02T03:04:06.789123456Z"
            },
            "payload": {
                "subscription": {
                    "type": topic,
                    "version": "2",
                    "condition": { "broadcaster_user_id": "42", "moderator_user_id": "7" }
                },
                "event": event
            }
        })
    }

    fn hold(event_id: &str) -> Value {
        notification(
            HOLD_TOPIC,
            event_id,
            json!({
                "broadcaster_user_id": "42",
                "user_id": "19",
                "user_login": "viewer",
                "user_name": "Viewer",
                "message_id": "held-1",
                "message": { "text": "  🦊 тест " },
                "reason": "automod",
                "automod": {
                    "category": "aggressive",
                    "boundaries": [{ "start_pos": 4, "end_pos": 7 }, { "start_pos": 1, "end_pos": 99 }]
                },
                "blocked_term": null,
                "held_at": "2025-01-02T03:04:05.123456789Z"
            }),
        )
    }

    fn update(status: &str) -> Value {
        notification(
            UPDATE_TOPIC,
            "update-1",
            json!({
                "broadcaster_user_id": "42",
                "moderator_user_id": "99",
                "message_id": "held-1",
                "status": status
            }),
        )
    }

    #[test]
    fn uses_eventsub_scope_and_validated_client_identity() {
        let mut validation = json!({
            "user_id": "7", "client_id": "fixture-client", "scopes": ["moderator:manage:automod"]
        });
        assert_eq!(
            automod_identity(&validation),
            Some(("7".into(), "fixture-client".into()))
        );
        validation["scopes"] = json!(["channel:moderate"]);
        assert_eq!(automod_identity(&validation), None);

        for topic in [HOLD_TOPIC, UPDATE_TOPIC] {
            assert_eq!(
                subscription_body(&wanted(), "session", topic),
                json!({
                    "type": topic,
                    "version": "2",
                    "condition": { "broadcaster_user_id": "42", "moderator_user_id": "7" },
                    "transport": { "method": "websocket", "session_id": "session" }
                })
            );
        }
    }

    #[test]
    fn parses_hold_with_original_text_and_utf16_highlight() {
        let frame = hold("hold-1");
        let (event_id, event) = parse_notification(&frame, &wanted()).unwrap();
        assert_eq!(event_id, "hold-1");
        let ChatEvent::AutomodHeld {
            id,
            message_id,
            channel_id,
            timestamp_ms,
            author_user_id,
            author_login,
            author_display_name,
            text,
            caught_ranges,
            reason,
            status,
        } = event
        else {
            panic!("expected held message");
        };
        assert_eq!(id, "automod_held-1");
        assert_eq!(message_id, "held-1");
        assert_eq!(channel_id, "42");
        assert_eq!(timestamp_ms, 1_735_787_045_123);
        assert_eq!(author_user_id, "19");
        assert_eq!(author_login, "viewer");
        assert_eq!(author_display_name, "Viewer");
        assert_eq!(text, "  🦊 тест ");
        assert_eq!(caught_ranges, vec![AutomodRange { start: 5, end: 9 }]);
        assert_eq!(reason.as_deref(), Some("aggressive"));
        assert_eq!(status, "pending");
    }

    #[test]
    fn parses_blocked_term_and_link_boundaries() {
        for why in ["blocked_term", "blocked_link"] {
            let mut frame = hold("hold-1");
            let event = &mut frame["payload"]["event"];
            event["reason"] = json!(why);
            event["automod"] = Value::Null;
            event["blocked_term"] = json!({
                "terms_found": [
                    { "boundary": { "start_pos": 2, "end_pos": 2 } },
                    { "boundary": { "start_pos": 2, "end_pos": 2 } },
                    { "boundary": { "start_pos": 4, "end_pos": 3 } }
                ]
            });
            let Some((
                _,
                ChatEvent::AutomodHeld {
                    reason,
                    caught_ranges,
                    ..
                },
            )) = parse_notification(&frame, &wanted())
            else {
                panic!("expected held message");
            };
            assert_eq!(reason.as_deref(), Some(why));
            assert_eq!(caught_ranges, vec![AutomodRange { start: 2, end: 4 }]);
        }
    }

    #[test]
    fn maps_status_from_another_moderator_and_rejects_other_rooms() {
        for (upstream, expected) in [
            ("Approved", "allowed"),
            ("denied", "denied"),
            ("expired", "expired"),
        ] {
            let frame = update(upstream);
            let Some((
                _,
                ChatEvent::AutomodStatus {
                    target_id,
                    timestamp_ms,
                    status,
                    ..
                },
            )) = parse_notification(&frame, &wanted())
            else {
                panic!("expected status update");
            };
            assert_eq!(target_id, "automod_held-1");
            assert_eq!(timestamp_ms, 1_735_787_046_789);
            assert_eq!(status, expected);
        }
        assert!(parse_notification(&update("pending"), &wanted()).is_none());
        let mut frame = update("denied");
        frame["payload"]["subscription"]["condition"]["moderator_user_id"] = json!("99");
        assert!(parse_notification(&frame, &wanted()).is_none());
        frame = update("denied");
        frame["payload"]["event"]["broadcaster_user_id"] = json!("99");
        assert!(parse_notification(&frame, &wanted()).is_none());
    }

    #[test]
    fn late_hold_keeps_decision_and_repeat_is_discarded() {
        let mut seen = VecDeque::new();
        let update = update("denied");
        let (id, mut decision) = parse_notification(&update, &wanted()).unwrap();
        assert!(remember_notification(&mut seen, id, &mut decision));
        assert!(!remember_notification(&mut seen, id, &mut decision));

        let frame = hold("hold-1");
        let (id, mut message) = parse_notification(&frame, &wanted()).unwrap();
        assert!(remember_notification(&mut seen, id, &mut message));
        assert!(matches!(&message, ChatEvent::AutomodHeld {status, ..} if status == "denied"));
        assert!(!remember_notification(&mut seen, id, &mut message));
    }

    fn reconnect_frame(url: &str) -> Value {
        json!({
            "metadata": { "message_type": "session_reconnect" },
            "payload": { "session": { "reconnect_url": url } }
        })
    }

    #[test]
    fn passes_reconnect_url_unchanged_and_checks_the_origin() {
        let raw = "wss://eventsub.wss.twitch.tv/ws?reconnect=a%2Fb&session_id=fixture";
        assert_eq!(reconnect_url(&reconnect_frame(raw)).as_deref(), Some(raw));
        for invalid in [
            "https://eventsub.wss.twitch.tv/ws",
            "wss://eventsub.wss.twitch.tv.example.org/ws",
            "wss://eventsub.wss.twitch.tv:9000/ws",
            "wss://eventsub.wss.twitch.tv/login",
        ] {
            assert!(reconnect_url(&reconnect_frame(invalid)).is_none());
        }
    }

    async fn socket_pair() -> (
        EventSubSession<tokio::io::DuplexStream>,
        WebSocketStream<tokio::io::DuplexStream>,
    ) {
        let (client, server) = tokio::io::duplex(8 * 1024);
        let socket = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        let server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        (
            EventSubSession {
                socket,
                id: "old".into(),
                heartbeat: Duration::from_secs(35),
            },
            server,
        )
    }

    #[tokio::test]
    async fn socket_close_and_revocation_require_fresh_subscriptions() {
        let revocation = json!({ "metadata": { "message_type": "revocation" } });
        for frame in [
            Message::Close(None),
            Message::Text(revocation.to_string().into()),
        ] {
            let (mut session, mut server) = socket_pair().await;
            server.send(frame).await.unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                listen_eventsub(
                    &mut session,
                    |_| async { panic!("only a reconnect message can transfer subscriptions") },
                    || true,
                    |_| panic!("revocation is not a notification"),
                ),
            )
            .await;
            assert_eq!(result.unwrap(), Err(()));
        }
    }

    #[tokio::test]
    async fn handoff_receives_old_and_new_notifications_and_stops_after_tab_change() {
        let (mut session, mut old_server) = socket_pair().await;
        let (new_session, mut new_server) = socket_pair().await;
        let replacement = RefCell::new(Some(new_session));
        let current = Cell::new(true);
        let received_old = tokio::sync::Notify::new();
        let received_new = tokio::sync::Notify::new();
        let mut ids = Vec::new();
        let listen = listen_eventsub(
            &mut session,
            |_| {
                let mut next = replacement.borrow_mut().take().unwrap();
                async move {
                    let (id, heartbeat) = parse_welcome(&read_eventsub(&mut next.socket).await?)?;
                    next.id = id;
                    next.heartbeat = heartbeat;
                    Some(next)
                }
            },
            || current.get(),
            |frame| {
                let (id, _) = parse_notification(frame, &wanted()).unwrap();
                ids.push(id.to_string());
                match id {
                    "hold-1" => received_old.notify_one(),
                    "update-1" => received_new.notify_one(),
                    _ => panic!("stale notification delivered"),
                }
            },
        );
        let simulate_twitch = async {
            old_server
                .send(Message::Ping(vec![7].into()))
                .await
                .unwrap();
            assert_eq!(
                old_server.next().await.unwrap().unwrap(),
                Message::Pong(vec![7].into())
            );
            let redirect = reconnect_frame("wss://eventsub.wss.twitch.tv/ws?session_id=fixture");
            old_server
                .send(Message::Text(redirect.to_string().into()))
                .await
                .unwrap();
            old_server
                .send(Message::Text(hold("hold-1").to_string().into()))
                .await
                .unwrap();
            received_old.notified().await;
            let welcome = json!({
                "metadata": { "message_type": "session_welcome" },
                "payload": { "session": { "id": "new", "keepalive_timeout_seconds": 30 } }
            });
            new_server
                .send(Message::Text(welcome.to_string().into()))
                .await
                .unwrap();
            new_server
                .send(Message::Text(update("approved").to_string().into()))
                .await
                .unwrap();
            received_new.notified().await;
            current.set(false);
            new_server
                .send(Message::Text(hold("stale").to_string().into()))
                .await
                .unwrap();
        };

        let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(listen, simulate_twitch)
        })
        .await
        .expect("handoff should complete");
        assert!(result.is_ok());
        assert_eq!(session.id, "new");
        assert_eq!(ids, ["hold-1", "update-1"]);
    }
}
