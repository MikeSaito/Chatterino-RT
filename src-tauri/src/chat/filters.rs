// SPDX-FileCopyrightText: 2018 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of ignore phrases and highlight matching from Chatterino
// src/controllers/ignores and src/controllers/highlights. Not a copy of C++/Qt source.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use regex::Regex;

use super::auth;
use super::spans::decorate_text_spans;
use super::state::Shared;
use super::types::{Badge, ChatEvent, EmoteSpan};

const FILTERS_FILE: &str = "filters.json";
const MAX_LIST: usize = 200;
const MAX_PATTERN: usize = 200;
const MAX_FILE_BYTES: usize = 256 * 1024;
/// Stock processIgnorePhrases iteration cap.
const MAX_IGNORE_REPLACEMENTS: usize = 128;
const TOO_MANY_REPLACEMENTS: &str = "Too many replacements - check your ignores!";
pub const SELF_HIGHLIGHT_COLOR: &str = "#7f3f4980";
/// Stock FALLBACK_SELF_MESSAGE_HIGHLIGHT_COLOR.
pub const SELF_MESSAGE_HIGHLIGHT_COLOR: &str = "#0076DD73";
/// Stock HighlightBadge::FALLBACK_HIGHLIGHT_COLOR.
pub const BADGE_HIGHLIGHT_COLOR: &str = "#7F3F4980";
/// Stock FALLBACK_COLOR_SUBSCRIPTION.
pub const SUB_HIGHLIGHT_COLOR: &str = "#C466FF64";
/// Stock FALLBACK_COLOR_REDEEMED.
pub const REDEEMED_HIGHLIGHT_COLOR: &str = "#1C7E8D3C";
/// Stock FALLBACK_COLOR_FIRST_MESSAGE.
pub const FIRST_MSG_HIGHLIGHT_COLOR: &str = "#487F3F3C";

const SUB_MSG_IDS: &[&str] = &["sub", "resub", "subgift"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    #[serde(default = "default_true")]
    pub enable_self_highlight: bool,
    #[serde(default)]
    pub ignore_logins: Vec<String>,
    #[serde(default)]
    pub ignore_phrases: Vec<String>,
    #[serde(default)]
    pub highlight_phrases: Vec<String>,
    #[serde(default)]
    pub highlight_logins: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl Default for Filters {
    fn default() -> Self {
        Self {
            enable_self_highlight: true,
            ignore_logins: Vec::new(),
            ignore_phrases: Vec::new(),
            highlight_phrases: Vec::new(),
            highlight_logins: Vec::new(),
        }
    }
}

#[derive(Default)]
pub struct FiltersInner {
    pub path: PathBuf,
    pub data: Filters,
}

pub fn init(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(FILTERS_FILE);
    let data = load_file(&path);
    let mut inner = shared.filters.lock().map_err(|e| e.to_string())?;
    inner.path = path;
    inner.data = data;
    Ok(())
}

pub fn snapshot(shared: &Shared) -> Result<Filters, String> {
    shared
        .filters
        .lock()
        .map(|inner| inner.data.clone())
        .map_err(|e| e.to_string())
}

pub fn replace(shared: &Shared, incoming: Filters) -> Result<Filters, String> {
    let clean = sanitize(incoming)?;
    let path = shared
        .filters
        .lock()
        .map_err(|e| e.to_string())?
        .path
        .clone();
    save_file(&path, &clean)?;
    let mut inner = shared.filters.lock().map_err(|e| e.to_string())?;
    if inner.path != path {
        return Err("каталог конфигурации сменился".into());
    }
    inner.data = clean.clone();
    Ok(clean)
}

pub fn gate_event(shared: &Shared, event: &mut ChatEvent) -> bool {
    let self_login = auth::resolved_login_token(shared).map(|(login, _)| login);
    let filters = match shared.filters.lock() {
        Ok(inner) => inner.data.clone(),
        Err(_) => return false,
    };
    let ignore_blocks = match shared.ignore_block_rules.lock() {
        Ok(inner) => inner.clone(),
        Err(_) => Vec::new(),
    };
    let ignore_users = match shared.ignore_user_rules.lock() {
        Ok(inner) => inner.clone(),
        Err(_) => Vec::new(),
    };
    if should_drop(
        &filters,
        &ignore_users,
        &ignore_blocks,
        event,
        self_login.as_deref(),
    ) {
        return true;
    }
    let ignore_replaces = match shared.ignore_replace_rules.lock() {
        Ok(inner) => inner.clone(),
        Err(_) => Vec::new(),
    };
    apply_ignore_replacements(event, &ignore_replaces);
    let sound_ctx = match shared.highlight_sound.lock() {
        Ok(inner) => inner.clone(),
        Err(_) => HighlightSoundCtx::default(),
    };
    let blacklist = match shared.highlight_blacklist.lock() {
        Ok(inner) => inner.clone(),
        Err(_) => Vec::new(),
    };
    let kinds = HighlightKindsCtx::from_shared(shared);
    apply_highlight(
        &filters,
        &sound_ctx,
        &kinds,
        &blacklist,
        event,
        self_login.as_deref(),
    );
    false
}

/// Rebuild cached phrase/user/badge highlight context after settings change.
pub fn refresh_highlight_sound(shared: &Shared) {
    let ctx = HighlightSoundCtx::from_shared(shared);
    if let Ok(mut slot) = shared.highlight_sound.lock() {
        *slot = ctx;
    }
}

/// Rebuild cached ignore-message block rules after settings change.
pub fn refresh_ignore_block_rules(shared: &Shared) {
    let rules = match shared.settings.lock() {
        Ok(inner) => ignore_block_rules_from_settings(&inner.data),
        Err(_) => Vec::new(),
    };
    if let Ok(mut slot) = shared.ignore_block_rules.lock() {
        *slot = rules;
    }
}

/// Rebuild cached highlight-blacklist rules after settings change.
pub fn refresh_highlight_blacklist(shared: &Shared) {
    let rules = match shared.settings.lock() {
        Ok(inner) => blacklist_rules_from_settings(&inner.data),
        Err(_) => Vec::new(),
    };
    if let Ok(mut slot) = shared.highlight_blacklist.lock() {
        *slot = rules;
    }
}

/// Rebuild cached Ignores Users drop rules after settings change.
pub fn refresh_ignore_user_rules(shared: &Shared) {
    let rules = match shared.settings.lock() {
        Ok(inner) => ignore_user_rules_from_settings(&inner.data),
        Err(_) => Vec::new(),
    };
    if let Ok(mut slot) = shared.ignore_user_rules.lock() {
        *slot = rules;
    }
}

/// Rebuild cached Ignores Messages replacement rules after settings change.
pub fn refresh_ignore_replace_rules(shared: &Shared) {
    let rules = match shared.settings.lock() {
        Ok(inner) => ignore_replace_rules_from_settings(&inner.data),
        Err(_) => Vec::new(),
    };
    if let Ok(mut slot) = shared.ignore_replace_rules.lock() {
        *slot = rules;
    }
}

pub(crate) fn sanitize(raw: Filters) -> Result<Filters, String> {
    Ok(Filters {
        enable_self_highlight: raw.enable_self_highlight,
        ignore_logins: sanitize_logins(raw.ignore_logins, "игнор логинов")?,
        ignore_phrases: sanitize_phrases(raw.ignore_phrases, "игнор фраз")?,
        highlight_phrases: sanitize_phrases(raw.highlight_phrases, "хайлайт фраз")?,
        highlight_logins: sanitize_logins(raw.highlight_logins, "хайлайт логинов")?,
    })
}

pub(crate) fn should_drop(
    filters: &Filters,
    ignore_users: &[BlacklistRule],
    ignore_blocks: &[PhraseRule],
    event: &ChatEvent,
    self_login: Option<&str>,
) -> bool {
    let login = event_login(event);
    if let Some(login) = login {
        if is_self(login, self_login) {
            return false;
        }
        if filters.ignore_logins.iter().any(|item| item.eq_ignore_ascii_case(login)) {
            return true;
        }
        if login_is_blacklisted(login, ignore_users) {
            return true;
        }
    }
    let hay = event_hay(event);
    if hay.is_empty() {
        return false;
    }
    if ignore_blocks.iter().any(|rule| phrase_matches_ex(&hay, rule)) {
        return true;
    }
    if filters.ignore_phrases.iter().any(|p| phrase_matches(&hay, p)) {
        return true;
    }
    false
}

fn event_hay(event: &ChatEvent) -> String {
    match event {
        ChatEvent::Privmsg { text, .. } => text.clone(),
        ChatEvent::Usernotice {
            system_text,
            privmsg,
            ..
        } => {
            let body = match privmsg.as_deref() {
                Some(ChatEvent::Privmsg { text, .. }) => text.as_str(),
                _ => "",
            };
            if system_text.is_empty() {
                body.to_string()
            } else if body.is_empty() {
                system_text.clone()
            } else {
                format!("{system_text} {body}")
            }
        }
        _ => String::new(),
    }
}

pub(crate) fn apply_highlight(
    filters: &Filters,
    sound: &HighlightSoundCtx,
    kinds: &HighlightKindsCtx,
    blacklist: &[BlacklistRule],
    event: &mut ChatEvent,
    self_login: Option<&str>,
) {
    if let Some(login) = event_sender_login(event) {
        if login_is_blacklisted(login, blacklist) {
            return;
        }
    }
    match event {
        ChatEvent::Privmsg {
            login,
            text,
            badges,
            first_msg,
            custom_reward_id,
            system_msg_id,
            highlight_color,
            highlight_sound,
            highlight_sound_path,
            highlight_flash,
            ..
        } => {
            let hit = highlight_hit(filters, sound, login, text, badges, self_login);
            *highlight_color = hit.color;
            *highlight_sound = hit.sound;
            *highlight_sound_path = hit.sound_path;
            *highlight_flash = hit.flash;
            if highlight_color.is_none() {
                let redeemed = kinds.enable_redeemed
                    && (custom_reward_id.as_ref().is_some_and(|s| !s.is_empty())
                        || is_redeemed_system_msg_id(system_msg_id.as_deref()));
                if redeemed {
                    *highlight_color = Some(resolve_highlight_color_or(
                        &kinds.redeemed_color,
                        REDEEMED_HIGHLIGHT_COLOR,
                    ));
                } else if kinds.enable_first && *first_msg {
                    *highlight_color = Some(resolve_highlight_color_or(
                        &kinds.first_color,
                        FIRST_MSG_HIGHLIGHT_COLOR,
                    ));
                }
            }
        }
        ChatEvent::Usernotice {
            login,
            system_text,
            msg_id,
            privmsg,
            highlight_color,
            highlight_sound,
            highlight_sound_path,
            highlight_flash,
            ..
        } => {
            let sender = login
                .clone()
                .or_else(|| {
                    privmsg.as_ref().and_then(|inner| match inner.as_ref() {
                        ChatEvent::Privmsg { login, .. } => Some(login.clone()),
                        _ => None,
                    })
                })
                .unwrap_or_default();
            let (body, badges) = match privmsg.as_deref() {
                Some(ChatEvent::Privmsg { text, badges, .. }) => (text.as_str(), badges.as_slice()),
                _ => ("", &[][..]),
            };
            let hay = if system_text.is_empty() {
                body.to_string()
            } else if body.is_empty() {
                system_text.clone()
            } else {
                format!("{system_text} {body}")
            };
            let hit = highlight_hit(filters, sound, &sender, &hay, badges, self_login);
            *highlight_color = hit.color.clone();
            *highlight_sound = hit.sound;
            *highlight_sound_path = hit.sound_path.clone();
            *highlight_flash = hit.flash;
            if let Some(inner) = privmsg.as_mut() {
                if let ChatEvent::Privmsg {
                    highlight_color: inner_color,
                    highlight_sound: inner_sound,
                    highlight_sound_path: inner_sound_path,
                    highlight_flash: inner_flash,
                    ..
                } = inner.as_mut()
                {
                    *inner_color = hit.color;
                    *inner_sound = hit.sound;
                    *inner_sound_path = hit.sound_path;
                    *inner_flash = hit.flash;
                }
            }
            // HighlightController: Sub before Phrase — overwrite for sub USERNOTICE.
            if kinds.enable_sub && is_subscription_msg_id(msg_id.as_deref()) {
                let color =
                    resolve_highlight_color_or(&kinds.sub_color, SUB_HIGHLIGHT_COLOR);
                *highlight_color = Some(color.clone());
                if let Some(inner) = privmsg.as_mut() {
                    if let ChatEvent::Privmsg {
                        highlight_color: inner_color,
                        ..
                    } = inner.as_mut()
                    {
                        *inner_color = Some(color);
                    }
                }
            }
        }
        _ => {}
    }
}

fn is_subscription_msg_id(msg_id: Option<&str>) -> bool {
    msg_id.is_some_and(|id| {
        SUB_MSG_IDS
            .iter()
            .any(|s| id.eq_ignore_ascii_case(s))
    })
}

fn is_redeemed_system_msg_id(msg_id: Option<&str>) -> bool {
    const IDS: &[&str] = &[
        "highlighted-message",
        "animated-message",
        "gigantified-emote-message",
    ];
    msg_id.is_some_and(|id| IDS.iter().any(|s| id.eq_ignore_ascii_case(s)))
}

#[derive(Debug, Clone)]
pub(crate) struct HighlightKindsCtx {
    pub enable_sub: bool,
    pub enable_first: bool,
    pub enable_redeemed: bool,
    pub sub_color: String,
    pub first_color: String,
    pub redeemed_color: String,
}

impl Default for HighlightKindsCtx {
    fn default() -> Self {
        Self {
            enable_sub: true,
            enable_first: true,
            enable_redeemed: true,
            sub_color: String::new(),
            first_color: String::new(),
            redeemed_color: String::new(),
        }
    }
}

impl HighlightKindsCtx {
    pub fn from_shared(shared: &Shared) -> Self {
        let Ok(settings) = shared.settings.lock() else {
            return Self::default();
        };
        let knobs = &settings.data.knobs;
        let knob_str = |key: &str| {
            knobs
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        Self {
            enable_sub: knobs
                .get("highlighting.enableSubHighlight")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            enable_first: knobs
                .get("highlighting.enableFirstMessageHighlight")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            enable_redeemed: knobs
                .get("highlighting.enableRedeemedHighlight")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            sub_color: knob_str("highlighting.subHighlightColor"),
            first_color: knob_str("highlighting.firstMessageHighlightColor"),
            redeemed_color: knob_str("highlighting.redeemedHighlightColor"),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PhraseRule {
    pub pattern: String,
    pub play: bool,
    pub color: String,
    pub custom_sound: String,
    pub flash_taskbar: bool,
    pub is_regex: bool,
    pub case_sensitive: bool,
    /// Compiled only when `is_regex`; None if pattern invalid (never matches).
    pub compiled: Option<Regex>,
}

impl PhraseRule {
    fn from_row(
        pattern: String,
        play: bool,
        color: String,
        custom_sound: String,
        flash_taskbar: bool,
        is_regex: bool,
        case_sensitive: bool,
    ) -> Self {
        let compiled = if is_regex {
            regex::RegexBuilder::new(&pattern)
                .case_insensitive(!case_sensitive)
                .unicode(true)
                .build()
                .ok()
        } else {
            None
        };
        Self {
            pattern,
            play,
            color,
            custom_sound,
            flash_taskbar,
            is_regex,
            case_sensitive,
            compiled,
        }
    }

    #[cfg(test)]
    fn plain(pattern: &str, play: bool, color: &str) -> Self {
        Self::from_row(
            pattern.into(),
            play,
            color.into(),
            String::new(),
            false,
            false,
            false,
        )
    }
}

/// Block rows from Ignores Messages table (`block` + non-empty pattern).
pub fn ignore_block_rules_from_settings(data: &super::settings::AppSettings) -> Vec<PhraseRule> {
    data.ignore_messages
        .iter()
        .filter(|r| r.block && !r.pattern.trim().is_empty())
        .map(|r| {
            PhraseRule::from_row(
                r.pattern.clone(),
                false,
                String::new(),
                String::new(),
                false,
                r.regex,
                r.case_sensitive,
            )
        })
        .collect()
}

/// Non-block Ignores Messages rows: pattern → replacement on message text.
#[derive(Debug, Clone)]
pub(crate) struct ReplaceRule {
    pub pattern: String,
    pub replacement: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub compiled: Option<Regex>,
}

impl ReplaceRule {
    fn from_row(
        pattern: String,
        replacement: String,
        is_regex: bool,
        case_sensitive: bool,
    ) -> Self {
        let compiled = if is_regex {
            regex::RegexBuilder::new(&pattern)
                .case_insensitive(!case_sensitive)
                .unicode(true)
                .build()
                .ok()
        } else {
            None
        };
        Self {
            pattern,
            replacement,
            is_regex,
            case_sensitive,
            compiled,
        }
    }
}

/// Rows from Ignores Messages with `block == false` and non-empty pattern.
pub fn ignore_replace_rules_from_settings(
    data: &super::settings::AppSettings,
) -> Vec<ReplaceRule> {
    data.ignore_messages
        .iter()
        .filter(|r| !r.block && !r.pattern.trim().is_empty())
        .map(|r| {
            ReplaceRule::from_row(
                r.pattern.clone(),
                r.replacement.clone(),
                r.regex,
                r.case_sensitive,
            )
        })
        .collect()
}

/// Apply ignore-message replacements to Privmsg text (and nested Usernotice body).
pub(crate) fn apply_ignore_replacements(event: &mut ChatEvent, rules: &[ReplaceRule]) {
    if rules.is_empty() {
        return;
    }
    match event {
        ChatEvent::Privmsg {
            text,
            emote_spans,
            link_spans,
            mention_spans,
            ..
        } => {
            if apply_replacements_to_body(text, emote_spans, rules) {
                let (links, mentions) = decorate_text_spans(text, emote_spans);
                *link_spans = links;
                *mention_spans = mentions;
            }
        }
        ChatEvent::Usernotice { privmsg, .. } => {
            if let Some(inner) = privmsg.as_deref_mut() {
                apply_ignore_replacements(inner, rules);
            }
        }
        _ => {}
    }
}

/// Returns true if `text` / emote spans were mutated.
fn apply_replacements_to_body(
    text: &mut String,
    emote_spans: &mut Vec<EmoteSpan>,
    rules: &[ReplaceRule],
) -> bool {
    let mut changed = false;
    let mut total: usize = 0;
    for rule in rules {
        if rule.pattern.is_empty() {
            continue;
        }
        if rule.is_regex {
            let Some(re) = rule.compiled.as_ref() else {
                continue;
            };
            match apply_regex_replacements(text, emote_spans, re, &rule.replacement, &mut total) {
                ReplaceOutcome::Changed => changed = true,
                ReplaceOutcome::TooMany => return true,
                ReplaceOutcome::Unchanged => {}
            }
        } else {
            match apply_literal_replacements(
                text,
                emote_spans,
                &rule.pattern,
                &rule.replacement,
                rule.case_sensitive,
                &mut total,
            ) {
                ReplaceOutcome::Changed => changed = true,
                ReplaceOutcome::TooMany => return true,
                ReplaceOutcome::Unchanged => {}
            }
        }
    }
    changed
}

enum ReplaceOutcome {
    Unchanged,
    Changed,
    TooMany,
}

fn apply_regex_replacements(
    text: &mut String,
    emote_spans: &mut Vec<EmoteSpan>,
    re: &Regex,
    replacement_tpl: &str,
    total: &mut usize,
) -> ReplaceOutcome {
    let mut changed = false;
    let mut search_from = 0usize;
    loop {
        let (abs_start, abs_end, dest, match_empty) = {
            let Some(caps) = re.captures(&text[search_from..]) else {
                break;
            };
            let m = caps.get(0).expect("full match");
            let abs_start = search_from + m.start();
            let abs_end = search_from + m.end();
            let match_empty = m.as_str().is_empty();
            let dest = expand_ignore_replacement(&caps, replacement_tpl);
            (abs_start, abs_end, dest, match_empty)
        };
        let matched = text[abs_start..abs_end].to_string();
        patch_emote_spans(emote_spans, text, abs_start, abs_end, &matched, &dest);
        text.replace_range(abs_start..abs_end, &dest);
        changed = true;
        *total += 1;
        if *total >= MAX_IGNORE_REPLACEMENTS {
            *text = TOO_MANY_REPLACEMENTS.to_string();
            emote_spans.clear();
            return ReplaceOutcome::TooMany;
        }
        search_from = abs_start + dest.len();
        if search_from > text.len() {
            break;
        }
        // Empty match: advance one char only when replacement did not already move past it.
        if match_empty && dest.is_empty() {
            if let Some(ch) = text[search_from..].chars().next() {
                search_from += ch.len_utf8();
            } else {
                break;
            }
        }
    }
    if changed {
        ReplaceOutcome::Changed
    } else {
        ReplaceOutcome::Unchanged
    }
}

/// Stock-style `\1` / `\12` and plan `$1` / `${1}` capture refs; other `$` stay literal.
fn expand_ignore_replacement(caps: &regex::Captures<'_>, tpl: &str) -> String {
    let bytes = tpl.as_bytes();
    let mut out = String::with_capacity(tpl.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() {
            if let Some((n, consumed)) = parse_group_ref(&bytes[i + 1..], caps.len()) {
                if let Some(m) = caps.get(n) {
                    out.push_str(m.as_str());
                }
                i += 1 + consumed;
                continue;
            }
            out.push('\\');
            i += 1;
            continue;
        }
        if b == b'$' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'$' {
                out.push('$');
                i += 2;
                continue;
            }
            if bytes[i + 1] == b'{' {
                if let Some(end) = bytes[i + 2..].iter().position(|&c| c == b'}') {
                    let inner = &bytes[i + 2..i + 2 + end];
                    if let Ok(n) = std::str::from_utf8(inner).unwrap_or("").parse::<usize>() {
                        if n < caps.len() {
                            if let Some(m) = caps.get(n) {
                                out.push_str(m.as_str());
                            }
                            i += 3 + end;
                            continue;
                        }
                    }
                }
            } else if let Some((n, consumed)) = parse_group_ref(&bytes[i + 1..], caps.len()) {
                if let Some(m) = caps.get(n) {
                    out.push_str(m.as_str());
                }
                i += 1 + consumed;
                continue;
            }
            out.push('$');
            i += 1;
            continue;
        }
        let ch = tpl[i..].chars().next().expect("utf8");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Parse 1–2 digit group index in `1..=caps_len-1`. Returns (index, bytes_consumed).
fn parse_group_ref(bytes: &[u8], caps_len: usize) -> Option<(usize, usize)> {
    if caps_len <= 1 || bytes.is_empty() || !bytes[0].is_ascii_digit() || bytes[0] == b'0' {
        return None;
    }
    let max = caps_len - 1;
    let d1 = (bytes[0] - b'0') as usize;
    if bytes.len() >= 2 && bytes[1].is_ascii_digit() {
        let two = d1 * 10 + (bytes[1] - b'0') as usize;
        if (1..=max).contains(&two) {
            return Some((two, 2));
        }
    }
    if d1 <= max {
        Some((d1, 1))
    } else {
        None
    }
}

fn apply_literal_replacements(
    text: &mut String,
    emote_spans: &mut Vec<EmoteSpan>,
    pattern: &str,
    replacement: &str,
    case_sensitive: bool,
    total: &mut usize,
) -> ReplaceOutcome {
    if pattern.is_empty() {
        return ReplaceOutcome::Unchanged;
    }
    let mut changed = false;
    let mut search_from = 0usize;
    while let Some((abs_start, abs_end)) =
        find_literal(text, pattern, search_from, case_sensitive)
    {
        let matched = text[abs_start..abs_end].to_string();
        patch_emote_spans(emote_spans, text, abs_start, abs_end, &matched, replacement);
        text.replace_range(abs_start..abs_end, replacement);
        changed = true;
        *total += 1;
        if *total >= MAX_IGNORE_REPLACEMENTS {
            *text = TOO_MANY_REPLACEMENTS.to_string();
            emote_spans.clear();
            return ReplaceOutcome::TooMany;
        }
        search_from = abs_start + replacement.len();
        if search_from > text.len() {
            break;
        }
    }
    if changed {
        ReplaceOutcome::Changed
    } else {
        ReplaceOutcome::Unchanged
    }
}

fn find_literal(
    hay: &str,
    needle: &str,
    from_byte: usize,
    case_sensitive: bool,
) -> Option<(usize, usize)> {
    if from_byte > hay.len() || needle.is_empty() {
        return None;
    }
    let rest = &hay[from_byte..];
    if case_sensitive {
        let rel = rest.find(needle)?;
        let start = from_byte + rel;
        return Some((start, start + needle.len()));
    }
    let needle_chars: Vec<char> = needle.chars().collect();
    let hay_chars: Vec<(usize, char)> = rest.char_indices().collect();
    if needle_chars.len() > hay_chars.len() {
        return None;
    }
    let last = hay_chars.len() - needle_chars.len();
    for i in 0..=last {
        let slice: Vec<char> = hay_chars[i..i + needle_chars.len()]
            .iter()
            .map(|(_, c)| *c)
            .collect();
        if eq_ignore_case(&slice, &needle_chars) {
            let start = from_byte + hay_chars[i].0;
            let end = if i + needle_chars.len() < hay_chars.len() {
                from_byte + hay_chars[i + needle_chars.len()].0
            } else {
                hay.len()
            };
            return Some((start, end));
        }
    }
    None
}

fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

fn byte_to_utf16(s: &str, byte: usize) -> u32 {
    utf16_len(&s[..byte.min(s.len())])
}

fn patch_emote_spans(
    spans: &mut Vec<EmoteSpan>,
    full: &str,
    byte_start: usize,
    byte_end: usize,
    matched: &str,
    replacement: &str,
) {
    let u_start = byte_to_utf16(full, byte_start);
    let u_end = u_start + utf16_len(matched);
    let delta = utf16_len(replacement) as i64 - utf16_len(matched) as i64;
    spans.retain_mut(|s| {
        if s.end <= u_start {
            return true;
        }
        if s.start >= u_end {
            let ns = s.start as i64 + delta;
            let ne = s.end as i64 + delta;
            if ns < 0 || ne < 0 || ns >= ne {
                return false;
            }
            s.start = ns as u32;
            s.end = ne as u32;
            return true;
        }
        // Overlaps replaced range — drop.
        false
    });
}

#[derive(Debug, Clone)]
pub(crate) struct BlacklistRule {
    pub pattern: String,
    pub is_regex: bool,
    /// Compiled only when `is_regex`; None if invalid (never matches).
    pub compiled: Option<Regex>,
}

impl BlacklistRule {
    fn from_row(pattern: String, is_regex: bool) -> Self {
        let compiled = if is_regex {
            regex::RegexBuilder::new(&pattern)
                .case_insensitive(true)
                .unicode(true)
                .build()
                .ok()
        } else {
            None
        };
        Self {
            pattern,
            is_regex,
            compiled,
        }
    }
}

/// Rows from Highlights Blacklisted Users table (non-empty username).
pub fn blacklist_rules_from_settings(data: &super::settings::AppSettings) -> Vec<BlacklistRule> {
    data.highlight_blacklist
        .iter()
        .filter(|r| !r.username.trim().is_empty())
        .map(|r| BlacklistRule::from_row(r.username.clone(), r.regex))
        .collect()
}

/// Rows from Ignores Users table (non-empty username) — drop matching logins.
pub fn ignore_user_rules_from_settings(data: &super::settings::AppSettings) -> Vec<BlacklistRule> {
    data.ignore_users
        .iter()
        .filter(|r| !r.username.trim().is_empty())
        .map(|r| BlacklistRule::from_row(r.username.clone(), r.regex))
        .collect()
}

fn login_is_blacklisted(login: &str, rules: &[BlacklistRule]) -> bool {
    if login.is_empty() || rules.is_empty() {
        return false;
    }
    rules.iter().any(|rule| {
        if rule.pattern.is_empty() {
            return false;
        }
        if rule.is_regex {
            rule.compiled
                .as_ref()
                .is_some_and(|re| re.is_match(login))
        } else {
            login.eq_ignore_ascii_case(rule.pattern.trim())
        }
    })
}

fn event_sender_login(event: &ChatEvent) -> Option<&str> {
    match event {
        ChatEvent::Privmsg { login, .. } if !login.is_empty() => Some(login.as_str()),
        ChatEvent::Usernotice { login, privmsg, .. } => login
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| match privmsg.as_deref() {
                Some(ChatEvent::Privmsg { login, .. }) if !login.is_empty() => Some(login.as_str()),
                _ => None,
            }),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HighlightSoundCtx {
    pub enable_self_sound: bool,
    /// Raw color from `highlighting.selfHighlightColor` (empty → fallback).
    pub self_highlight_color: String,
    /// Stock self-message highlight (own outgoing messages).
    pub enable_self_message: bool,
    pub self_message_color: String,
    pub phrase_rules: Vec<PhraseRule>,
    /// username → (play_sound, raw color, custom_sound path, flash_taskbar)
    pub user_sound: Vec<(String, bool, String, String, bool)>,
    /// badge name → (play, color, custom_sound, flash_taskbar)
    pub badge_rows: Vec<(String, bool, String, String, bool)>,
}

impl Default for HighlightSoundCtx {
    fn default() -> Self {
        Self {
            enable_self_sound: true,
            self_highlight_color: String::new(),
            enable_self_message: false,
            self_message_color: String::new(),
            phrase_rules: Vec::new(),
            user_sound: Vec::new(),
            badge_rows: Vec::new(),
        }
    }
}

impl HighlightSoundCtx {
    pub fn from_shared(shared: &Shared) -> Self {
        let Ok(settings) = shared.settings.lock() else {
            return Self {
                enable_self_sound: true,
                ..Self::default()
            };
        };
        Self::from_settings(&settings.data)
    }

    /// Build from already-loaded settings (caller holds the settings lock).
    pub fn from_settings(data: &super::settings::AppSettings) -> Self {
        let knobs = &data.knobs;
        let enable_self_sound = knobs
            .get("highlighting.enableSelfHighlightSound")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let self_highlight_color = knobs
            .get("highlighting.selfHighlightColor")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let enable_self_message = knobs
            .get("highlighting.enableSelfMessageHighlight")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let self_message_color = knobs
            .get("highlighting.selfMessageHighlightColor")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let phrase_rules = data
            .highlight_messages
            .iter()
            .filter(|r| !r.pattern.trim().is_empty())
            .map(|r| {
                PhraseRule::from_row(
                    r.pattern.clone(),
                    r.play_sound,
                    r.color.clone(),
                    r.custom_sound.clone(),
                    r.flash_taskbar,
                    r.regex,
                    r.case_sensitive,
                )
            })
            .collect();
        let user_sound = data
            .highlight_users
            .iter()
            .filter(|r| !r.username.trim().is_empty())
            .map(|r| {
                (
                    r.username.clone(),
                    r.play_sound,
                    r.color.clone(),
                    r.custom_sound.clone(),
                    r.flash_taskbar,
                )
            })
            .collect();
        let badge_rows = data
            .highlight_badges
            .iter()
            .filter(|r| !r.name.trim().is_empty())
            .map(|r| {
                (
                    r.name.clone(),
                    r.play_sound,
                    r.color.clone(),
                    r.custom_sound.clone(),
                    r.flash_taskbar,
                )
            })
            .collect();
        Self {
            enable_self_sound,
            self_highlight_color,
            enable_self_message,
            self_message_color,
            phrase_rules,
            user_sound,
            badge_rows,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HighlightHit {
    color: Option<String>,
    sound: bool,
    sound_path: Option<String>,
    flash: bool,
}

fn highlight_sound_path(play: bool, custom_sound: &str) -> Option<String> {
    if !play {
        return None;
    }
    let t = custom_sound.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Accept `#RRGGBB` / `#RRGGBBAA`; empty or invalid → `fallback`.
pub(crate) fn resolve_highlight_color_or(raw: &str, fallback: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return fallback.to_string();
    }
    let body = t.strip_prefix('#').unwrap_or(t);
    let ok = matches!(body.len(), 6 | 8)
        && body.bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        format!("#{body}")
    } else {
        fallback.to_string()
    }
}

/// Phrase / self-nick / user row colors → stock self-highlight fallback.
pub(crate) fn resolve_highlight_color(raw: &str) -> String {
    resolve_highlight_color_or(raw, SELF_HIGHLIGHT_COLOR)
}

fn first_custom_sound_in_check_order(
    filters: &Filters,
    sound: &HighlightSoundCtx,
    login: &str,
    text: &str,
    badges: &[Badge],
    self_login: Option<&str>,
) -> Option<String> {
    let self_msg = is_self(login, self_login);
    if self_msg && sound.enable_self_message {
        return None;
    }
    if !self_msg {
        for rule in &sound.phrase_rules {
            if phrase_matches_ex(text, rule) {
                if let Some(p) = highlight_sound_path(rule.play, &rule.custom_sound) {
                    return Some(p);
                }
            }
        }
    }
    for (user, play, _, custom_sound, _) in &sound.user_sound {
        if user.eq_ignore_ascii_case(login) {
            if let Some(p) = highlight_sound_path(*play, custom_sound) {
                return Some(p);
            }
        }
    }
    if filters
        .highlight_logins
        .iter()
        .any(|item| item.eq_ignore_ascii_case(login))
    {
        if let Some((_, play, _, custom, _)) = sound
            .user_sound
            .iter()
            .find(|(u, _, _, _, _)| u.eq_ignore_ascii_case(login))
        {
            if let Some(p) = highlight_sound_path(*play, custom) {
                return Some(p);
            }
        }
    }
    for (name, play, _, custom_sound, _) in &sound.badge_rows {
        if badge_matches(name, badges) {
            if let Some(p) = highlight_sound_path(*play, custom_sound) {
                return Some(p);
            }
        }
    }
    None
}

fn first_flash_in_check_order(
    filters: &Filters,
    sound: &HighlightSoundCtx,
    login: &str,
    text: &str,
    badges: &[Badge],
    self_login: Option<&str>,
) -> bool {
    let self_msg = is_self(login, self_login);
    if self_msg && sound.enable_self_message {
        return false;
    }
    if !self_msg && filters.enable_self_highlight {
        if let Some(me) = self_login {
            if phrase_matches(text, me) {
                return true;
            }
        }
    }
    if !self_msg {
        for rule in &sound.phrase_rules {
            if phrase_matches_ex(text, rule) && rule.flash_taskbar {
                return true;
            }
        }
    }
    for (user, _, _, _, flash) in &sound.user_sound {
        if user.eq_ignore_ascii_case(login) && *flash {
            return true;
        }
    }
    if filters
        .highlight_logins
        .iter()
        .any(|item| item.eq_ignore_ascii_case(login))
    {
        if let Some((_, _, _, _, flash)) = sound
            .user_sound
            .iter()
            .find(|(u, _, _, _, _)| u.eq_ignore_ascii_case(login))
        {
            if *flash {
                return true;
            }
        }
    }
    for (name, _, _, _, flash) in &sound.badge_rows {
        if badge_matches(name, badges) && *flash {
            return true;
        }
    }
    false
}

fn highlight_primary(
    filters: &Filters,
    sound: &HighlightSoundCtx,
    login: &str,
    text: &str,
    badges: &[Badge],
    self_login: Option<&str>,
) -> (Option<String>, bool) {
    let self_msg = is_self(login, self_login);
    if self_msg && sound.enable_self_message {
        return (
            Some(resolve_highlight_color_or(
                &sound.self_message_color,
                SELF_MESSAGE_HIGHLIGHT_COLOR,
            )),
            false,
        );
    }
    if !self_msg {
        if filters.enable_self_highlight {
            if let Some(me) = self_login {
                if phrase_matches(text, me) {
                    return (
                        Some(resolve_highlight_color(&sound.self_highlight_color)),
                        sound.enable_self_sound,
                    );
                }
            }
        }
        for rule in &sound.phrase_rules {
            if phrase_matches_ex(text, rule) {
                return (
                    Some(resolve_highlight_color(&rule.color)),
                    rule.play,
                );
            }
        }
        for phrase in &filters.highlight_phrases {
            if sound
                .phrase_rules
                .iter()
                .any(|r| r.pattern.eq_ignore_ascii_case(phrase))
            {
                continue;
            }
            if phrase_matches(text, phrase) {
                return (Some(SELF_HIGHLIGHT_COLOR.to_string()), false);
            }
        }
    }
    for (user, play, color, _, _) in &sound.user_sound {
        if user.eq_ignore_ascii_case(login) {
            return (Some(resolve_highlight_color(color)), *play);
        }
    }
    if filters
        .highlight_logins
        .iter()
        .any(|item| item.eq_ignore_ascii_case(login))
    {
        let (play, color) = sound
            .user_sound
            .iter()
            .find(|(u, _, _, _, _)| u.eq_ignore_ascii_case(login))
            .map(|(_, p, c, _, _)| (*p, c.as_str()))
            .unwrap_or((false, ""));
        return (Some(resolve_highlight_color(color)), play);
    }
    for (name, play, color, _, _) in &sound.badge_rows {
        if badge_matches(name, badges) {
            return (
                Some(resolve_highlight_color_or(color, BADGE_HIGHLIGHT_COLOR)),
                *play,
            );
        }
    }
    (None, false)
}

fn highlight_hit(
    filters: &Filters,
    sound: &HighlightSoundCtx,
    login: &str,
    text: &str,
    badges: &[Badge],
    self_login: Option<&str>,
) -> HighlightHit {
    let (color, sound_flag) =
        highlight_primary(filters, sound, login, text, badges, self_login);
    let sound_path = if sound_flag {
        first_custom_sound_in_check_order(filters, sound, login, text, badges, self_login)
    } else {
        None
    };
    let flash = first_flash_in_check_order(filters, sound, login, text, badges, self_login);
    HighlightHit {
        color,
        sound: sound_flag,
        sound_path,
        flash,
    }
}

/// Stock HighlightBadge::isMatch — `set`, `set/version`, or comma-separated list.
fn badge_matches(row_name: &str, badges: &[Badge]) -> bool {
    let name = row_name.trim();
    if name.is_empty() || badges.is_empty() {
        return false;
    }
    name.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|id| badge_id_matches(id, badges))
}

fn badge_id_matches(id: &str, badges: &[Badge]) -> bool {
    if let Some((set, version)) = id.split_once('/') {
        let set = set.trim();
        let version = version.trim();
        if set.is_empty() {
            return false;
        }
        badges.iter().any(|b| {
            b.set.eq_ignore_ascii_case(set) && b.version.eq_ignore_ascii_case(version)
        })
    } else {
        badges
            .iter()
            .any(|b| b.set.eq_ignore_ascii_case(id))
    }
}

pub(crate) fn phrase_matches(text: &str, pattern: &str) -> bool {
    phrase_matches_boundary(text, pattern, false)
}

fn phrase_matches_ex(text: &str, rule: &PhraseRule) -> bool {
    if rule.pattern.is_empty() {
        return false;
    }
    if rule.is_regex {
        return rule.compiled.as_ref().is_some_and(|re| re.is_match(text));
    }
    phrase_matches_boundary(text, &rule.pattern, rule.case_sensitive)
}

fn phrase_matches_boundary(text: &str, pattern: &str, case_sensitive: bool) -> bool {
    if pattern.is_empty() {
        return false;
    }
    let hay: Vec<char> = text.chars().collect();
    let needle: Vec<char> = pattern.chars().collect();
    if needle.is_empty() || needle.len() > hay.len() {
        return false;
    }
    let last = hay.len() - needle.len();
    for i in 0..=last {
        let slice = &hay[i..i + needle.len()];
        let eq = if case_sensitive {
            slice == needle.as_slice()
        } else {
            eq_ignore_case(slice, &needle)
        };
        if !eq {
            continue;
        }
        let left_ok = i == 0
            || hay[i - 1].is_whitespace()
            || is_word(hay[i - 1]) != is_word(needle[0]);
        let after = i + needle.len();
        let right_ok = after == hay.len()
            || hay[after].is_whitespace()
            || is_word(hay[after]) != is_word(needle[needle.len() - 1]);
        if left_ok && right_ok {
            return true;
        }
    }
    false
}

fn eq_ignore_case(a: &[char], b: &[char]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| {
        x.to_lowercase().eq(y.to_lowercase())
    })
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_self(login: &str, self_login: Option<&str>) -> bool {
    self_login.is_some_and(|me| me.eq_ignore_ascii_case(login))
}

fn event_login(event: &ChatEvent) -> Option<&str> {
    match event {
        ChatEvent::Privmsg { login, .. } if !login.is_empty() => Some(login.as_str()),
        ChatEvent::Usernotice { login, privmsg, .. } => login
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| match privmsg.as_deref() {
                Some(ChatEvent::Privmsg { login, .. }) if !login.is_empty() => Some(login.as_str()),
                _ => None,
            }),
        _ => None,
    }
}

fn sanitize_logins(items: Vec<String>, label: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for raw in items {
        if raw.trim().is_empty() {
            continue;
        }
        let login = normalize_login(&raw)?;
        if !out.iter().any(|x| x == &login) {
            out.push(login);
        }
        if out.len() > MAX_LIST {
            return Err(format!("{label}: не больше {MAX_LIST} записей"));
        }
    }
    Ok(out)
}

fn sanitize_phrases(items: Vec<String>, label: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in items {
        let phrase = raw.trim();
        if phrase.is_empty() {
            continue;
        }
        if phrase.chars().count() > MAX_PATTERN {
            return Err(format!("{label}: фраза длиннее {MAX_PATTERN} символов"));
        }
        if phrase.chars().any(|c| c.is_control()) {
            return Err(format!("{label}: фраза содержит запрещённые символы"));
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(phrase)) {
            out.push(phrase.to_string());
        }
        if out.len() > MAX_LIST {
            return Err(format!("{label}: не больше {MAX_LIST} записей"));
        }
    }
    Ok(out)
}

fn normalize_login(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_start_matches('#').to_lowercase();
    if s.is_empty() || s.len() > 25 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("логин: 1-25 символов [a-z0-9_]".into());
    }
    Ok(s)
}

fn load_file(path: &Path) -> Filters {
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > MAX_FILE_BYTES {
                eprintln!("filters.json слишком большой, используются значения по умолчанию");
                return Filters::default();
            }
            match serde_json::from_slice::<Filters>(&bytes) {
                Ok(parsed) => match sanitize(parsed) {
                    Ok(clean) => clean,
                    Err(e) => {
                        eprintln!("filters.json отклонён ({e}), используются значения по умолчанию");
                        Filters::default()
                    }
                },
                Err(e) => {
                    eprintln!("filters.json повреждён ({e}), используются значения по умолчанию");
                    Filters::default()
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Filters::default(),
        Err(e) => {
            eprintln!("не удалось прочитать filters.json ({e}), используются значения по умолчанию");
            Filters::default()
        }
    }
}

fn save_file(path: &Path, data: &Filters) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("каталог конфигурации не задан".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn privmsg(login: &str, text: &str) -> ChatEvent {
        ChatEvent::Privmsg {
            id: "1".into(),
            timestamp_ms: 1,
            user_id: "9".into(),
            login: login.into(),
            display_name: login.into(),
            color: String::new(),
            badges: vec![],
            text: text.into(),
            emote_spans: vec![],
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
        }
    }

    fn with_badges(mut ev: ChatEvent, badges: Vec<Badge>) -> ChatEvent {
        if let ChatEvent::Privmsg {
            badges: slot, ..
        } = &mut ev
        {
            *slot = badges;
        }
        ev
    }

    fn badge(set: &str, version: &str) -> Badge {
        Badge {
            set: set.into(),
            version: version.into(),
            url: None,
        }
    }

    #[test]
    fn drops_ignored_login_but_not_self() {
        let filters = Filters {
            ignore_logins: vec!["spam".into()],
            ..Filters::default()
        };
        assert!(should_drop(&filters, &[], &[], &privmsg("spam", "hi"), Some("me")));
        assert!(should_drop(&filters, &[], &[], &privmsg("SPAM", "hi"), Some("me")));
        assert!(!should_drop(&filters, &[], &[], &privmsg("spam", "hi"), Some("spam")));
        assert!(!should_drop(&filters, &[], &[], &privmsg("ok", "hi"), Some("me")));
    }

    #[test]
    fn drops_ignored_phrase_except_self() {
        let filters = Filters {
            ignore_phrases: vec!["buy followers".into()],
            ..Filters::default()
        };
        assert!(should_drop(
            &filters,
            &[],
            &[],
            &privmsg("x", "please buy followers now"),
            Some("me")
        ));
        assert!(!should_drop(
            &filters,
            &[],
            &[],
            &privmsg("me", "please buy followers now"),
            Some("me")
        ));
        assert!(!should_drop(&filters, &[], &[], &privmsg("x", "buyfollowers"), Some("me")));
    }

    #[test]
    fn self_nick_highlights_other_messages() {
        let filters = Filters::default();
        let mut ev = privmsg("xqc", "hello Mike there");
        apply_highlight(&filters, &HighlightSoundCtx::default(), &HighlightKindsCtx::default(), &[], &mut ev, Some("mike"));
        match ev {
            ChatEvent::Privmsg {
                highlight_color,
                highlight_sound,
                ..
            } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
                assert!(highlight_sound);
            }
            _ => panic!("privmsg"),
        }
        let mut self_ev = privmsg("mike", "hello Mike there");
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &HighlightKindsCtx::default(),
            &[],
            &mut self_ev,
            Some("mike"),
        );
        match self_ev {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert!(highlight_color.is_none());
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn self_highlight_sound_follows_ctx() {
        let filters = Filters {
            enable_self_highlight: true,
            ..Filters::default()
        };
        let mut ev = privmsg("ann", "hey mike");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                enable_self_sound: true,
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut ev,
            Some("mike"),
        );
        match ev {
            ChatEvent::Privmsg { highlight_sound, .. } => assert!(highlight_sound),
            _ => panic!("privmsg"),
        }
        let mut ev2 = privmsg("ann", "hey mike");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                enable_self_sound: false,
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut ev2,
            Some("mike"),
        );
        match ev2 {
            ChatEvent::Privmsg { highlight_sound, .. } => assert!(!highlight_sound),
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn phrase_user_badge_flash_taskbar_on_event() {
        let filters = Filters {
            enable_self_highlight: false,
            ..Filters::default()
        };
        let sound = HighlightSoundCtx {
            phrase_rules: vec![PhraseRule::from_row(
                "pog".into(),
                true,
                String::new(),
                String::new(),
                false,
                false,
                false,
            )],
            user_sound: vec![(
                "streamer".into(),
                true,
                String::new(),
                String::new(),
                true,
            )],
            ..HighlightSoundCtx::default()
        };
        let mut by_phrase = privmsg("x", "nice pog");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_phrase,
            Some("me"),
        );
        match by_phrase {
            ChatEvent::Privmsg { highlight_flash, .. } => assert!(!highlight_flash),
            _ => panic!("privmsg"),
        }

        let mut by_user = privmsg("streamer", "hello");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_user,
            Some("me"),
        );
        match by_user {
            ChatEvent::Privmsg { highlight_flash, .. } => assert!(highlight_flash),
            _ => panic!("privmsg"),
        }

        let mut phrase_then_user = privmsg("streamer", "nice pog");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut phrase_then_user,
            Some("me"),
        );
        match phrase_then_user {
            ChatEvent::Privmsg { highlight_flash, .. } => assert!(highlight_flash),
            _ => panic!("privmsg"),
        }

        let mut by_badge = with_badges(privmsg("ann", "hi"), vec![badge("moderator", "1")]);
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                badge_rows: vec![(
                    "moderator".into(),
                    true,
                    String::new(),
                    String::new(),
                    true,
                )],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut by_badge,
            Some("me"),
        );
        match by_badge {
            ChatEvent::Privmsg { highlight_flash, .. } => assert!(highlight_flash),
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn phrase_and_user_custom_sound_path_on_event() {
        let filters = Filters {
            enable_self_highlight: false,
            ..Filters::default()
        };
        let phrase_path = r"C:\sounds\pog.wav".to_string();
        let user_path = r"C:\sounds\streamer.wav".to_string();
        let sound = HighlightSoundCtx {
            phrase_rules: vec![PhraseRule::from_row(
                "pog".into(),
                true,
                String::new(),
                phrase_path.clone(),
                false,
                false,
                false,
            )],
            user_sound: vec![(
                "streamer".into(),
                true,
                String::new(),
                user_path.clone(),
                false,
            )],
            ..HighlightSoundCtx::default()
        };
        let mut by_phrase = privmsg("x", "nice pog");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_phrase,
            Some("me"),
        );
        match by_phrase {
            ChatEvent::Privmsg {
                highlight_sound,
                highlight_sound_path,
                ..
            } => {
                assert!(highlight_sound);
                assert_eq!(highlight_sound_path.as_deref(), Some(phrase_path.as_str()));
            }
            _ => panic!("privmsg"),
        }

        let mut by_user = privmsg("streamer", "hello");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_user,
            Some("me"),
        );
        match by_user {
            ChatEvent::Privmsg {
                highlight_sound,
                highlight_sound_path,
                ..
            } => {
                assert!(highlight_sound);
                assert_eq!(highlight_sound_path.as_deref(), Some(user_path.as_str()));
            }
            _ => panic!("privmsg"),
        }

        let mut phrase_then_user = privmsg("streamer", "nice pog");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut phrase_then_user,
            Some("me"),
        );
        match phrase_then_user {
            ChatEvent::Privmsg {
                highlight_sound,
                highlight_sound_path,
                ..
            } => {
                assert!(highlight_sound);
                assert_eq!(
                    highlight_sound_path.as_deref(),
                    Some(phrase_path.as_str())
                );
            }
            _ => panic!("privmsg"),
        }

        let mut phrase_no_custom_user_custom = privmsg("streamer", "nice pog");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![PhraseRule::from_row(
                    "pog".into(),
                    true,
                    String::new(),
                    String::new(),
                    false,
                    false,
                    false,
                )],
                user_sound: vec![(
                    "streamer".into(),
                    true,
                    String::new(),
                    user_path.clone(),
                    false,
                )],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut phrase_no_custom_user_custom,
            Some("me"),
        );
        match phrase_no_custom_user_custom {
            ChatEvent::Privmsg {
                highlight_sound,
                highlight_sound_path,
                ..
            } => {
                assert!(highlight_sound);
                assert_eq!(
                    highlight_sound_path.as_deref(),
                    Some(user_path.as_str())
                );
            }
            _ => panic!("privmsg"),
        }

        let mut default_sound = privmsg("x", "nice pog");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![PhraseRule::plain("pog", true, "")],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut default_sound,
            Some("me"),
        );
        match default_sound {
            ChatEvent::Privmsg {
                highlight_sound,
                highlight_sound_path,
                ..
            } => {
                assert!(highlight_sound);
                assert!(highlight_sound_path.is_none());
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn phrase_and_user_sound_from_rows() {
        let filters = Filters {
            highlight_phrases: vec!["pog".into()],
            highlight_logins: vec!["streamer".into()],
            enable_self_highlight: false,
            ..Filters::default()
        };
        let sound = HighlightSoundCtx {
            enable_self_sound: true,
            phrase_rules: vec![PhraseRule::plain("pog", true, "")],
            user_sound: vec![("streamer".into(), true, String::new(), String::new(), false)],
            ..HighlightSoundCtx::default()
        };
        let mut by_phrase = privmsg("x", "that was pog");
        apply_highlight(&filters, &sound, &HighlightKindsCtx::default(), &[], &mut by_phrase, Some("me"));
        match by_phrase {
            ChatEvent::Privmsg {
                highlight_color,
                highlight_sound,
                ..
            } => {
                assert!(highlight_color.is_some());
                assert!(highlight_sound);
            }
            _ => panic!("privmsg"),
        }
        let mut silent = privmsg("x", "that was pog");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![PhraseRule::plain("pog", false, "")],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut silent,
            Some("me"),
        );
        match silent {
            ChatEvent::Privmsg { highlight_sound, .. } => assert!(!highlight_sound),
            _ => panic!("privmsg"),
        }
        let mut by_user = privmsg("streamer", "hey");
        apply_highlight(&filters, &sound, &HighlightKindsCtx::default(), &[], &mut by_user, Some("me"));
        match by_user {
            ChatEvent::Privmsg { highlight_sound, .. } => assert!(highlight_sound),
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn highlight_login_and_phrase() {
        let filters = Filters {
            highlight_logins: vec!["streamer".into()],
            highlight_phrases: vec!["pog".into()],
            enable_self_highlight: false,
            ..Filters::default()
        };
        let mut by_user = privmsg("streamer", "hey");
        apply_highlight(&filters, &HighlightSoundCtx::default(), &HighlightKindsCtx::default(), &[], &mut by_user, Some("me"));
        match by_user {
            ChatEvent::Privmsg { highlight_color, highlight_sound, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
                assert!(!highlight_sound);
            }
            _ => panic!("privmsg"),
        }
        let mut by_phrase = privmsg("x", "that was pog");
        apply_highlight(&filters, &HighlightSoundCtx::default(), &HighlightKindsCtx::default(), &[], &mut by_phrase, Some("me"));
        match by_phrase {
            ChatEvent::Privmsg { highlight_color, highlight_sound, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
                assert!(!highlight_sound);
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn sanitize_rejects_bad_login_and_long_phrase() {
        assert!(sanitize(Filters {
            ignore_logins: vec!["has space".into()],
            ..Filters::default()
        })
        .is_err());
        assert!(sanitize(Filters {
            ignore_phrases: vec!["a".repeat(201)],
            ..Filters::default()
        })
        .is_err());
        let ok = sanitize(Filters {
            ignore_logins: vec!["#XQC".into(), "xqc".into()],
            ignore_phrases: vec!["  hi  ".into(), "".into()],
            ..Filters::default()
        })
        .unwrap();
        assert_eq!(ok.ignore_logins, vec!["xqc"]);
        assert_eq!(ok.ignore_phrases, vec!["hi"]);
        let skipped = sanitize(Filters {
            ignore_logins: vec!["".into(), "  ".into(), "xqc".into()],
            highlight_phrases: vec!["Hi".into(), "hi".into()],
            ..Filters::default()
        })
        .unwrap();
        assert_eq!(skipped.ignore_logins, vec!["xqc"]);
        assert_eq!(skipped.highlight_phrases, vec!["Hi"]);
        let mut padded: Vec<String> = (0..200).map(|i| format!("u{i}")).collect();
        padded.push("".into());
        assert!(sanitize(Filters {
            ignore_logins: padded,
            ..Filters::default()
        })
        .is_ok());
    }

    #[test]
    fn phrase_uses_word_boundaries() {
        assert!(phrase_matches("hello world", "hello"));
        assert!(phrase_matches("Hello!", "hello"));
        assert!(!phrase_matches("shello", "hello"));
        assert!(phrase_matches("foo bar baz", "bar"));
    }

    #[test]
    fn phrase_case_sensitive_and_regex() {
        let filters = Filters {
            enable_self_highlight: false,
            ..Filters::default()
        };
        let case_row = PhraseRule::from_row("Pog".into(), true, String::new(), String::new(), false, false, true);
        assert!(phrase_matches_ex("say Pog now", &case_row));
        assert!(!phrase_matches_ex("say pog now", &case_row));
        assert!(!phrase_matches_ex("xPog", &case_row));
        assert!(!phrase_matches_ex("PogChamp", &case_row));
        assert!(phrase_matches_ex("Pog!", &case_row));

        let ignore_case = PhraseRule::plain("Pog", true, "");
        assert!(phrase_matches_ex("say pog now", &ignore_case));

        let re = PhraseRule::from_row(r"\bfoo\b".into(), true, "#11223344".into(), String::new(), false, true, false);
        assert!(re.compiled.is_some());
        let mut hit = privmsg("x", "bar foo baz");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![re],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut hit,
            Some("me"),
        );
        match hit {
            ChatEvent::Privmsg {
                highlight_color,
                highlight_sound,
                ..
            } => {
                assert_eq!(highlight_color.as_deref(), Some("#11223344"));
                assert!(highlight_sound);
            }
            _ => panic!("privmsg"),
        }
        let mut miss = privmsg("x", "bar foobar baz");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![PhraseRule::from_row(
                    r"\bfoo\b".into(),
                    true,
                    String::new(),
                    String::new(),
                    false,
                    true,
                    false,
                )],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut miss,
            Some("me"),
        );
        match miss {
            ChatEvent::Privmsg { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("privmsg"),
        }

        let invalid = PhraseRule::from_row("(".into(), true, "#FF0000".into(), String::new(), false, true, false);
        assert!(invalid.compiled.is_none());
        assert!(!phrase_matches_ex("anything", &invalid));
        let mut no_hl = privmsg("x", "(");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![invalid],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut no_hl,
            Some("me"),
        );
        match no_hl {
            ChatEvent::Privmsg { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("privmsg"),
        }

        let case_re = PhraseRule::from_row("Foo".into(), false, String::new(), String::new(), false, true, true);
        assert!(phrase_matches_ex("Foo", &case_re));
        assert!(!phrase_matches_ex("foo", &case_re));

        let ignore_re = PhraseRule::from_row("[a-z]+".into(), false, String::new(), String::new(), false, true, false);
        assert!(phrase_matches_ex("FOO", &ignore_re));

        let first = PhraseRule::from_row("alpha".into(), true, "#11111111".into(), String::new(), false, false, false);
        let second = PhraseRule::from_row("beta".into(), false, "#22222222".into(), String::new(), false, false, false);
        let mut multi = privmsg("x", "alpha and beta");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![first, second],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut multi,
            Some("me"),
        );
        match multi {
            ChatEvent::Privmsg {
                highlight_color,
                highlight_sound,
                ..
            } => {
                assert_eq!(highlight_color.as_deref(), Some("#11111111"));
                assert!(highlight_sound);
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn refresh_highlight_sound_compiles_once_into_shared() {
        use super::super::settings::{AppSettings, HighlightMessageRow};
        use super::super::state::Shared;

        let shared = Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner.data = AppSettings {
                highlight_messages: vec![HighlightMessageRow {
                    pattern: r"\bcache\b".into(),
                    show_in_mentions: false,
                    flash_taskbar: false,
                    play_sound: true,
                    custom_sound: String::new(),
                    regex: true,
                    case_sensitive: false,
                    color: "#AABBCCDD".into(),
                }],
                ..AppSettings::default()
            };
        }
        refresh_highlight_sound(&shared);
        let ctx = shared.highlight_sound.lock().unwrap().clone();
        assert_eq!(ctx.phrase_rules.len(), 1);
        assert!(ctx.phrase_rules[0].compiled.is_some());
        assert!(phrase_matches_ex("has cache here", &ctx.phrase_rules[0]));
        assert!(!phrase_matches_ex("cached", &ctx.phrase_rules[0]));
    }

    fn usernotice(login: &str, system: &str) -> ChatEvent {
        ChatEvent::Usernotice {
            id: "u".into(),
            timestamp_ms: 1,
            system_text: system.into(),
            login: Some(login.into()),
            msg_id: None,
            privmsg: None,
            highlight_color: None,
        highlight_sound: false,
        highlight_sound_path: None,
        highlight_flash: false,
        }
    }

    #[test]
    fn usernotice_without_body_highlights_login() {
        let filters = Filters {
            highlight_logins: vec!["ann".into()],
            enable_self_highlight: false,
            ..Filters::default()
        };
        let mut ev = usernotice("ann", "ann subscribed");
        apply_highlight(&filters, &HighlightSoundCtx::default(), &HighlightKindsCtx::default(), &[], &mut ev, Some("me"));
        match ev {
            ChatEvent::Usernotice { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
            }
            _ => panic!("usernotice"),
        }
    }

    #[test]
    fn first_msg_and_redeemed_when_no_phrase() {
        let filters = Filters {
            enable_self_highlight: false,
            ..Filters::default()
        };
        let kinds = HighlightKindsCtx::default();
        let mut first = privmsg("ann", "hello");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut first {
            *first_msg = true;
        }
        apply_highlight(&filters, &HighlightSoundCtx::default(), &kinds, &[], &mut first, Some("me"));
        match &first {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(FIRST_MSG_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut redeem = privmsg("ann", "hello");
        if let ChatEvent::Privmsg { custom_reward_id, .. } = &mut redeem {
            *custom_reward_id = Some("abc".into());
        }
        apply_highlight(&filters, &HighlightSoundCtx::default(), &kinds, &[], &mut redeem, Some("me"));
        match &redeem {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(REDEEMED_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut highlighted = privmsg("ann", "hello");
        if let ChatEvent::Privmsg { system_msg_id, .. } = &mut highlighted {
            *system_msg_id = Some("highlighted-message".into());
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &kinds,
            &[],
            &mut highlighted,
            Some("me"),
        );
        match &highlighted {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(REDEEMED_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut both = privmsg("ann", "hello");
        if let ChatEvent::Privmsg {
            first_msg,
            custom_reward_id,
            ..
        } = &mut both
        {
            *first_msg = true;
            *custom_reward_id = Some("abc".into());
        }
        apply_highlight(&filters, &HighlightSoundCtx::default(), &kinds, &[], &mut both, Some("me"));
        match &both {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(REDEEMED_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut powerup = privmsg("ann", "hello");
        if let ChatEvent::Privmsg { system_msg_id, .. } = &mut powerup {
            *system_msg_id = Some("animated-message".into());
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &kinds,
            &[],
            &mut powerup,
            Some("me"),
        );
        match &powerup {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(REDEEMED_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn phrase_wins_over_first_msg() {
        let filters = Filters {
            highlight_phrases: vec!["hello".into()],
            enable_self_highlight: false,
            ..Filters::default()
        };
        let mut ev = privmsg("ann", "hello");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut ev {
            *first_msg = true;
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &HighlightKindsCtx::default(),
            &[],
            &mut ev,
            Some("me"),
        );
        match ev {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn sub_usernotice_overwrites_phrase() {
        let filters = Filters {
            highlight_phrases: vec!["subscribed".into()],
            enable_self_highlight: false,
            ..Filters::default()
        };
        let mut ev = usernotice("ann", "ann subscribed");
        if let ChatEvent::Usernotice { msg_id, .. } = &mut ev {
            *msg_id = Some("resub".into());
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &HighlightKindsCtx::default(),
            &[],
            &mut ev,
            Some("me"),
        );
        match ev {
            ChatEvent::Usernotice { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SUB_HIGHLIGHT_COLOR));
            }
            _ => panic!("usernotice"),
        }
    }

    #[test]
    fn irc_kinds_respect_knobs_off() {
        let filters = Filters {
            enable_self_highlight: false,
            ..Filters::default()
        };
        let off = HighlightKindsCtx {
            enable_sub: false,
            enable_first: false,
            enable_redeemed: false,
            ..HighlightKindsCtx::default()
        };
        let mut first = privmsg("ann", "hi");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut first {
            *first_msg = true;
        }
        apply_highlight(&filters, &HighlightSoundCtx::default(), &off, &[], &mut first, Some("me"));
        match first {
            ChatEvent::Privmsg { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("privmsg"),
        }
        let mut sub = usernotice("ann", "ann subscribed");
        if let ChatEvent::Usernotice { msg_id, .. } = &mut sub {
            *msg_id = Some("sub".into());
        }
        apply_highlight(&filters, &HighlightSoundCtx::default(), &off, &[], &mut sub, Some("me"));
        match sub {
            ChatEvent::Usernotice { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("usernotice"),
        }
    }

    #[test]
    fn irc_kind_custom_colors() {
        let filters = Filters {
            enable_self_highlight: false,
            ..Filters::default()
        };
        let kinds = HighlightKindsCtx {
            first_color: "#11111122".into(),
            redeemed_color: "#33333344".into(),
            sub_color: "#55555566".into(),
            ..HighlightKindsCtx::default()
        };
        let mut first = privmsg("ann", "hi");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut first {
            *first_msg = true;
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &kinds,
            &[],
            &mut first,
            Some("me"),
        );
        match first {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#11111122"));
            }
            _ => panic!("privmsg"),
        }
        let mut redeem = privmsg("ann", "hi");
        if let ChatEvent::Privmsg { custom_reward_id, .. } = &mut redeem {
            *custom_reward_id = Some("r1".into());
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &kinds,
            &[],
            &mut redeem,
            Some("me"),
        );
        match redeem {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#33333344"));
            }
            _ => panic!("privmsg"),
        }
        let mut sub = usernotice("ann", "ann subscribed");
        if let ChatEvent::Usernotice { msg_id, .. } = &mut sub {
            *msg_id = Some("sub".into());
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &kinds,
            &[],
            &mut sub,
            Some("me"),
        );
        match sub {
            ChatEvent::Usernotice { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#55555566"));
            }
            _ => panic!("usernotice"),
        }
        let bad = HighlightKindsCtx {
            first_color: "#xyz".into(),
            ..HighlightKindsCtx::default()
        };
        let mut first_bad = privmsg("ann", "hi");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut first_bad {
            *first_msg = true;
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &bad,
            &[],
            &mut first_bad,
            Some("me"),
        );
        match first_bad {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(FIRST_MSG_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn resolve_highlight_color_rules() {
        assert_eq!(resolve_highlight_color(""), SELF_HIGHLIGHT_COLOR);
        assert_eq!(resolve_highlight_color("  "), SELF_HIGHLIGHT_COLOR);
        assert_eq!(resolve_highlight_color("#xyz"), SELF_HIGHLIGHT_COLOR);
        assert_eq!(resolve_highlight_color("#abc"), SELF_HIGHLIGHT_COLOR);
        assert_eq!(resolve_highlight_color("#aabbcc"), "#aabbcc");
        assert_eq!(resolve_highlight_color("#AABBCC80"), "#AABBCC80");
        assert_eq!(resolve_highlight_color("ff00aa"), "#ff00aa");
    }

    #[test]
    fn phrase_and_user_custom_colors() {
        let filters = Filters {
            highlight_phrases: vec!["pog".into()],
            highlight_logins: vec!["streamer".into()],
            enable_self_highlight: false,
            ..Filters::default()
        };
        let sound = HighlightSoundCtx {
            phrase_rules: vec![PhraseRule::plain("pog", true, "#11223344")],
            user_sound: vec![("streamer".into(), true, "#AABBCC".into(), String::new(), false)],
            ..HighlightSoundCtx::default()
        };
        let mut by_phrase = privmsg("x", "that was pog");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_phrase,
            Some("me"),
        );
        match by_phrase {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#11223344"));
            }
            _ => panic!("privmsg"),
        }
        let mut by_user = privmsg("streamer", "hey");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_user,
            Some("me"),
        );
        match by_user {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#AABBCC"));
            }
            _ => panic!("privmsg"),
        }
        let mut empty_color = privmsg("x", "that was pog");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![PhraseRule::plain("pog", true, "")],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut empty_color,
            Some("me"),
        );
        match empty_color {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut bad = privmsg("x", "that was pog");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![PhraseRule::plain("pog", true, "#xyz")],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut bad,
            Some("me"),
        );
        match bad {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn self_nick_uses_knob_color() {
        let filters = Filters {
            enable_self_highlight: true,
            ..Filters::default()
        };
        let mut ev = privmsg("ann", "hey mike");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                self_highlight_color: "#DEADBE".into(),
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut ev,
            Some("mike"),
        );
        match ev {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#DEADBE"));
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn badge_highlight_match_and_priority() {
        let filters = Filters {
            enable_self_highlight: false,
            highlight_phrases: vec!["hello".into()],
            ..Filters::default()
        };
        let sound = HighlightSoundCtx {
            badge_rows: vec![
                ("moderator".into(), true, "#AABBCCDD".into(), String::new(), false),
                ("subscriber/12".into(), false, String::new(), String::new(), false),
            ],
            phrase_rules: vec![PhraseRule::plain("hello", false, "#01020304")],
            ..HighlightSoundCtx::default()
        };
        let mut by_set = with_badges(privmsg("ann", "hi"), vec![badge("moderator", "1")]);
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_set,
            Some("me"),
        );
        match by_set {
            ChatEvent::Privmsg {
                highlight_color,
                highlight_sound,
                ..
            } => {
                assert_eq!(highlight_color.as_deref(), Some("#AABBCCDD"));
                assert!(highlight_sound);
            }
            _ => panic!("privmsg"),
        }
        let mut by_ver = with_badges(privmsg("ann", "hi"), vec![badge("subscriber", "12")]);
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut by_ver,
            Some("me"),
        );
        match by_ver {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(BADGE_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut wrong_ver = with_badges(privmsg("ann", "hi"), vec![badge("subscriber", "1")]);
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut wrong_ver,
            Some("me"),
        );
        match wrong_ver {
            ChatEvent::Privmsg { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("privmsg"),
        }
        let mut phrase_wins =
            with_badges(privmsg("ann", "hello there"), vec![badge("moderator", "1")]);
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut phrase_wins,
            Some("me"),
        );
        match phrase_wins {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#01020304"));
            }
            _ => panic!("privmsg"),
        }
        let mut first = with_badges(privmsg("ann", "hi"), vec![badge("moderator", "1")]);
        if let ChatEvent::Privmsg { first_msg, .. } = &mut first {
            *first_msg = true;
        }
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[],
            &mut first,
            Some("me"),
        );
        match first {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#AABBCCDD"));
            }
            _ => panic!("privmsg"),
        }
        assert!(badge_matches("vip,moderator", &[badge("moderator", "1")]));
        assert!(!badge_matches("", &[badge("moderator", "1")]));
    }

    #[test]
    fn self_message_highlight_when_enabled() {
        let filters = Filters {
            highlight_phrases: vec!["hello".into()],
            enable_self_highlight: true,
            ..Filters::default()
        };
        let mut off = privmsg("mike", "hello world");
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &HighlightKindsCtx::default(),
            &[],
            &mut off,
            Some("mike"),
        );
        match off {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert!(highlight_color.is_none(), "own msg not phrase-highlighted");
            }
            _ => panic!("privmsg"),
        }
        let mut on = privmsg("mike", "hello world");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                enable_self_message: true,
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut on,
            Some("mike"),
        );
        match on {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(
                    highlight_color.as_deref(),
                    Some(SELF_MESSAGE_HIGHLIGHT_COLOR)
                );
            }
            _ => panic!("privmsg"),
        }
        let mut custom = privmsg("mike", "hi");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                enable_self_message: true,
                self_message_color: "#11223344".into(),
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut custom,
            Some("mike"),
        );
        match custom {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#11223344"));
            }
            _ => panic!("privmsg"),
        }
        let mut other = privmsg("ann", "hey");
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                enable_self_message: true,
                user_sound: vec![("ann".into(), false, "#AABBCC".into(), String::new(), false)],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut other,
            Some("mike"),
        );
        match other {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#AABBCC"));
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn phrase_custom_color_still_wins_over_first_msg() {
        let filters = Filters {
            highlight_phrases: vec!["hello".into()],
            enable_self_highlight: false,
            ..Filters::default()
        };
        let mut ev = privmsg("ann", "hello");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut ev {
            *first_msg = true;
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx {
                phrase_rules: vec![PhraseRule::plain("hello", false, "#01020304")],
                ..HighlightSoundCtx::default()
            },
            &HighlightKindsCtx::default(),
            &[],
            &mut ev,
            Some("me"),
        );
        match ev {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#01020304"));
            }
            _ => panic!("privmsg"),
        }
    }

    #[test]
    fn load_corrupt_json_falls_back() {
        let path = std::env::temp_dir().join(format!(
            "chatterino-rt-filters-test-{}.json",
            std::process::id()
        ));
        fs::write(&path, "{not json").expect("write");
        let data = load_file(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(data, Filters::default());
    }

    #[test]
    fn drop_does_not_increment_pending() {
        use super::super::pending::Pending;
        let filters = Filters {
            ignore_logins: vec!["spam".into()],
            ..Filters::default()
        };
        let ev = privmsg("spam", "hi");
        assert!(should_drop(&filters, &[], &[], &ev, Some("me")));
        let mut pending = Pending::new("xqc");
        assert_eq!(pending.seq(), 0);
        assert!(pending.take_batch().is_none());
    }

    #[test]
    fn ignore_messages_block_regex_and_case() {
        let filters = Filters::default();
        let case_row = PhraseRule::from_row("Spam".into(), false, String::new(), String::new(), false, false, true);
        assert!(should_drop(
            &filters,
            &[],
            &[case_row.clone()],
            &privmsg("x", "buy Spam now"),
            Some("me")
        ));
        assert!(!should_drop(
            &filters,
            &[],
            &[case_row],
            &privmsg("x", "buy spam now"),
            Some("me")
        ));

        let re = PhraseRule::from_row(r"\bspam\b".into(), false, String::new(), String::new(), false, true, false);
        assert!(should_drop(
            &filters,
            &[],
            &[re.clone()],
            &privmsg("x", "no Spam here"),
            Some("me")
        ));
        assert!(!should_drop(
            &filters,
            &[],
            &[re],
            &privmsg("x", "spammer alert"),
            Some("me")
        ));

        let invalid = PhraseRule::from_row("(".into(), false, String::new(), String::new(), false, true, false);
        assert!(invalid.compiled.is_none());
        assert!(!should_drop(
            &filters,
            &[],
            &[invalid],
            &privmsg("x", "("),
            Some("me")
        ));

        let no_block = ignore_block_rules_from_settings(&super::super::settings::AppSettings {
            ignore_messages: vec![super::super::settings::IgnoreMessageRow {
                pattern: "spam".into(),
                regex: false,
                case_sensitive: false,
                block: false,
                replacement: "***".into(),
            }],
            ..super::super::settings::AppSettings::default()
        });
        assert!(no_block.is_empty());
        assert!(!should_drop(
            &filters,
            &[],
            &no_block,
            &privmsg("x", "spam"),
            Some("me")
        ));

        assert!(!should_drop(
            &filters,
            &[],
            &[PhraseRule::plain("spam", false, "")],
            &privmsg("me", "spam"),
            Some("me")
        ));

        let shared = super::super::state::Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner.data.ignore_messages = vec![super::super::settings::IgnoreMessageRow {
                pattern: r"\bcache\b".into(),
                regex: true,
                case_sensitive: false,
                block: true,
                replacement: String::new(),
            }];
        }
        refresh_ignore_block_rules(&shared);
        let rules = shared.ignore_block_rules.lock().unwrap().clone();
        assert_eq!(rules.len(), 1);
        assert!(rules[0].compiled.is_some());
        assert!(should_drop(
            &filters,
            &[],
            &rules,
            &privmsg("x", "has cache here"),
            Some("me")
        ));
        assert!(!should_drop(
            &filters,
            &[],
            &rules,
            &privmsg("x", "cached"),
            Some("me")
        ));
    }

    #[test]
    fn ignore_messages_replacement_literal_regex_and_spans() {
        let mut ev = privmsg("bob", "buy Spam now");
        apply_ignore_replacements(
            &mut ev,
            &[ReplaceRule::from_row(
                "Spam".into(),
                "***".into(),
                false,
                true,
            )],
        );
        match &ev {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "buy *** now"),
            _ => panic!("expected privmsg"),
        }

        let mut miss = privmsg("bob", "buy spam now");
        apply_ignore_replacements(
            &mut miss,
            &[ReplaceRule::from_row(
                "Spam".into(),
                "***".into(),
                false,
                true,
            )],
        );
        match &miss {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "buy spam now"),
            _ => panic!("expected privmsg"),
        }

        let mut re_ev = privmsg("bob", "code abc123 end");
        apply_ignore_replacements(
            &mut re_ev,
            &[ReplaceRule::from_row(
                r"([a-z]+)(\d+)".into(),
                "$2:$1".into(),
                true,
                false,
            )],
        );
        match &re_ev {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "code 123:abc end"),
            _ => panic!("expected privmsg"),
        }

        let mut stock_ref = privmsg("bob", "code abc123 end");
        apply_ignore_replacements(
            &mut stock_ref,
            &[ReplaceRule::from_row(
                r"([a-z]+)(\d+)".into(),
                r"\2:\1".into(),
                true,
                false,
            )],
        );
        match &stock_ref {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "code 123:abc end"),
            _ => panic!("expected privmsg"),
        }

        let mut dollar_lit = privmsg("bob", "cost 10");
        apply_ignore_replacements(
            &mut dollar_lit,
            &[ReplaceRule::from_row(
                r"(\d+)".into(),
                "price $5".into(),
                true,
                false,
            )],
        );
        match &dollar_lit {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "cost price $5"),
            _ => panic!("expected privmsg"),
        }

        let invalid = ReplaceRule::from_row("(".into(), "x".into(), true, false);
        assert!(invalid.compiled.is_none());
        let mut inv = privmsg("bob", "hello (");
        apply_ignore_replacements(&mut inv, &[invalid]);
        match &inv {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "hello ("),
            _ => panic!("expected privmsg"),
        }

        // Block rows are not loaded as replace rules.
        let only_block = ignore_replace_rules_from_settings(&super::super::settings::AppSettings {
            ignore_messages: vec![super::super::settings::IgnoreMessageRow {
                pattern: "spam".into(),
                regex: false,
                case_sensitive: false,
                block: true,
                replacement: "***".into(),
            }],
            ..super::super::settings::AppSettings::default()
        });
        assert!(only_block.is_empty());

        let mut empty_repl = privmsg("bob", "drop this word");
        apply_ignore_replacements(
            &mut empty_repl,
            &[ReplaceRule::from_row(
                "this ".into(),
                String::new(),
                false,
                false,
            )],
        );
        match &empty_repl {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "drop word"),
            _ => panic!("expected privmsg"),
        }

        // Self messages are still replaced (stock applies to all).
        let mut self_ev = privmsg("me", "hide spam please");
        apply_ignore_replacements(
            &mut self_ev,
            &[ReplaceRule::from_row(
                "spam".into(),
                "###".into(),
                false,
                false,
            )],
        );
        match &self_ev {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "hide ### please"),
            _ => panic!("expected privmsg"),
        }

        // Emote after replaced prefix shifts; overlapping emote is dropped.
        let mut with_emote = privmsg("bob", "hello Kappa world");
        if let ChatEvent::Privmsg { emote_spans, .. } = &mut with_emote {
            emote_spans.push(EmoteSpan {
                start: 6,
                end: 11,
                emote_id: "25".into(),
                provider: "twitch".into(),
                url: String::new(),
                zero_width: false,
            });
        }
        apply_ignore_replacements(
            &mut with_emote,
            &[ReplaceRule::from_row(
                "hello".into(),
                "hi".into(),
                false,
                false,
            )],
        );
        match &with_emote {
            ChatEvent::Privmsg {
                text, emote_spans, ..
            } => {
                assert_eq!(text, "hi Kappa world");
                assert_eq!(emote_spans.len(), 1);
                assert_eq!(emote_spans[0].start, 3);
                assert_eq!(emote_spans[0].end, 8);
            }
            _ => panic!("expected privmsg"),
        }

        let mut drop_emote = privmsg("bob", "say Kappa please");
        if let ChatEvent::Privmsg { emote_spans, .. } = &mut drop_emote {
            emote_spans.push(EmoteSpan {
                start: 4,
                end: 9,
                emote_id: "25".into(),
                provider: "twitch".into(),
                url: String::new(),
                zero_width: false,
            });
        }
        apply_ignore_replacements(
            &mut drop_emote,
            &[ReplaceRule::from_row(
                "Kappa".into(),
                "X".into(),
                false,
                true,
            )],
        );
        match &drop_emote {
            ChatEvent::Privmsg {
                text, emote_spans, ..
            } => {
                assert_eq!(text, "say X please");
                assert!(emote_spans.is_empty());
            }
            _ => panic!("expected privmsg"),
        }

        let mut many = privmsg("bob", &"x".repeat(130));
        apply_ignore_replacements(
            &mut many,
            &[ReplaceRule::from_row("x".into(), "y".into(), false, false)],
        );
        match &many {
            ChatEvent::Privmsg { text, .. } => {
                assert_eq!(text, TOO_MANY_REPLACEMENTS);
            }
            _ => panic!("expected privmsg"),
        }

        let shared = super::super::state::Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner.data.ignore_messages = vec![super::super::settings::IgnoreMessageRow {
                pattern: "secret".into(),
                regex: false,
                case_sensitive: false,
                block: false,
                replacement: "[redacted]".into(),
            }];
        }
        refresh_ignore_replace_rules(&shared);
        let rules = shared.ignore_replace_rules.lock().unwrap().clone();
        assert_eq!(rules.len(), 1);
        let mut cached = privmsg("bob", "has secret data");
        apply_ignore_replacements(&mut cached, &rules);
        match &cached {
            ChatEvent::Privmsg { text, .. } => assert_eq!(text, "has [redacted] data"),
            _ => panic!("expected privmsg"),
        }
    }

    #[test]
    fn ignore_users_drop_login_match() {
        let filters = Filters::default();
        let exact = BlacklistRule::from_row("ann".into(), false);
        assert!(should_drop(
            &filters,
            &[exact.clone()],
            &[],
            &privmsg("ann", "hello"),
            Some("me")
        ));
        assert!(should_drop(
            &filters,
            &[exact.clone()],
            &[],
            &privmsg("ANN", "hello"),
            Some("me")
        ));
        assert!(!should_drop(
            &filters,
            &[exact],
            &[],
            &privmsg("ann", "hello"),
            Some("ann")
        ));
        // Match is by login only, not message body.
        assert!(!should_drop(
            &filters,
            &[BlacklistRule::from_row("ann".into(), false)],
            &[],
            &privmsg("bob", "please ask ann later"),
            Some("me")
        ));

        let re = BlacklistRule::from_row(r"^bot_.*".into(), true);
        assert!(re.compiled.is_some());
        assert!(should_drop(
            &filters,
            &[re],
            &[],
            &privmsg("bot_spam", "hi"),
            Some("me")
        ));

        let invalid = BlacklistRule::from_row("(".into(), true);
        assert!(invalid.compiled.is_none());
        assert!(!should_drop(
            &filters,
            &[invalid],
            &[],
            &privmsg("ann", "hi"),
            Some("me")
        ));

        let empty = ignore_user_rules_from_settings(&super::super::settings::AppSettings {
            ignore_users: vec![super::super::settings::HighlightBlacklistRow {
                username: "  ".into(),
                regex: false,
            }],
            ..super::super::settings::AppSettings::default()
        });
        assert!(empty.is_empty());

        let shared = super::super::state::Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner.data.ignore_users = vec![super::super::settings::HighlightBlacklistRow {
                username: "nightbot".into(),
                regex: false,
            }];
        }
        refresh_ignore_user_rules(&shared);
        let rules = shared.ignore_user_rules.lock().unwrap().clone();
        assert_eq!(rules.len(), 1);
        assert!(login_is_blacklisted("NightBot", &rules));
        assert!(!login_is_blacklisted("bob", &rules));
        assert!(should_drop(
            &filters,
            &rules,
            &[],
            &privmsg("nightbot", "cmd"),
            Some("me")
        ));
    }

    #[test]
    fn highlight_blacklist_skips_color_and_sound() {
        let filters = Filters {
            enable_self_highlight: false,
            highlight_phrases: vec!["hello".into()],
            highlight_logins: vec!["streamer".into()],
            ..Filters::default()
        };
        let sound = HighlightSoundCtx {
            phrase_rules: vec![PhraseRule::plain("hello", true, "#11223344")],
            user_sound: vec![("streamer".into(), true, "#AABBCC".into(), String::new(), false)],
            ..HighlightSoundCtx::default()
        };
        let exact = BlacklistRule::from_row("ann".into(), false);
        let mut skipped = privmsg("ann", "hello there");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[exact.clone()],
            &mut skipped,
            Some("me"),
        );
        match skipped {
            ChatEvent::Privmsg {
                highlight_color,
                highlight_sound,
                ..
            } => {
                assert!(highlight_color.is_none());
                assert!(!highlight_sound);
            }
            _ => panic!("privmsg"),
        }
        let mut case_insensitive = privmsg("ANN", "hello there");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[exact],
            &mut case_insensitive,
            Some("me"),
        );
        match case_insensitive {
            ChatEvent::Privmsg { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("privmsg"),
        }

        let re = BlacklistRule::from_row(r"^bot_.*".into(), true);
        assert!(re.compiled.is_some());
        let mut bot = privmsg("bot_spam", "hello");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[re],
            &mut bot,
            Some("me"),
        );
        match bot {
            ChatEvent::Privmsg { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("privmsg"),
        }

        let invalid = BlacklistRule::from_row("(".into(), true);
        assert!(invalid.compiled.is_none());
        let mut still_hl = privmsg("ann", "hello");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[invalid],
            &mut still_hl,
            Some("me"),
        );
        match still_hl {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some("#11223344"));
            }
            _ => panic!("privmsg"),
        }

        let empty = blacklist_rules_from_settings(&super::super::settings::AppSettings {
            highlight_blacklist: vec![super::super::settings::HighlightBlacklistRow {
                username: "  ".into(),
                regex: false,
            }],
            ..super::super::settings::AppSettings::default()
        });
        assert!(empty.is_empty());

        let mut other = privmsg("bob", "hello");
        apply_highlight(
            &filters,
            &sound,
            &HighlightKindsCtx::default(),
            &[BlacklistRule::from_row("ann".into(), false)],
            &mut other,
            Some("me"),
        );
        match other {
            ChatEvent::Privmsg {
                highlight_color,
                highlight_sound,
                ..
            } => {
                assert_eq!(highlight_color.as_deref(), Some("#11223344"));
                assert!(highlight_sound);
            }
            _ => panic!("privmsg"),
        }

        let mut first = privmsg("ann", "hi");
        if let ChatEvent::Privmsg { first_msg, .. } = &mut first {
            *first_msg = true;
        }
        apply_highlight(
            &filters,
            &HighlightSoundCtx::default(),
            &HighlightKindsCtx::default(),
            &[BlacklistRule::from_row("ann".into(), false)],
            &mut first,
            Some("me"),
        );
        match first {
            ChatEvent::Privmsg { highlight_color, .. } => assert!(highlight_color.is_none()),
            _ => panic!("privmsg"),
        }

        let shared = super::super::state::Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner.data.highlight_blacklist =
                vec![super::super::settings::HighlightBlacklistRow {
                    username: "nightbot".into(),
                    regex: false,
                }];
        }
        refresh_highlight_blacklist(&shared);
        let rules = shared.highlight_blacklist.lock().unwrap().clone();
        assert_eq!(rules.len(), 1);
        assert!(login_is_blacklisted("NightBot", &rules));
        assert!(!login_is_blacklisted("bob", &rules));
    }
}
