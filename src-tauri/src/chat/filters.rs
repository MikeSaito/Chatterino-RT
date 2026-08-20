// SPDX-FileCopyrightText: 2018 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of ignore phrases and highlight matching from Chatterino
// src/controllers/ignores and src/controllers/highlights. Not a copy of C++/Qt source.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::auth;
use super::state::Shared;
use super::types::ChatEvent;

const FILTERS_FILE: &str = "filters.json";
const MAX_LIST: usize = 200;
const MAX_PATTERN: usize = 200;
const MAX_FILE_BYTES: usize = 256 * 1024;
pub const SELF_HIGHLIGHT_COLOR: &str = "#7f3f4980";

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
    let Ok(inner) = shared.filters.lock() else {
        return false;
    };
    if should_drop(&inner.data, event, self_login.as_deref()) {
        return true;
    }
    apply_highlight(&inner.data, event, self_login.as_deref());
    false
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

pub(crate) fn should_drop(filters: &Filters, event: &ChatEvent, self_login: Option<&str>) -> bool {
    let login = event_login(event);
    if let Some(login) = login {
        if is_self(login, self_login) {
            return false;
        }
        if filters.ignore_logins.iter().any(|item| item.eq_ignore_ascii_case(login)) {
            return true;
        }
    }
    let hay = event_hay(event);
    if !hay.is_empty() && filters.ignore_phrases.iter().any(|p| phrase_matches(&hay, p)) {
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

pub(crate) fn apply_highlight(filters: &Filters, event: &mut ChatEvent, self_login: Option<&str>) {
    match event {
        ChatEvent::Privmsg {
            login,
            text,
            highlight_color,
            ..
        } => {
            *highlight_color = highlight_color_for(filters, login, text, self_login);
        }
        ChatEvent::Usernotice {
            login,
            system_text,
            privmsg,
            highlight_color,
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
            let body = match privmsg.as_deref() {
                Some(ChatEvent::Privmsg { text, .. }) => text.as_str(),
                _ => "",
            };
            let hay = if system_text.is_empty() {
                body.to_string()
            } else if body.is_empty() {
                system_text.clone()
            } else {
                format!("{system_text} {body}")
            };
            let color = highlight_color_for(filters, &sender, &hay, self_login);
            *highlight_color = color.clone();
            if let Some(inner) = privmsg.as_mut() {
                if let ChatEvent::Privmsg {
                    highlight_color: inner_color,
                    ..
                } = inner.as_mut()
                {
                    *inner_color = color;
                }
            }
        }
        _ => {}
    }
}

fn highlight_color_for(
    filters: &Filters,
    login: &str,
    text: &str,
    self_login: Option<&str>,
) -> Option<String> {
    let self_msg = is_self(login, self_login);
    if !self_msg {
        if filters.enable_self_highlight {
            if let Some(me) = self_login {
                if phrase_matches(text, me) {
                    return Some(SELF_HIGHLIGHT_COLOR.to_string());
                }
            }
        }
        for phrase in &filters.highlight_phrases {
            if phrase_matches(text, phrase) {
                return Some(SELF_HIGHLIGHT_COLOR.to_string());
            }
        }
    }
    if filters.highlight_logins.iter().any(|item| item.eq_ignore_ascii_case(login)) {
        return Some(SELF_HIGHLIGHT_COLOR.to_string());
    }
    None
}

pub(crate) fn phrase_matches(text: &str, pattern: &str) -> bool {
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
        if !eq_ignore_case(&hay[i..i + needle.len()], &needle) {
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
            reply_to_text: None,
            action: false,
            highlight_color: None,
        }
    }

    #[test]
    fn drops_ignored_login_but_not_self() {
        let filters = Filters {
            ignore_logins: vec!["spam".into()],
            ..Filters::default()
        };
        assert!(should_drop(&filters, &privmsg("spam", "hi"), Some("me")));
        assert!(should_drop(&filters, &privmsg("SPAM", "hi"), Some("me")));
        assert!(!should_drop(&filters, &privmsg("spam", "hi"), Some("spam")));
        assert!(!should_drop(&filters, &privmsg("ok", "hi"), Some("me")));
    }

    #[test]
    fn drops_ignored_phrase_except_self() {
        let filters = Filters {
            ignore_phrases: vec!["buy followers".into()],
            ..Filters::default()
        };
        assert!(should_drop(
            &filters,
            &privmsg("x", "please buy followers now"),
            Some("me")
        ));
        assert!(!should_drop(
            &filters,
            &privmsg("me", "please buy followers now"),
            Some("me")
        ));
        assert!(!should_drop(&filters, &privmsg("x", "buyfollowers"), Some("me")));
    }

    #[test]
    fn self_nick_highlights_other_messages() {
        let filters = Filters::default();
        let mut ev = privmsg("xqc", "hello Mike there");
        apply_highlight(&filters, &mut ev, Some("mike"));
        match ev {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut self_ev = privmsg("mike", "hello Mike there");
        apply_highlight(&filters, &mut self_ev, Some("mike"));
        match self_ev {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert!(highlight_color.is_none());
            }
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
        apply_highlight(&filters, &mut by_user, Some("me"));
        match by_user {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
            }
            _ => panic!("privmsg"),
        }
        let mut by_phrase = privmsg("x", "that was pog");
        apply_highlight(&filters, &mut by_phrase, Some("me"));
        match by_phrase {
            ChatEvent::Privmsg { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
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

    fn usernotice(login: &str, system: &str) -> ChatEvent {
        ChatEvent::Usernotice {
            id: "u".into(),
            timestamp_ms: 1,
            system_text: system.into(),
            login: Some(login.into()),
            privmsg: None,
            highlight_color: None,
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
        apply_highlight(&filters, &mut ev, Some("me"));
        match ev {
            ChatEvent::Usernotice { highlight_color, .. } => {
                assert_eq!(highlight_color.as_deref(), Some(SELF_HIGHLIGHT_COLOR));
            }
            _ => panic!("usernotice"),
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
        assert!(should_drop(&filters, &ev, Some("me")));
        let mut pending = Pending::new("xqc");
        assert_eq!(pending.seq(), 0);
        assert!(pending.take_batch().is_none());
    }
}
