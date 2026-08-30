use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use super::state::Shared;

const HELIX: &str = "https://api.twitch.tv/helix";
const EVENTSUB_WS: &str = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const CHAT_POLLS_EVENT: &str = "chat:polls";
const ATTEMPTS: u32 = 3;
const RETRY_BASE: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(30);
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(20);
const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_WS_FRAME: usize = 64 * 1024;

const SUB_TYPES: &[(&str, PanelKind)] = &[
    ("channel.poll.begin", PanelKind::Poll),
    ("channel.poll.progress", PanelKind::Poll),
    ("channel.poll.end", PanelKind::Poll),
    ("channel.prediction.begin", PanelKind::Prediction),
    ("channel.prediction.progress", PanelKind::Prediction),
    ("channel.prediction.lock", PanelKind::Prediction),
    ("channel.prediction.end", PanelKind::Prediction),
];

#[derive(Debug, Clone)]
pub enum PollsCmd {
    SetChannel(String),
    ClearChannel,
    Relogin,
    Shutdown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PanelKind {
    Poll,
    Prediction,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PollsPayload {
    pub channel: String,
    pub panels: Vec<PollPanel>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PollPanel {
    pub kind: PanelKind,
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winning_option_id: Option<String>,
    pub total_votes: u64,
    pub options: Vec<PollOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PollOption {
    pub id: String,
    pub title: String,
    pub votes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_winner: bool,
}

#[derive(Debug, Clone)]
struct Wanted {
    login: String,
    broadcaster_id: String,
    token: String,
    client_id: String,
}

pub fn start(app: AppHandle, shared: Shared) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<PollsCmd>();
    {
        let mut slot = shared.polls_tx.lock().map_err(|e| e.to_string())?;
        *slot = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_loop(app, shared, rx).await;
    });
    Ok(())
}

pub fn emit_clear(app: &AppHandle, channel: &str) {
    let _ = app.emit(
        CHAT_POLLS_EVENT,
        PollsPayload {
            channel: channel.to_string(),
            panels: Vec::new(),
        },
    );
}

async fn run_loop(app: AppHandle, shared: Shared, mut rx: mpsc::UnboundedReceiver<PollsCmd>) {
    let mut active: Option<String> = None;
    let mut backoff = Duration::from_secs(1);
    let mut ws_url = EVENTSUB_WS.to_string();
    loop {
        if shared.polls_shutdown.load(Ordering::SeqCst) {
            break;
        }
        let Some(login) = active.clone() else {
            match rx.recv().await {
                None | Some(PollsCmd::Shutdown) => break,
                Some(PollsCmd::SetChannel(login)) => {
                    emit_clear(&app, &login);
                    active = Some(login);
                    ws_url = EVENTSUB_WS.to_string();
                    backoff = Duration::from_secs(1);
                }
                Some(PollsCmd::ClearChannel) | Some(PollsCmd::Relogin) => {}
            }
            continue;
        };
        let Some(wanted) = resolve_wanted(&shared, &login).await else {
            emit_clear(&app, &login);
            match wait_for_change(&mut rx, &mut active, SNAPSHOT_INTERVAL).await {
                WaitEnd::Shutdown => break,
                WaitEnd::Changed => {
                    backoff = Duration::from_secs(1);
                    ws_url = EVENTSUB_WS.to_string();
                    continue;
                }
                WaitEnd::Tick => continue,
            }
        };
        let end = connect_eventsub(&app, &shared, wanted, &mut rx, &mut active, &ws_url).await;
        match end {
            SessionEnd::Shutdown => break,
            SessionEnd::Changed => {
                backoff = Duration::from_secs(1);
                ws_url = EVENTSUB_WS.to_string();
            }
            SessionEnd::AuthDenied => {
                emit_clear(&app, &login);
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
    let profile = super::helix::fetch_user_profile(login, Some(&token), &client_id).await?;
    Some(Wanted {
        login: login.to_string(),
        broadcaster_id: profile.id,
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
    rx: &mut mpsc::UnboundedReceiver<PollsCmd>,
    active: &mut Option<String>,
    delay: Duration,
) -> WaitEnd {
    tokio::select! {
        _ = tokio::time::sleep(delay) => WaitEnd::Tick,
        cmd = rx.recv() => apply_cmd(active, cmd),
    }
}

fn apply_cmd(active: &mut Option<String>, cmd: Option<PollsCmd>) -> WaitEnd {
    match cmd {
        None | Some(PollsCmd::Shutdown) => WaitEnd::Shutdown,
        Some(PollsCmd::SetChannel(login)) => {
            if active.as_deref() == Some(login.as_str()) {
                WaitEnd::Tick
            } else {
                *active = Some(login);
                WaitEnd::Changed
            }
        }
        Some(PollsCmd::ClearChannel) => {
            if active.is_none() {
                WaitEnd::Tick
            } else {
                *active = None;
                WaitEnd::Changed
            }
        }
        Some(PollsCmd::Relogin) => WaitEnd::Changed,
    }
}

async fn wait_until_change(
    rx: &mut mpsc::UnboundedReceiver<PollsCmd>,
    active: &mut Option<String>,
) -> WaitEnd {
    apply_cmd(active, rx.recv().await)
}

enum SessionEnd {
    Reconnect,
    ReconnectTo(String),
    AuthDenied,
    Changed,
    Shutdown,
}

async fn connect_eventsub(
    app: &AppHandle,
    shared: &Shared,
    wanted: Wanted,
    rx: &mut mpsc::UnboundedReceiver<PollsCmd>,
    active: &mut Option<String>,
    ws_url: &str,
) -> SessionEnd {
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_FRAME))
        .read_buffer_size(32 * 1024);
    let Ok(Ok((stream, _))) = tokio::time::timeout(
        Duration::from_secs(12),
        tokio_tungstenite::connect_async_with_config(ws_url, Some(cfg), false),
    )
    .await
    else {
        return SessionEnd::Reconnect;
    };
    let (mut write, mut read) = stream.split();
    let mut subscribed = false;
    let mut live = LivePanels::default();
    let mut snapshot_tick = tokio::time::interval(SNAPSHOT_INTERVAL);
    snapshot_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        if shared.polls_shutdown.load(Ordering::SeqCst) {
            let _ = write.send(Message::Close(None)).await;
            return SessionEnd::Shutdown;
        }
        tokio::select! {
            cmd = rx.recv() => {
                match apply_cmd(active, cmd) {
                    WaitEnd::Shutdown => {
                        let _ = write.send(Message::Close(None)).await;
                        return SessionEnd::Shutdown;
                    }
                    WaitEnd::Changed => {
                        let _ = write.send(Message::Close(None)).await;
                        return SessionEnd::Changed;
                    }
                    WaitEnd::Tick => {}
                }
            }
            _ = snapshot_tick.tick() => {
                if subscribed {
                    refresh_snapshot(app, &wanted, &mut live).await;
                }
            }
            incoming = read.next() => {
                let Some(Ok(msg)) = incoming else {
                    return SessionEnd::Reconnect;
                };
                match msg {
                    Message::Text(text) => {
                        match handle_eventsub_text(app, &wanted, text.as_str()).await {
                            EventAction::Ready(session_id) => {
                                match create_subscriptions(&wanted, &session_id).await {
                                    SubResult::Ok => {
                                        subscribed = true;
                                        refresh_snapshot(app, &wanted, &mut live).await;
                                    }
                                    SubResult::AuthDenied => {
                                        return SessionEnd::AuthDenied;
                                    }
                                    SubResult::Retry => {
                                        refresh_snapshot(app, &wanted, &mut live).await;
                                        return SessionEnd::Reconnect;
                                    }
                                }
                            }
                            EventAction::Notification(panel) => {
                                live.upsert(panel);
                                emit_live(app, &wanted.login, &live);
                            }
                            EventAction::ReconnectTo(url) => {
                                return SessionEnd::ReconnectTo(url);
                            }
                            EventAction::Reconnect => return SessionEnd::Reconnect,
                            EventAction::None => {}
                        }
                    }
                    Message::Ping(p) => {
                        if write.send(Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect;
                        }
                    }
                    Message::Close(_) => return SessionEnd::Reconnect,
                    _ => {}
                }
            }
        }
    }
}

enum EventAction {
    Ready(String),
    Notification(PollPanel),
    Reconnect,
    ReconnectTo(String),
    None,
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

async fn handle_eventsub_text(app: &AppHandle, wanted: &Wanted, text: &str) -> EventAction {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return EventAction::None;
    };
    let msg_type = value
        .pointer("/metadata/message_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    match msg_type {
        "session_welcome" => {
            let session_id = value
                .pointer("/payload/session/id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if session_id.is_empty() {
                EventAction::Reconnect
            } else {
                EventAction::Ready(session_id.to_string())
            }
        }
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
        "notification" => {
            let sub_type = value
                .pointer("/payload/subscription/type")
                .and_then(Value::as_str)
                .unwrap_or("");
            let event = value.pointer("/payload/event").unwrap_or(&Value::Null);
            let kind = SUB_TYPES
                .iter()
                .find_map(|(t, k)| (*t == sub_type).then_some(*k));
            let Some(kind) = kind else {
                return EventAction::None;
            };
            parse_event_panel(kind, event)
                .map(EventAction::Notification)
                .unwrap_or(EventAction::None)
        }
        "revocation" => {
            emit_clear(app, &wanted.login);
            EventAction::Reconnect
        }
        _ => EventAction::None,
    }
}

async fn create_subscriptions(wanted: &Wanted, session_id: &str) -> SubResult {
    let mut ok = 0u32;
    let mut denied = 0u32;
    for (sub_type, _) in SUB_TYPES {
        match post_eventsub_subscription(wanted, session_id, sub_type).await {
            SubAttempt::Ok => ok += 1,
            SubAttempt::AuthDenied => denied += 1,
            SubAttempt::Retry => {}
        }
    }
    if ok > 0 {
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
        "condition": { "broadcaster_user_id": wanted.broadcaster_id },
        "transport": { "method": "websocket", "session_id": session_id },
    });
    let client = http_client(Duration::from_secs(12));
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

async fn refresh_snapshot(app: &AppHandle, wanted: &Wanted, live: &mut LivePanels) {
    let (polls, predictions) = tokio::join!(fetch_polls(wanted), fetch_predictions(wanted));
    let mut panels = Vec::new();
    if let Some(poll) = polls
        .iter()
        .find(|p| p.status == "ACTIVE")
        .cloned()
        .or_else(|| {
            polls.into_iter().find(|p| {
                matches!(
                    p.status.as_str(),
                    "COMPLETED" | "TERMINATED" | "ARCHIVED" | "MODERATED"
                )
            })
        })
    {
        panels.push(poll);
    }
    if let Some(prediction) = predictions
        .iter()
        .find(|p| matches!(p.status.as_str(), "ACTIVE" | "LOCKED"))
        .cloned()
        .or_else(|| {
            predictions
                .into_iter()
                .find(|p| matches!(p.status.as_str(), "RESOLVED" | "CANCELED" | "CANCELLED"))
        })
    {
        panels.push(prediction);
    }
    live.replace_from_snapshot(panels);
    emit_live(app, &wanted.login, live);
}

fn emit_live(app: &AppHandle, channel: &str, live: &LivePanels) {
    let _ = app.emit(
        CHAT_POLLS_EVENT,
        PollsPayload {
            channel: channel.to_string(),
            panels: live.to_vec(),
        },
    );
}

#[derive(Debug, Default, Clone)]
struct LivePanels {
    poll: Option<PollPanel>,
    prediction: Option<PollPanel>,
}

impl LivePanels {
    fn upsert(&mut self, panel: PollPanel) {
        match panel.kind {
            PanelKind::Poll => self.poll = Some(panel),
            PanelKind::Prediction => self.prediction = Some(panel),
        }
    }

    fn replace_from_snapshot(&mut self, panels: Vec<PollPanel>) {
        self.poll = None;
        self.prediction = None;
        for panel in panels {
            self.upsert(panel);
        }
    }

    fn to_vec(&self) -> Vec<PollPanel> {
        let mut out = Vec::with_capacity(2);
        if let Some(panel) = self.poll.clone() {
            out.push(panel);
        }
        if let Some(panel) = self.prediction.clone() {
            out.push(panel);
        }
        out
    }
}

async fn fetch_polls(wanted: &Wanted) -> Vec<PollPanel> {
    let url = helix_query(
        "/polls",
        &[
            ("broadcaster_id", wanted.broadcaster_id.as_str()),
            ("first", "1"),
        ],
    );
    get_json(wanted, &url)
        .await
        .and_then(|v| v.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| parse_helix_poll(&v))
        .collect()
}

async fn fetch_predictions(wanted: &Wanted) -> Vec<PollPanel> {
    let url = helix_query(
        "/predictions",
        &[
            ("broadcaster_id", wanted.broadcaster_id.as_str()),
            ("first", "1"),
        ],
    );
    get_json(wanted, &url)
        .await
        .and_then(|v| v.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| parse_helix_prediction(&v))
        .collect()
}

async fn get_json(wanted: &Wanted, url: &str) -> Option<Value> {
    let client = http_client(Duration::from_secs(12));
    let mut delay = RETRY_BASE;
    for attempt in 0..ATTEMPTS {
        match client
            .get(url)
            .header("Client-Id", &wanted.client_id)
            .header("Authorization", format!("Bearer {}", wanted.token))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
                Ok(v) => return Some(v),
                Err(_) => {}
            },
            Ok(resp) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
                return None;
            }
            Ok(_) | Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    None
}

fn parse_event_panel(kind: PanelKind, value: &Value) -> Option<PollPanel> {
    match kind {
        PanelKind::Poll => parse_poll_common(value),
        PanelKind::Prediction => parse_prediction_common(value),
    }
}

fn parse_helix_poll(value: &Value) -> Option<PollPanel> {
    parse_poll_common(value)
}

fn parse_helix_prediction(value: &Value) -> Option<PollPanel> {
    parse_prediction_common(value)
}

fn parse_poll_common(value: &Value) -> Option<PollPanel> {
    let id = clean_id(value.get("id")?.as_str()?)?;
    let title = clean_title(value.get("title")?.as_str()?, 160)?;
    let status = clean_status(
        value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("ACTIVE"),
    );
    let started_at = clean_time(value.get("started_at").and_then(Value::as_str));
    let ends_at = clean_time(value.get("ends_at").and_then(Value::as_str)).or_else(|| {
        derive_ends_at(
            started_at.as_deref(),
            value.get("duration").and_then(Value::as_u64),
        )
    });
    let ended_at = clean_time(value.get("ended_at").and_then(Value::as_str));
    let mut options: Vec<PollOption> = value
        .get("choices")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(parse_poll_choice)
        .collect();
    if options.is_empty() {
        return None;
    }
    let winning = winner_id(&options, status.as_str() == "COMPLETED");
    if let Some(winner) = winning.as_deref() {
        for option in &mut options {
            option.is_winner = option.id == winner;
        }
    }
    let total_votes = options.iter().map(|o| o.votes).sum();
    Some(PollPanel {
        kind: PanelKind::Poll,
        id,
        title,
        status,
        started_at,
        ends_at,
        ended_at,
        locked_at: None,
        winning_option_id: winning,
        total_votes,
        options,
    })
}

fn parse_prediction_common(value: &Value) -> Option<PollPanel> {
    let id = clean_id(value.get("id")?.as_str()?)?;
    let title = clean_title(value.get("title")?.as_str()?, 160)?;
    let status = clean_status(
        value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("ACTIVE"),
    );
    let started_at = clean_time(
        value
            .get("started_at")
            .or_else(|| value.get("created_at"))
            .and_then(Value::as_str),
    );
    let ends_at = clean_time(
        value
            .get("locks_at")
            .or_else(|| value.get("locked_at"))
            .and_then(Value::as_str),
    )
    .or_else(|| {
        derive_ends_at(
            started_at.as_deref(),
            value.get("prediction_window").and_then(Value::as_u64),
        )
    });
    let ended_at = clean_time(value.get("ended_at").and_then(Value::as_str));
    let winning_option_id = value
        .get("winning_outcome_id")
        .and_then(Value::as_str)
        .and_then(clean_id);
    let mut options: Vec<PollOption> = value
        .get("outcomes")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(parse_prediction_outcome)
        .collect();
    if options.is_empty() {
        return None;
    }
    if let Some(winner) = winning_option_id.as_deref() {
        for option in &mut options {
            option.is_winner = option.id == winner;
        }
    }
    let total_votes = options.iter().map(|o| o.votes).sum();
    Some(PollPanel {
        kind: PanelKind::Prediction,
        id,
        title,
        status,
        started_at,
        ends_at,
        ended_at,
        locked_at: clean_time(value.get("locked_at").and_then(Value::as_str)),
        winning_option_id,
        total_votes,
        options,
    })
}

fn parse_poll_choice(value: &Value) -> Option<PollOption> {
    Some(PollOption {
        id: clean_id(value.get("id")?.as_str()?)?,
        title: clean_title(value.get("title")?.as_str()?, 80)?,
        votes: number_field(value, &["votes"]),
        points: Some(number_field(value, &["channel_points_votes"])).filter(|n| *n > 0),
        color: None,
        is_winner: false,
    })
}

fn parse_prediction_outcome(value: &Value) -> Option<PollOption> {
    Some(PollOption {
        id: clean_id(value.get("id")?.as_str()?)?,
        title: clean_title(value.get("title")?.as_str()?, 80)?,
        votes: number_field(value, &["users"]),
        points: Some(number_field(value, &["channel_points"])).filter(|n| *n > 0),
        color: value
            .get("color")
            .and_then(Value::as_str)
            .and_then(clean_prediction_color),
        is_winner: false,
    })
}

fn number_field(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
        .unwrap_or(0)
}

fn winner_id(options: &[PollOption], finished: bool) -> Option<String> {
    if !finished {
        return None;
    }
    let max = options.iter().map(|o| o.votes).max().unwrap_or(0);
    if max == 0 {
        return None;
    }
    let winners = options
        .iter()
        .filter(|o| o.votes == max)
        .map(|o| o.id.as_str())
        .collect::<HashSet<_>>();
    if winners.len() == 1 {
        winners.iter().next().map(|id| (*id).to_string())
    } else {
        None
    }
}

fn clean_id(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 128 {
        return None;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return None;
    }
    Some(s.to_string())
}

fn clean_title(raw: &str, max: usize) -> Option<String> {
    let mut s = String::new();
    for c in raw.trim().chars().take(max + 1) {
        if matches!(c, '\0' | '\r' | '\n' | '\u{0001}') {
            continue;
        }
        s.push(c);
    }
    let out: String = s.chars().take(max).collect();
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn clean_status(raw: &str) -> String {
    let s = raw.trim().to_ascii_uppercase();
    match s.as_str() {
        "ACTIVE" | "COMPLETED" | "TERMINATED" | "ARCHIVED" | "MODERATED" | "INVALID" | "LOCKED"
        | "RESOLVED" | "CANCELED" | "CANCELLED" => s,
        _ => "ACTIVE".to_string(),
    }
}

fn clean_prediction_color(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "blue" => Some("blue".to_string()),
        "pink" => Some("pink".to_string()),
        _ => None,
    }
}

fn clean_reconnect_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "wss" {
        return None;
    }
    if url.host_str() != Some("eventsub.wss.twitch.tv") {
        return None;
    }
    if url.path().is_empty() {
        return None;
    }
    Some(url.to_string())
}

fn clean_time(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '.' | 'Z' | '+'))
    {
        Some(s.to_string())
    } else {
        None
    }
}

fn derive_ends_at(started_at: Option<&str>, duration: Option<u64>) -> Option<String> {
    let (Some(started_at), Some(duration)) = (started_at, duration) else {
        return None;
    };
    let parsed = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    parsed
        .checked_add_signed(chrono::Duration::seconds(duration.min(86_400) as i64))
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
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

fn http_client(timeout: Duration) -> reqwest::Client {
    super::http_client::build(timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_poll_marks_single_finished_winner() {
        let v = json!({
            "id": "poll-1",
            "title": "Next game?",
            "status": "COMPLETED",
            "started_at": "2024-01-01T00:00:00Z",
            "duration": 60,
            "choices": [
                { "id": "a", "title": "A", "votes": 2 },
                { "id": "b", "title": "B", "votes": 5 }
            ]
        });
        let panel = parse_helix_poll(&v).expect("poll");
        assert_eq!(panel.ends_at.as_deref(), Some("2024-01-01T00:01:00.000Z"));
        assert_eq!(panel.winning_option_id.as_deref(), Some("b"));
        assert!(panel.options[1].is_winner);
    }

    #[test]
    fn parse_prediction_uses_channel_points() {
        let v = json!({
            "id": "pred-1",
            "title": "Win?",
            "status": "RESOLVED",
            "winning_outcome_id": "yes",
            "outcomes": [
                { "id": "yes", "title": "Yes", "users": 10, "channel_points": 1000, "color": "blue" },
                { "id": "no", "title": "No", "users": 3, "channel_points": 400, "color": "pink" }
            ]
        });
        let panel = parse_helix_prediction(&v).expect("prediction");
        assert_eq!(panel.total_votes, 13);
        assert_eq!(panel.options[0].points, Some(1000));
        assert!(panel.options[0].is_winner);
    }

    #[test]
    fn parse_helix_prediction_uses_created_at_window() {
        let v = json!({
            "id": "pred-2",
            "title": "Leeks?",
            "status": "ACTIVE",
            "prediction_window": 120,
            "created_at": "2021-04-28T17:11:22.595Z",
            "locked_at": null,
            "outcomes": [
                { "id": "yes", "title": "Yes", "users": 1, "channel_points": 10, "color": "BLUE" },
                { "id": "no", "title": "No", "users": 0, "channel_points": 0, "color": "PINK" }
            ]
        });
        let panel = parse_helix_prediction(&v).expect("prediction");
        assert_eq!(
            panel.started_at.as_deref(),
            Some("2021-04-28T17:11:22.595Z")
        );
        assert_eq!(panel.ends_at.as_deref(), Some("2021-04-28T17:13:22.595Z"));
        assert_eq!(panel.options[0].color.as_deref(), Some("blue"));
    }

    #[test]
    fn reconnect_url_must_be_eventsub_wss() {
        assert!(clean_reconnect_url("wss://eventsub.wss.twitch.tv/ws?session_id=abc").is_some());
        assert!(clean_reconnect_url("https://eventsub.wss.twitch.tv/ws").is_none());
        assert!(clean_reconnect_url("wss://evil.example/ws").is_none());
    }
}
