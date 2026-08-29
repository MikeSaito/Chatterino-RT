use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use futures_util::{Sink, SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::auth;
use super::cheers::attach_cheers;
use super::constants::BATCH_FLUSH_MS;
use super::emoji::attach_emoji;
use super::emotes::{attach_third_party, resolve_overlays};
use super::fetch;
use super::helix::resolve_badge_urls;
use super::parse::{
    parse_line, shift_emote_spans_back, strip_leading_reply_mention, synthetic_id, ParsedLine,
};
use super::spans::{decorate_text_spans_ex, FindMentions};
use super::state::{BttvCmd, EventCmd, IrcCmd, Shared};
use super::types::{ChatConnState, ChatEvent, ChatPipe, ChatSendWait, ChatStatus};

const IRC_URL: &str = "wss://irc-ws.chat.twitch.tv:443";
const CLIENT_PING: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(8);

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
    if let Ok(mut cat) = shared.badges.lock() {
        super::badge_fallback::seed_global(&mut cat);
    }
    // Emote/badge HTTP must not block IRC — slow BTTV/FFZ/7TV (retries×12s) left chat
    // empty for minutes while Join sat in the mpsc queue.
    {
        let shared_bg = shared.clone();
        tauri::async_runtime::spawn(async move {
            let flags = fetch::EmoteProviderFlags::from_shared(&shared_bg);
            let (globals_result, _, _) = tokio::join!(
                fetch::load_globals(&shared_bg.catalog, flags),
                super::ffz_badges::load(&shared_bg.ffz_badges),
                super::chatterino_badges::load(&shared_bg.chatterino_badges),
            );
            if let Ok(set_id) = globals_result {
                if flags.seventv_global {
                    if let Some(set_id) = set_id {
                        shared_bg.notify_event(EventCmd::SetGlobal { set_id });
                    }
                } else {
                    shared_bg.notify_event(EventCmd::ClearGlobal);
                }
            }
            super::twitch_blocks::spawn_load_if_enabled(&shared_bg);
        });
    }
    let mut wanted: HashSet<String> = HashSet::new();
    let mut last_error: Option<String> = None;
    let mut backoff = Duration::from_secs(1);
    let mut pending_out: VecDeque<(String, String, Option<String>)> = VecDeque::new();
    loop {
        match connect_session(
            &app,
            &shared,
            &mut rx,
            &mut wanted,
            &mut last_error,
            &mut backoff,
            &mut pending_out,
        )
        .await
        {
            SessionEnd::Shutdown => break,
            SessionEnd::Reconnect { wait } => {
                if let Ok(mut hub) = shared.hub.lock() {
                    hub.mark_disconnect_at(&wanted, unix_ms());
                }
                let status_ch = status_channel(&shared, &wanted);
                emit_status(
                    &app,
                    ChatConnState::Reconnecting,
                    status_ch.as_deref(),
                    None,
                );
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
                            None | Some(IrcCmd::Shutdown) => break,
                            Some(IrcCmd::Join(ch)) => {
                                wanted.insert(ch);
                                last_error = None;
                                backoff = Duration::from_secs(1);
                            }
                            Some(IrcCmd::PartChannel(ch)) => {
                                wanted.remove(&ch);
                                last_error = None;
                                release_pending_channel(&mut pending_out, &ch, &shared);
                            }
                            Some(IrcCmd::Part) => {
                                wanted.clear();
                                last_error = None;
                                clear_pending_out(&mut pending_out, &shared);
                            }
                            Some(IrcCmd::Privmsg {
                                channel,
                                text,
                                reply_to,
                            }) => {
                                enqueue_pending_out(&mut pending_out, channel, text, reply_to);
                            }
                            Some(IrcCmd::Relogin) => {
                                backoff = Duration::from_secs(1);
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
    Reconnect { wait: bool },
}

async fn connect_session(
    app: &AppHandle,
    shared: &Shared,
    rx: &mut mpsc::Receiver<IrcCmd>,
    wanted: &mut HashSet<String>,
    last_error: &mut Option<String>,
    backoff: &mut Duration,
    pending_out: &mut VecDeque<(String, String, Option<String>)>,
) -> SessionEnd {
    let status_ch = status_channel(shared, wanted);
    emit_status(app, ChatConnState::Connecting, status_ch.as_deref(), None);
    let Ok(Ok((stream, _))) = tokio::time::timeout(
        Duration::from_secs(12),
        tokio_tungstenite::connect_async(IRC_URL),
    )
    .await
    else {
        return SessionEnd::Reconnect { wait: true };
    };
    *backoff = Duration::from_secs(1);
    let (mut write, mut read) = stream.split();
    let (nick, pass) = credentials(shared);
    let authed = pass.is_some();
    let mut hello =
        vec!["CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership".to_string()];
    if let Some(token) = pass {
        hello.push(format!("PASS oauth:{token}"));
    }
    hello.push(format!("NICK {nick}"));
    for line in &hello {
        if send_line(&mut write, line).await.is_err() {
            return SessionEnd::Reconnect { wait: true };
        }
    }
    if authed {
        spawn_helix_globals(shared);
    }
    for ch in wanted.iter() {
        if send_line(&mut write, &format!("JOIN #{ch}")).await.is_err() {
            return SessionEnd::Reconnect { wait: true };
        }
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(BATCH_FLUSH_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ping_at =
        tokio::time::interval_at(tokio::time::Instant::now() + CLIENT_PING, CLIENT_PING);
    ping_at.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pong_deadline: Option<Instant> = None;
    let mut loaded_room: HashMap<String, String> = HashMap::new();
    let mut in_rooms: HashSet<String> = HashSet::new();

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                flush_emit(app, shared);
                emit_send_waits(app, shared);
                if pong_deadline.is_some_and(|d| Instant::now() >= d) {
                    return SessionEnd::Reconnect { wait: true };
                }
            }
            _ = ping_at.tick() => {
                if pong_deadline.is_some() {
                    return SessionEnd::Reconnect { wait: true };
                }
                if send_line(&mut write, "PING :webtv").await.is_err() {
                    return SessionEnd::Reconnect { wait: true };
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
                        for ch in wanted.iter() {
                            let _ = send_line(&mut write, &format!("PART #{ch}")).await;
                            super::logging::close_channel(shared, ch);
                        }
                        wanted.clear();
                        in_rooms.clear();
                        loaded_room.clear();
                        *last_error = None;
                        clear_pending_out(pending_out, shared);
                        emit_status(app, ChatConnState::Connected, None, None);
                    }
                    Some(IrcCmd::PartChannel(ch)) => {
                        wanted.remove(&ch);
                        in_rooms.remove(&ch);
                        loaded_room.remove(&ch);
                        release_pending_channel(pending_out, &ch, shared);
                        let _ = send_line(&mut write, &format!("PART #{ch}")).await;
                        if let Ok(mut hub) = shared.hub.lock() {
                            hub.set_joined(&ch, false);
                        }
                        super::logging::close_channel(shared, &ch);
                        auth::emit(app, shared);
                        *last_error = None;
                        let status_ch = status_channel(shared, wanted);
                        emit_status(
                            app,
                            ChatConnState::Connected,
                            status_ch.as_deref(),
                            None,
                        );
                    }
                    Some(IrcCmd::Join(ch)) => {
                        *last_error = None;
                        let already = wanted.contains(&ch);
                        wanted.insert(ch.clone());
                        if already && in_rooms.contains(&ch) {
                            emit_status(app, ChatConnState::Connected, Some(&ch), None);
                            if let Ok(mut hub) = shared.hub.lock() {
                                hub.set_joined(&ch, true);
                            }
                            auth::emit(app, shared);
                            let is_active = shared
                                .hub
                                .lock()
                                .ok()
                                .is_some_and(|h| h.active.as_deref() == Some(ch.as_str()));
                            if is_active {
                                if let Some(id) = loaded_room.get(&ch).cloned() {
                                    let has_map = shared
                                        .catalog
                                        .lock()
                                        .ok()
                                        .is_some_and(|c| c.has_channel(&ch));
                                    let bttv_ok = shared.snapshot_bttv_wanted().channel.as_ref().is_some_and(
                                        |c| c.login == ch && c.room_id == id,
                                    );
                                    if !(has_map && bttv_ok) {
                                        spawn_channel_assets(app, shared, ch.clone(), id);
                                    }
                                }
                            }
                            continue;
                        }
                        emit_status(app, ChatConnState::Connecting, Some(&ch), None);
                        if send_line(&mut write, &format!("JOIN #{ch}")).await.is_err() {
                            return SessionEnd::Reconnect { wait: true };
                        }
                    }
                    Some(IrcCmd::Privmsg {
                        channel,
                        text,
                        reply_to,
                    }) => {
                        enqueue_pending_out(pending_out, channel, text, reply_to);
                        match flush_outgoing(
                            &mut write,
                            wanted,
                            &in_rooms,
                            pending_out,
                            shared,
                        )
                        .await
                        {
                            Err(()) => return SessionEnd::Reconnect { wait: true },
                            Ok(sent) => {
                                for (ch, txt, reply) in sent {
                                    echo_own_privmsg(app, shared, &ch, txt, reply);
                                }
                            }
                        }
                    }
                    Some(IrcCmd::Relogin) => {
                        let _ = send_ws(&mut write, Message::Close(None)).await;
                        return SessionEnd::Reconnect { wait: false };
                    }
                }
            }
            incoming = read.next() => {
                match incoming {
                    None => return SessionEnd::Reconnect { wait: true },
                    Some(Err(_)) => return SessionEnd::Reconnect { wait: true },
                    Some(Ok(Message::Close(_))) => return SessionEnd::Reconnect { wait: true },
                    Some(Ok(Message::Ping(p))) => {
                        if send_ws(&mut write, Message::Pong(p)).await.is_err() {
                            return SessionEnd::Reconnect { wait: true };
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        for raw in text.as_str().replace('\r', "").split('\n') {
                            if raw.is_empty() { continue; }
                            match dispatch_line(app, shared, raw, wanted, &nick, &mut loaded_room) {
                                LineAction::None => {}
                                LineAction::Pong(pong) => {
                                    if send_line(&mut write, &pong).await.is_err() {
                                        return SessionEnd::Reconnect { wait: true };
                                    }
                                }
                                LineAction::PongAck => {
                                    pong_deadline = None;
                                }
                                LineAction::Joined(ch) => {
                                    let first = in_rooms.insert(ch.clone());
                                    if first
                                        && shared
                                            .hub
                                            .lock()
                                            .ok()
                                            .is_some_and(|hub| hub.has_channel(&ch))
                                    {
                                        shared.post_channel_notice(
                                            app,
                                            &ch,
                                            "joined channel".into(),
                                        );
                                    }
                                    maybe_spawn_gap_fill(app, shared, &ch);
                                    match flush_outgoing(
                                        &mut write,
                                        wanted,
                                        &in_rooms,
                                        pending_out,
                                        shared,
                                    )
                                    .await
                                    {
                                        Err(()) => {
                                            return SessionEnd::Reconnect { wait: true };
                                        }
                                        Ok(sent) => {
                                            for (ch, txt, reply) in sent {
                                                echo_own_privmsg(app, shared, &ch, txt, reply);
                                            }
                                        }
                                    }
                                }
                                LineAction::LeftRoom(ch) => {
                                    in_rooms.remove(&ch);
                                    let is_active = shared
                                        .hub
                                        .lock()
                                        .ok()
                                        .is_some_and(|h| h.active.as_deref() == Some(ch.as_str()));
                                    if is_active {
                                        if let Ok(mut hub) = shared.hub.lock() {
                                            hub.set_joined(&ch, false);
                                        }
                                        auth::emit(app, shared);
                                    }
                                    if wanted.contains(&ch) {
                                        if send_line(&mut write, &format!("JOIN #{ch}"))
                                            .await
                                            .is_err()
                                        {
                                            return SessionEnd::Reconnect { wait: true };
                                        }
                                    }
                                }
                                LineAction::JoinFailed { channel, message } => {
                                    wanted.remove(&channel);
                                    in_rooms.remove(&channel);
                                    loaded_room.remove(&channel);
                                    release_pending_channel(pending_out, &channel, shared);
                                    if let Ok(mut cat) = shared.catalog.lock() {
                                        cat.drop_channel(&channel);
                                    }
                                    if let Ok(mut cat) = shared.badges.lock() {
                                        cat.drop_channel(&channel);
                                    }
                                    if let Ok(mut cat) = shared.cheers.lock() {
                                        cat.drop_channel(&channel);
                                    }
                                    if let Ok(mut set) = shared.chatters.lock() {
                                        set.drop_channel(&channel);
                                    }
                                    let was_active = shared
                                        .hub
                                        .lock()
                                        .ok()
                                        .is_some_and(|h| h.active.as_deref() == Some(channel.as_str()));
                                    if let Ok(mut hub) = shared.hub.lock() {
                                        if let Some(text) = hub.drop_channel(&channel) {
                                            let _ = app.emit(
                                                "chat:send-wait",
                                                ChatSendWait {
                                                    channel_id: channel.clone(),
                                                    text,
                                                },
                                            );
                                        }
                                    }
                                    let _ = crate::chat::session::forget_open(shared, &channel);
                                    if was_active {
                                        shared.notify_event(EventCmd::ClearChannel);
                                        shared.notify_bttv(BttvCmd::ClearChannel);
                                        let next_focus = crate::chat::session::preferred_focus(shared);
                                        if let Some(ch) = next_focus {
                                            if let Ok(mut hub) = shared.hub.lock() {
                                                hub.set_active(Some(ch.clone()));
                                            }
                                            let _ = crate::chat::session::remember(shared, ch.clone(), true);
                                            wanted.insert(ch.clone());
                                            if !in_rooms.contains(&ch) {
                                                if send_line(&mut write, &format!("JOIN #{ch}"))
                                                    .await
                                                    .is_err()
                                                {
                                                    return SessionEnd::Reconnect { wait: true };
                                                }
                                            } else if let Some(id) =
                                                loaded_room.get(&ch).cloned()
                                            {
                                                spawn_channel_assets(app, shared, ch, id);
                                            }
                                        } else {
                                            let _ = crate::chat::session::clear_last(shared);
                                        }
                                    }
                                    *last_error = Some(message.clone());
                                    emit_status(
                                        app,
                                        ChatConnState::Error,
                                        status_channel(shared, wanted).as_deref(),
                                        last_error.as_deref(),
                                    );
                                    crate::chat::session::emit_rooms(
                                        app,
                                        shared,
                                        Some(channel),
                                    );
                                    auth::emit(app, shared);
                                }
                                LineAction::Reconnect => return SessionEnd::Reconnect { wait: true },
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

fn status_channel(shared: &Shared, wanted: &HashSet<String>) -> Option<String> {
    shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.active.clone())
        .filter(|c| wanted.contains(c))
}

async fn send_line<S>(write: &mut S, line: &str) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
{
    send_ws(write, Message::Text(format!("{line}\r\n").into())).await
}

/// Шлёт накопленные PRIVMSG; возвращает успешно ушедшие (channel, text, reply_to)
/// для локального echo: Twitch не возвращает отправителю его PRIVMSG на том же
/// соединении (подтверждение только USERSTATE), поэтому своё сообщение надо
/// отобразить локально после успешной записи в сокет.
async fn flush_outgoing<S>(
    write: &mut S,
    wanted: &HashSet<String>,
    in_rooms: &HashSet<String>,
    pending: &mut VecDeque<(String, String, Option<String>)>,
    shared: &Shared,
) -> Result<Vec<(String, String, Option<String>)>, ()>
where
    S: Sink<Message> + Unpin,
{
    let mut sent: Vec<(String, String, Option<String>)> = Vec::new();
    let mut rest = VecDeque::new();
    while let Some((channel, text, reply_to)) = pending.pop_front() {
        if !wanted.contains(&channel) {
            shared.release_outbound(1);
            continue;
        }
        if !in_rooms.contains(&channel) {
            rest.push_back((channel, text, reply_to));
            continue;
        }
        let line = match &reply_to {
            Some(id) => format!("@reply-parent-msg-id={id} PRIVMSG #{channel} :{text}"),
            None => format!("PRIVMSG #{channel} :{text}"),
        };
        if send_line(write, &line).await.is_err() {
            rest.push_back((channel, text, reply_to));
            rest.append(pending);
            *pending = rest;
            return Err(());
        }
        shared.release_outbound(1);
        if let Ok(mut last) = shared.last_sent.lock() {
            last.insert(channel.clone(), text.clone());
        }
        sent.push((channel, text, reply_to));
    }
    *pending = rest;
    Ok(sent)
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
    Joined(String),
    LeftRoom(String),
    JoinFailed { channel: String, message: String },
    Reconnect,
}

fn inline_whispers_enabled(shared: &Shared) -> bool {
    super::streamer_mode::inline_whispers_enabled(shared)
}

fn dispatch_line(
    app: &AppHandle,
    shared: &Shared,
    raw: &str,
    wanted: &HashSet<String>,
    nick: &str,
    loaded_room: &mut HashMap<String, String>,
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
            if wanted.is_empty() {
                emit_status(app, ChatConnState::Connected, None, None);
            }
            LineAction::None
        }
        ParsedLine::Membership {
            part,
            channel,
            login,
        } => {
            if part && login == nick && wanted.contains(&channel) {
                emit_status(app, ChatConnState::Connecting, Some(&channel), None);
                LineAction::LeftRoom(channel)
            } else {
                if let Ok(mut set) = shared.chatters.lock() {
                    if part {
                        set.remove(&channel, &login);
                    } else {
                        set.add(&channel, &login, &login);
                    }
                }
                let self_login = auth::resolved_login_token(shared).map(|(l, _)| l);
                if !part && login == nick {
                    // First self-JOIN → Joined (notice once in handler). Re-JOIN spam skipped via in_rooms.
                    return LineAction::Joined(channel);
                } else if part {
                    if super::membership_batch::should_show(
                        shared,
                        &channel,
                        &login,
                        self_login.as_deref(),
                        false,
                    ) {
                        super::membership_batch::record_part(shared, app, channel.clone(), login);
                    }
                } else if super::membership_batch::should_show(
                    shared,
                    &channel,
                    &login,
                    self_login.as_deref(),
                    true,
                ) {
                    super::membership_batch::record_join(shared, app, channel.clone(), login);
                }
                LineAction::None
            }
        }
        ParsedLine::Names { channel, logins } => {
            if let Ok(mut set) = shared.chatters.lock() {
                set.add_many(&channel, &logins);
            }
            LineAction::None
        }
        ParsedLine::Whisper { mut event } => {
            if !inline_whispers_enabled(shared) {
                return LineAction::None;
            }
            let gate_channel = shared
                .hub
                .lock()
                .ok()
                .and_then(|h| h.active.clone())
                .unwrap_or_default();
            if super::filters::gate_event(shared, &gate_channel, &mut event) {
                return LineAction::None;
            }
            super::filters::apply_whisper_highlight(shared, &mut event);
            // One whisper log file (stock /whispers); fan-out must not duplicate.
            super::logging::try_log(shared, super::logging::whispers_key(), &event, "");
            let self_login = auth::resolved_login_token(shared).map(|(l, _)| l);
            let sim = super::similarity::cfg_from_shared(shared);
            let stack_style = super::timeout_stack::style_from_shared(shared);
            let mut batches = Vec::new();
            if let Ok(mut hub) = shared.hub.lock() {
                let channels = hub.channels();
                for ch in channels {
                    let mut ev = event.clone();
                    decorate_event(&mut ev, shared, &ch);
                    if let Some(batch) =
                        hub.ingest(&ch, ev, self_login.as_deref(), &sim, stack_style)
                    {
                        batches.push(batch);
                    }
                }
            }
            for batch in batches {
                deliver_batch(app, shared, &batch);
            }
            emit_send_waits(app, shared);
            LineAction::None
        }
        ParsedLine::Event {
            channel,
            mut event,
            room_id,
        } => {
            let joined = matches!(&event, ChatEvent::Roomstate { .. }) && wanted.contains(&channel);
            if joined {
                emit_status(app, ChatConnState::Connected, Some(&channel), None);
                if let Ok(mut hub) = shared.hub.lock() {
                    hub.set_joined(&channel, true);
                }
                auth::emit(app, shared);
            }
            if let ChatEvent::Userstate {
                display_name,
                color,
                badges,
                ..
            } = &event
            {
                if let Ok(mut profiles) = shared.self_profiles.lock() {
                    let entry = profiles.entry(channel.clone()).or_default();
                    if let Some(name) = display_name {
                        entry.display_name = name.clone();
                    }
                    if let Some(c) = color {
                        entry.color = c.clone();
                    }
                    entry.badges = badges.clone();
                }
            }
            let mut failed: Option<String> = None;
            if let ChatEvent::Notice { msg_id, text, .. } = &event {
                let mid = msg_id.as_deref().unwrap_or("");
                if is_login_failure(&channel, mid, text) {
                    let app2 = app.clone();
                    let shared2 = shared.clone();
                    tauri::async_runtime::spawn(async move {
                        auth::reject_session(app2, shared2, "IRC login rejected").await;
                    });
                }
                if wanted.contains(&channel) && is_join_failure(mid) {
                    emit_status(app, ChatConnState::Error, Some(&channel), Some(text));
                    if let Ok(mut hub) = shared.hub.lock() {
                        hub.set_joined(&channel, false);
                    }
                    auth::emit(app, shared);
                    failed = Some(text.clone());
                }
            }
            if let Some(id) = room_id.as_deref() {
                if wanted.contains(&channel) {
                    if let Ok(mut hub) = shared.hub.lock() {
                        hub.set_room_id(&channel, id.to_string());
                    }
                    let prev = loaded_room.insert(channel.clone(), id.to_string());
                    let room_changed = prev.as_ref().map(|r| r.as_str() != id).unwrap_or(true);
                    let is_active = shared
                        .hub
                        .lock()
                        .ok()
                        .is_some_and(|h| h.active.as_deref() == Some(channel.as_str()));
                    if room_changed {
                        if is_active {
                            spawn_channel_assets(app, shared, channel.clone(), id.to_string());
                        } else {
                            super::recent_messages::spawn_recent_messages(
                                app.clone(),
                                shared.clone(),
                                channel.clone(),
                            );
                        }
                        super::shared_chat::spawn_refresh(shared, channel.clone(), id.to_string());
                    }
                }
            }
            remember_chatter(shared, &channel, &event);
            if super::filters::gate_event(shared, &channel, &mut event) {
                if let Some(msg) = failed {
                    return LineAction::JoinFailed {
                        channel,
                        message: msg,
                    };
                }
                if joined {
                    return LineAction::Joined(channel);
                }
                return LineAction::None;
            }
            decorate_event(&mut event, shared, &channel);
            if matches!(&event, ChatEvent::Privmsg { .. }) {
                if let Some(rid) = shared
                    .hub
                    .lock()
                    .ok()
                    .and_then(|h| h.room_id(&channel).map(str::to_string))
                {
                    super::shared_chat::maybe_probe(shared, &channel, &rid);
                }
            }
            let self_login = auth::resolved_login_token(shared).map(|(l, _)| l);
            let sim = super::similarity::cfg_from_shared(shared);
            let stack_style = super::timeout_stack::style_from_shared(shared);
            let log_channel = channel.clone();
            let stream_id = super::logging::resolve_stream_id(shared, &channel);
            let mut logged: Vec<ChatEvent> = Vec::new();
            let batch = shared.hub.lock().ok().and_then(|mut hub| {
                hub.ingest_logged(
                    &channel,
                    event,
                    self_login.as_deref(),
                    &sim,
                    stack_style,
                    |ev| {
                        logged.push(ev.clone());
                    },
                )
            });
            for ev in &logged {
                super::logging::try_log(shared, &log_channel, ev, &stream_id);
            }
            if let Some(batch) = batch {
                deliver_batch(app, shared, &batch);
            }
            emit_send_waits(app, shared);
            if let Some(msg) = failed {
                LineAction::JoinFailed {
                    channel,
                    message: msg,
                }
            } else if joined {
                LineAction::Joined(channel)
            } else {
                LineAction::None
            }
        }
        ParsedLine::Ignore => LineAction::None,
    }
}

fn remember_chatter(shared: &Shared, channel: &str, event: &ChatEvent) {
    let (login, display) = match event {
        ChatEvent::Privmsg {
            login,
            display_name,
            ..
        } => (login.as_str(), display_name.as_str()),
        ChatEvent::Usernotice { login, privmsg, .. } => {
            if let Some(ChatEvent::Privmsg {
                login,
                display_name,
                ..
            }) = privmsg.as_deref()
            {
                (login.as_str(), display_name.as_str())
            } else if let Some(login) = login.as_deref() {
                (login, login)
            } else {
                return;
            }
        }
        _ => return,
    };
    if let Ok(mut set) = shared.chatters.lock() {
        set.add(channel, login, display);
    }
}

fn is_login_failure(channel: &str, id: &str, text: &str) -> bool {
    if channel != "*" && !channel.is_empty() {
        return false;
    }
    id.eq_ignore_ascii_case("login_unsuccessful")
        || text
            .to_ascii_lowercase()
            .contains("login authentication failed")
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

fn emit_status(
    app: &AppHandle,
    state: ChatConnState,
    channel: Option<&str>,
    message: Option<&str>,
) {
    let _ = app.emit(
        "chat:status",
        ChatStatus {
            state,
            channel: channel.map(str::to_string),
            message: message.map(str::to_string),
        },
    );
}

fn emit_send_waits(app: &AppHandle, shared: &Shared) {
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

fn flush_emit(app: &AppHandle, shared: &Shared) {
    let batches = match shared.hub.lock() {
        Ok(mut hub) => hub.flush_all(),
        Err(_) => return,
    };
    for batch in batches {
        deliver_batch(app, shared, &batch);
    }
}

fn deliver_batch(app: &AppHandle, shared: &Shared, batch: &super::types::ChatBatch) {
    match shared.send_batch(batch) {
        super::state::BatchSend::Delivered => {}
        super::state::BatchSend::EncodeError => {
            eprintln!("chat batch encode failed for channel {}", batch.channel_id);
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
        super::state::BatchSend::NoSubscriber => {
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

/// Локальный echo своего PRIVMSG после успешной записи в сокет.
/// Twitch не шлёт отправителю его сообщение на том же соединении (только
/// USERSTATE-подтверждение), поэтому своё сообщение рендерим сами через тот же
/// пайплайн, что и входящие: gate/decorate/ingest/deliver. Бейджи, цвет и
/// display-name берём из кэша USERSTATE (приходит на JOIN и после каждого
/// PRIVMSG), reply-контекст — из скроллбэка по parent id.
pub(crate) fn echo_own_privmsg(
    app: &AppHandle,
    shared: &Shared,
    channel: &str,
    text: String,
    reply_to: Option<String>,
) {
    let Some((login, _)) = auth::resolved_login_token(shared) else {
        return;
    };
    let now = unix_ms();
    let (display_name, color, badges) = shared
        .self_profiles
        .lock()
        .ok()
        .and_then(|profiles| profiles.get(channel).cloned())
        .map(|p| {
            (
                if p.display_name.is_empty() {
                    login.clone()
                } else {
                    p.display_name
                },
                p.color,
                p.badges,
            )
        })
        .unwrap_or_else(|| (login.clone(), String::new(), Vec::new()));
    let user_id = auth::resolved_twitch_user_id(shared).unwrap_or_default();
    let (reply_to_login, reply_to_display_name, reply_to_text) = reply_to
        .as_deref()
        .and_then(
            |rid| match shared.hub.lock().ok()?.peek_event(channel, rid)? {
                ChatEvent::Privmsg {
                    login,
                    display_name,
                    text,
                    ..
                } => Some((Some(login), Some(display_name), Some(text))),
                _ => None,
            },
        )
        .unwrap_or((None, None, None));
    let mut event = ChatEvent::Privmsg {
        id: synthetic_id("l", now, &text),
        timestamp_ms: now,
        user_id,
        login: login.clone(),
        display_name,
        color,
        badges,
        text,
        emote_spans: Vec::new(),
        link_spans: Vec::new(),
        mention_spans: Vec::new(),
        bits: None,
        reply_to_id: reply_to,
        reply_to_login,
        reply_to_display_name,
        reply_to_text,
        action: false,
        first_msg: false,
        custom_reward_id: None,
        system_msg_id: None,
        highlight_color: None,
        highlight_sound: false,
        highlight_sound_path: None,
        highlight_flash: false,
        whisper: false,
        disabled: false,
        source_room_id: None,
        source_badges: Vec::new(),
        paint: None,
    };
    if super::filters::gate_event(shared, channel, &mut event) {
        return;
    }
    decorate_event(&mut event, shared, channel);
    let sim = super::similarity::cfg_from_shared(shared);
    let stack_style = super::timeout_stack::style_from_shared(shared);
    let stream_id = super::logging::resolve_stream_id(shared, channel);
    let mut logged: Vec<ChatEvent> = Vec::new();
    let batch = shared.hub.lock().ok().and_then(|mut hub| {
        hub.ingest_logged(
            channel,
            event,
            Some(login.as_str()),
            &sim,
            stack_style,
            |ev| {
                logged.push(ev.clone());
            },
        )
    });
    for ev in &logged {
        super::logging::try_log(shared, channel, ev, &stream_id);
    }
    if let Some(batch) = batch {
        deliver_batch(app, shared, &batch);
    }
    emit_send_waits(app, shared);
}

fn enqueue_pending_out(
    pending_out: &mut VecDeque<(String, String, Option<String>)>,
    channel: String,
    text: String,
    reply_to: Option<String>,
) {
    // Capacity reserved in chat_send via try_reserve_outbound.
    pending_out.push_back((channel, text, reply_to));
}

fn clear_pending_out(
    pending_out: &mut VecDeque<(String, String, Option<String>)>,
    shared: &Shared,
) {
    let n = pending_out.len();
    pending_out.clear();
    shared.release_outbound(n);
}

fn release_pending_channel(
    pending_out: &mut VecDeque<(String, String, Option<String>)>,
    channel: &str,
    shared: &Shared,
) {
    let before = pending_out.len();
    pending_out.retain(|(c, _, _)| c != channel);
    shared.release_outbound(before.saturating_sub(pending_out.len()));
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
            user_id,
            reply_to_display_name,
            source_room_id,
            source_badges,
            paint,
            ..
        } => {
            maybe_strip_reply_mention(
                shared,
                text,
                emote_spans,
                link_spans,
                mention_spans,
                reply_to_display_name.as_deref(),
            );
            if let Some(n) = *bits {
                if let Ok(cat) = shared.cheers.lock() {
                    let stack_bits = shared
                        .settings
                        .lock()
                        .ok()
                        .and_then(|inner| {
                            inner
                                .data
                                .knobs
                                .get("emotes.stackBits")
                                .and_then(|v| v.as_bool())
                        })
                        .unwrap_or(false);
                    let extra = attach_cheers(text, emote_spans, &cat, channel, n, stack_bits);
                    emote_spans.extend(extra);
                }
            }
            if let Ok(cat) = shared.catalog.lock() {
                let extra = attach_third_party(text, emote_spans, &cat, channel);
                emote_spans.extend(extra);
            }
            let emoji_set = shared
                .settings
                .lock()
                .ok()
                .and_then(|inner| {
                    inner
                        .data
                        .knobs
                        .get("emotes.emojiSet")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "Twitter".into());
            let extra = attach_emoji(text, emote_spans, &emoji_set);
            emote_spans.extend(extra);
            if let Ok(cat) = shared.badges.lock() {
                resolve_badge_urls(badges, &cat, channel);
            }
            let (use_ffz_mod, use_ffz_vip) = shared
                .settings
                .lock()
                .ok()
                .map(|inner| {
                    let knobs = &inner.data.knobs;
                    (
                        knobs
                            .get("appearance.useCustomFfzModeratorBadges")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true),
                        knobs
                            .get("appearance.useCustomFfzVipBadges")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true),
                    )
                })
                .unwrap_or((true, true));
            if let Ok(extras_map) = shared.ffz_channel.lock() {
                if let Some(extras) = extras_map.get(channel) {
                    super::ffz_channel::apply_custom_authority(
                        badges,
                        extras,
                        use_ffz_mod,
                        use_ffz_vip,
                    );
                }
            }
            if let Ok(ch) = shared.chatterino_badges.lock() {
                ch.append_for_user(badges, user_id);
            }
            if let (Ok(ffz), Ok(extras_map)) = (shared.ffz_badges.lock(), shared.ffz_channel.lock())
            {
                ffz.append_for_user(badges, user_id);
                if let Some(extras) = extras_map.get(channel) {
                    super::ffz_channel::append_channel_badges(&ffz, extras, badges, user_id);
                }
            } else if let Ok(ffz) = shared.ffz_badges.lock() {
                ffz.append_for_user(badges, user_id);
            }
            if let Ok(bttv) = shared.bttv_badges.lock() {
                bttv.append_for_user(badges, user_id);
            }
            if let Ok(stv) = shared.seventv_badges.lock() {
                stv.append_for_user(badges, user_id);
            }
            *paint = None;
            let show_paints = shared
                .settings
                .lock()
                .ok()
                .and_then(|inner| {
                    inner
                        .data
                        .knobs
                        .get("appearance.showSevenTvPaints")
                        .and_then(|v| v.as_bool())
                })
                .unwrap_or(true);
            if show_paints {
                if let Ok(stv) = shared.seventv_paints.lock() {
                    *paint = stv.paint_for_user(user_id);
                }
            }
            super::shared_chat::apply_badges(
                shared,
                channel,
                badges,
                source_room_id.as_deref(),
                source_badges,
            );
            emote_spans.sort_by_key(|s| s.start);
            resolve_overlays(text, emote_spans);
            let find_all = shared
                .settings
                .lock()
                .ok()
                .and_then(|inner| {
                    inner
                        .data
                        .knobs
                        .get("appearance.findAllUsernames")
                        .and_then(|v| v.as_bool())
                })
                .unwrap_or(false);
            let (links, mentions) = if find_all {
                let chatters = shared.chatters.lock().ok();
                let channel_owned = channel.to_string();
                if let Some(ref set) = chatters {
                    decorate_text_spans_ex(
                        text,
                        emote_spans,
                        FindMentions {
                            find_all: true,
                            is_chatter: &|login| set.contains(&channel_owned, login),
                        },
                    )
                } else {
                    decorate_text_spans_ex(text, emote_spans, FindMentions::none())
                }
            } else {
                decorate_text_spans_ex(text, emote_spans, FindMentions::none())
            };
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

fn maybe_strip_reply_mention(
    shared: &Shared,
    text: &mut String,
    emote_spans: &mut Vec<super::types::EmoteSpan>,
    link_spans: &mut Vec<super::types::LinkSpan>,
    mention_spans: &mut Vec<super::types::MentionSpan>,
    display_name: Option<&str>,
) {
    let Some(name) = display_name.filter(|s| !s.is_empty()) else {
        return;
    };
    let (strip_on, hide_ctx) = shared
        .settings
        .lock()
        .ok()
        .map(|inner| {
            let knobs = &inner.data.knobs;
            let strip = knobs
                .get("appearance.stripReplyMention")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let hide = knobs
                .get("appearance.hideReplyContext")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            (strip, hide)
        })
        .unwrap_or((true, false));
    if !strip_on || hide_ctx {
        return;
    }
    let Some((rest, offset)) = strip_leading_reply_mention(text, name) else {
        return;
    };
    *text = rest;
    shift_emote_spans_back(emote_spans, offset);
    link_spans.clear();
    mention_spans.clear();
}

fn credentials(shared: &Shared) -> (String, Option<String>) {
    if let Some((login, token)) = auth::resolved_login_token(shared) {
        return (login, Some(token));
    }
    let n = unix_ms() % 90_000 + 10_000;
    (format!("justinfan{n}"), None)
}

fn spawn_helix_globals(shared: &Shared) {
    let badges = shared.badges.clone();
    let emotes = shared.catalog.clone();
    let shared = shared.clone();
    tauri::async_runtime::spawn(async move {
        let token = auth::oauth_token(&shared);
        let client_id = auth::resolved_client_id(&shared);
        let t = token.as_deref();
        let id = client_id.as_str();
        tokio::join!(
            super::helix::load_global_badges(&badges, t, id),
            super::helix::load_global_emotes(&emotes, t, id),
        );
        super::twitch_blocks::spawn_load_if_enabled(&shared);
    });
}

fn spawn_channel_assets(app: &AppHandle, shared: &Shared, login: String, room_id: String) {
    let app = app.clone();
    let cat = shared.catalog.clone();
    let badges = shared.badges.clone();
    let cheers = shared.cheers.clone();
    let hub = shared.hub.clone();
    let ffz_channel = shared.ffz_channel.clone();
    let events = shared.clone();
    let token = auth::oauth_token(shared);
    let client_id = auth::resolved_client_id(shared);
    let room_for_bttv = room_id.clone();
    let flags = fetch::EmoteProviderFlags::from_shared(shared);
    tauri::async_runtime::spawn(async move {
        // History must not wait on BTTV/FFZ/7TV/Helix (can take minutes when APIs hang).
        super::recent_messages::spawn_recent_messages(app.clone(), events.clone(), login.clone());
        let stv = fetch::load_channel(
            &cat,
            &badges,
            &cheers,
            &hub,
            &ffz_channel,
            &login,
            &room_id,
            token.as_deref(),
            &client_id,
            flags,
        )
        .await;
        let still = hub
            .lock()
            .ok()
            .and_then(|h| h.active.clone())
            .is_some_and(|ch| ch == login);
        if !still {
            return;
        }
        let needs_stv_event = super::eventapi::seventv_event_channel_needed(&events);
        let flags = fetch::EmoteProviderFlags::from_shared(&events);
        if needs_stv_event {
            let (set_id, user_id) = if flags.seventv_channel {
                stv.unwrap_or_default()
            } else {
                (String::new(), String::new())
            };
            events.notify_event(EventCmd::SetChannel {
                login: login.clone(),
                room_id: room_id.clone(),
                set_id,
                user_id,
            });
        } else {
            events.notify_event(EventCmd::ClearChannel);
        }
        events.notify_bttv(BttvCmd::SetChannel {
            login: login.clone(),
            room_id: room_for_bttv,
        });
    });
}

fn maybe_spawn_gap_fill(app: &AppHandle, shared: &Shared, channel: &str) {
    let after_ms = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.disconnect_at(channel));
    if let Some(after_ms) = after_ms {
        super::recent_messages::spawn_gap_fill(
            app.clone(),
            shared.clone(),
            channel.to_string(),
            after_ms,
        );
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
