//! BetterTTV live emote updates (Chatterino BttvLiveUpdates). MIT reimpl; no C++/Qt.

use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::emotes::EmoteDef;
use super::state::{BttvCmd, Shared};

const BTTV_WS: &str = "wss://sockets.betterttv.net/ws";
const WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_WS_FRAME: usize = 64 * 1024;

pub fn bttv_cdn_url(emote_id: &str) -> String {
    format!("https://cdn.betterttv.net/emote/{emote_id}/1x")
}

pub fn start(shared: Shared) -> Result<(), String> {
    let enabled = knob_enabled(&shared);
    {
        let mut wanted = shared
            .bttv_wanted
            .lock()
            .map_err(|e| e.to_string())?;
        wanted.enabled = enabled;
    }
    let (tx, rx) = mpsc::unbounded_channel::<BttvCmd>();
    {
        let mut slot = shared.bttv_tx.lock().map_err(|e| e.to_string())?;
        *slot = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_loop(shared, rx).await;
    });
    Ok(())
}

fn knob_enabled(shared: &Shared) -> bool {
    shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("emotes.enableBTTVLiveUpdates")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

fn shutting_down(shared: &Shared) -> bool {
    shared.bttv_shutdown.load(Ordering::SeqCst)
}

async fn run_loop(shared: Shared, mut rx: mpsc::UnboundedReceiver<BttvCmd>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        if shutting_down(&shared) {
            break;
        }
        let wanted = shared.snapshot_bttv_wanted();
        if !wanted.enabled {
            match rx.recv().await {
                None | Some(BttvCmd::Shutdown) => break,
                Some(cmd) => shared.apply_bttv_cmd(&cmd),
            }
            continue;
        }
        match connect_session(&shared, &mut rx).await {
            SessionEnd::Shutdown => break,
            SessionEnd::Reconnect { wait } => {
                if wait {
                    let sleep = tokio::time::sleep(backoff);
                    tokio::pin!(sleep);
                    tokio::select! {
                        _ = &mut sleep => {
                            backoff = (backoff * 2).min(Duration::from_secs(60));
                        }
                        cmd = rx.recv() => {
                            match cmd {
                                None | Some(BttvCmd::Shutdown) => break,
                                Some(cmd) => {
                                    shared.apply_bttv_cmd(&cmd);
                                    backoff = Duration::from_secs(1);
                                }
                            }
                        }
                    }
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
    shared: &Shared,
    rx: &mut mpsc::UnboundedReceiver<BttvCmd>,
) -> SessionEnd {
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_FRAME))
        .read_buffer_size(32 * 1024);
    let Ok(Ok((stream, _))) = tokio::time::timeout(
        Duration::from_secs(12),
        tokio_tungstenite::connect_async_with_config(BTTV_WS, Some(cfg), false),
    )
    .await
    else {
        return SessionEnd::Reconnect { wait: true };
    };
    let (mut write, mut read) = stream.split();
    let mut joined: Option<String> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    if sync_join(shared, &mut write, &mut joined).await.is_err() {
        let _ = send_ws(&mut write, Message::Close(None)).await;
        return SessionEnd::Reconnect { wait: true };
    }

    loop {
        if shutting_down(shared) {
            let _ = send_ws(&mut write, Message::Close(None)).await;
            return SessionEnd::Shutdown;
        }
        tokio::select! {
            _ = tick.tick() => {
                if shutting_down(shared) {
                    let _ = send_ws(&mut write, Message::Close(None)).await;
                    return SessionEnd::Shutdown;
                }
                let wanted = shared.snapshot_bttv_wanted();
                if !wanted.enabled {
                    let _ = part_if_joined(&mut write, &mut joined).await;
                    let _ = send_ws(&mut write, Message::Close(None)).await;
                    return SessionEnd::Reconnect { wait: false };
                }
                if sync_join(shared, &mut write, &mut joined).await.is_err() {
                    let _ = send_ws(&mut write, Message::Close(None)).await;
                    return SessionEnd::Reconnect { wait: true };
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    None | Some(BttvCmd::Shutdown) => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Shutdown;
                    }
                    Some(other) => {
                        shared.apply_bttv_cmd(&other);
                        if sync_join(shared, &mut write, &mut joined).await.is_err() {
                            let _ = send_ws(&mut write, Message::Close(None)).await;
                            return SessionEnd::Reconnect { wait: true };
                        }
                        if !shared.snapshot_bttv_wanted().enabled {
                            let _ = send_ws(&mut write, Message::Close(None)).await;
                            return SessionEnd::Reconnect { wait: false };
                        }
                    }
                }
            }
            msg = read.next() => {
                match msg {
                    None => return SessionEnd::Reconnect { wait: true },
                    Some(Ok(Message::Text(text))) => {
                        handle_text(shared, text.as_ref());
                    }
                    Some(Ok(Message::Binary(bin))) => {
                        if let Ok(text) = std::str::from_utf8(&bin) {
                            handle_text(shared, text);
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        if send_ws(&mut write, Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect { wait: true };
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) => {
                        return SessionEnd::Reconnect { wait: true };
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

async fn sync_join<S>(
    shared: &Shared,
    write: &mut S,
    joined: &mut Option<String>,
) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    let wanted = shared.snapshot_bttv_wanted();
    let target = if wanted.enabled {
        wanted.channel.as_ref().map(|c| c.room_id.clone())
    } else {
        None
    };
    if joined.as_ref() == target.as_ref() {
        return Ok(());
    }
    part_if_joined(write, joined).await?;
    if let Some(room_id) = target {
        let payload = json!({
            "name": "join_channel",
            "data": { "name": format!("twitch:{room_id}") }
        });
        send_ws(write, Message::Text(payload.to_string().into())).await?;
        *joined = Some(room_id);
    }
    Ok(())
}

async fn part_if_joined<S>(write: &mut S, joined: &mut Option<String>) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    if let Some(room_id) = joined.take() {
        let payload = json!({
            "name": "part_channel",
            "data": { "name": format!("twitch:{room_id}") }
        });
        send_ws(write, Message::Text(payload.to_string().into())).await?;
    }
    Ok(())
}

async fn send_ws<S>(write: &mut S, msg: Message) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    tokio::time::timeout(WRITE_TIMEOUT, write.send(msg))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

fn handle_text(shared: &Shared, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return;
    };
    apply_event(shared, &v);
}

pub fn apply_event(shared: &Shared, root: &Value) {
    let wanted = shared.snapshot_bttv_wanted();
    if !wanted.enabled {
        return;
    }
    let Some(channel) = wanted.channel.as_ref() else {
        return;
    };
    let active_ok = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.active.clone())
        .is_some_and(|ch| ch == channel.login);
    if !active_ok {
        return;
    }
    let event_type = root.get("name").and_then(Value::as_str).unwrap_or("");
    let data = root.get("data").unwrap_or(&Value::Null);
    let room_id = match parse_twitch_channel_id(data.get("channel").and_then(Value::as_str)) {
        Some(id) => id,
        None => return,
    };
    if room_id != channel.room_id {
        return;
    }
    let login = channel.login.as_str();
    match event_type {
        "emote_create" | "emote_update" => {
            let emote = data.get("emote").unwrap_or(&Value::Null);
            let id = emote.get("id").and_then(Value::as_str).unwrap_or("");
            let code = emote.get("code").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() || code.is_empty() {
                return;
            }
            let def = EmoteDef {
                id: id.to_string(),
                provider: "bttv".into(),
                url: bttv_cdn_url(id),
                zero_width: false,
            };
            if let Ok(mut cat) = shared.catalog.lock() {
                cat.upsert_bttv(login, code.to_string(), def);
            }
        }
        "emote_delete" => {
            let id = data.get("emoteId").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return;
            }
            if let Ok(mut cat) = shared.catalog.lock() {
                cat.remove_bttv_by_id(login, id);
            }
        }
        _ => {}
    }
}

fn parse_twitch_channel_id(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let id = raw.strip_prefix("twitch:")?;
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::state::BttvChannelWanted;

    fn shared_with_channel(login: &str, room_id: &str) -> Shared {
        let shared = Shared::new();
        shared.hub.lock().unwrap().set_active(Some(login.into()));
        shared.notify_bttv(BttvCmd::SetChannel {
            login: login.into(),
            room_id: room_id.into(),
        });
        shared
    }

    #[test]
    fn create_and_delete_update_catalog() {
        let shared = shared_with_channel("xqc", "123");
        apply_event(
            &shared,
            &json!({
                "name": "emote_create",
                "data": {
                    "channel": "twitch:123",
                    "emote": { "id": "abc", "code": "CatJam" }
                }
            }),
        );
        {
            let cat = shared.catalog.lock().unwrap();
            let def = cat.lookup("xqc", "CatJam").expect("emote");
            assert_eq!(def.provider, "bttv");
            assert_eq!(def.url, bttv_cdn_url("abc"));
        }
        apply_event(
            &shared,
            &json!({
                "name": "emote_delete",
                "data": { "channel": "twitch:123", "emoteId": "abc" }
            }),
        );
        assert!(shared.catalog.lock().unwrap().lookup("xqc", "CatJam").is_none());
    }

    #[test]
    fn ignores_other_room_and_disabled() {
        let shared = shared_with_channel("xqc", "123");
        apply_event(
            &shared,
            &json!({
                "name": "emote_create",
                "data": {
                    "channel": "twitch:999",
                    "emote": { "id": "abc", "code": "Nope" }
                }
            }),
        );
        assert!(shared.catalog.lock().unwrap().lookup("xqc", "Nope").is_none());
        shared.notify_bttv(BttvCmd::SetEnabled(false));
        apply_event(
            &shared,
            &json!({
                "name": "emote_create",
                "data": {
                    "channel": "twitch:123",
                    "emote": { "id": "abc", "code": "CatJam" }
                }
            }),
        );
        assert!(shared.catalog.lock().unwrap().lookup("xqc", "CatJam").is_none());
    }

    #[test]
    fn parse_channel_id() {
        assert_eq!(
            parse_twitch_channel_id(Some("twitch:42")).as_deref(),
            Some("42")
        );
        assert!(parse_twitch_channel_id(Some("42")).is_none());
        assert!(parse_twitch_channel_id(Some("twitch:")).is_none());
    }

    #[test]
    fn set_channel_requires_active() {
        let shared = Shared::new();
        shared.notify_bttv(BttvCmd::SetChannel {
            login: "xqc".into(),
            room_id: "1".into(),
        });
        assert!(shared.snapshot_bttv_wanted().channel.is_none());
        shared.hub.lock().unwrap().set_active(Some("xqc".into()));
        shared.notify_bttv(BttvCmd::SetChannel {
            login: "xqc".into(),
            room_id: "1".into(),
        });
        assert_eq!(
            shared.snapshot_bttv_wanted().channel,
            Some(BttvChannelWanted {
                login: "xqc".into(),
                room_id: "1".into(),
            })
        );
    }
}
