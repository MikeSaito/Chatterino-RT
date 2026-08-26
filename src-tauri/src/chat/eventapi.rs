// SPDX-FileCopyrightText: 2022 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of 7TV EventAPI subscribe/dispatch from Chatterino
// src/providers/seventv/eventapi. Not a copy of C++/Qt source.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use std::collections::BTreeMap;

use super::emotes::{Catalog, SetScope};
use super::fetch::{self, parse_active_emote, EmoteProviderFlags};
use super::seventv_badges::{
    apply_cosmetic_create, apply_entitlement_create, apply_entitlement_delete,
};
use super::state::{EventCmd, EventWanted, Shared};

const EVENT_URL: &str = "wss://events.7tv.io/v3";
const OP_DISPATCH: i64 = 0;
const OP_HELLO: i64 = 1;
const OP_HEARTBEAT: i64 = 2;
const OP_RECONNECT: i64 = 4;
const OP_SUBSCRIBE: i64 = 35;
const OP_UNSUBSCRIBE: i64 = 36;
const DEFAULT_HEARTBEAT: Duration = Duration::from_millis(25_000);
const WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_WS_FRAME: usize = 64 * 1024;
const MAX_SET_CHANGES: usize = 512;
const CHANNEL_SUB_TYPES: &[&str] = &[
    "cosmetic.create",
    "entitlement.create",
    "entitlement.delete",
];

pub fn seventv_event_channel_needed_from_knobs(knobs: &BTreeMap<String, serde_json::Value>) -> bool {
    let flags = EmoteProviderFlags::from_knobs(knobs);
    if !flags.seventv_event_api {
        return false;
    }
    let show_badges = knobs
        .get("appearance.showBadgesSevenTV")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    flags.seventv_channel || show_badges
}

pub fn seventv_event_channel_needed(shared: &Shared) -> bool {
    shared
        .settings
        .lock()
        .ok()
        .map(|inner| seventv_event_channel_needed_from_knobs(&inner.data.knobs))
        .unwrap_or(true)
}

pub fn spawn_event_channel_resync(shared: Shared) {
    tauri::async_runtime::spawn(async move {
        resync_event_channel(&shared).await;
    });
}

pub fn resolve_twitch_room_id(shared: &Shared, login: &str) -> Option<String> {
    if let Some(ch) = shared
        .snapshot_event_wanted()
        .channel
        .filter(|c| c.login == login && !c.room_id.is_empty())
    {
        return Some(ch.room_id);
    }
    if let Some(ch) = shared
        .snapshot_bttv_wanted()
        .channel
        .filter(|c| c.login == login && !c.room_id.is_empty())
    {
        return Some(ch.room_id);
    }
    shared
        .hub
        .lock()
        .ok()
        .and_then(|hub| hub.room_id(login).map(str::to_string))
        .filter(|id| valid_twitch_room_id(id))
}

pub fn valid_twitch_room_id(room_id: &str) -> bool {
    !room_id.is_empty() && room_id.chars().all(|c| c.is_ascii_digit())
}

async fn resync_event_channel(shared: &Shared) {
    if !seventv_event_channel_needed(shared) {
        shared.notify_event(EventCmd::ClearChannel);
        return;
    }
    let login = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.active.clone());
    let Some(login) = login else {
        return;
    };
    let Some(room_id) = resolve_twitch_room_id(shared, &login) else {
        shared.notify_event(EventCmd::ClearChannel);
        return;
    };
    let flags = EmoteProviderFlags::from_shared(shared);
    let (set_id, user_id) = if flags.seventv_channel {
        if let Some(ch) = shared
            .snapshot_event_wanted()
            .channel
            .filter(|c| c.login == login && !c.set_id.is_empty())
        {
            (ch.set_id, ch.user_id)
        } else {
            let token = super::auth::oauth_token(shared);
            let client_id = super::auth::resolved_client_id(shared);
            fetch::load_channel(
                &shared.catalog,
                &shared.badges,
                &shared.cheers,
                &shared.hub,
                &shared.ffz_channel,
                &login,
                &room_id,
                token.as_deref(),
                &client_id,
                flags,
            )
            .await
            .unwrap_or_default()
        }
    } else {
        (String::new(), String::new())
    };
    let still = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.active.clone())
        .is_some_and(|ch| ch == login);
    if !still {
        return;
    }
    shared.notify_event(EventCmd::SetChannel {
        login,
        room_id,
        set_id,
        user_id,
    });
}

pub fn start(shared: Shared) -> Result<(), String> {
    let enabled = EmoteProviderFlags::from_shared(&shared).seventv_event_api;
    {
        let mut wanted = shared
            .event_wanted
            .lock()
            .map_err(|e| e.to_string())?;
        wanted.enabled = enabled;
    }
    let (tx, rx) = mpsc::unbounded_channel::<EventCmd>();
    {
        let mut slot = shared.event_tx.lock().map_err(|e| e.to_string())?;
        *slot = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_loop(shared, rx).await;
    });
    Ok(())
}

fn shutting_down(shared: &Shared) -> bool {
    shared.event_shutdown.load(Ordering::SeqCst)
}

async fn run_loop(shared: Shared, mut rx: mpsc::UnboundedReceiver<EventCmd>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        if shutting_down(&shared) {
            break;
        }
        let wanted = shared.snapshot_event_wanted();
        if !wanted.enabled {
            match rx.recv().await {
                None | Some(EventCmd::Shutdown) => break,
                Some(cmd) => shared.apply_event_cmd(&cmd),
            }
            continue;
        }
        match connect_session(&shared, &mut rx).await {
            SessionEnd::Shutdown => break,
            SessionEnd::Reconnect { wait } => {
                if !wait {
                    backoff = Duration::from_secs(1);
                    continue;
                }
                let sleep = tokio::time::sleep(backoff);
                tokio::pin!(sleep);
                tokio::select! {
                    _ = &mut sleep => {
                        if backoff < Duration::from_secs(16) {
                            backoff *= 2;
                        }
                    }
                    cmd = rx.recv() => {
                        match cmd {
                            None | Some(EventCmd::Shutdown) => break,
                            Some(other) => shared.apply_event_cmd(&other),
                        }
                        backoff = Duration::from_secs(1);
                    }
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
    rx: &mut mpsc::UnboundedReceiver<EventCmd>,
) -> SessionEnd {
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_FRAME))
        .read_buffer_size(32 * 1024);
    let Ok(Ok((stream, _))) = tokio::time::timeout(
        Duration::from_secs(12),
        tokio_tungstenite::connect_async_with_config(EVENT_URL, Some(cfg), false),
    )
    .await
    else {
        return SessionEnd::Reconnect { wait: true };
    };
    let (mut write, mut read) = stream.split();
    let mut hello = false;
    let mut heartbeat = DEFAULT_HEARTBEAT;
    let mut last_hb = Instant::now();
    let mut live_sets = std::collections::HashSet::<String>::new();
    let mut live_users = std::collections::HashSet::<String>::new();
    let mut live_channels = std::collections::HashSet::<String>::new();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
                if !shared.snapshot_event_wanted().enabled {
                    let _ = send_ws(&mut write, Message::Close(None)).await;
                    return SessionEnd::Reconnect { wait: false };
                }
                if last_hb.elapsed() > heartbeat * 3 {
                    let _ = send_ws(&mut write, Message::Close(None)).await;
                    return SessionEnd::Reconnect { wait: true };
                }
                if hello {
                    let wanted = shared.snapshot_event_wanted();
                    if sync_subs(
                        &mut write,
                        &wanted,
                        &mut live_sets,
                        &mut live_users,
                        &mut live_channels,
                    )
                        .await
                        .is_err()
                    {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Reconnect { wait: true };
                    }
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    None | Some(EventCmd::Shutdown) => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Shutdown;
                    }
                    Some(other) => {
                        shared.apply_event_cmd(&other);
                        if hello {
                            let wanted = shared.snapshot_event_wanted();
                            if sync_subs(
                        &mut write,
                        &wanted,
                        &mut live_sets,
                        &mut live_users,
                        &mut live_channels,
                    )
                                .await
                                .is_err()
                            {
                                let _ = send_ws(&mut write, Message::Close(None)).await;
                                return SessionEnd::Reconnect { wait: true };
                            }
                        }
                    }
                }
            }
            incoming = read.next() => {
                let Some(Ok(msg)) = incoming else {
                    return SessionEnd::Reconnect { wait: true };
                };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Ping(p) => {
                        if send_ws(&mut write, Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect { wait: true };
                        }
                        continue;
                    }
                    Message::Close(_) => return SessionEnd::Reconnect { wait: true },
                    _ => continue,
                };
                if text.len() > MAX_WS_MESSAGE {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let op = v.get("op").and_then(Value::as_i64).unwrap_or(-1);
                let data = v.get("d").unwrap_or(&Value::Null);
                match op {
                    OP_HELLO => {
                        if let Some(ms) = hello_interval_ms(data) {
                            heartbeat = Duration::from_millis(ms);
                        }
                        hello = true;
                        last_hb = Instant::now();
                        live_sets.clear();
                        live_users.clear();
                        live_channels.clear();
                        let wanted = shared.snapshot_event_wanted();
                        if sync_subs(
                        &mut write,
                        &wanted,
                        &mut live_sets,
                        &mut live_users,
                        &mut live_channels,
                    )
                            .await
                            .is_err()
                        {
                            return SessionEnd::Reconnect { wait: true };
                        }
                    }
                    OP_HEARTBEAT => {
                        last_hb = Instant::now();
                    }
                    OP_DISPATCH => {
                        if handle_dispatch(shared, data) && hello {
                            let wanted = shared.snapshot_event_wanted();
                            if sync_subs(
                        &mut write,
                        &wanted,
                        &mut live_sets,
                        &mut live_users,
                        &mut live_channels,
                    )
                                .await
                                .is_err()
                            {
                                let _ = send_ws(&mut write, Message::Close(None)).await;
                                return SessionEnd::Reconnect { wait: true };
                            }
                        }
                    }
                    OP_RECONNECT => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Reconnect { wait: false };
                    }
                    _ => {}
                }
            }
        }
    }
}

fn handle_dispatch(shared: &Shared, data: &Value) -> bool {
    if !shared.snapshot_event_wanted().enabled {
        return false;
    }
    let kind = data.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "emote_set.update" => {
            let flags = EmoteProviderFlags::from_shared(shared);
            if let Ok(mut cat) = shared.catalog.lock() {
                apply_emote_set_update(&mut cat, data, flags);
            }
            false
        }
        "user.update" => apply_user_set_switch(shared, data),
        "cosmetic.create" => {
            if let Ok(mut cat) = shared.seventv_badges.lock() {
                apply_cosmetic_create(&mut cat, data);
            }
            false
        }
        "entitlement.create" => {
            if let Ok(mut cat) = shared.seventv_badges.lock() {
                apply_entitlement_create(&mut cat, data);
            }
            false
        }
        "entitlement.delete" => {
            if let Ok(mut cat) = shared.seventv_badges.lock() {
                apply_entitlement_delete(&mut cat, data);
            }
            false
        }
        _ => false,
    }
}

fn apply_user_set_switch(shared: &Shared, data: &Value) -> bool {
    let flags = EmoteProviderFlags::from_shared(shared);
    if !flags.seventv_channel {
        return false;
    }
    let wanted = shared.snapshot_event_wanted();
    let Some(ch) = wanted.channel.as_ref() else {
        return false;
    };
    {
        let Ok(hub) = shared.hub.lock() else {
            return false;
        };
        if hub.active.as_deref() != Some(ch.login.as_str()) {
            return false;
        }
    }
    let Some((_old_set, new_set)) = user_set_switch(data, &ch.user_id, &ch.set_id) else {
        return false;
    };
    let login = ch.login.clone();
    let user_id = ch.user_id.clone();
    {
        let Ok(hub) = shared.hub.lock() else {
            return false;
        };
        if hub.active.as_deref() != Some(login.as_str()) {
            return false;
        }
        let Ok(mut slot) = shared.event_wanted.lock() else {
            return false;
        };
        let Some(live) = slot.channel.as_mut() else {
            return false;
        };
        if live.login != login || live.user_id != user_id {
            return false;
        }
        live.set_id = new_set.clone();
    }
    if let Ok(mut cat) = shared.catalog.lock() {
        cat.bind_set(new_set.clone(), SetScope::Channel(login.clone()));
    }
    let catalog = shared.catalog.clone();
    let hub = shared.hub.clone();
    let show_unlisted = flags.show_unlisted_7tv;
    tauri::async_runtime::spawn(async move {
        fill_switched_set(catalog, hub, login, new_set, show_unlisted).await;
    });
    true
}

async fn fill_switched_set(
    catalog: std::sync::Arc<std::sync::Mutex<Catalog>>,
    hub: std::sync::Arc<std::sync::Mutex<super::hub::Hub>>,
    login: String,
    new_set: String,
    show_unlisted: bool,
) {
    let Some(incoming) = fetch::load_7tv_set(&new_set, show_unlisted).await else {
        return;
    };
    {
        let Ok(h) = hub.lock() else {
            return;
        };
        if h.active.as_deref() != Some(login.as_str()) {
            return;
        }
        let Ok(mut cat) = catalog.lock() else {
            return;
        };
        if cat.scope_for_set(&new_set) != Some(&SetScope::Channel(login.clone())) {
            return;
        }
        cat.replace_7tv(&login, incoming);
    }
}

pub(crate) fn hello_interval_ms(data: &Value) -> Option<u64> {
    data.get("heartbeat_interval")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok())))
        .filter(|ms| *ms >= 1_000 && *ms <= 120_000)
}

pub(crate) fn apply_emote_set_update(
    catalog: &mut Catalog,
    data: &Value,
    flags: EmoteProviderFlags,
) -> bool {
    let body = data.get("body").unwrap_or(data);
    let Some(set_id) = body.get("id").and_then(Value::as_str) else {
        return false;
    };
    let Some(scope) = catalog.scope_for_set(set_id).cloned() else {
        return false;
    };
    let allowed = match &scope {
        SetScope::Global => flags.seventv_global,
        SetScope::Channel(_) => flags.seventv_channel,
    };
    if !allowed {
        return false;
    }
    let show_unlisted = flags.show_unlisted_7tv;
    let mut changed = false;
    changed |= apply_pushed(catalog, &scope, body.get("pushed"), show_unlisted);
    changed |= apply_updated(catalog, &scope, body.get("updated"), show_unlisted);
    changed |= apply_pulled(catalog, &scope, body.get("pulled"));
    changed
}

fn apply_pushed(
    catalog: &mut Catalog,
    scope: &SetScope,
    arr: Option<&Value>,
    show_unlisted: bool,
) -> bool {
    let Some(items) = change_items(arr) else {
        return false;
    };
    let mut changed = false;
    for item in items {
        if item.get("key").and_then(Value::as_str) != Some("emotes") {
            continue;
        }
        let Some(value) = item.get("value") else {
            continue;
        };
        let Some((name, def)) = parse_active_emote(value, show_unlisted) else {
            continue;
        };
        catalog.upsert_7tv(scope, name, def);
        changed = true;
    }
    changed
}

fn apply_pulled(catalog: &mut Catalog, scope: &SetScope, arr: Option<&Value>) -> bool {
    let Some(items) = change_items(arr) else {
        return false;
    };
    let mut changed = false;
    for item in items {
        if item.get("key").and_then(Value::as_str) != Some("emotes") {
            continue;
        }
        let name = item
            .get("old_value")
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str);
        let Some(name) = name else {
            continue;
        };
        catalog.remove_7tv(scope, name);
        changed = true;
    }
    changed
}

fn apply_updated(
    catalog: &mut Catalog,
    scope: &SetScope,
    arr: Option<&Value>,
    show_unlisted: bool,
) -> bool {
    let Some(items) = change_items(arr) else {
        return false;
    };
    let mut changed = false;
    for item in items {
        if item.get("key").and_then(Value::as_str) != Some("emotes") {
            continue;
        }
        let old_name = item
            .get("old_value")
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(value) = item.get("value") else {
            continue;
        };
        let Some((name, def)) = parse_active_emote(value, show_unlisted) else {
            continue;
        };
        if !old_name.is_empty() && old_name != name {
            catalog.rename_7tv(scope, old_name, name.clone());
        }
        catalog.upsert_7tv(scope, name, def);
        changed = true;
    }
    changed
}

fn change_items(arr: Option<&Value>) -> Option<&[Value]> {
    let items = arr.and_then(Value::as_array)?;
    if items.len() > MAX_SET_CHANGES {
        return None;
    }
    Some(items)
}

pub(crate) fn user_set_switch(data: &Value, user_id: &str, current_set: &str) -> Option<(String, String)> {
    let body = data.get("body").unwrap_or(data);
    let dispatch_user = body.get("id").and_then(Value::as_str)?;
    if dispatch_user != user_id {
        return None;
    }
    let updated = body.get("updated").and_then(Value::as_array)?;
    for item in updated {
        if item.get("key").and_then(Value::as_str) != Some("connections") {
            continue;
        }
        let values = item.get("value").and_then(Value::as_array)?;
        for value in values {
            if value.get("key").and_then(Value::as_str) != Some("emote_set") {
                continue;
            }
            let old_id = value
                .get("old_value")
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let new_id = value
                .get("value")
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !fetch::safe_object_id(old_id) || !fetch::safe_object_id(new_id) || old_id == new_id {
                continue;
            }
            if old_id != current_set {
                continue;
            }
            return Some((old_id.to_string(), new_id.to_string()));
        }
    }
    None
}

async fn sync_subs<S>(
    write: &mut S,
    wanted: &EventWanted,
    live_sets: &mut std::collections::HashSet<String>,
    live_users: &mut std::collections::HashSet<String>,
    live_channels: &mut std::collections::HashSet<String>,
) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
{
    let mut want_sets = std::collections::HashSet::new();
    let mut want_users = std::collections::HashSet::new();
    let mut want_channels = std::collections::HashSet::new();
    if wanted.enabled {
        if let Some(id) = wanted.global_set.as_ref() {
            want_sets.insert(id.clone());
        }
        if let Some(ch) = wanted.channel.as_ref() {
            if !ch.set_id.is_empty() {
                want_sets.insert(ch.set_id.clone());
            }
            if !ch.user_id.is_empty() {
                want_users.insert(ch.user_id.clone());
            }
            if !ch.room_id.is_empty() && valid_twitch_room_id(&ch.room_id) {
                want_channels.insert(ch.room_id.clone());
            }
        }
    }
    let unsub_channels: Vec<String> = live_channels.difference(&want_channels).cloned().collect();
    let sub_channels: Vec<String> = want_channels.difference(live_channels).cloned().collect();
    for id in &unsub_channels {
        for kind in CHANNEL_SUB_TYPES {
            send_json(write, channel_sub_payload(OP_UNSUBSCRIBE, kind, id)).await?;
        }
    }
    for id in &sub_channels {
        for kind in CHANNEL_SUB_TYPES {
            send_json(write, channel_sub_payload(OP_SUBSCRIBE, kind, id)).await?;
        }
    }
    *live_channels = want_channels;

    let unsub_sets: Vec<String> = live_sets.difference(&want_sets).cloned().collect();
    let unsub_users: Vec<String> = live_users.difference(&want_users).cloned().collect();
    let sub_sets: Vec<String> = want_sets.difference(live_sets).cloned().collect();
    let sub_users: Vec<String> = want_users.difference(live_users).cloned().collect();
    for id in &unsub_sets {
        send_json(write, sub_payload(OP_UNSUBSCRIBE, "emote_set.update", id)).await?;
    }
    for id in &unsub_users {
        send_json(write, sub_payload(OP_UNSUBSCRIBE, "user.update", id)).await?;
    }
    for id in &sub_sets {
        send_json(write, sub_payload(OP_SUBSCRIBE, "emote_set.update", id)).await?;
    }
    for id in &sub_users {
        send_json(write, sub_payload(OP_SUBSCRIBE, "user.update", id)).await?;
    }
    *live_sets = want_sets;
    *live_users = want_users;
    Ok(())
}

fn channel_sub_payload(op: i64, kind: &str, room_id: &str) -> String {
    json!({
        "op": op,
        "d": {
            "type": kind,
            "condition": {
                "ctx": "channel",
                "platform": "TWITCH",
                "id": room_id
            }
        }
    })
    .to_string()
}

fn sub_payload(op: i64, kind: &str, object_id: &str) -> String {
    json!({
        "op": op,
        "d": {
            "type": kind,
            "condition": { "object_id": object_id }
        }
    })
    .to_string()
}

async fn send_json<S>(write: &mut S, payload: String) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
{
    send_ws(write, Message::Text(payload.into())).await
}

async fn send_ws<S>(write: &mut S, msg: Message) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
{
    tokio::time::timeout(WRITE_TIMEOUT, write.send(msg))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::emotes::EmoteDef;

    fn active_emote(name: &str, flags: u64) -> Value {
        serde_json::json!({
            "id": "abc",
            "name": name,
            "flags": flags,
            "data": {
                "id": "abc",
                "name": name,
                "host": {
                    "url": "//cdn.7tv.app/emote/abc",
                    "files": [{"name": "1x.webp"}]
                },
                "owner": { "id": "o" }
            }
        })
    }

    fn catalog_with_set() -> Catalog {
        let mut cat = Catalog::default();
        cat.bind_set("set1".into(), SetScope::Channel("xqc".into()));
        cat.replace_channel("xqc".into(), std::collections::HashMap::new());
        cat
    }

    #[test]
    fn parses_hello_heartbeat_interval() {
        let data = serde_json::json!({ "heartbeat_interval": 25000 });
        assert_eq!(hello_interval_ms(&data), Some(25000));
        assert!(hello_interval_ms(&serde_json::json!({ "heartbeat_interval": 12 })).is_none());
    }

    #[test]
    fn pushed_zero_width_inserts() {
        let mut cat = catalog_with_set();
        let data = serde_json::json!({
            "type": "emote_set.update",
            "body": {
                "id": "set1",
                "pushed": [{ "key": "emotes", "value": active_emote("cvHazmat", 1) }]
            }
        });
        assert!(apply_emote_set_update(&mut cat, &data, EmoteProviderFlags::default()));
        let def = cat.lookup("xqc", "cvHazmat").expect("inserted");
        assert!(def.zero_width);
        assert_eq!(def.provider, "7tv");
    }

    #[test]
    fn pulled_removes() {
        let mut cat = catalog_with_set();
        cat.upsert_7tv(
            &SetScope::Channel("xqc".into()),
            "cvHazmat".into(),
            EmoteDef {
                id: "abc".into(),
                provider: "7tv".into(),
                url: "https://cdn.7tv.app/emote/abc/1x.webp".into(),
                zero_width: true,
                display_width: None,
                display_height: None,
            },
        );
        let data = serde_json::json!({
            "type": "emote_set.update",
            "body": {
                "id": "set1",
                "pulled": [{ "key": "emotes", "old_value": { "id": "abc", "name": "cvHazmat" } }]
            }
        });
        assert!(apply_emote_set_update(&mut cat, &data, EmoteProviderFlags::default()));
        assert!(cat.lookup("xqc", "cvHazmat").is_none());
    }

    #[test]
    fn rename_updates_code() {
        let mut cat = catalog_with_set();
        cat.upsert_7tv(
            &SetScope::Channel("xqc".into()),
            "oldName".into(),
            EmoteDef {
                id: "abc".into(),
                provider: "7tv".into(),
                url: "https://cdn.7tv.app/emote/abc/1x.webp".into(),
                zero_width: false,
                display_width: None,
                display_height: None,
            },
        );
        let data = serde_json::json!({
            "type": "emote_set.update",
            "body": {
                "id": "set1",
                "updated": [{
                    "key": "emotes",
                    "old_value": { "id": "abc", "name": "oldName" },
                    "value": active_emote("newName", 0)
                }]
            }
        });
        assert!(apply_emote_set_update(&mut cat, &data, EmoteProviderFlags::default()));
        assert!(cat.lookup("xqc", "oldName").is_none());
        assert!(cat.lookup("xqc", "newName").is_some());
    }

    #[test]
    fn foreign_set_id_ignored() {
        let mut cat = catalog_with_set();
        let data = serde_json::json!({
            "type": "emote_set.update",
            "body": {
                "id": "other",
                "pushed": [{ "key": "emotes", "value": active_emote("cvHazmat", 1) }]
            }
        });
        assert!(!apply_emote_set_update(&mut cat, &data, EmoteProviderFlags::default()));
        assert!(cat.lookup("xqc", "cvHazmat").is_none());
    }

    #[test]
    fn user_switch_requires_matching_ids() {
        let data = serde_json::json!({
            "type": "user.update",
            "body": {
                "id": "user1",
                "updated": [{
                    "key": "connections",
                    "value": [{
                        "key": "emote_set",
                        "old_value": { "id": "set1" },
                        "value": { "id": "set2" }
                    }]
                }]
            }
        });
        assert_eq!(
            user_set_switch(&data, "user1", "set1"),
            Some(("set1".into(), "set2".into()))
        );
        assert!(user_set_switch(&data, "nope", "set1").is_none());
        assert!(user_set_switch(&data, "user1", "set9").is_none());
    }

    #[test]
    fn user_update_ignored_when_hub_inactive() {
        let shared = Shared::new();
        shared.event_wanted.lock().unwrap().channel = Some(super::super::state::EventChannelWanted {
            login: "xqc".into(),
            room_id: "999".into(),
            set_id: "set1".into(),
            user_id: "user1".into(),
        });
        let data = serde_json::json!({
            "type": "user.update",
            "body": {
                "id": "user1",
                "updated": [{
                    "key": "connections",
                    "value": [{
                        "key": "emote_set",
                        "old_value": { "id": "set1" },
                        "value": { "id": "set2" }
                    }]
                }]
            }
        });
        assert!(!handle_dispatch(&shared, &data));
        assert_eq!(
            shared.snapshot_event_wanted().channel.unwrap().set_id,
            "set1"
        );
    }

    #[test]
    fn invalid_update_does_not_rename() {
        let mut cat = catalog_with_set();
        cat.upsert_7tv(
            &SetScope::Channel("xqc".into()),
            "oldName".into(),
            EmoteDef {
                id: "abc".into(),
                provider: "7tv".into(),
                url: "https://cdn.7tv.app/emote/abc/1x.webp".into(),
                zero_width: false,
                display_width: None,
                display_height: None,
            },
        );
        let data = serde_json::json!({
            "type": "emote_set.update",
            "body": {
                "id": "set1",
                "updated": [{
                    "key": "emotes",
                    "old_value": { "id": "abc", "name": "oldName" },
                    "value": { "name": "newName" }
                }]
            }
        });
        assert!(!apply_emote_set_update(&mut cat, &data, EmoteProviderFlags::default()));
        assert!(cat.lookup("xqc", "oldName").is_some());
        assert!(cat.lookup("xqc", "newName").is_none());
    }

    #[test]
    fn oversized_pushed_is_ignored() {
        let mut cat = catalog_with_set();
        let pushed: Vec<Value> = (0..MAX_SET_CHANGES + 1)
            .map(|i| {
                serde_json::json!({
                    "key": "emotes",
                    "value": active_emote(&format!("e{i}"), 0)
                })
            })
            .collect();
        let data = serde_json::json!({
            "type": "emote_set.update",
            "body": { "id": "set1", "pushed": pushed }
        });
        assert!(!apply_emote_set_update(&mut cat, &data, EmoteProviderFlags::default()));
        assert!(cat.lookup("xqc", "e0").is_none());
    }

    #[test]
    fn channel_sub_payload_uses_twitch_room_condition() {
        let payload = channel_sub_payload(OP_SUBSCRIBE, "cosmetic.create", "12345");
        let v: Value = serde_json::from_str(&payload).expect("json");
        assert_eq!(v["op"], OP_SUBSCRIBE);
        assert_eq!(v["d"]["type"], "cosmetic.create");
        assert_eq!(v["d"]["condition"]["ctx"], "channel");
        assert_eq!(v["d"]["condition"]["platform"], "TWITCH");
        assert_eq!(v["d"]["condition"]["id"], "12345");
    }

    #[test]
    fn handle_dispatch_cosmetic_and_entitlement() {
        let shared = Shared::new();
        let cosmetic = serde_json::json!({
            "type": "cosmetic.create",
            "body": {
                "object": {
                    "kind": "BADGE",
                    "data": {
                        "id": "badge1",
                        "name": "Test",
                        "host": {
                            "url": "//cdn.7tv.app/badge/badge1",
                            "files": [{
                                "format": "WEBP",
                                "name": "1x.webp",
                                "static_name": "1x_static.webp"
                            }]
                        }
                    }
                }
            }
        });
        assert!(!handle_dispatch(&shared, &cosmetic));
        let entitlement = serde_json::json!({
            "type": "entitlement.create",
            "body": {
                "object": {
                    "kind": "BADGE",
                    "ref_id": "badge1",
                    "user": {
                        "connections": [{
                            "platform": "TWITCH",
                            "id": "777",
                            "username": "viewer"
                        }]
                    }
                }
            }
        });
        assert!(!handle_dispatch(&shared, &entitlement));
        let badges = shared.seventv_badges.lock().unwrap();
        assert!(badges.badge_for_user("777").is_some());
    }

    #[test]
    fn seventv_event_channel_needed_respects_badges_knob() {
        use std::collections::BTreeMap;
        let mut knobs = BTreeMap::new();
        knobs.insert("emotes.enableSevenTVEventAPI".into(), Value::Bool(true));
        knobs.insert("emotes.enableSevenTVChannelEmotes".into(), Value::Bool(false));
        knobs.insert("appearance.showBadgesSevenTV".into(), Value::Bool(true));
        assert!(seventv_event_channel_needed_from_knobs(&knobs));
        knobs.insert("appearance.showBadgesSevenTV".into(), Value::Bool(false));
        assert!(!seventv_event_channel_needed_from_knobs(&knobs));
    }
}
