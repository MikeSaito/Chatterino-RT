use std::time::{Duration, Instant};

use futures_util::{Sink, SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::cheers::attach_cheers;
use super::constants::BATCH_FLUSH_MS;
use super::emotes::attach_third_party;
use super::fetch;
use super::helix::resolve_badge_urls;
use super::parse::{parse_line, ParsedLine};
use super::spans::decorate_text_spans;
use super::state::Shared;
use super::types::{ChatConnState, ChatEvent, ChatStatus};

const IRC_URL: &str = "wss://irc-ws.chat.twitch.tv:443";
const CLIENT_PING: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone)]
pub enum IrcCmd {
    Join(String),
    Part,
    Shutdown,
}

pub fn start(app: AppHandle, shared: Shared) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<IrcCmd>(32);
    {
        let mut slot = shared.irc_tx.lock().map_err(|e| e.to_string())?;
        *slot = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_loop(app, shared, rx).await;
    });
    Ok(())
}

async fn run_loop(app: AppHandle, shared: Shared, mut rx: mpsc::Receiver<IrcCmd>) {
    fetch::load_globals(&shared.catalog, &shared.badges).await;
    let mut wanted: Option<String> = None;
    let mut join_blocked = false;
    let mut last_error: Option<String> = None;
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_session(
            &app,
            &shared,
            &mut rx,
            &mut wanted,
            &mut join_blocked,
            &mut last_error,
            &mut backoff,
        )
        .await
        {
            SessionEnd::Shutdown => break,
            SessionEnd::Reconnect => {
                emit_status(&app, ChatConnState::Reconnecting, wanted.as_deref(), None);
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
                            None | Some(IrcCmd::Shutdown) => break,
                            Some(IrcCmd::Join(ch)) => {
                                wanted = Some(ch);
                                join_blocked = false;
                                last_error = None;
                                backoff = Duration::from_secs(1);
                            }
                            Some(IrcCmd::Part) => {
                                wanted = None;
                                join_blocked = false;
                                last_error = None;
                            }
                        }
                    }
                }
            }
        }
    }
}

enum SessionEnd {
    Shutdown,
    Reconnect,
}

async fn connect_session(
    app: &AppHandle,
    shared: &Shared,
    rx: &mut mpsc::Receiver<IrcCmd>,
    wanted: &mut Option<String>,
    join_blocked: &mut bool,
    last_error: &mut Option<String>,
    backoff: &mut Duration,
) -> SessionEnd {
    if *join_blocked {
        emit_status(
            app,
            ChatConnState::Error,
            wanted.as_deref(),
            last_error.as_deref(),
        );
    } else {
        emit_status(app, ChatConnState::Connecting, wanted.as_deref(), None);
    }
    let Ok(Ok((stream, _))) =
        tokio::time::timeout(Duration::from_secs(12), tokio_tungstenite::connect_async(IRC_URL)).await
    else {
        return SessionEnd::Reconnect;
    };
    *backoff = Duration::from_secs(1);
    let (mut write, mut read) = stream.split();
    let (nick, pass) = credentials();
    let mut hello = vec!["CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership".to_string()];
    if let Some(token) = pass {
        hello.push(format!("PASS oauth:{token}"));
    }
    hello.push(format!("NICK {nick}"));
    for line in &hello {
        if send_line(&mut write, line).await.is_err() {
            return SessionEnd::Reconnect;
        }
    }
    if !*join_blocked {
        if let Some(ch) = wanted.clone() {
            if send_line(&mut write, &format!("JOIN #{ch}")).await.is_err() {
                return SessionEnd::Reconnect;
            }
        }
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(BATCH_FLUSH_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ping_at = tokio::time::interval_at(
        tokio::time::Instant::now() + CLIENT_PING,
        CLIENT_PING,
    );
    ping_at.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pong_deadline: Option<Instant> = None;
    let mut loaded_room: Option<(String, String)> = None;
    let mut in_room = false;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                flush_emit(app, shared);
                if pong_deadline.is_some_and(|d| Instant::now() >= d) {
                    return SessionEnd::Reconnect;
                }
            }
            _ = ping_at.tick() => {
                if pong_deadline.is_some() {
                    return SessionEnd::Reconnect;
                }
                if send_line(&mut write, "PING :webtv").await.is_err() {
                    return SessionEnd::Reconnect;
                }
                pong_deadline = Some(Instant::now() + PONG_TIMEOUT);
            }
            cmd = rx.recv() => {
                match cmd {
                    None | Some(IrcCmd::Shutdown) => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Shutdown;
                    }
                    Some(IrcCmd::Part) => {
                        if let Some(ch) = wanted.take() {
                            let _ = send_line(&mut write, &format!("PART #{ch}")).await;
                        }
                        loaded_room = None;
                        in_room = false;
                        *join_blocked = false;
                        *last_error = None;
                        emit_status(app, ChatConnState::Connected, None, None);
                    }
                    Some(IrcCmd::Join(ch)) => {
                        *join_blocked = false;
                        *last_error = None;
                        if wanted.as_deref() == Some(ch.as_str()) {
                            if in_room {
                                emit_status(app, ChatConnState::Connected, Some(&ch), None);
                                continue;
                            }
                            emit_status(app, ChatConnState::Connecting, Some(&ch), None);
                            if send_line(&mut write, &format!("JOIN #{ch}")).await.is_err() {
                                return SessionEnd::Reconnect;
                            }
                            continue;
                        }
                        in_room = false;
                        emit_status(app, ChatConnState::Connecting, Some(&ch), None);
                        if let Some(prev) = wanted.replace(ch.clone()) {
                            let _ = send_line(&mut write, &format!("PART #{prev}")).await;
                        }
                        loaded_room = None;
                        if send_line(&mut write, &format!("JOIN #{ch}")).await.is_err() {
                            return SessionEnd::Reconnect;
                        }
                    }
                }
            }
            incoming = read.next() => {
                match incoming {
                    None => return SessionEnd::Reconnect,
                    Some(Err(_)) => return SessionEnd::Reconnect,
                    Some(Ok(Message::Close(_))) => return SessionEnd::Reconnect,
                    Some(Ok(Message::Ping(p))) => {
                        if send_ws(&mut write, Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        for raw in text.as_str().replace('\r', "").split('\n') {
                            if raw.is_empty() { continue; }
                            match dispatch_line(app, shared, raw, wanted, &nick, &mut loaded_room) {
                                LineAction::None => {}
                                LineAction::Pong(pong) => {
                                    if send_line(&mut write, &pong).await.is_err() {
                                        return SessionEnd::Reconnect;
                                    }
                                }
                                LineAction::PongAck => {
                                    pong_deadline = None;
                                }
                                LineAction::Joined => {
                                    in_room = true;
                                }
                                LineAction::LeftRoom => {
                                    in_room = false;
                                }
                                LineAction::JoinFailed(msg) => {
                                    in_room = false;
                                    *join_blocked = true;
                                    *last_error = Some(msg);
                                }
                                LineAction::Reconnect => return SessionEnd::Reconnect,
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

async fn send_line<S>(write: &mut S, line: &str) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
{
    send_ws(write, Message::Text(format!("{line}\r\n").into())).await
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

enum LineAction {
    None,
    Pong(String),
    PongAck,
    Joined,
    LeftRoom,
    JoinFailed(String),
    Reconnect,
}

fn dispatch_line(
    app: &AppHandle,
    shared: &Shared,
    raw: &str,
    wanted: &Option<String>,
    nick: &str,
    loaded_room: &mut Option<(String, String)>,
) -> LineAction {
    let now = unix_ms();
    match parse_line(raw, now) {
        ParsedLine::Ping(payload) => {
            if payload.is_empty() {
                LineAction::Pong("PONG".into())
            } else {
                LineAction::Pong(format!("PONG :{payload}"))
            }
        }
        ParsedLine::Pong => LineAction::PongAck,
        ParsedLine::Reconnect => LineAction::Reconnect,
        ParsedLine::Ready => {
            if wanted.is_none() {
                emit_status(app, ChatConnState::Connected, None, None);
            }
            LineAction::None
        }
        ParsedLine::Membership {
            part,
            channel,
            login,
        } => {
            if part && login == nick && wanted.as_deref() == Some(channel.as_str()) {
                emit_status(app, ChatConnState::Connecting, Some(&channel), None);
                LineAction::LeftRoom
            } else {
                LineAction::None
            }
        }
        ParsedLine::Event {
            channel,
            mut event,
            room_id,
        } => {
            let joined = matches!(&event, ChatEvent::Roomstate { .. })
                && wanted.as_deref() == Some(channel.as_str());
            if joined {
                emit_status(app, ChatConnState::Connected, Some(&channel), None);
            }
            let mut failed: Option<String> = None;
            if let ChatEvent::Notice { id, text, .. } = &event {
                if wanted.as_deref() == Some(channel.as_str()) && is_join_failure(id) {
                    emit_status(app, ChatConnState::Error, Some(&channel), Some(text));
                    failed = Some(text.clone());
                }
            }
            if let (Some(id), Some(login)) = (room_id.as_deref(), wanted.as_deref()) {
                if login == channel {
                    let need = loaded_room
                        .as_ref()
                        .map(|(c, r)| c != login || r != id)
                        .unwrap_or(true);
                    if need {
                        *loaded_room = Some((login.to_string(), id.to_string()));
                        let cat = shared.catalog.clone();
                        let badges = shared.badges.clone();
                        let cheers = shared.cheers.clone();
                        let hub = shared.hub.clone();
                        let login_s = login.to_string();
                        let id_s = id.to_string();
                        tauri::async_runtime::spawn(async move {
                            fetch::load_channel(&cat, &badges, &cheers, &hub, &login_s, &id_s)
                                .await;
                        });
                    }
                }
            }
            decorate_event(&mut event, shared, &channel);
            let batch = shared
                .hub
                .lock()
                .ok()
                .and_then(|mut hub| hub.ingest(&channel, event));
            if let Some(batch) = batch {
                let _ = app.emit("chat:batch", &batch);
            }
            if let Some(msg) = failed {
                LineAction::JoinFailed(msg)
            } else if joined {
                LineAction::Joined
            } else {
                LineAction::None
            }
        }
        ParsedLine::Ignore => LineAction::None,
    }
}

fn is_join_failure(msg_id: &str) -> bool {
    matches!(
        msg_id,
        "msg_banned"
            | "msg_channel_suspended"
            | "msg_channel_blocked"
            | "msg_suspended"
            | "msg_room_not_found"
            | "msg_requires_verified_phone_number"
            | "tos_ban"
            | "no_permission"
    )
}

fn emit_status(app: &AppHandle, state: ChatConnState, channel: Option<&str>, message: Option<&str>) {
    let _ = app.emit(
        "chat:status",
        ChatStatus {
            state,
            channel: channel.map(str::to_string),
            message: message.map(str::to_string),
        },
    );
}

fn flush_emit(app: &AppHandle, shared: &Shared) {
    let batches = match shared.hub.lock() {
        Ok(mut hub) => hub.flush_all(),
        Err(_) => return,
    };
    for batch in batches {
        let _ = app.emit("chat:batch", &batch);
    }
}

pub(crate) fn decorate_event(event: &mut ChatEvent, shared: &Shared, channel: &str) {
    match event {
        ChatEvent::Privmsg {
            text,
            emote_spans,
            link_spans,
            mention_spans,
            badges,
            bits,
            ..
        } => {
            if let Some(n) = *bits {
                if let Ok(cat) = shared.cheers.lock() {
                    let extra = attach_cheers(text, emote_spans, &cat, channel, n);
                    emote_spans.extend(extra);
                }
            }
            if let Ok(cat) = shared.catalog.lock() {
                let extra = attach_third_party(text, emote_spans, &cat, channel);
                emote_spans.extend(extra);
            }
            if let Ok(cat) = shared.badges.lock() {
                resolve_badge_urls(badges, &cat, channel);
            }
            emote_spans.sort_by_key(|s| s.start);
            let (links, mentions) = decorate_text_spans(text, emote_spans);
            *link_spans = links;
            *mention_spans = mentions;
        }
        ChatEvent::Usernotice {
            privmsg: Some(inner),
            ..
        } => {
            decorate_event(inner, shared, channel);
        }
        _ => {}
    }
}

fn credentials() -> (String, Option<String>) {
    let login = std::env::var("TWITCH_LOGIN")
        .ok()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && s != "your_login_here");
    let token = std::env::var("TWITCH_OAUTH_TOKEN").ok().and_then(|s| {
        let t = s.trim().trim_start_matches("oauth:").to_string();
        if t.is_empty() || t == "YOUR_API_KEY_HERE" {
            None
        } else {
            Some(t)
        }
    });
    match (login, token) {
        (Some(l), Some(t)) => (l, Some(t)),
        _ => {
            let n = unix_ms() % 90_000 + 10_000;
            (format!("justinfan{n}"), None)
        }
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
