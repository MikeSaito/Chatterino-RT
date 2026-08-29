// SPDX-FileCopyrightText: 2023 Contributors to Chatterino <https://chatterino.com>
//
// SPDX-License-Identifier: MIT
//
// MIT reimpl: Chatterino recent-messages API (Api.cpp, Impl.cpp).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use url::Url;

use super::filters;
use super::irc::decorate_event;
use super::parse::{parse_line, ParsedLine};
use super::state::Shared;
use super::types::ChatEvent;

const TIMEOUT_SECS: u64 = 30;
const DEFAULT_LIMIT: usize = 800;
const MIN_LIMIT: usize = 10;
const MAX_LIMIT: usize = 800;

static NOTICE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize, Clone)]
struct HistoryLoadedPayload {
    #[serde(rename = "channelId")]
    channel_id: String,
}

pub fn spawn_recent_messages(app: AppHandle, shared: Shared, channel: String) {
    if !history_enabled(&shared) {
        return;
    }
    let limit = history_limit(&shared);
    if !try_begin_load(&shared, &channel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = load_and_apply(&app, &shared, &channel, limit, None, None).await;
        finish_load(&shared, &channel);
        if let Err(err) = result {
            if push_history_notice(
                &shared,
                &channel,
                format!("Message history service unavailable (Error: {err})"),
            ) {
                emit_history_loaded_if_active(&app, &shared, &channel);
            }
        }
    });
}

/// Fill scrollback gap after IRC reconnect (Chatterino loadRecentMessagesReconnect).
pub fn spawn_gap_fill(app: AppHandle, shared: Shared, channel: String, after_ms: u64) {
    if !history_enabled(&shared) {
        return;
    }
    let before_ms = now_ms();
    if after_ms >= before_ms {
        return;
    }
    if !try_begin_gap_load(&shared, &channel) {
        return;
    }
    let took = shared
        .hub
        .lock()
        .ok()
        .and_then(|mut h| h.take_disconnect_at(&channel));
    if took.is_none() {
        finish_load(&shared, &channel);
        return;
    }
    let limit = gap_limit(after_ms, before_ms, history_limit(&shared));
    tauri::async_runtime::spawn(async move {
        let result = load_gap_and_apply(&app, &shared, &channel, limit, after_ms, before_ms).await;
        finish_load(&shared, &channel);
        if let Err(err) = result {
            if push_history_notice(
                &shared,
                &channel,
                format!("Message history service unavailable (Error: {err})"),
            ) {
                emit_history_loaded_if_active(&app, &shared, &channel);
            }
        }
    });
}

fn try_begin_gap_load(shared: &Shared, channel: &str) -> bool {
    let mut loading = shared
        .loading_recent
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    loading.insert(channel.to_string())
}

fn try_begin_load(shared: &Shared, channel: &str) -> bool {
    let already = shared
        .hub
        .lock()
        .ok()
        .is_some_and(|h| h.recent_already_loaded(channel));
    if already {
        return false;
    }
    let mut loading = shared
        .loading_recent
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !loading.insert(channel.to_string()) {
        return false;
    }
    true
}

fn finish_load(shared: &Shared, channel: &str) {
    if let Ok(mut loading) = shared.loading_recent.lock() {
        loading.remove(channel);
    }
}

async fn load_and_apply(
    app: &AppHandle,
    shared: &Shared,
    channel: &str,
    limit: usize,
    after_ms: Option<u64>,
    before_ms: Option<u64>,
) -> Result<(), String> {
    let (messages, error_code) = fetch_recent_messages(channel, limit, after_ms, before_ms).await?;
    if !channel_still_open(shared, channel) {
        return Ok(());
    }

    let api_empty = messages.is_empty();
    let mut events = build_history_events(shared, channel, &messages);
    if error_code.as_deref() == Some("channel_not_joined") && !events.is_empty() {
        events.push(history_notice(
            "Message history service recovering, there may be gaps in the message history.",
        ));
    }

    let parsed_count = events.len();
    let prepended = {
        let mut hub = shared.hub.lock().map_err(|_| "lock".to_string())?;
        if !hub.has_channel(channel) {
            return Ok(());
        }
        let n = hub.prepend_history(channel, events);
        if api_empty || n > 0 {
            hub.mark_recent_loaded(channel);
        } else if parsed_count > 0 {
            hub.mark_recent_loaded(channel);
            drop(hub);
            if push_history_notice(
                shared,
                channel,
                "Message history could not be loaded: scrollback is full.".to_string(),
            ) {
                emit_history_loaded_if_active(app, shared, channel);
            }
            return Ok(());
        }
        n
    };

    if prepended > 0 {
        emit_history_loaded_if_active(app, shared, channel);
    }
    Ok(())
}

async fn load_gap_and_apply(
    app: &AppHandle,
    shared: &Shared,
    channel: &str,
    limit: usize,
    after_ms: u64,
    before_ms: u64,
) -> Result<(), String> {
    let (messages, error_code) =
        fetch_recent_messages(channel, limit, Some(after_ms), Some(before_ms)).await?;
    if !channel_still_open(shared, channel) {
        return Ok(());
    }

    let mut events = build_history_events(shared, channel, &messages);
    if error_code.as_deref() == Some("channel_not_joined") && !events.is_empty() {
        events.push(history_notice(
            "Message history service recovering, there may be gaps in the message history.",
        ));
    }

    let merged = {
        let mut hub = shared.hub.lock().map_err(|_| "lock".to_string())?;
        if !hub.has_channel(channel) {
            return Ok(());
        }
        hub.fill_in_missing(channel, events)
    };

    if merged > 0 {
        emit_history_loaded_if_active(app, shared, channel);
    }
    Ok(())
}

fn emit_history_loaded_if_active(app: &AppHandle, shared: &Shared, channel: &str) {
    let is_active = shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.active.clone())
        .is_some_and(|ch| ch == channel);
    if is_active {
        let _ = app.emit(
            "chat:history-loaded",
            HistoryLoadedPayload {
                channel_id: channel.to_string(),
            },
        );
    }
}

fn channel_still_open(shared: &Shared, channel: &str) -> bool {
    shared
        .hub
        .lock()
        .ok()
        .is_some_and(|h| h.has_channel(channel))
}

fn push_history_notice(shared: &Shared, channel: &str, text: String) -> bool {
    if !channel_still_open(shared, channel) {
        return false;
    }
    let notice = history_notice(&text);
    let prepended = shared
        .hub
        .lock()
        .ok()
        .map(|mut h| h.prepend_history(channel, vec![notice]))
        .unwrap_or(0);
    prepended > 0
}

fn history_notice(text: &str) -> ChatEvent {
    let ts = now_ms();
    let seq = NOTICE_SEQ.fetch_add(1, Ordering::Relaxed);
    ChatEvent::Notice {
        id: format!("hist-{ts}-{seq}"),
        timestamp_ms: ts,
        text: text.to_string(),
        msg_id: None,
        timeout_remaining_sec: None,
    }
}

fn build_history_events(shared: &Shared, channel: &str, raw_lines: &[String]) -> Vec<ChatEvent> {
    let now = now_ms();
    let mut out = Vec::new();
    for raw in raw_lines {
        let line = unescape_zero_width_joiner(raw);
        match parse_line(&line, now) {
            ParsedLine::Event {
                channel: ch,
                mut event,
                ..
            } if ch.eq_ignore_ascii_case(channel) => {
                if !history_event_kind(&event) {
                    continue;
                }
                if filters::gate_event(shared, channel, &mut event) {
                    continue;
                }
                decorate_event(&mut event, shared, channel);
                out.push(event);
            }
            ParsedLine::Whisper { .. } => {}
            _ => {}
        }
    }
    out
}

fn history_event_kind(event: &ChatEvent) -> bool {
    matches!(
        event,
        ChatEvent::Privmsg { .. }
            | ChatEvent::Usernotice { .. }
            | ChatEvent::Clearchat { .. }
            | ChatEvent::Clearmsg { .. }
            | ChatEvent::Notice { .. }
    )
}

async fn fetch_recent_messages(
    channel: &str,
    limit: usize,
    after_ms: Option<u64>,
    before_ms: Option<u64>,
) -> Result<(Vec<String>, Option<String>), String> {
    let url = build_url(channel, limit, after_ms, before_ms)?;
    let client = http_client();
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let root: Value = resp.json().await.map_err(|e| e.to_string())?;
    let messages = root
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let error_code = root
        .get("error_code")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok((messages, error_code))
}

fn build_url(
    channel: &str,
    limit: usize,
    after_ms: Option<u64>,
    before_ms: Option<u64>,
) -> Result<Url, String> {
    let template = std::env::var("CHATTERINO_RT_RECENT_MESSAGES_URL").unwrap_or_else(|_| {
        "https://recent-messages.robotty.de/api/v2/recent-messages/{channel}".to_string()
    });
    let base = template.replace("{channel}", channel);
    let mut url = Url::parse(&base).map_err(|e| e.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("limit", &limit.to_string());
        if let Some(after) = after_ms {
            pairs.append_pair("after", &after.to_string());
        }
        if let Some(before) = before_ms {
            pairs.append_pair("before", &before.to_string());
        }
    }
    Ok(url)
}

fn gap_limit(after_ms: u64, before_ms: u64, max: usize) -> usize {
    let gap_sec = before_ms.saturating_sub(after_ms) / 1000;
    let scaled = ((gap_sec + 1) * 10) as usize;
    scaled.clamp(MIN_LIMIT, max)
}

fn http_client() -> reqwest::Client {
    super::http_client::build(Duration::from_secs(TIMEOUT_SECS))
}

fn unescape_zero_width_joiner(input: &str) -> String {
    const TAG: char = '\u{e0002}';
    const ZWJ: char = '\u{200d}';
    let mut out = String::with_capacity(input.len());
    let mut prev = None;
    for ch in input.chars() {
        if ch == TAG {
            if prev != Some(TAG) {
                out.push(ZWJ);
            } else {
                out.push(TAG);
            }
        } else {
            out.push(ch);
        }
        prev = Some(ch);
    }
    out
}

fn history_enabled(shared: &Shared) -> bool {
    shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("misc.loadTwitchMessageHistoryOnConnect")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

fn history_limit(shared: &Shared) -> usize {
    let raw = shared
        .settings
        .lock()
        .ok()
        .map(|inner| {
            knob_usize(
                &inner.data.knobs,
                "misc.twitchMessageHistoryLimit",
                DEFAULT_LIMIT,
            )
        })
        .unwrap_or(DEFAULT_LIMIT);
    raw.clamp(MIN_LIMIT, MAX_LIMIT)
}

fn knob_usize(knobs: &BTreeMap<String, Value>, key: &str, default: usize) -> usize {
    match knobs.get(key) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(default as u64) as usize,
        Some(Value::String(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::ChatEvent;

    fn privmsg_line(id: &str, text: &str) -> String {
        format!(
            "@badge-info=;badges=;color=#FF0000;display-name=Test;emotes=;id={id};mod=0;room-id=1;subscriber=0;tmi-sent-ts=1000;turbo=0;user-id=99;user-type= :test!test@test.tmi.twitch.tv PRIVMSG #xqc :{text}"
        )
    }

    #[test]
    fn unescape_zero_width_joiner_replaces_tag() {
        let raw = format!("hello\u{e0002}world");
        assert_eq!(unescape_zero_width_joiner(&raw), "hello\u{200D}world");
    }

    #[test]
    fn history_limit_clamps() {
        let shared = Shared::new();
        {
            let mut settings = shared.settings.lock().unwrap();
            settings.data.knobs.insert(
                "misc.twitchMessageHistoryLimit".into(),
                Value::Number(5000.into()),
            );
        }
        assert_eq!(history_limit(&shared), MAX_LIMIT);
    }

    #[test]
    fn build_history_events_parses_privmsg() {
        let shared = Shared::new();
        let lines = vec![privmsg_line("abc", "hello")];
        let events = build_history_events(&shared, "xqc", &lines);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::Privmsg { id, text, .. } => {
                assert_eq!(id, "abc");
                assert_eq!(text, "hello");
            }
            other => panic!("expected privmsg, got {other:?}"),
        }
    }

    #[test]
    fn build_history_events_skips_other_channel() {
        let shared = Shared::new();
        let lines = vec![privmsg_line("abc", "hello").replace("#xqc", "#other")];
        let events = build_history_events(&shared, "xqc", &lines);
        assert!(events.is_empty());
    }

    #[test]
    fn history_event_kind_filters_roomstate() {
        let event = ChatEvent::Roomstate {
            id: "r".into(),
            timestamp_ms: 1,
            slow_sec: None,
            emote_only: None,
            subs_only: None,
            followers_only: None,
        };
        assert!(!history_event_kind(&event));
    }

    #[test]
    fn build_url_includes_limit() {
        let url = build_url("xqc", 120, None, None).unwrap();
        assert!(url.as_str().contains("recent-messages/xqc"));
        assert!(url.as_str().contains("limit=120"));
    }

    #[test]
    fn build_url_includes_after_before() {
        let url = build_url("xqc", 50, Some(1000), Some(2000)).unwrap();
        assert!(url.as_str().contains("after=1000"));
        assert!(url.as_str().contains("before=2000"));
    }

    #[test]
    fn gap_limit_scales_with_disconnect_duration() {
        assert_eq!(gap_limit(0, 5000, 800), 60);
        assert_eq!(gap_limit(0, 90_000, 800), 800);
        assert_eq!(gap_limit(1000, 1000, 800), MIN_LIMIT);
    }
}
