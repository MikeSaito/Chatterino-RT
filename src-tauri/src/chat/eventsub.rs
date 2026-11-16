use std::collections::VecDeque;
use std::future::Future;
use std::time::Duration;

use futures_util::{stream::FuturesUnordered, SinkExt, StreamExt};
use reqwest::StatusCode;
use serde_json::Value;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub(super) const EVENTSUB_WS: &str = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const HELIX_EVENTSUB: &str = "https://api.twitch.tv/helix/eventsub/subscriptions";
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const WANTED_POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_WS_FRAME: usize = 64 * 1024;

pub(super) struct EventSubSession<S = MaybeTlsStream<tokio::net::TcpStream>> {
    pub(super) socket: WebSocketStream<S>,
    pub(super) id: String,
    pub(super) heartbeat: Duration,
}

pub(super) async fn open_eventsub(url: &str) -> Option<EventSubSession> {
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_FRAME))
        .read_buffer_size(32 * 1024);
    tokio::time::timeout(WS_CONNECT_TIMEOUT, async {
        let (mut socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(cfg), false)
            .await
            .ok()?;
        let welcome = read_eventsub(&mut socket).await?;
        let (id, heartbeat) = parse_welcome(&welcome)?;
        Some(EventSubSession {
            socket,
            id,
            heartbeat,
        })
    })
    .await
    .ok()
    .flatten()
}

pub(super) fn parse_welcome(value: &Value) -> Option<(String, Duration)> {
    if message_type(value) != Some("session_welcome") {
        return None;
    }
    let session = value.pointer("/payload/session")?;
    let id = session.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let seconds = session
        .get("keepalive_timeout_seconds")
        .and_then(Value::as_u64)
        .filter(|n| (10..=600).contains(n))
        .unwrap_or(30);
    Some((id.to_string(), Duration::from_secs(seconds + 5)))
}

pub(super) async fn listen_eventsub<S, F>(
    session: &mut EventSubSession<S>,
    open_replacement: impl Fn(String) -> F,
    is_current: impl Fn() -> bool,
    mut notify: impl FnMut(&Value),
) -> Result<(), ()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: Future<Output = Option<EventSubSession<S>>>,
{
    let mut poll = tokio::time::interval(WANTED_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut deadline = tokio::time::Instant::now() + session.heartbeat;
    let mut replacement = FuturesUnordered::new();
    let mut old_open = true;

    loop {
        tokio::select! {
            biased;
            _ = poll.tick() => {
                if !is_current() {
                    return Ok(());
                }
            }
            _ = tokio::time::sleep_until(deadline), if replacement.is_empty() => return Err(()),
            frame = read_eventsub(&mut session.socket), if old_open => {
                let Some(frame) = frame else {
                    if replacement.is_empty() {
                        return Err(());
                    }
                    old_open = false;
                    continue;
                };
                match message_type(&frame) {
                    Some("session_keepalive") => {
                        deadline = tokio::time::Instant::now() + session.heartbeat;
                    }
                    Some("notification") => {
                        deadline = tokio::time::Instant::now() + session.heartbeat;
                        if !is_current() {
                            return Ok(());
                        }
                        notify(&frame);
                    }
                    Some("session_reconnect") if replacement.is_empty() => {
                        let url = reconnect_url(&frame).ok_or(())?;
                        // Keep consuming the old socket until Twitch welcomes its replacement.
                        replacement.push(open_replacement(url));
                    }
                    Some("revocation") => return Err(()),
                    _ => {}
                }
            }
            next = replacement.next(), if !replacement.is_empty() => {
                *session = next.flatten().ok_or(())?;
                old_open = true;
                deadline = tokio::time::Instant::now() + session.heartbeat;
            }
        }
    }
}

pub(super) async fn read_eventsub<S>(socket: &mut WebSocketStream<S>) -> Option<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match socket.next().await?.ok()? {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str(text.as_str()) {
                    return Some(value);
                }
            }
            Message::Ping(_) => {
                // Tungstenite queues the Pong while reading.
                tokio::time::timeout(WS_WRITE_TIMEOUT, socket.flush())
                    .await
                    .ok()?
                    .ok()?;
            }
            Message::Close(_) => return None,
            _ => {}
        }
    }
}

fn message_type(value: &Value) -> Option<&str> {
    value.pointer("/metadata/message_type")?.as_str()
}

pub(super) fn reconnect_url(value: &Value) -> Option<String> {
    let raw = value.pointer("/payload/session/reconnect_url")?.as_str()?;
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() == "wss"
        && url.host_str() == Some("eventsub.wss.twitch.tv")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/ws" | "/ws/")
        && url.fragment().is_none()
    {
        return Some(raw.to_string());
    }
    None
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum Subscription {
    Ready,
    AuthDenied,
    Retry,
}

fn subscription_result(status: StatusCode) -> Subscription {
    match status {
        StatusCode::ACCEPTED => Subscription::Ready,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Subscription::AuthDenied,
        _ => Subscription::Retry,
    }
}

pub(super) async fn subscribe(client_id: &str, token: &str, body: &Value) -> Subscription {
    let client = super::http_client::build(WS_WRITE_TIMEOUT);
    match client
        .post(HELIX_EVENTSUB)
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
    {
        Ok(response) => subscription_result(response.status()),
        Err(_) => Subscription::Retry,
    }
}

#[derive(Default)]
pub(super) struct RecentNotifications(VecDeque<String>);

impl RecentNotifications {
    pub(super) fn receive<'a>(
        &mut self,
        frame: &'a Value,
        broadcaster_id: &str,
        moderator_id: &str,
        version: &str,
    ) -> Option<(&'a str, &'a Value)> {
        let subscription = frame.pointer("/payload/subscription")?;
        let event = frame.pointer("/payload/event")?;
        if subscription.get("version")?.as_str()? != version
            || subscription
                .pointer("/condition/broadcaster_user_id")?
                .as_str()?
                != broadcaster_id
            || subscription
                .pointer("/condition/moderator_user_id")?
                .as_str()?
                != moderator_id
            || event.get("broadcaster_user_id")?.as_str()? != broadcaster_id
        {
            return None;
        }
        let topic = subscription.get("type")?.as_str()?;
        let id = frame.pointer("/metadata/message_id")?.as_str()?;
        if id.is_empty() || self.0.iter().any(|entry| entry == id) {
            return None;
        }
        if self.0.len() == 512 {
            self.0.pop_front();
        }
        self.0.push_back(id.to_string());
        Some((topic, event))
    }
}

pub(super) fn is_current(shared: &super::state::Shared, login: &str, token: &str) -> bool {
    super::auth::oauth_token(shared)
        .is_some_and(|current| current.trim().trim_start_matches("oauth:") == token)
        && shared
            .hub
            .lock()
            .ok()
            .is_some_and(|hub| hub.active.as_deref() == Some(login))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conflict_is_not_a_confirmation_for_this_socket() {
        assert_eq!(
            subscription_result(StatusCode::ACCEPTED),
            Subscription::Ready
        );
        assert_eq!(
            subscription_result(StatusCode::CONFLICT),
            Subscription::Retry
        );
        assert_eq!(
            subscription_result(StatusCode::FORBIDDEN),
            Subscription::AuthDenied
        );
    }

    #[test]
    fn rejects_previous_channel_and_repeated_notifications() {
        let mut seen = RecentNotifications::default();
        let frame = json!({
            "metadata": { "message_id": "fixture-1" },
            "payload": {
                "subscription": {
                    "type": "channel.moderate",
                    "version": "2",
                    "condition": { "broadcaster_user_id": "42", "moderator_user_id": "7" }
                },
                "event": { "broadcaster_user_id": "42" }
            }
        });
        assert!(seen.receive(&frame, "99", "7", "2").is_none());
        assert!(seen.receive(&frame, "42", "8", "2").is_none());
        assert!(seen.receive(&frame, "42", "7", "1").is_none());
        assert_eq!(
            seen.receive(&frame, "42", "7", "2").map(|(topic, _)| topic),
            Some("channel.moderate")
        );
        assert!(seen.receive(&frame, "42", "7", "2").is_none());
    }
}
