//! Search predicates (Chatterino SearchPopup::parsePredicates + messages/search/*).
//! SPDX-FileCopyrightText: Contributors to Chatterino <https://chatterino.com>
//! SPDX-License-Identifier: MIT
//! Reimplementation; not a copy of C++/Qt source.

use super::shared_chat;
use super::spans;
use super::types::ChatEvent;
use regex::{Regex, RegexBuilder};
use url::Url;

const REGEX_PATTERN_MAX_CHARS: usize = 256;
const REGEX_SIZE_LIMIT: usize = 100_000;

const SUB_MSG_IDS: &[&str] = &["sub", "resub", "subgift"];
const REDEEMED_MSG_IDS: &[&str] = &[
    "highlighted-message",
    "animated-message",
    "gigantified-emote-message",
];
const WATCH_STREAK_MSG_IDS: &[&str] = &["viewermilestone", "modiversary"];

fn is_subscription_msg_id(msg_id: Option<&str>) -> bool {
    msg_id.is_some_and(|id| SUB_MSG_IDS.iter().any(|s| id.eq_ignore_ascii_case(s)))
}

fn is_redeemed_system_msg_id(msg_id: Option<&str>) -> bool {
    msg_id.is_some_and(|id| REDEEMED_MSG_IDS.iter().any(|s| id.eq_ignore_ascii_case(s)))
}

fn is_watch_streak_msg_id(msg_id: Option<&str>) -> bool {
    msg_id.is_some_and(|id| {
        WATCH_STREAK_MSG_IDS
            .iter()
            .any(|s| id.eq_ignore_ascii_case(s))
    })
}

fn strip_link_tail(word: &str) -> &str {
    word.trim_matches(|c: char| matches!(c, '>' | '?' | '!' | '.' | ',' | ':' | '*' | '~' | ')'))
}

/// Stock LinkPredicate: scheme URLs + bare hosts (www./domain.tld), via Url parse.
fn word_has_link(word: &str) -> bool {
    let trimmed = strip_link_tail(word);
    if trimmed.is_empty() {
        return false;
    }
    if spans::allowed_chat_url(trimmed).is_ok() {
        return true;
    }
    let candidate = if trimmed.starts_with("www.")
        || trimmed.starts_with("WWW.")
        || (!trimmed.contains("://")
            && trimmed.contains('.')
            && !trimmed.contains('@')
            && !trimmed.contains(' '))
    {
        format!("https://{trimmed}")
    } else {
        return false;
    };
    Url::parse(&candidate)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.contains('.')))
        .unwrap_or(false)
}

fn text_has_link(text: &str) -> bool {
    if !spans::decorate_text_spans(text, &[]).0.is_empty() {
        return true;
    }
    text.split_whitespace().any(word_has_link)
}

/// One stock-style search predicate (AND-combined by caller).
#[derive(Debug)]
pub enum Predicate {
    Author { authors: Vec<String>, negate: bool },
    Badge { badges: Vec<String>, negate: bool },
    Subtier { tiers: Vec<String>, negate: bool },
    Link { negate: bool },
    Channel { channels: Vec<String>, negate: bool },
    Flags { flags: FlagWant, negate: bool },
    Regex { re: Option<Regex>, negate: bool },
    Substring { needle_lower: String },
}

#[derive(Debug, Clone, Default)]
pub struct FlagWant {
    pub disabled: bool,
    pub subscription: bool,
    pub timeout: bool,
    pub highlighted: bool,
    pub system: bool,
    pub first_msg: bool,
    pub cheer: bool,
    pub redemption: bool,
    pub reply: bool,
    pub restricted: bool,
    pub monitored: bool,
    pub shared: bool,
    pub watch_streak: bool,
    pub announcement: bool,
}

impl FlagWant {
    fn is_empty(&self) -> bool {
        !(self.disabled
            || self.subscription
            || self.timeout
            || self.highlighted
            || self.system
            || self.first_msg
            || self.cheer
            || self.redemption
            || self.reply
            || self.restricted
            || self.monitored
            || self.shared
            || self.watch_streak
            || self.announcement)
    }

    fn parse_csv(raw: &str) -> Self {
        let mut f = Self::default();
        for part in raw.split(',') {
            let flag = part.trim();
            if flag.is_empty() {
                continue;
            }
            match flag {
                "deleted" | "disabled" => f.disabled = true,
                "sub" | "subscription" => f.subscription = true,
                "timeout" | "ban" => f.timeout = true,
                "highlighted" => f.highlighted = true,
                "system" => f.system = true,
                "first-msg" => f.first_msg = true,
                "cheer-msg" => f.cheer = true,
                "redemption" => f.redemption = true,
                "reply" => f.reply = true,
                "restricted" => f.restricted = true,
                "monitored" => f.monitored = true,
                "shared" => f.shared = true,
                "watch-streak" => f.watch_streak = true,
                "announcement" => f.announcement = true,
                _ => {}
            }
        }
        f
    }
}

fn is_word_start(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn split_csv_ci(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn normalize_badge_name(raw: &str) -> String {
    if raw.eq_ignore_ascii_case("mod") {
        "moderator".into()
    } else if raw.eq_ignore_ascii_case("sub") {
        "subscriber".into()
    } else if raw.eq_ignore_ascii_case("prime") {
        "premium".into()
    } else {
        raw.to_string()
    }
}

fn compile_search_regex(pattern: &str) -> Option<Regex> {
    if pattern.is_empty() || pattern.chars().count() > REGEX_PATTERN_MAX_CHARS {
        return None;
    }
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .build()
        .ok()
}

fn take_word(chars: &[char], mut i: usize) -> (String, usize) {
    let start = i;
    while i < chars.len() && is_word_start(chars[i]) {
        i += 1;
    }
    (chars[start..i].iter().collect(), i)
}

fn take_quoted_value(chars: &[char], mut i: usize) -> Option<(String, usize)> {
    if i >= chars.len() || chars[i] != '"' {
        return None;
    }
    i += 1;
    let start = i;
    while i < chars.len() && chars[i] != '"' {
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    let value: String = chars[start..i].iter().collect();
    i += 1;
    Some((value, i))
}

fn take_unquoted_value(chars: &[char], mut i: usize) -> (String, usize) {
    let start = i;
    while i < chars.len() && !chars[i].is_whitespace() {
        i += 1;
    }
    (chars[start..i].iter().collect(), i)
}

fn take_bare_token(chars: &[char], mut i: usize) -> (String, usize) {
    let start = i;
    while i < chars.len() && !chars[i].is_whitespace() {
        i += 1;
    }
    (chars[start..i].iter().collect(), i)
}

/// Stock SearchPopup::parsePredicates tokenizer (no lookaround).
fn next_token(
    chars: &[char],
    mut i: usize,
) -> Option<(Option<bool>, Option<(String, String)>, String, usize)> {
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    let token_start = i;
    let mut negate: Option<bool> = None;
    if chars[i] == '!' || chars[i] == '-' {
        negate = Some(true);
        i += 1;
    }
    if i < chars.len() && is_word_start(chars[i]) {
        let (name, after_name) = take_word(chars, i);
        if after_name < chars.len() && chars[after_name] == ':' {
            let after_colon = after_name + 1;
            if after_colon < chars.len() {
                if let Some((value, after_val)) = take_quoted_value(chars, after_colon) {
                    let full: String = chars[token_start..after_val].iter().collect();
                    return Some((negate, Some((name, value)), full, after_val));
                }
                if !chars[after_colon].is_whitespace() {
                    let (value, after_val) = take_unquoted_value(chars, after_colon);
                    let full: String = chars[token_start..after_val].iter().collect();
                    return Some((negate, Some((name, value)), full, after_val));
                }
            }
        }
    }
    // Named form failed → bare token from token_start (includes !/- as substring).
    let (full, after) = take_bare_token(chars, token_start);
    Some((None, None, full, after))
}

/// Parse stock SearchPopup predicate tokens from `input`.
pub fn parse_predicates(input: &str) -> Vec<Predicate> {
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while let Some((negate_opt, named, full, next)) = next_token(&chars, i) {
        i = next;
        if let Some((name, value)) = named {
            let negate = negate_opt.unwrap_or(false);
            if name == "from" {
                out.push(Predicate::Author {
                    authors: split_csv_ci(&value),
                    negate,
                });
            } else if name == "badge" {
                out.push(Predicate::Badge {
                    badges: split_csv_ci(&value)
                        .into_iter()
                        .map(|b| normalize_badge_name(&b))
                        .collect(),
                    negate,
                });
            } else if name == "subtier" {
                out.push(Predicate::Subtier {
                    tiers: split_csv_ci(&value),
                    negate,
                });
            } else if name == "has" && value == "link" {
                out.push(Predicate::Link { negate });
            } else if name == "in" {
                out.push(Predicate::Channel {
                    channels: split_csv_ci(&value),
                    negate,
                });
            } else if name == "is" {
                out.push(Predicate::Flags {
                    flags: FlagWant::parse_csv(&value),
                    negate,
                });
            } else if name == "regex" {
                out.push(Predicate::Regex {
                    re: compile_search_regex(&value),
                    negate,
                });
            } else {
                out.push(Predicate::Substring {
                    needle_lower: full.to_lowercase(),
                });
            }
        } else {
            out.push(Predicate::Substring {
                needle_lower: full.to_lowercase(),
            });
        }
    }
    out
}

fn apply_negate(inner: bool, negate: bool) -> bool {
    if negate {
        !inner
    } else {
        inner
    }
}

fn list_contains_ci(list: &[String], candidate: &str) -> bool {
    list.iter().any(|item| item.eq_ignore_ascii_case(candidate))
}

fn author_matches(event: &ChatEvent, authors: &[String]) -> bool {
    match event {
        ChatEvent::Privmsg {
            login,
            display_name,
            ..
        } => list_contains_ci(authors, login) || list_contains_ci(authors, display_name),
        ChatEvent::Usernotice { login, privmsg, .. } => {
            login
                .as_deref()
                .is_some_and(|l| list_contains_ci(authors, l))
                || privmsg
                    .as_ref()
                    .is_some_and(|inner| author_matches(inner, authors))
        }
        ChatEvent::Clearchat { target_login, .. } => target_login
            .as_deref()
            .is_some_and(|l| list_contains_ci(authors, l)),
        _ => false,
    }
}

fn badge_matches(event: &ChatEvent, badges: &[String]) -> bool {
    match event {
        ChatEvent::Privmsg {
            badges: msg_badges, ..
        } => msg_badges.iter().any(|b| list_contains_ci(badges, &b.set)),
        ChatEvent::Usernotice { privmsg, .. } => privmsg
            .as_ref()
            .is_some_and(|inner| badge_matches(inner, badges)),
        _ => false,
    }
}

fn subtier_matches(event: &ChatEvent, tiers: &[String]) -> bool {
    match event {
        ChatEvent::Privmsg {
            badges: msg_badges, ..
        } => {
            for b in msg_badges {
                if b.set != "subscriber" {
                    continue;
                }
                let tier = if b.version.len() > 3 {
                    b.version.chars().next().unwrap_or('1')
                } else {
                    '1'
                };
                let tier_s = tier.to_string();
                if tiers.iter().any(|t| t == &tier_s) {
                    return true;
                }
            }
            false
        }
        ChatEvent::Usernotice { privmsg, .. } => privmsg
            .as_ref()
            .is_some_and(|inner| subtier_matches(inner, tiers)),
        _ => false,
    }
}

fn event_message_text(event: &ChatEvent) -> String {
    match event {
        ChatEvent::Privmsg { text, .. } => text.clone(),
        ChatEvent::Usernotice {
            system_text,
            privmsg,
            ..
        } => {
            if let Some(inner) = privmsg {
                if let ChatEvent::Privmsg { text, .. } = inner.as_ref() {
                    return format!("{system_text} {text}");
                }
            }
            system_text.clone()
        }
        ChatEvent::Notice { text, .. } => text.clone(),
        ChatEvent::Clearchat { target_login, .. } => target_login.clone().unwrap_or_default(),
        ChatEvent::Roomstate {
            emote_only,
            subs_only,
            slow_sec,
            followers_only,
            ..
        } => format!(
            "emote:{emote_only:?} subs:{subs_only:?} slow:{slow_sec:?} followers:{followers_only:?}"
        ),
        ChatEvent::Clearmsg { .. } | ChatEvent::Userstate { .. } => String::new(),
        ChatEvent::AutomodHeld { text, .. } => text.clone(),
        ChatEvent::AutomodStatus { status, .. } => status.clone(),
    }
}

fn link_matches(event: &ChatEvent) -> bool {
    match event {
        ChatEvent::Privmsg {
            text, link_spans, ..
        } => !link_spans.is_empty() || text_has_link(text),
        ChatEvent::Usernotice {
            system_text,
            privmsg,
            ..
        } => {
            text_has_link(system_text) || privmsg.as_ref().is_some_and(|inner| link_matches(inner))
        }
        ChatEvent::Notice { text, .. } => text_has_link(text),
        _ => false,
    }
}

fn channel_matches(channel: &str, channels: &[String]) -> bool {
    list_contains_ci(channels, channel)
}

fn event_flag_bits(event: &ChatEvent, room_id: Option<&str>) -> FlagWant {
    let mut f = FlagWant::default();
    match event {
        ChatEvent::Privmsg {
            disabled,
            first_msg,
            bits,
            custom_reward_id,
            reply_to_id,
            source_room_id,
            system_msg_id,
            highlight_color,
            highlight_sound,
            highlight_flash,
            ..
        } => {
            f.disabled = *disabled;
            f.first_msg = *first_msg;
            f.cheer = bits.is_some();
            f.redemption =
                custom_reward_id.is_some() || is_redeemed_system_msg_id(system_msg_id.as_deref());
            f.reply = reply_to_id.is_some();
            f.shared = shared_chat::is_shared_message(source_room_id.as_deref(), room_id);
            f.highlighted = highlight_color.is_some() || *highlight_sound || *highlight_flash;
        }
        ChatEvent::Usernotice {
            msg_id,
            highlight_color,
            highlight_sound,
            highlight_flash,
            privmsg,
            ..
        } => {
            f.subscription = is_subscription_msg_id(msg_id.as_deref());
            f.highlighted = highlight_color.is_some() || *highlight_sound || *highlight_flash;
            if let Some(id) = msg_id.as_deref() {
                if id.eq_ignore_ascii_case("announcement") {
                    f.announcement = true;
                }
            }
            f.watch_streak = is_watch_streak_msg_id(msg_id.as_deref());
            if let Some(inner) = privmsg {
                let inner_f = event_flag_bits(inner, room_id);
                f.disabled |= inner_f.disabled;
                f.first_msg |= inner_f.first_msg;
                f.cheer |= inner_f.cheer;
                f.redemption |= inner_f.redemption;
                f.reply |= inner_f.reply;
                f.shared |= inner_f.shared;
                f.highlighted |= inner_f.highlighted;
            }
        }
        ChatEvent::Clearchat { .. } => {
            f.timeout = true;
        }
        ChatEvent::Notice { .. } | ChatEvent::Roomstate { .. } => {
            f.system = true;
        }
        ChatEvent::Clearmsg { .. } | ChatEvent::Userstate { .. } => {}
        ChatEvent::AutomodHeld { .. } | ChatEvent::AutomodStatus { .. } => {
            f.system = true;
        }
    }
    f
}

fn flags_match(event: &ChatEvent, want: &FlagWant, room_id: Option<&str>) -> bool {
    if want.is_empty() {
        return false;
    }
    let have = event_flag_bits(event, room_id);
    let any = (want.disabled && have.disabled)
        || (want.subscription && have.subscription)
        || (want.timeout && have.timeout)
        || (want.highlighted && have.highlighted)
        || (want.system && have.system)
        || (want.first_msg && have.first_msg)
        || (want.cheer && have.cheer)
        || (want.redemption && have.redemption)
        || (want.reply && have.reply)
        || (want.restricted && have.restricted)
        || (want.monitored && have.monitored)
        || (want.shared && have.shared)
        || (want.watch_streak && have.watch_streak)
        || (want.announcement && have.announcement);
    if want.system && !want.timeout {
        return any && !have.timeout;
    }
    any
}

fn regex_matches(event: &ChatEvent, re: &Option<Regex>) -> bool {
    let Some(re) = re else {
        return false;
    };
    re.is_match(&event_message_text(event))
}

impl Predicate {
    pub fn applies_to(&self, event: &ChatEvent, channel: &str, room_id: Option<&str>) -> bool {
        match self {
            Predicate::Author { authors, negate } => {
                apply_negate(author_matches(event, authors), *negate)
            }
            Predicate::Badge { badges, negate } => {
                apply_negate(badge_matches(event, badges), *negate)
            }
            Predicate::Subtier { tiers, negate } => {
                apply_negate(subtier_matches(event, tiers), *negate)
            }
            Predicate::Link { negate } => apply_negate(link_matches(event), *negate),
            Predicate::Channel { channels, negate } => {
                apply_negate(channel_matches(channel, channels), *negate)
            }
            Predicate::Flags { flags, negate } => {
                apply_negate(flags_match(event, flags, room_id), *negate)
            }
            Predicate::Regex { re, negate } => apply_negate(regex_matches(event, re), *negate),
            Predicate::Substring { needle_lower } => event.matches_substring(needle_lower),
        }
    }
}

/// True when every predicate applies (empty list → accept all, stock SearchPopup).
pub fn applies_all(
    preds: &[Predicate],
    event: &ChatEvent,
    channel: &str,
    room_id: Option<&str>,
) -> bool {
    preds.iter().all(|p| p.applies_to(event, channel, room_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::{Badge, EmoteSpan};

    fn privmsg(id: &str, login: &str, text: &str) -> ChatEvent {
        ChatEvent::Privmsg {
            id: id.to_string(),
            timestamp_ms: 1,
            user_id: "1".into(),
            login: login.to_string(),
            display_name: login.to_string(),
            color: "#fff".into(),
            badges: Vec::<Badge>::new(),
            text: text.to_string(),
            emote_spans: Vec::<EmoteSpan>::new(),
            link_spans: vec![],
            mention_spans: vec![],
            bits: None,
            reply_to_id: None,
            reply_to_login: None,
            reply_to_display_name: None,
            reply_to_text: None,
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
            source_badges: vec![],
            paint: None,
        }
    }

    fn privmsg_badges(id: &str, login: &str, text: &str, badges: Vec<Badge>) -> ChatEvent {
        match privmsg(id, login, text) {
            ChatEvent::Privmsg {
                id,
                timestamp_ms,
                user_id,
                login,
                display_name,
                color,
                text,
                emote_spans,
                link_spans,
                mention_spans,
                bits,
                reply_to_id,
                reply_to_login,
                reply_to_display_name,
                reply_to_text,
                action,
                first_msg,
                custom_reward_id,
                system_msg_id,
                highlight_color,
                highlight_sound,
                highlight_sound_path,
                highlight_flash,
                whisper,
                disabled,
                source_room_id,
                source_badges,
                ..
            } => ChatEvent::Privmsg {
                id,
                timestamp_ms,
                user_id,
                login,
                display_name,
                color,
                badges,
                text,
                emote_spans,
                link_spans,
                mention_spans,
                bits,
                reply_to_id,
                reply_to_login,
                reply_to_display_name,
                reply_to_text,
                action,
                first_msg,
                custom_reward_id,
                system_msg_id,
                highlight_color,
                highlight_sound,
                highlight_sound_path,
                highlight_flash,
                whisper,
                disabled,
                source_room_id,
                source_badges,
                paint: None,
            },
            other => other,
        }
    }

    #[test]
    fn parse_from_and_substring_and() {
        let preds = parse_predicates("from:ann kappa");
        assert_eq!(preds.len(), 2);
        let e = privmsg("1", "ann", "hello kappa");
        assert!(applies_all(&preds, &e, "chan", None));
        let other = privmsg("2", "bob", "hello kappa");
        assert!(!applies_all(&preds, &other, "chan", None));
    }

    #[test]
    fn parse_quoted_regex_and_negation() {
        let preds = parse_predicates(r#"regex:"kap+a""#);
        assert_eq!(preds.len(), 1);
        assert!(applies_all(&preds, &privmsg("1", "a", "kappaa"), "c", None));
        let neg = parse_predicates("!from:ann");
        assert_eq!(neg.len(), 1);
        assert!(!applies_all(&neg, &privmsg("1", "ann", "x"), "c", None));
        assert!(applies_all(&neg, &privmsg("2", "bob", "x"), "c", None));
    }

    #[test]
    fn invalid_regex_never_matches() {
        let preds = parse_predicates("regex:[");
        assert!(!applies_all(&preds, &privmsg("1", "a", "hello"), "c", None));
    }

    #[test]
    fn unknown_named_token_is_substring() {
        let preds = parse_predicates("foo:bar");
        assert!(matches!(preds.as_slice(), [Predicate::Substring { .. }]));
        assert!(applies_all(
            &preds,
            &privmsg("1", "a", "zz foo:bar zz"),
            "c",
            None
        ));
    }

    #[test]
    fn badge_alias_and_subtier() {
        let badges = vec![Badge {
            set: "subscriber".into(),
            version: "3012".into(),
            url: None,
            source: "twitch".into(),
            tooltip: None,
        }];
        let e = privmsg_badges("1", "ann", "hi", badges);
        let badge_pred = parse_predicates("badge:sub");
        assert!(applies_all(&badge_pred, &e, "c", None));
        let tier = parse_predicates("subtier:3");
        assert!(applies_all(&tier, &e, "c", None));
        let tier1 = parse_predicates("subtier:1");
        assert!(!applies_all(&tier1, &e, "c", None));
    }

    #[test]
    fn has_link_and_in_channel() {
        let mut e = privmsg("1", "ann", "see https://example.com/x");
        if let ChatEvent::Privmsg {
            link_spans, text, ..
        } = &mut e
        {
            *link_spans = spans::decorate_text_spans(text, &[]).0;
        }
        let link = parse_predicates("has:link");
        assert!(applies_all(&link, &e, "c", None));
        let no_link = privmsg("2", "ann", "no url here");
        assert!(!applies_all(&link, &no_link, "c", None));
        let bare = privmsg("3", "ann", "see example.com please");
        assert!(applies_all(&link, &bare, "c", None));
        let inn = parse_predicates("in:forsen,pajlada");
        assert!(applies_all(&inn, &e, "Forsen", None));
        assert!(!applies_all(&inn, &e, "xqc", None));
    }

    #[test]
    fn is_first_msg_and_system() {
        let mut e = privmsg("1", "ann", "hi");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut e {
            *first_msg = true;
        }
        assert!(applies_all(
            &parse_predicates("is:first-msg"),
            &e,
            "c",
            None
        ));
        let notice = ChatEvent::Notice {
            id: "n".into(),
            timestamp_ms: 1,
            text: "room".into(),

            msg_id: None,

            timeout_remaining_sec: None,
        };
        assert!(applies_all(
            &parse_predicates("is:system"),
            &notice,
            "c",
            None
        ));
        let to = ChatEvent::Clearchat {
            id: "t".into(),
            timestamp_ms: 1,
            target_login: Some("ann".into()),
            duration_sec: Some(60),
            stack_count: 1,
        };
        assert!(!applies_all(&parse_predicates("is:system"), &to, "c", None));
        assert!(applies_all(&parse_predicates("is:timeout"), &to, "c", None));
    }

    #[test]
    fn empty_predicates_accept_all() {
        assert!(applies_all(&[], &privmsg("1", "a", "x"), "c", None));
    }

    #[test]
    fn link_without_precomputed_spans() {
        let e = privmsg("1", "a", "https://example.com");
        assert!(applies_all(&parse_predicates("has:link"), &e, "c", None));
    }

    #[test]
    fn is_sub_only_subscription_msg_ids() {
        let sub = ChatEvent::Usernotice {
            id: "u1".into(),
            timestamp_ms: 1,
            system_text: "ann subscribed".into(),
            login: Some("ann".into()),
            msg_id: Some("sub".into()),
            params: None,
            privmsg: None,
            highlight_color: None,
            highlight_sound: false,
            highlight_sound_path: None,
            highlight_flash: false,
        };
        let raid = ChatEvent::Usernotice {
            id: "u2".into(),
            timestamp_ms: 1,
            system_text: "raid".into(),
            login: Some("ann".into()),
            msg_id: Some("raid".into()),
            params: None,
            privmsg: None,
            highlight_color: None,
            highlight_sound: false,
            highlight_sound_path: None,
            highlight_flash: false,
        };
        let pred = parse_predicates("is:sub");
        assert!(applies_all(&pred, &sub, "c", None));
        assert!(!applies_all(&pred, &raid, "c", None));
    }

    #[test]
    fn is_redemption_and_shared_and_watch_streak() {
        let mut redeem = privmsg("1", "ann", "hi");
        if let ChatEvent::Privmsg { system_msg_id, .. } = &mut redeem {
            *system_msg_id = Some("highlighted-message".into());
        }
        assert!(applies_all(
            &parse_predicates("is:redemption"),
            &redeem,
            "c",
            None
        ));

        let mut shared = privmsg("2", "ann", "hi");
        if let ChatEvent::Privmsg { source_room_id, .. } = &mut shared {
            *source_room_id = Some("999".into());
        }
        assert!(applies_all(
            &parse_predicates("is:shared"),
            &shared,
            "c",
            Some("1")
        ));
        assert!(!applies_all(
            &parse_predicates("is:shared"),
            &shared,
            "c",
            Some("999")
        ));

        let streak = ChatEvent::Usernotice {
            id: "u3".into(),
            timestamp_ms: 1,
            system_text: "streak".into(),
            login: Some("ann".into()),
            msg_id: Some("modiversary".into()),
            params: None,
            privmsg: None,
            highlight_color: None,
            highlight_sound: false,
            highlight_sound_path: None,
            highlight_flash: false,
        };
        assert!(applies_all(
            &parse_predicates("is:watch-streak"),
            &streak,
            "c",
            None
        ));
    }
}
