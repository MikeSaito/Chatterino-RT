use std::sync::atomic::{AtomicU64, Ordering};

use super::types::{Badge, ChatEvent, EmoteSpan};

static SYNTHETIC_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedLine {
    Event {
        channel: String,
        event: ChatEvent,
        room_id: Option<String>,
    },
    Ping(String),
    Pong,
    Ready,
    Reconnect,
    Membership {
        part: bool,
        channel: String,
        login: String,
    },
    Names {
        channel: String,
        logins: Vec<String>,
    },
    Typing {
        channel: String,
        login: String,
        display_name: String,
        user_id: String,
        badges: Vec<Badge>,
        is_mod_tag: bool,
        active: bool,
    },
    Whisper {
        event: ChatEvent,
    },
    Ignore,
}

pub fn parse_line(raw: &str, now_ms: u64) -> ParsedLine {
    let line = raw.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return ParsedLine::Ignore;
    }
    if let Some(rest) = line.strip_prefix("PING ") {
        let payload = rest.trim().trim_start_matches(':').to_string();
        return ParsedLine::Ping(payload);
    }
    if line == "PING" {
        return ParsedLine::Ping(String::new());
    }

    let (tags, rest) = split_tags(line);
    let rest = rest.trim_start();
    let (prefix, rest) = split_prefix(rest);
    let mut parts = rest.splitn(2, ' ');
    let command = parts.next().unwrap_or("");
    let params_raw = parts.next().unwrap_or("");
    let (params, trailing) = split_params(params_raw);

    match command {
        "PING" => ParsedLine::Ping(trailing.unwrap_or_default()),
        "PONG" => ParsedLine::Pong,
        "001" => ParsedLine::Ready,
        "PRIVMSG" => parse_privmsg(
            &tags,
            prefix.as_deref(),
            &params,
            trailing.as_deref(),
            now_ms,
        ),
        "WHISPER" => parse_whisper(&tags, prefix.as_deref(), trailing.as_deref(), now_ms),
        "CLEARCHAT" => parse_clearchat(&tags, &params, trailing.as_deref(), now_ms),
        "CLEARMSG" => parse_clearmsg(&tags, &params, now_ms),
        "USERNOTICE" => parse_usernotice(&tags, &params, trailing.as_deref(), now_ms),
        "ROOMSTATE" => parse_roomstate(&tags, &params, now_ms),
        "USERSTATE" => parse_userstate(&tags, &params, now_ms),
        "NOTICE" => parse_notice(&tags, &params, trailing.as_deref(), now_ms),
        "TYPING" => parse_typing(&tags, prefix.as_deref(), &params, trailing.as_deref()),
        "TAGMSG" if is_typing_tagmsg(&tags) => {
            parse_typing(&tags, prefix.as_deref(), &params, trailing.as_deref())
        }
        "RECONNECT" => ParsedLine::Reconnect,
        "JOIN" => parse_membership(false, prefix.as_deref(), &params),
        "PART" => parse_membership(true, prefix.as_deref(), &params),
        "353" => parse_names(&params, trailing.as_deref()),
        "366" | "CAP" | "GLOBALUSERSTATE" => ParsedLine::Ignore,
        _ => ParsedLine::Ignore,
    }
}

fn parse_typing(
    tags: &Tags,
    prefix: Option<&str>,
    params: &[String],
    trailing: Option<&str>,
) -> ParsedLine {
    let channel = channel_from_params(params);
    if channel.is_empty() {
        return ParsedLine::Ignore;
    }
    let login = tags
        .get("login")
        .or_else(|| tags.get("user-login"))
        .or_else(|| prefix.and_then(login_from_prefix))
        .unwrap_or_default();
    if login.is_empty() {
        return ParsedLine::Ignore;
    }
    let display_name = tags
        .get("display-name")
        .or_else(|| tags.get("user-name"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| login.clone());
    let active = typing_active(tags, trailing);
    ParsedLine::Typing {
        channel,
        login,
        display_name,
        user_id: tags.get("user-id").unwrap_or_default(),
        badges: parse_badges(tags.get("badges").as_deref()),
        is_mod_tag: tags.get("mod").as_deref() == Some("1"),
        active,
    }
}

fn is_typing_tagmsg(tags: &Tags) -> bool {
    tags.get("msg-id")
        .or_else(|| tags.get("event"))
        .or_else(|| tags.get("type"))
        .is_some_and(|v| v.eq_ignore_ascii_case("typing"))
}

fn typing_active(tags: &Tags, trailing: Option<&str>) -> bool {
    let raw = tags
        .get("typing")
        .or_else(|| tags.get("active"))
        .or_else(|| trailing.map(|s| s.trim().to_string()))
        .unwrap_or_else(|| "1".to_string());
    !matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "stop" | "stopped" | "idle"
    )
}

fn parse_privmsg(
    tags: &Tags,
    prefix: Option<&str>,
    params: &[String],
    trailing: Option<&str>,
    now_ms: u64,
) -> ParsedLine {
    let channel = channel_from_params(params);
    if channel.is_empty() {
        return ParsedLine::Ignore;
    }
    let (text, action) = parse_message_body(trailing.unwrap_or(""));
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: build_privmsg(tags, prefix, text, action, now_ms, false),
        channel,
    }
}

fn parse_whisper(
    tags: &Tags,
    prefix: Option<&str>,
    trailing: Option<&str>,
    now_ms: u64,
) -> ParsedLine {
    let (text, action) = parse_message_body(trailing.unwrap_or(""));
    ParsedLine::Whisper {
        event: build_privmsg(tags, prefix, text, action, now_ms, true),
    }
}

fn parse_message_body(raw: &str) -> (String, bool) {
    let mut text = raw.to_string();
    let mut action = false;
    if let Some(inner) = text
        .strip_prefix("\u{0001}ACTION ")
        .and_then(|s| s.strip_suffix('\u{0001}'))
    {
        text = inner.to_string();
        action = true;
    }
    (text, action)
}

fn build_privmsg(
    tags: &Tags,
    prefix: Option<&str>,
    text: String,
    action: bool,
    now_ms: u64,
    whisper: bool,
) -> ChatEvent {
    let login = tags
        .get("login")
        .or_else(|| prefix.and_then(login_from_prefix))
        .unwrap_or_default();
    let display_name = tags
        .get("display-name")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| login.clone());
    let twitch_emotes = parse_twitch_emotes(tags.get("emotes").as_deref(), &text);
    let gif_spans = parse_twitch_gifs(tags.get("gifs").as_deref(), &text);
    let emote_spans = merge_emote_and_gif_spans(twitch_emotes, gif_spans);
    let (link_spans, mention_spans) = super::spans::decorate_text_spans(&text, &emote_spans);
    let id_prefix = if whisper { "w" } else { "p" };
    ChatEvent::Privmsg {
        id: tags
            .get("id")
            .or_else(|| tags.get("message-id"))
            .unwrap_or_else(|| synthetic_id(id_prefix, now_ms, &text)),
        timestamp_ms: tags.timestamp(now_ms),
        user_id: tags.get("user-id").unwrap_or_default(),
        login,
        display_name,
        color: tags.get("color").unwrap_or_default(),
        badges: parse_badges(tags.get("badges").as_deref()),
        emote_spans,
        link_spans,
        mention_spans,
        bits: tags.get("bits").and_then(|s| s.parse().ok()),
        reply_to_id: tags.get("reply-parent-msg-id"),
        reply_to_login: tags
            .get("reply-parent-user-login")
            .or_else(|| tags.get("reply-parent-display-name")),
        reply_to_display_name: tags.get("reply-parent-display-name"),
        reply_to_text: tags.get("reply-parent-msg-body"),
        action,
        first_msg: tags.get("first-msg").as_deref() == Some("1"),
        custom_reward_id: tags.get("custom-reward-id").filter(|s| !s.is_empty()),
        system_msg_id: tags.get("msg-id").filter(|s| !s.is_empty()),
        text,
        highlight_color: None,
        highlight_sound: false,
        highlight_sound_path: None,
        highlight_flash: false,
        whisper,
        disabled: false,
        source_room_id: tags.get("source-room-id").filter(|s| !s.is_empty()),
        source_badges: parse_badges(tags.get("source-badges").as_deref()),
        paint: None,
    }
}

fn parse_clearchat(
    tags: &Tags,
    params: &[String],
    trailing: Option<&str>,
    now_ms: u64,
) -> ParsedLine {
    let channel = channel_from_params(params);
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Clearchat {
            id: tags
                .get("id")
                .unwrap_or_else(|| synthetic_id("c", now_ms, &channel)),
            timestamp_ms: tags.timestamp(now_ms),
            target_login: trailing.map(|s| s.to_lowercase()).filter(|s| !s.is_empty()),
            duration_sec: tags.get("ban-duration").and_then(|s| s.parse().ok()),
            stack_count: 1,
            source_login: None,
            moderator_login: None,
        },
        channel,
    }
}

fn parse_clearmsg(tags: &Tags, params: &[String], now_ms: u64) -> ParsedLine {
    let channel = channel_from_params(params);
    let target_id = tags.get("target-msg-id").unwrap_or_default();
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Clearmsg {
            id: tags
                .get("id")
                .unwrap_or_else(|| synthetic_id("m", now_ms, &target_id)),
            timestamp_ms: tags.timestamp(now_ms),
            target_id,
        },
        channel,
    }
}

fn parse_usernotice(
    tags: &Tags,
    params: &[String],
    trailing: Option<&str>,
    now_ms: u64,
) -> ParsedLine {
    let channel = channel_from_params(params);
    let raw_system = tags.get("system-msg").unwrap_or_default();
    let login = tags.get("login");
    let msg_id = tags.get("msg-id").filter(|s| !s.is_empty());
    let notice_params = {
        let get = |k: &str| tags.get(k);
        super::usernotice::parse_usernotice_params(&get, msg_id.as_deref())
    };
    let system_text = super::usernotice::format_usernotice_system_en(
        msg_id.as_deref(),
        notice_params.as_ref(),
        &raw_system,
    );
    let attached = trailing.filter(|t| !t.is_empty()).map(|text| {
        let twitch_emotes = parse_twitch_emotes(tags.get("emotes").as_deref(), text);
        let gif_spans = parse_twitch_gifs(tags.get("gifs").as_deref(), text);
        let emote_spans = merge_emote_and_gif_spans(twitch_emotes, gif_spans);
        let (link_spans, mention_spans) = super::spans::decorate_text_spans(text, &emote_spans);
        Box::new(ChatEvent::Privmsg {
            id: format!(
                "{}-body",
                tags.get("id")
                    .unwrap_or_else(|| synthetic_id("u", now_ms, text))
            ),
            timestamp_ms: tags.timestamp(now_ms),
            user_id: tags.get("user-id").unwrap_or_default(),
            login: login.clone().unwrap_or_default(),
            display_name: tags
                .get("display-name")
                .filter(|s| !s.is_empty())
                .or_else(|| login.clone())
                .unwrap_or_default(),
            color: tags.get("color").unwrap_or_default(),
            badges: parse_badges(tags.get("badges").as_deref()),
            text: text.to_string(),
            emote_spans,
            link_spans,
            mention_spans,
            bits: None,
            reply_to_id: tags.get("reply-parent-msg-id"),
            reply_to_login: tags
                .get("reply-parent-user-login")
                .or_else(|| tags.get("reply-parent-display-name")),
            reply_to_display_name: tags.get("reply-parent-display-name"),
            reply_to_text: tags.get("reply-parent-msg-body"),
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
            source_room_id: tags.get("source-room-id").filter(|s| !s.is_empty()),
            source_badges: parse_badges(tags.get("source-badges").as_deref()),
            paint: None,
        })
    });
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Usernotice {
            id: tags
                .get("id")
                .unwrap_or_else(|| synthetic_id("u", now_ms, &system_text)),
            timestamp_ms: tags.timestamp(now_ms),
            system_text,
            login,
            msg_id,
            params: notice_params,
            privmsg: attached,
            highlight_color: None,
            highlight_sound: false,
            highlight_sound_path: None,
            highlight_flash: false,
        },
        channel,
    }
}

fn parse_roomstate(tags: &Tags, params: &[String], now_ms: u64) -> ParsedLine {
    let channel = channel_from_params(params);
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Roomstate {
            id: synthetic_id("r", now_ms, &channel),
            timestamp_ms: now_ms,
            emote_only: tags.get("emote-only").map(|v| v == "1"),
            subs_only: tags.get("subs-only").map(|v| v == "1"),
            slow_sec: tags.get("slow").and_then(|s| s.parse().ok()),
            followers_only: tags.get("followers-only").and_then(|s| s.parse().ok()),
        },
        channel,
    }
}

fn parse_userstate(tags: &Tags, params: &[String], now_ms: u64) -> ParsedLine {
    let channel = channel_from_params(params);
    if channel.is_empty() {
        return ParsedLine::Ignore;
    }
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Userstate {
            id: synthetic_id("u", now_ms, &channel),
            timestamp_ms: now_ms,
            badges: parse_badges(tags.get("badges").as_deref()),
            is_mod_tag: tags.get("mod").as_deref() == Some("1"),
            display_name: tags.get("display-name").filter(|s| !s.is_empty()),
            color: tags.get("color").filter(|s| !s.is_empty()),
        },
        channel,
    }
}

fn parse_names(params: &[String], trailing: Option<&str>) -> ParsedLine {
    let channel = params
        .iter()
        .rev()
        .find(|s| s.starts_with('#'))
        .map(|s| s.trim_start_matches('#').to_lowercase())
        .unwrap_or_default();
    if channel.is_empty() {
        return ParsedLine::Ignore;
    }
    let logins = trailing
        .unwrap_or("")
        .split_whitespace()
        .map(|n| n.trim_start_matches(['@', '+']).to_string())
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>();
    if logins.is_empty() {
        return ParsedLine::Ignore;
    }
    ParsedLine::Names { channel, logins }
}

fn parse_membership(part: bool, prefix: Option<&str>, params: &[String]) -> ParsedLine {
    let channel = channel_from_params(params);
    let login = prefix.and_then(login_from_prefix).unwrap_or_default();
    if channel.is_empty() || login.is_empty() {
        return ParsedLine::Ignore;
    }
    ParsedLine::Membership {
        part,
        channel,
        login,
    }
}

fn parse_notice(tags: &Tags, params: &[String], trailing: Option<&str>, now_ms: u64) -> ParsedLine {
    let channel = channel_from_params(params);
    let raw_text = trailing.unwrap_or("").to_string();
    let msg_id = tags.get("msg-id").filter(|s| !s.is_empty());
    let timeout_remaining_sec = msg_id
        .as_deref()
        .filter(|id| id.eq_ignore_ascii_case("msg_timedout"))
        .and_then(|_| super::usernotice::parse_notice_timeout_remaining(&raw_text));
    let text = if let Some(sec) = timeout_remaining_sec {
        format!(
            "You are timed out for {}.",
            super::usernotice::format_duration_en(u64::from(sec), 4)
        )
    } else {
        raw_text
    };
    ParsedLine::Event {
        room_id: None,
        event: ChatEvent::Notice {
            id: tags
                .get("id")
                .unwrap_or_else(|| synthetic_id("n", now_ms, &text)),
            timestamp_ms: now_ms,
            text,
            msg_id,
            timeout_remaining_sec,
        },
        channel,
    }
}

struct Tags(Vec<(String, String)>);

impl Tags {
    fn get(&self, key: &str) -> Option<String> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| unescape_tag(v))
            .filter(|v| !v.is_empty())
    }

    fn timestamp(&self, fallback: u64) -> u64 {
        self.get("tmi-sent-ts")
            .and_then(|s| s.parse().ok())
            .unwrap_or(fallback)
    }

    fn flag(&self, key: &str) -> bool {
        self.get(key).map(|v| v != "0").unwrap_or(false)
    }
}

fn split_tags(line: &str) -> (Tags, &str) {
    if let Some(rest) = line.strip_prefix('@') {
        if let Some((tags, rest)) = rest.split_once(' ') {
            let parsed = tags
                .split(';')
                .filter_map(|pair| {
                    pair.split_once('=')
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                })
                .collect();
            return (Tags(parsed), rest);
        }
    }
    (Tags(Vec::new()), line)
}

fn split_prefix(rest: &str) -> (Option<String>, &str) {
    if let Some(rest) = rest.strip_prefix(':') {
        if let Some((prefix, rest)) = rest.split_once(' ') {
            return (Some(prefix.to_string()), rest);
        }
    }
    (None, rest)
}

fn split_params(raw: &str) -> (Vec<String>, Option<String>) {
    if raw.is_empty() {
        return (Vec::new(), None);
    }
    if let Some(idx) = find_trailing(raw) {
        let head = raw[..idx].trim();
        let trail = raw[idx + 1..].to_string();
        let params = if head.is_empty() {
            Vec::new()
        } else {
            head.split_whitespace().map(|s| s.to_string()).collect()
        };
        (params, Some(trail))
    } else {
        (
            raw.split_whitespace().map(|s| s.to_string()).collect(),
            None,
        )
    }
}

fn find_trailing(raw: &str) -> Option<usize> {
    if let Some(stripped) = raw.strip_prefix(':') {
        if stripped.contains(" :") || !raw[1..].contains(' ') {
            return Some(0);
        }
    }
    raw.find(" :").map(|i| i + 1)
}

fn channel_from_params(params: &[String]) -> String {
    params
        .first()
        .map(|s| s.trim_start_matches('#').to_lowercase())
        .unwrap_or_default()
}

fn login_from_prefix(prefix: &str) -> Option<String> {
    let ident = prefix.split('!').next().unwrap_or(prefix);
    if ident.is_empty() || ident.contains('.') {
        None
    } else {
        Some(ident.to_lowercase())
    }
}

fn parse_badges(raw: Option<&str>) -> Vec<Badge> {
    match raw {
        None | Some("") => Vec::new(),
        Some(s) => s
            .split(',')
            .filter_map(|part| {
                let part = part.trim();
                if part.is_empty() {
                    return None;
                }
                let (set, version) = part.split_once('/')?;
                if set.is_empty() || version.is_empty() {
                    return None;
                }
                Some(Badge {
                    set: set.to_string(),
                    version: version.to_string(),
                    url: None,
                    source: "twitch".to_string(),
                    tooltip: None,
                })
            })
            .collect(),
    }
}

pub fn parse_twitch_emotes(raw: Option<&str>, text: &str) -> Vec<EmoteSpan> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let mut spans = Vec::new();
    for group in raw.split('/') {
        let Some((id, ranges)) = group.split_once(':') else {
            continue;
        };
        for range in ranges.split(',') {
            let Some((a, b)) = range.split_once('-') else {
                continue;
            };
            let Ok(start_cp) = a.parse::<usize>() else {
                continue;
            };
            let Ok(end_cp) = b.parse::<usize>() else {
                continue;
            };
            if !safe_twitch_emote_id(id) {
                continue;
            }
            let text_u16 = utf16_units(text) as u32;
            let start = scalar_to_utf16(text, start_cp) as u32;
            let end = scalar_to_utf16(text, end_cp.saturating_add(1)) as u32;
            if start >= end || start >= text_u16 {
                continue;
            }
            let end = end.min(text_u16);
            if start >= end {
                continue;
            }
            spans.push(EmoteSpan {
                start,
                end,
                emote_id: id.to_string(),
                provider: "twitch".to_string(),
                url: twitch_emote_url(id),
                zero_width: false,
                bits_amount: None,
                bits_color: None,
                display_width: None,
                display_height: None,
            });
        }
    }
    spans.sort_by_key(|s| s.start);
    spans
}

/// Twitch IRC `gifs` tag: comma-separated `start-end|id|url` entries (UTF-16 indices).
pub fn parse_twitch_gifs(raw: Option<&str>, text: &str) -> Vec<EmoteSpan> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let text_u16 = utf16_units(text) as u32;
    let mut spans = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let mut parts = entry.splitn(3, '|');
        let range = parts.next().unwrap_or("");
        let gif_id = parts.next().unwrap_or("");
        let url = parts.next().unwrap_or("");
        if gif_id.is_empty() || url.is_empty() {
            continue;
        }
        if !safe_twitch_gif_id(gif_id) {
            continue;
        }
        let Some(url) = super::fetch::allowed_twitch_gif_url(url) else {
            continue;
        };
        if !super::fetch::gif_url_matches_id(&url, gif_id) {
            continue;
        }
        let Some((a, b)) = range.split_once('-') else {
            continue;
        };
        let Ok(start_cp) = a.parse::<usize>() else {
            continue;
        };
        let Ok(end_cp) = b.parse::<usize>() else {
            continue;
        };
        let start = scalar_to_utf16(text, start_cp) as u32;
        let end = scalar_to_utf16(text, end_cp.saturating_add(1)) as u32;
        if start >= end || start >= text_u16 {
            continue;
        }
        let end = end.min(text_u16);
        if start >= end {
            continue;
        }
        spans.push(EmoteSpan {
            start,
            end,
            emote_id: gif_id.to_string(),
            provider: "twitch-gif".to_string(),
            url,
            zero_width: false,
            bits_amount: None,
            bits_color: None,
            display_width: Some(4),
            display_height: Some(3),
        });
    }
    spans.sort_by_key(|s| s.start);
    spans
}

pub fn emote_span_for_gif(text: &str, gif_id: &str, url: &str) -> Option<EmoteSpan> {
    if text.is_empty() || !safe_twitch_gif_id(gif_id) {
        return None;
    }
    let allowed = super::fetch::allowed_twitch_gif_url(url)?;
    if !super::fetch::gif_url_matches_id(&allowed, gif_id) {
        return None;
    }
    let end = utf16_units(text) as u32;
    if end == 0 {
        return None;
    }
    Some(EmoteSpan {
        start: 0,
        end,
        emote_id: gif_id.to_string(),
        provider: "twitch-gif".to_string(),
        url: allowed,
        zero_width: false,
        bits_amount: None,
        bits_color: None,
        display_width: Some(4),
        display_height: Some(3),
    })
}

fn safe_twitch_gif_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn merge_emote_and_gif_spans(emotes: Vec<EmoteSpan>, gifs: Vec<EmoteSpan>) -> Vec<EmoteSpan> {
    if gifs.is_empty() {
        return emotes;
    }
    if emotes.is_empty() {
        return gifs;
    }
    let mut out = gifs;
    for emote in emotes {
        if !out.iter().any(|g| spans_overlap(g, &emote)) {
            out.push(emote);
        }
    }
    out.sort_by_key(|s| s.start);
    out
}

fn spans_overlap(a: &EmoteSpan, b: &EmoteSpan) -> bool {
    a.start < b.end && b.start < a.end
}

/// Stock stripLeadingReplyMention — UTF-16 offset of stripped `@displayName `.
pub fn strip_leading_reply_mention(text: &str, display_name: &str) -> Option<(String, u32)> {
    if display_name.is_empty() {
        return None;
    }
    let name_u16 = utf16_units(display_name);
    if utf16_units(text) <= 1 + name_u16 {
        return None;
    }
    let prefix = format!("@{display_name} ");
    if !text.starts_with(&prefix) {
        return None;
    }
    let rest = text[prefix.len()..].to_string();
    Some((rest, utf16_units(&prefix) as u32))
}

pub fn shift_emote_spans_back(spans: &mut Vec<EmoteSpan>, offset: u32) {
    if offset == 0 {
        return;
    }
    spans.retain_mut(|s| {
        if s.end <= offset {
            return false;
        }
        s.start = s.start.saturating_sub(offset);
        s.end -= offset;
        s.start < s.end
    });
}

pub fn utf16_units(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

pub fn safe_twitch_emote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn twitch_emote_url(id: &str) -> String {
    format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0")
}

pub fn scalar_to_utf16(text: &str, scalar_index: usize) -> usize {
    text.chars().take(scalar_index).map(|c| c.len_utf16()).sum()
}

fn unescape_tag(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(':') => out.push(';'),
                Some('s') => out.push(' '),
                Some('\\') => out.push('\\'),
                Some('r') => out.push('\r'),
                Some('n') => out.push('\n'),
                Some(other) => out.push(other),
                None => break,
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub(crate) fn synthetic_id(prefix: &str, now_ms: u64, salt: &str) -> String {
    let seq = SYNTHETIC_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{now_ms}-{seq}-{}", salt.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_privmsg_and_utf16_emote_span() {
        let line = "@badge-info=;badges=broadcaster/1;color=#FF0000;display-name=Test;emotes=25:0-4;id=abc;mod=0;room-id=1;subscriber=0;tmi-sent-ts=10;turbo=0;user-id=99;user-type= :test!test@test.tmi.twitch.tv PRIVMSG #xqc :Kappa hello";
        match parse_line(line, 99) {
            ParsedLine::Event {
                channel,
                event:
                    ChatEvent::Privmsg {
                        text,
                        emote_spans,
                        display_name,
                        user_id,
                        ..
                    },
                room_id,
            } => {
                assert_eq!(channel, "xqc");
                assert_eq!(room_id.as_deref(), Some("1"));
                assert_eq!(text, "Kappa hello");
                assert_eq!(display_name, "Test");
                assert_eq!(user_id, "99");
                assert_eq!(emote_spans.len(), 1);
                assert_eq!(emote_spans[0].start, 0);
                assert_eq!(emote_spans[0].end, 5);
                assert_eq!(emote_spans[0].provider, "twitch");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn userstate_keeps_display_name_and_color() {
        let line = "@badge-info=;badges=broadcaster/1;color=#9ACD32;display-name=Mike_Saito;emote-sets=0;mod=0;subscriber=0;user-type= :tmi.twitch.tv USERSTATE #mike_saito";
        match parse_line(line, 42) {
            ParsedLine::Event {
                channel,
                event:
                    ChatEvent::Userstate {
                        display_name,
                        color,
                        badges,
                        ..
                    },
                ..
            } => {
                assert_eq!(channel, "mike_saito");
                assert_eq!(display_name.as_deref(), Some("Mike_Saito"));
                assert_eq!(color.as_deref(), Some("#9ACD32"));
                assert_eq!(badges.len(), 1);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn userstate_empty_color_stays_none() {
        let line = "@badge-info=;badges=;color=;display-name=;mod=0 :tmi.twitch.tv USERSTATE #xqc";
        match parse_line(line, 1) {
            ParsedLine::Event {
                event:
                    ChatEvent::Userstate {
                        display_name,
                        color,
                        ..
                    },
                ..
            } => {
                assert!(display_name.is_none());
                assert!(color.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_typing_signal() {
        let line = "@badges=moderator/1;display-name=Mod_User;login=mod_user;mod=1;user-id=42 :mod_user!mod_user@mod_user.tmi.twitch.tv TYPING #streamer";
        match parse_line(line, 99) {
            ParsedLine::Typing {
                channel,
                login,
                display_name,
                user_id,
                badges,
                is_mod_tag,
                active,
            } => {
                assert_eq!(channel, "streamer");
                assert_eq!(login, "mod_user");
                assert_eq!(display_name, "Mod_User");
                assert_eq!(user_id, "42");
                assert_eq!(badges[0].set, "moderator");
                assert!(is_mod_tag);
                assert!(active);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_typing_stop_tagmsg() {
        let line = "@badges=broadcaster/1;display-name=Streamer;login=streamer;msg-id=typing;typing=0;user-id=7 :streamer!streamer@streamer.tmi.twitch.tv TAGMSG #streamer";
        match parse_line(line, 99) {
            ParsedLine::Typing {
                channel,
                login,
                display_name,
                user_id,
                active,
                ..
            } => {
                assert_eq!(channel, "streamer");
                assert_eq!(login, "streamer");
                assert_eq!(display_name, "Streamer");
                assert_eq!(user_id, "7");
                assert!(!active);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_badge_set_and_version() {
        let line = "@badges=broadcaster/1,subscriber/12;id=abc;display-name=Test;user-id=1 :test!test@test.tmi.twitch.tv PRIVMSG #xqc :hi";
        match parse_line(line, 1) {
            ParsedLine::Event {
                event: ChatEvent::Privmsg { badges, .. },
                ..
            } => {
                assert_eq!(badges.len(), 2);
                assert_eq!(badges[0].set, "broadcaster");
                assert_eq!(badges[0].version, "1");
                assert!(badges[0].url.is_none());
                assert_eq!(badges[1].set, "subscriber");
                assert_eq!(badges[1].version, "12");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn emote_indices_use_utf16_for_non_bmp() {
        let text = "😀Kappa";
        let smile_scalars = text.chars().take(1).count();
        assert_eq!(smile_scalars, 1);
        assert_eq!(scalar_to_utf16(text, 0), 0);
        assert_eq!(scalar_to_utf16(text, 1), 2);
        let spans = parse_twitch_emotes(Some("25:1-5"), text);
        assert_eq!(spans[0].start, 2);
        assert_eq!(spans[0].end, 7);
    }

    #[test]
    fn ping_and_clearchat() {
        assert_eq!(
            parse_line("PING :tmi.twitch.tv", 1),
            ParsedLine::Ping("tmi.twitch.tv".into())
        );
        assert_eq!(
            parse_line(":tmi.twitch.tv PONG tmi.twitch.tv :webtv", 1),
            ParsedLine::Pong
        );
        match parse_line(
            "@ban-duration=600;room-id=1 :tmi.twitch.tv CLEARCHAT #xqc :baduser",
            2,
        ) {
            ParsedLine::Event {
                event:
                    ChatEvent::Clearchat {
                        target_login,
                        duration_sec,
                        ..
                    },
                ..
            } => {
                assert_eq!(target_login.as_deref(), Some("baduser"));
                assert_eq!(duration_sec, Some(600));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_action_privmsg() {
        let line = "@id=a1;display-name=Test;user-id=9;room-id=1 :test!test@test.tmi.twitch.tv PRIVMSG #xqc :\u{0001}ACTION waves\u{0001}";
        match parse_line(line, 10) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        action,
                        text,
                        emote_spans,
                        ..
                    },
                channel,
                ..
            } => {
                assert_eq!(channel, "xqc");
                assert!(action);
                assert_eq!(text, "waves");
                assert!(emote_spans.is_empty());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn action_emote_indices_are_on_inner_text() {
        let line = "@id=a2;emotes=25:0-4;display-name=Test;user-id=9 :test!test@test.tmi.twitch.tv PRIVMSG #xqc :\u{0001}ACTION Kappa\u{0001}";
        match parse_line(line, 10) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        action,
                        text,
                        emote_spans,
                        ..
                    },
                ..
            } => {
                assert!(action);
                assert_eq!(text, "Kappa");
                assert_eq!(emote_spans.len(), 1);
                assert_eq!(emote_spans[0].start, 0);
                assert_eq!(emote_spans[0].end, 5);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn privmsg_without_emotes_tag() {
        let line =
            "@id=abc;display-name=Test;user-id=1 :test!test@test.tmi.twitch.tv PRIVMSG #xqc :hello";
        match parse_line(line, 11) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        text,
                        emote_spans,
                        action,
                        ..
                    },
                ..
            } => {
                assert_eq!(text, "hello");
                assert!(!action);
                assert!(emote_spans.is_empty());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn usernotice_unescapes_system_msg() {
        let line =
            "@system-msg=foo\\sbar;id=u1;login=ann;msg-id=sub :tmi.twitch.tv USERNOTICE #xqc";
        match parse_line(line, 12) {
            ParsedLine::Event {
                event:
                    ChatEvent::Usernotice {
                        system_text,
                        login,
                        privmsg,
                        ..
                    },
                ..
            } => {
                assert_eq!(system_text, "foo bar");
                assert_eq!(login.as_deref(), Some("ann"));
                assert!(privmsg.is_none());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn usernotice_trailing_has_link_span() {
        let line = "@system-msg=subbed;id=u2;login=ann;display-name=Ann :tmi.twitch.tv USERNOTICE #xqc :hi https://example.com";
        match parse_line(line, 21) {
            ParsedLine::Event {
                event: ChatEvent::Usernotice { privmsg, .. },
                ..
            } => {
                let Some(ChatEvent::Privmsg {
                    text, link_spans, ..
                }) = privmsg.as_deref()
                else {
                    panic!("no body");
                };
                assert_eq!(text, "hi https://example.com");
                assert_eq!(link_spans.len(), 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn clearmsg_target_msg_id() {
        let line = "@login=x;target-msg-id=abc;room-id=1 :tmi.twitch.tv CLEARMSG #xqc :hide";
        match parse_line(line, 13) {
            ParsedLine::Event {
                event: ChatEvent::Clearmsg { target_id, .. },
                channel,
                ..
            } => {
                assert_eq!(channel, "xqc");
                assert_eq!(target_id, "abc");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_reply_tags_and_link_span() {
        let line = "@id=r1;display-name=Test;user-id=1;reply-parent-msg-id=p0;reply-parent-user-login=ann;reply-parent-display-name=Ann;reply-parent-msg-body=hi\\sthere :test!test@test.tmi.twitch.tv PRIVMSG #xqc :see https://example.com @bob";
        match parse_line(line, 20) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        reply_to_id,
                        reply_to_login,
                        reply_to_display_name,
                        reply_to_text,
                        link_spans,
                        mention_spans,
                        text,
                        ..
                    },
                ..
            } => {
                assert_eq!(reply_to_id.as_deref(), Some("p0"));
                assert_eq!(reply_to_login.as_deref(), Some("ann"));
                assert_eq!(reply_to_display_name.as_deref(), Some("Ann"));
                assert_eq!(reply_to_text.as_deref(), Some("hi there"));
                assert_eq!(text, "see https://example.com @bob");
                assert_eq!(link_spans.len(), 1);
                assert_eq!(link_spans[0].start, 4);
                assert_eq!(mention_spans.len(), 1);
                assert_eq!(mention_spans[0].login, "bob");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn roomstate_and_reconnect() {
        assert_eq!(
            parse_line(":tmi.twitch.tv RECONNECT", 14),
            ParsedLine::Reconnect
        );
        match parse_line(
            ":justinfan1!justinfan1@justinfan1.tmi.twitch.tv PART #xqc",
            16,
        ) {
            ParsedLine::Membership {
                part,
                channel,
                login,
            } => {
                assert!(part);
                assert_eq!(channel, "xqc");
                assert_eq!(login, "justinfan1");
            }
            other => panic!("{other:?}"),
        }
        match parse_line(
            "@emote-only=1;subs-only=0;slow=5;followers-only=-1;room-id=1 :tmi.twitch.tv ROOMSTATE #xqc",
            15,
        ) {
            ParsedLine::Event {
                event: ChatEvent::Roomstate {
                    emote_only,
                    subs_only,
                    slow_sec,
                    followers_only,
                    ..
                },
                channel,
                room_id,
            } => {
                assert_eq!(channel, "xqc");
                assert_eq!(room_id.as_deref(), Some("1"));
                assert_eq!(emote_only, Some(true));
                assert_eq!(subs_only, Some(false));
                assert_eq!(slow_sec, Some(5));
                assert_eq!(followers_only, Some(-1));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_names_353() {
        match parse_line(
            ":tmi.twitch.tv 353 justinfan1 = #xqc :bob @Mod_user +voice",
            20,
        ) {
            ParsedLine::Names { channel, logins } => {
                assert_eq!(channel, "xqc");
                assert_eq!(logins, vec!["bob", "Mod_user", "voice"]);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse_line(":tmi.twitch.tv 366 justinfan1 #xqc :End of /NAMES list", 21),
            ParsedLine::Ignore
        ));
    }

    #[test]
    fn strip_leading_reply_mention_stock() {
        let (rest, off) = strip_leading_reply_mention("@Ann hello", "Ann").unwrap();
        assert_eq!(rest, "hello");
        assert_eq!(off, 5);
        assert!(strip_leading_reply_mention("@Ann", "Ann").is_none());
        assert!(strip_leading_reply_mention("@ann hello", "Ann").is_none());
        assert!(strip_leading_reply_mention("hello Ann", "Ann").is_none());
        let mut spans = vec![EmoteSpan {
            start: 5,
            end: 10,
            emote_id: "25".into(),
            provider: "twitch".into(),
            url: "x".into(),
            zero_width: false,
            bits_amount: None,
            bits_color: None,
            display_width: None,
            display_height: None,
        }];
        shift_emote_spans_back(&mut spans, 5);
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[0].end, 5);
    }

    #[test]
    fn parses_first_msg_reward_and_usernotice_msg_id() {
        match parse_line(
            "@badge-info=;badges=;color=;display-name=Ann;emotes=;first-msg=1;id=m1;mod=0;msg-id=highlighted-message;custom-reward-id=rew1;room-id=1;subscriber=0;tmi-sent-ts=10;user-id=9;user-type= :ann!ann@ann.tmi.twitch.tv PRIVMSG #xqc :hi",
            1,
        ) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        first_msg,
                        custom_reward_id,
                        system_msg_id,
                        ..
                    },
                ..
            } => {
                assert!(first_msg);
                assert_eq!(custom_reward_id.as_deref(), Some("rew1"));
                assert_eq!(system_msg_id.as_deref(), Some("highlighted-message"));
            }
            other => panic!("{other:?}"),
        }
        match parse_line(
            "@badge-info=;badges=;color=;display-name=Ann;emotes=;id=u1;login=ann;msg-id=resub;room-id=1;subscriber=1;system-msg=ann\\ssubscribed;tmi-sent-ts=10;user-id=9;user-type= :tmi.twitch.tv USERNOTICE #xqc",
            2,
        ) {
            ParsedLine::Event {
                event: ChatEvent::Usernotice { msg_id, .. },
                ..
            } => {
                assert_eq!(msg_id.as_deref(), Some("resub"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_usernotice_subgift_params() {
        let line = "@badge-info=;badges=;color=#FFF;display-name=Gifter;emotes=;id=u2;login=gifter;msg-id=subgift;msg-param-gift-months=3;msg-param-months=3;msg-param-recipient-display-name=Bob;msg-param-recipient-id=2;msg-param-recipient-user-name=bob;msg-param-sender-count=10;msg-param-sub-plan=1000;room-id=1;subscriber=1;system-msg=Gifter\\sgifted;tmi-sent-ts=10;user-id=1;user-type= :tmi.twitch.tv USERNOTICE #xqc";
        match parse_line(line, 3) {
            ParsedLine::Event {
                event:
                    ChatEvent::Usernotice {
                        msg_id,
                        params: Some(p),
                        ..
                    },
                ..
            } => {
                assert_eq!(msg_id.as_deref(), Some("subgift"));
                assert_eq!(p.gift_months, Some(3));
                assert_eq!(p.recipient_login.as_deref(), Some("bob"));
                assert_eq!(p.plan.as_deref(), Some("1000"));
                assert!(!p.anon);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_usernotice_raid_params() {
        let line = "@badge-info=;badges=;color=;display-name=IgnoredHost;emotes=;id=raid1;login=ignoredhost;msg-id=raid;msg-param-displayName=BusterBroid;msg-param-login=busterbroid;msg-param-viewerCount=428;room-id=1;system-msg=BusterBroid\\sis\\sraiding\\swith\\sa\\sparty\\sof\\s428!;tmi-sent-ts=10;user-id=9;user-type= :tmi.twitch.tv USERNOTICE #xqc";
        match parse_line(line, 4) {
            ParsedLine::Event {
                channel,
                event:
                    ChatEvent::Usernotice {
                        msg_id,
                        system_text,
                        params: Some(p),
                        ..
                    },
                ..
            } => {
                assert_eq!(channel, "xqc");
                assert_eq!(msg_id.as_deref(), Some("raid"));
                assert_eq!(p.raid_login.as_deref(), Some("busterbroid"));
                assert_eq!(p.raid_display_name.as_deref(), Some("BusterBroid"));
                assert_eq!(p.viewer_count, Some(428));
                assert_eq!(system_text, "BusterBroid is raiding with a party of 428!");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_notice_msg_timedout() {
        let line = "@msg-id=msg_timedout :tmi.twitch.tv NOTICE #xqc :You are timed out for 600 more seconds.";
        match parse_line(line, 4) {
            ParsedLine::Event {
                event:
                    ChatEvent::Notice {
                        msg_id,
                        timeout_remaining_sec,
                        ..
                    },
                ..
            } => {
                assert_eq!(msg_id.as_deref(), Some("msg_timedout"));
                assert_eq!(timeout_remaining_sec, Some(600));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_shared_chat_privmsg_tags() {
        let line = r#"@mod=0;flags=;badge-info=;source-badge-info=;color=#DAA520;user-id=612865661;subscriber=0;id=886028cc-9985-47b9-a273-8164c6d59a76;turbo=0;source-badges=staff/1,moderator/1;room-id=11148817;source-id=eefbae4a-d3a1-4307-8d15-fab0f03fd9b9;source-room-id=1025594235;emotes=;display-name=lahoooo;tmi-sent-ts=1727304317562;badges=staff/1;user-type=staff :lahoooo!lahoooo@lahoooo.tmi.twitch.tv PRIVMSG #pajlada :hello"#;
        match parse_line(line, 100) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        source_room_id,
                        source_badges,
                        badges,
                        ..
                    },
                room_id,
                ..
            } => {
                assert_eq!(room_id.as_deref(), Some("11148817"));
                assert_eq!(source_room_id.as_deref(), Some("1025594235"));
                assert_eq!(source_badges.len(), 2);
                assert_eq!(source_badges[0].set, "staff");
                assert_eq!(badges.len(), 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_whisper_with_message_id_and_emotes() {
        let line = "@badge-info=;badges=;color=#9146FF;display-name=Sender;emotes=25:0-4;message-id=w1;thread-id=t1;turbo=0;user-id=42;user-type= :sender!sender@sender.tmi.twitch.tv WHISPER receiver :Kappa secret";
        match parse_line(line, 100) {
            ParsedLine::Whisper {
                event:
                    ChatEvent::Privmsg {
                        text,
                        emote_spans,
                        login,
                        user_id,
                        whisper,
                        ..
                    },
            } => {
                assert!(whisper);
                assert_eq!(login, "sender");
                assert_eq!(user_id, "42");
                assert_eq!(text, "Kappa secret");
                assert_eq!(emote_spans.len(), 1);
                assert_eq!(emote_spans[0].start, 0);
                assert_eq!(emote_spans[0].end, 5);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_yandy_placeholder_gif_via_gifs_tag() {
        let url = "https://media2.giphy.com/media/xYz9AbCdEfGhIjKl/giphy.webp?cid=abc";
        let text = "[Valentines Day Reaction GIF by Yandy.com]";
        let end = text.chars().count().saturating_sub(1);
        let line = format!(
            "@display-name=Dev;emotes=;gifs=0-{end}|xYz9AbCdEfGhIjKl|{url};id=g2;user-id=1 :dev!dev@dev.tmi.twitch.tv PRIVMSG #twitch :{text}"
        );
        match parse_line(&line, 100) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        text: body,
                        emote_spans,
                        ..
                    },
                ..
            } => {
                assert_eq!(body, text);
                assert_eq!(emote_spans.len(), 1);
                assert_eq!(emote_spans[0].provider, "twitch-gif");
                assert_eq!(emote_spans[0].emote_id, "xYz9AbCdEfGhIjKl");
                assert_eq!(emote_spans[0].url, url);
                assert_eq!(emote_spans[0].start, 0);
                assert_eq!(emote_spans[0].end, utf16_units(text) as u32);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_twitch_gifs_tag_on_privmsg() {
        let url = "https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=abc";
        let text = "[Y A Y Yes GIF by Djemilah Birnie]";
        let line = format!(
            "@display-name=Dev;emotes=;gifs=0-33|joSNxeswxuc74Juo8X|{url};id=g1;user-id=1 :dev!dev@dev.tmi.twitch.tv PRIVMSG #twitch :{text}"
        );
        match parse_line(&line, 100) {
            ParsedLine::Event {
                event:
                    ChatEvent::Privmsg {
                        text: body,
                        emote_spans,
                        ..
                    },
                ..
            } => {
                assert_eq!(body, text);
                assert_eq!(emote_spans.len(), 1);
                assert_eq!(emote_spans[0].provider, "twitch-gif");
                assert_eq!(emote_spans[0].emote_id, "joSNxeswxuc74Juo8X");
                assert_eq!(emote_spans[0].url, url);
                assert_eq!(emote_spans[0].start, 0);
                assert_eq!(emote_spans[0].end, utf16_units(text) as u32);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn gif_spans_win_over_emote_overlap() {
        let _text = "[GIF]";
        let emotes = vec![EmoteSpan {
            start: 0,
            end: 5,
            emote_id: "25".into(),
            provider: "twitch".into(),
            url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0".into(),
            zero_width: false,
            bits_amount: None,
            bits_color: None,
            display_width: None,
            display_height: None,
        }];
        let gifs = vec![EmoteSpan {
            start: 0,
            end: 5,
            emote_id: "abc".into(),
            provider: "twitch-gif".into(),
            url: "https://media1.giphy.com/media/abc/giphy.gif".into(),
            zero_width: false,
            bits_amount: None,
            bits_color: None,
            display_width: Some(4),
            display_height: Some(3),
        }];
        let merged = merge_emote_and_gif_spans(emotes, gifs);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].provider, "twitch-gif");
    }
}
