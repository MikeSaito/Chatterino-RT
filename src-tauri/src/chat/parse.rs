use super::types::{ChatEvent, EmoteSpan};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedLine {
    Event {
        channel: String,
        event: ChatEvent,
        room_id: Option<String>,
    },
    Ping(String),
    Ready,
    Reconnect,
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
        "001" => ParsedLine::Ready,
        "PRIVMSG" => parse_privmsg(&tags, prefix.as_deref(), &params, trailing.as_deref(), now_ms),
        "CLEARCHAT" => parse_clearchat(&tags, &params, trailing.as_deref(), now_ms),
        "CLEARMSG" => parse_clearmsg(&tags, &params, now_ms),
        "USERNOTICE" => parse_usernotice(&tags, &params, trailing.as_deref(), now_ms),
        "ROOMSTATE" => parse_roomstate(&tags, &params, now_ms),
        "NOTICE" => parse_notice(&tags, &params, trailing.as_deref(), now_ms),
        "RECONNECT" => ParsedLine::Reconnect,
        "JOIN" | "PART" | "353" | "366" | "CAP" | "PONG" | "GLOBALUSERSTATE" => ParsedLine::Ignore,
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
    let mut text = trailing.unwrap_or("").to_string();
    let mut action = false;
    if let Some(inner) = text
        .strip_prefix("\u{0001}ACTION ")
        .and_then(|s| s.strip_suffix('\u{0001}'))
    {
        text = inner.to_string();
        action = true;
    }
    let login = tags
        .get("login")
        .or_else(|| prefix.and_then(login_from_prefix))
        .unwrap_or_default();
    let display_name = tags.get("display-name").filter(|s| !s.is_empty()).unwrap_or_else(|| login.clone());
    let emote_spans = parse_twitch_emotes(tags.get("emotes").as_deref(), &text);
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Privmsg {
            id: tags.get("id").unwrap_or_else(|| synthetic_id("p", now_ms, &text)),
            timestamp_ms: tags.timestamp(now_ms),
            user_id: tags.get("user-id").unwrap_or_default(),
            login,
            display_name,
            color: tags.get("color").unwrap_or_default(),
            badges: parse_badges(tags.get("badges").as_deref()),
            emote_spans,
            bits: tags.get("bits").and_then(|s| s.parse().ok()),
            reply_to_id: tags.get("reply-parent-msg-id"),
            action,
            text,
        },
        channel,
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
    let system_text = unescape_tag(&tags.get("system-msg").unwrap_or_default());
    let login = tags.get("login");
    let attached = trailing.filter(|t| !t.is_empty()).map(|text| {
        let emote_spans = parse_twitch_emotes(tags.get("emotes").as_deref(), text);
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
            bits: None,
            reply_to_id: None,
            action: false,
        })
    });
    ParsedLine::Event {
        room_id: tags.get("room-id"),
        event: ChatEvent::Usernotice {
            id: tags.get("id").unwrap_or_else(|| synthetic_id("u", now_ms, &system_text)),
            timestamp_ms: tags.timestamp(now_ms),
            system_text,
            login,
            privmsg: attached,
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
            emote_only: tags.flag("emote-only"),
            subs_only: tags.flag("subs-only"),
            slow_sec: tags.get("slow").and_then(|s| s.parse().ok()).unwrap_or(0),
            followers_sec: tags
                .get("followers-only")
                .and_then(|s| s.parse().ok())
                .map(|v: i32| if v < 0 { 0 } else { v as u32 })
                .unwrap_or(0),
        },
        channel,
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

fn parse_badges(raw: Option<&str>) -> Vec<String> {
    match raw {
        None | Some("") => Vec::new(),
        Some(s) => s.split(',').filter(|p| !p.is_empty()).map(|s| s.to_string()).collect(),
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
            let start = scalar_to_utf16(text, start_cp) as u32;
            let end = scalar_to_utf16(text, end_cp.saturating_add(1)) as u32;
            spans.push(EmoteSpan {
                start,
                end,
                emote_id: id.to_string(),
                provider: "twitch".to_string(),
                url: twitch_emote_url(id),
            });
        }
    }
    spans.sort_by_key(|s| s.start);
    spans
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
    format!("{prefix}-{now_ms}-{}", salt.len())
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
}
