use std::time::Duration;

use futures_util::{Sink, SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::constants::BATCH_FLUSH_MS;
use super::emotes::attach_third_party;
use super::fetch;
use super::parse::{parse_line, ParsedLine};
use super::state::Shared;
use super::types::ChatEvent;

const IRC_URL: &str = "wss://irc-ws.chat.twitch.tv:443";

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
    fetch::load_globals(&shared.catalog).await;
    let mut wanted: Option<String> = None;
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_session(&app, &shared, &mut rx, &mut wanted, &mut backoff).await {
            SessionEnd::Shutdown => break,
            SessionEnd::Reconnect => {
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
                                backoff = Duration::from_secs(1);
                            }
                            Some(IrcCmd::Part) => {
                                wanted = None;
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
    backoff: &mut Duration,
) -> SessionEnd {
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
    if let Some(ch) = wanted.clone() {
        if send_line(&mut write, &format!("JOIN #{ch}")).await.is_err() {
            return SessionEnd::Reconnect;
        }
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(BATCH_FLUSH_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut loaded_room: Option<(String, String)> = None;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                flush_emit(app, shared);
            }
            cmd = rx.recv() => {
                match cmd {
                    None | Some(IrcCmd::Shutdown) => {
                        let _ = write.send(Message::Close(None)).await;
                        return SessionEnd::Shutdown;
                    }
                    Some(IrcCmd::Part) => {
                        if let Some(ch) = wanted.take() {
                            let _ = send_line(&mut write, &format!("PART #{ch}")).await;
                        }
                        loaded_room = None;
                    }
                    Some(IrcCmd::Join(ch)) => {
                        if let Some(prev) = wanted.replace(ch.clone()) {
                            if prev != ch {
                                let _ = send_line(&mut write, &format!("PART #{prev}")).await;
                            }
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
                        if write.send(Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        for raw in text.as_str().replace('\r', "").split('\n') {
                            if raw.is_empty() { continue; }
                            match dispatch_line(app, shared, raw, wanted, &mut loaded_room) {
                                LineAction::None => {}
                                LineAction::Pong(pong) => {
                                    if send_line(&mut write, &pong).await.is_err() {
                                        return SessionEnd::Reconnect;
                                    }
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
    write
        .send(Message::Text(format!("{line}\r\n").into()))
        .await
        .map_err(|_| ())
}

enum LineAction {
    None,
    Pong(String),
    Reconnect,
}

fn dispatch_line(
    app: &AppHandle,
    shared: &Shared,
    raw: &str,
    wanted: &Option<String>,
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
        ParsedLine::Reconnect => LineAction::Reconnect,
        ParsedLine::Event {
            channel,
            mut event,
            room_id,
        } => {
            if let (Some(id), Some(login)) = (room_id.as_deref(), wanted.as_deref()) {
                let need = loaded_room
                    .as_ref()
                    .map(|(c, r)| c != login || r != id)
                    .unwrap_or(true);
                if need {
                    *loaded_room = Some((login.to_string(), id.to_string()));
                    let cat = shared.catalog.clone();
                    let login_s = login.to_string();
                    let id_s = id.to_string();
                    tauri::async_runtime::spawn(async move {
                        fetch::load_channel(&cat, &login_s, &id_s).await;
                    });
                }
            }
            if let ChatEvent::Privmsg {
                ref text,
                ref mut emote_spans,
                ..
            } = event
            {
                if let Ok(cat) = shared.catalog.lock() {
                    let extra = attach_third_party(text, emote_spans, &cat, &channel);
                    emote_spans.extend(extra);
                    emote_spans.sort_by_key(|s| s.start);
                }
            }
            let batch = shared
                .hub
                .lock()
                .ok()
                .and_then(|mut hub| hub.ingest(&channel, event));
            if let Some(batch) = batch {
                let _ = app.emit("chat:batch", &batch);
            }
            LineAction::None
        }
        ParsedLine::Ready | ParsedLine::Ignore => LineAction::None,
    }
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
