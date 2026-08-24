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
        "PRIVMSG" => parse_privmsg(&tags, prefix.as_deref(), &params, trailing.as_deref(), now_ms),
        "WHISPER" => parse_whisper(&tags, prefix.as_deref(), trailing.as_deref(), now_ms),
        "CLEARCHAT" => parse_clearchat(&tags, &params, trailing.as_deref(), now_ms),
        "CLEARMSG" => parse_clearmsg(&tags, &params, now_ms),
        "USERNOTICE" => parse_usernotice(&tags, &params, trailing.as_deref(), now_ms),
        "ROOMSTATE" => parse_roomstate(&tags, &params, now_ms),
        "USERSTATE" => parse_userstate(&tags, &params, now_ms),
        "NOTICE" => parse_notice(&tags, &params, trailing.as_deref(), now_ms),
        "RECONNECT" => ParsedLine::Reconnect,
        "JOIN" => parse_membership(false, prefix.as_deref(), &params),
        "PART" => parse_membership(true, prefix.as_deref(), &params),
        "353" => parse_names(&params, trailing.as_deref()),
        "366" | "CAP" | "GLOBALUSERSTATE" => ParsedLine::Ignore,
        _ => ParsedLine::Ignore,
    }
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
    let emote_spans = parse_twitch_emotes(tags.get("emotes").as_deref(), &text);
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
        custom_reward_id: tags
            .get("custom-reward-id")
            .filter(|s| !s.is_empty()),
        system_msg_id: tags.get("msg-id").filter(|s| !s.is_empty()),
        text,
        highlight_color: None,
        highlight_sound: false,
        highlight_sound_path: None,
        highlight_flash: false,
        whisper,
        disabled: false,
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
            id: tags.get("id").unwrap_or_else(|| synthetic_id("c", now_ms, &channel)),
            timestamp_ms: tags.timestamp(now_ms),
            target_login: trailing.map(|s| s.to_lowercase()).filter(|s| !s.is_empty()),
            duration_sec: tags.get("ban-duration").and_then(|s| s.parse().ok()),
            stack_count: 1,
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
            id: tags.get("id").unwrap_or_else(|| synthetic_id("m", now_ms, &target_id)),
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
    let system_text = tags.get("system-msg").unwrap_or_default();
    let login = tags.get("login");
    let attached = trailing.filter(|t| !t.is_empty()).map(|text| {
        let emote_spans = parse_twitch_emotes(tags.get("emotes").as_deref(), text);
        let (link_spans, mention_spans) = super::spans::decorate_text_spans(text, &emote_spans);
        Box::new(ChatEvent::Privmsg {
            id: format!("{}-body", tags.get("id").unwrap_or_else(|| synthetic_id("u", now_ms, text))),
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
        })
    });
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Usernotice {
            id: tags.get("id").unwrap_or_else(|| synthetic_id("u", now_ms, &system_text)),
            timestamp_ms: tags.timestamp(now_ms),
            system_text,
            login,
            msg_id: tags.get("msg-id").filter(|s| !s.is_empty()),
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

fn parse_notice(
    tags: &Tags,
    params: &[String],
    trailing: Option<&str>,
    now_ms: u64,
) -> ParsedLine {
    let channel = channel_from_params(params);
    let text = trailing.unwrap_or("").to_string();
    ParsedLine::Event {
        room_id: None,
        event: ChatEvent::Notice {
            id: tags.get("msg-id").unwrap_or_else(|| synthetic_id("n", now_ms, &text)),
            timestamp_ms: now_ms,
            text,
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
                .filter_map(|pair| pair.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
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
            let Ok(start_cp) = a.parse::<usize>() else { continue };
            let Ok(end_cp) = b.parse::<usize>() else { continue };
            if !safe_twitch_emote_id(id) {
                continue;
            }
            let start = scalar_to_utf16(text, start_cp) as u32;
            let end = scalar_to_utf16(text, end_cp.saturating_add(1)) as u32;
            spans.push(EmoteSpan {
                start,
                end,
                emote_id: id.to_string(),
                provider: "twitch".to_string(),
                url: twitch_emote_url(id),
                zero_width: false,
                bits_amount: None,
                bits_color: None,
            });
        }
    }
    spans.sort_by_key(|s| s.start);
    spans
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

fn utf16_units(s: &str) -> usize {
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

fn synthetic_id(prefix: &str, now_ms: u64, salt: &str) -> String {
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
                event: ChatEvent::Privmsg {
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
        assert_eq!(parse_line("PING :tmi.twitch.tv", 1), ParsedLine::Ping("tmi.twitch.tv".into()));
        assert_eq!(parse_line(":tmi.twitch.tv PONG tmi.twitch.tv :webtv", 1), ParsedLine::Pong);
        match parse_line("@ban-duration=600;room-id=1 :tmi.twitch.tv CLEARCHAT #xqc :baduser", 2) {
            ParsedLine::Event {
                event: ChatEvent::Clearchat {
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
                event: ChatEvent::Privmsg {
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
                event: ChatEvent::Privmsg {
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
        let line = "@id=abc;display-name=Test;user-id=1 :test!test@test.tmi.twitch.tv PRIVMSG #xqc :hello";
        match parse_line(line, 11) {
            ParsedLine::Event {
                event: ChatEvent::Privmsg {
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
        let line = "@system-msg=foo\\sbar;id=u1;login=ann;msg-id=sub :tmi.twitch.tv USERNOTICE #xqc";
        match parse_line(line, 12) {
            ParsedLine::Event {
                event: ChatEvent::Usernotice {
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
                    text,
                    link_spans,
                    ..
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
                event: ChatEvent::Privmsg {
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
        assert_eq!(parse_line(":tmi.twitch.tv RECONNECT", 14), ParsedLine::Reconnect);
        match parse_line(":justinfan1!justinfan1@justinfan1.tmi.twitch.tv PART #xqc", 16) {
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
}
