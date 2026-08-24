//! Local R9K / message similarity (stock Chatterino MessageSimilarity).
//! Logic reimplemented under MIT; not a copy of C++/Qt sources.
//!
//! Delay uses wall-clock ingest time (stock `parseTime` vs `QTime::currentTime()`),
//! not IRC `tmi-sent-ts`. LCS is over UTF-16 code units like `QStringView`.

use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::state::Shared;
use super::types::ChatEvent;

/// Cap of remembered samples (stock dropdown max is 5; headroom for interleaved notices).
const RECENT_CAP: usize = 16;

#[derive(Debug, Clone, Copy)]
pub struct SimilarityCfg {
    pub enabled: bool,
    pub same_user: bool,
    pub hide_myself: bool,
    pub percentage: f32,
    pub max_delay_sec: u64,
    pub max_check: usize,
    pub shown_trigger_highlights: bool,
}

impl Default for SimilarityCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            same_user: true,
            hide_myself: false,
            percentage: 0.9,
            max_delay_sec: 5,
            max_check: 3,
            shown_trigger_highlights: false,
        }
    }
}

#[derive(Debug, Clone)]
struct SimEntry {
    login: String,
    text: String,
    at: Instant,
}

/// Per-channel recent texts with ingest Instant (stock parseTime).
#[derive(Debug, Default)]
pub struct SimilarityRecent {
    entries: VecDeque<SimEntry>,
}

impl SimilarityRecent {
    pub fn remember(&mut self, event: &ChatEvent) {
        let Some((login, text)) = sample_text(event) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        if self.entries.len() == RECENT_CAP {
            self.entries.pop_front();
        }
        self.entries.push_back(SimEntry {
            login,
            text,
            at: Instant::now(),
        });
    }

    #[cfg(test)]
    fn push_aged(&mut self, login: &str, text: &str, age: Duration) {
        let at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        if self.entries.len() == RECENT_CAP {
            self.entries.pop_front();
        }
        self.entries.push_back(SimEntry {
            login: login.into(),
            text: text.into(),
            at,
        });
    }
}

pub fn cfg_from_shared(shared: &Shared) -> SimilarityCfg {
    match shared.settings.lock() {
        Ok(inner) => cfg_from_knobs(&inner.data.knobs),
        Err(_) => SimilarityCfg::default(),
    }
}

pub fn cfg_from_knobs(knobs: &BTreeMap<String, Value>) -> SimilarityCfg {
    let mut cfg = SimilarityCfg::default();
    cfg.enabled = knob_bool(knobs, "similarity.similarityEnabled", false);
    cfg.same_user = knob_bool(knobs, "similarity.hideSimilarBySameUser", true);
    cfg.hide_myself = knob_bool(knobs, "similarity.hideSimilarMyself", false);
    cfg.shown_trigger_highlights =
        knob_bool(knobs, "similarity.shownSimilarTriggerHighlights", false);
    cfg.percentage = knob_f32(knobs, "similarity.similarityPercentage", 0.9).clamp(0.0, 1.0);
    cfg.max_delay_sec = knob_u64(knobs, "similarity.hideSimilarMaxDelay", 5);
    cfg.max_check = knob_usize(knobs, "similarity.hideSimilarMaxMessagesToCheck", 3).max(1);
    cfg
}

/// Longest common substring length / max(len1, len2). Stock `relativeSimilarity` (UTF-16).
pub fn relative_similarity(a: &str, b: &str) -> f32 {
    let s1: Vec<u16> = a.encode_utf16().collect();
    let s2: Vec<u16> = b.encode_utf16().collect();
    if s1.is_empty() || s2.is_empty() {
        return 0.0;
    }
    let mut prev = vec![0usize; s2.len()];
    let mut cur = vec![0usize; s2.len()];
    let mut best = 0usize;
    for (i, &c1) in s1.iter().enumerate() {
        for (j, &c2) in s2.iter().enumerate() {
            if c1 == c2 {
                let diag = if i == 0 || j == 0 { 0 } else { prev[j - 1] };
                cur[j] = diag + 1;
                best = best.max(cur[j]);
            } else {
                cur[j] = 0;
            }
        }
        std::mem::swap(&mut prev, &mut cur);
        cur.fill(0);
    }
    if best == 0 {
        return 0.0;
    }
    let denom = s1.len().max(s2.len()).max(1) as f32;
    best as f32 / denom
}

/// Mark PRIVMSG / USERNOTICE body as disabled when similar (stock setSimilarityFlags).
pub fn mark_similar(
    recent: &SimilarityRecent,
    event: &mut ChatEvent,
    cfg: &SimilarityCfg,
    self_login: Option<&str>,
) {
    if !cfg.enabled {
        return;
    }
    match event {
        ChatEvent::Privmsg {
            login,
            text,
            highlight_sound,
            highlight_sound_path,
            highlight_flash,
            disabled,
            whisper,
            ..
        } => {
            if *whisper {
                return;
            }
            apply_mark(
                recent,
                login,
                text,
                cfg,
                self_login,
                disabled,
                highlight_sound,
                highlight_sound_path,
                highlight_flash,
            );
        }
        ChatEvent::Usernotice {
            login: _,
            system_text: _,
            privmsg,
            highlight_sound,
            highlight_sound_path,
            highlight_flash,
            ..
        } => {
            if let Some(inner) = privmsg.as_mut() {
                if let ChatEvent::Privmsg {
                    login: plogin,
                    text,
                    disabled,
                    whisper,
                    highlight_sound: inner_sound,
                    highlight_sound_path: inner_path,
                    highlight_flash: inner_flash,
                    ..
                } = inner.as_mut()
                {
                    if *whisper {
                        return;
                    }
                    let before = *disabled;
                    apply_mark(
                        recent,
                        plogin,
                        text,
                        cfg,
                        self_login,
                        disabled,
                        inner_sound,
                        inner_path,
                        inner_flash,
                    );
                    if *disabled && !before && !cfg.shown_trigger_highlights {
                        *highlight_sound = false;
                        *highlight_sound_path = None;
                        *highlight_flash = false;
                    }
                }
            }
        }
        _ => {}
    }
}

fn apply_mark(
    recent: &SimilarityRecent,
    login: &str,
    text: &str,
    cfg: &SimilarityCfg,
    self_login: Option<&str>,
    disabled: &mut bool,
    highlight_sound: &mut bool,
    highlight_sound_path: &mut Option<String>,
    highlight_flash: &mut bool,
) {
    let is_myself = self_login.is_some_and(|s| eq_login(s, login));
    if is_myself && !cfg.hide_myself {
        return;
    }
    let score = max_similarity(recent, login, text, cfg);
    if score <= cfg.percentage {
        return;
    }
    *disabled = true;
    if !cfg.shown_trigger_highlights {
        *highlight_sound = false;
        *highlight_sound_path = None;
        *highlight_flash = false;
    }
}

fn max_similarity(recent: &SimilarityRecent, login: &str, text: &str, cfg: &SimilarityCfg) -> f32 {
    let mut best = 0.0f32;
    let max_delay = Duration::from_secs(cfg.max_delay_sec);
    for prev in recent.entries.iter().rev().take(cfg.max_check) {
        if prev.at.elapsed() >= max_delay {
            break;
        }
        if cfg.same_user && !eq_login(login, &prev.login) {
            continue;
        }
        best = best.max(relative_similarity(text, &prev.text));
    }
    best
}

fn sample_text(event: &ChatEvent) -> Option<(String, String)> {
    match event {
        ChatEvent::Privmsg {
            login,
            text,
            whisper,
            ..
        } if !*whisper => Some((login.clone(), text.clone())),
        ChatEvent::Usernotice {
            login,
            system_text,
            privmsg,
            ..
        } => {
            if let Some(inner) = privmsg.as_ref() {
                if let ChatEvent::Privmsg {
                    login: plogin,
                    text,
                    whisper,
                    ..
                } = inner.as_ref()
                {
                    if !*whisper {
                        return Some((plogin.clone(), text.clone()));
                    }
                }
            }
            Some((
                login.clone().unwrap_or_default(),
                system_text.clone(),
            ))
        }
        ChatEvent::Notice { text, .. } => Some((String::new(), text.clone())),
        _ => None,
    }
}

fn eq_login(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn knob_bool(knobs: &BTreeMap<String, Value>, key: &str, default: bool) -> bool {
    knobs
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

fn knob_f32(knobs: &BTreeMap<String, Value>, key: &str, default: f32) -> f32 {
    match knobs.get(key) {
        Some(Value::Number(n)) => n.as_f64().map(|f| f as f32).unwrap_or(default),
        Some(Value::String(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn knob_u64(knobs: &BTreeMap<String, Value>, key: &str, default: u64) -> u64 {
    match knobs.get(key) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(default),
        Some(Value::String(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn knob_usize(knobs: &BTreeMap<String, Value>, key: &str, default: usize) -> usize {
    knob_u64(knobs, key, default as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::{Badge, ChatEvent, EmoteSpan};

    fn privmsg(login: &str, text: &str, ts: u64) -> ChatEvent {
        ChatEvent::Privmsg {
            id: format!("{login}-{ts}"),
            timestamp_ms: ts,
            user_id: "1".into(),
            login: login.into(),
            display_name: login.into(),
            color: "#fff".into(),
            badges: Vec::<Badge>::new(),
            text: text.into(),
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
            highlight_sound: true,
            highlight_sound_path: Some("x.wav".into()),
            highlight_flash: true,
            whisper: false,
            disabled: false,
        source_room_id: None,
        source_badges: vec![],
        }
    }

    #[test]
    fn identical_texts_are_fully_similar() {
        assert!((relative_similarity("kappa", "kappa") - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn unrelated_texts_are_zero() {
        assert_eq!(relative_similarity("abc", "xyz"), 0.0);
    }

    #[test]
    fn empty_texts_are_zero() {
        assert_eq!(relative_similarity("", "a"), 0.0);
        assert_eq!(relative_similarity("a", ""), 0.0);
    }

    #[test]
    fn substring_score_uses_max_len() {
        let s = relative_similarity("hello", "hell");
        assert!((s - 0.8).abs() < 0.001);
    }

    #[test]
    fn utf16_counts_surrogate_pairs() {
        // "𐐷" is one Unicode scalar, two UTF-16 units — stock QString length 2.
        let a = "𐐷";
        assert_eq!(a.encode_utf16().count(), 2);
        assert!((relative_similarity(a, a) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn marks_similar_and_gates_sound() {
        let mut recent = SimilarityRecent::default();
        recent.remember(&privmsg("alice", "hello world", 1000));
        let mut cfg = SimilarityCfg {
            enabled: true,
            percentage: 0.5,
            ..SimilarityCfg::default()
        };
        let mut ev = privmsg("alice", "hello world!", 1500);
        mark_similar(&recent, &mut ev, &cfg, None);
        match &ev {
            ChatEvent::Privmsg {
                disabled,
                highlight_sound,
                highlight_flash,
                highlight_sound_path,
                ..
            } => {
                assert!(*disabled);
                assert!(!*highlight_sound);
                assert!(!*highlight_flash);
                assert!(highlight_sound_path.is_none());
            }
            _ => panic!("expected privmsg"),
        }
        cfg.shown_trigger_highlights = true;
        let mut ev2 = privmsg("alice", "hello world!", 1500);
        mark_similar(&recent, &mut ev2, &cfg, None);
        match &ev2 {
            ChatEvent::Privmsg {
                disabled,
                highlight_sound,
                ..
            } => {
                assert!(*disabled);
                assert!(*highlight_sound);
            }
            _ => panic!("expected privmsg"),
        }
    }

    #[test]
    fn same_user_skips_other_logins() {
        let mut recent = SimilarityRecent::default();
        recent.remember(&privmsg("alice", "hello world", 1000));
        let cfg = SimilarityCfg {
            enabled: true,
            same_user: true,
            percentage: 0.5,
            ..SimilarityCfg::default()
        };
        let mut ev = privmsg("bob", "hello world", 1500);
        mark_similar(&recent, &mut ev, &cfg, None);
        match &ev {
            ChatEvent::Privmsg { disabled, .. } => assert!(!*disabled),
            _ => panic!("expected privmsg"),
        }
    }

    #[test]
    fn hide_myself_off_skips_self() {
        let mut recent = SimilarityRecent::default();
        recent.remember(&privmsg("me", "hello world", 1000));
        let cfg = SimilarityCfg {
            enabled: true,
            hide_myself: false,
            percentage: 0.5,
            ..SimilarityCfg::default()
        };
        let mut ev = privmsg("me", "hello world", 1500);
        mark_similar(&recent, &mut ev, &cfg, Some("me"));
        match &ev {
            ChatEvent::Privmsg { disabled, .. } => assert!(!*disabled),
            _ => panic!("expected privmsg"),
        }
    }

    #[test]
    fn delay_breaks_walk_by_ingest_age() {
        let mut recent = SimilarityRecent::default();
        recent.push_aged("alice", "hello world", Duration::from_secs(6));
        let cfg = SimilarityCfg {
            enabled: true,
            percentage: 0.5,
            max_delay_sec: 5,
            ..SimilarityCfg::default()
        };
        let mut ev = privmsg("alice", "hello world", 99999);
        mark_similar(&recent, &mut ev, &cfg, None);
        match &ev {
            ChatEvent::Privmsg { disabled, .. } => assert!(!*disabled),
            _ => panic!("expected privmsg"),
        }
    }

    #[test]
    fn whisper_not_marked() {
        let mut recent = SimilarityRecent::default();
        recent.remember(&privmsg("alice", "hello world", 1000));
        let cfg = SimilarityCfg {
            enabled: true,
            percentage: 0.5,
            ..SimilarityCfg::default()
        };
        let mut ev = privmsg("alice", "hello world", 1500);
        if let ChatEvent::Privmsg { whisper, .. } = &mut ev {
            *whisper = true;
        }
        mark_similar(&recent, &mut ev, &cfg, None);
        match &ev {
            ChatEvent::Privmsg { disabled, .. } => assert!(!*disabled),
            _ => panic!("expected privmsg"),
        }
    }

    #[test]
    fn usernotice_body_is_marked() {
        let mut recent = SimilarityRecent::default();
        recent.remember(&privmsg("alice", "hello world", 1000));
        let cfg = SimilarityCfg {
            enabled: true,
            percentage: 0.5,
            ..SimilarityCfg::default()
        };
        let mut ev = ChatEvent::Usernotice {
            id: "u1".into(),
            timestamp_ms: 2,
            system_text: "alice subscribed".into(),
            login: Some("alice".into()),
            msg_id: Some("resub".into()),
            privmsg: Some(Box::new(privmsg("alice", "hello world!", 2))),
            highlight_color: None,
            highlight_sound: true,
            highlight_sound_path: Some("x.wav".into()),
            highlight_flash: true,
        };
        mark_similar(&recent, &mut ev, &cfg, None);
        match &ev {
            ChatEvent::Usernotice {
                privmsg: Some(inner),
                highlight_sound,
                ..
            } => {
                match inner.as_ref() {
                    ChatEvent::Privmsg { disabled, .. } => assert!(*disabled),
                    _ => panic!("nested privmsg"),
                }
                assert!(!*highlight_sound);
            }
            _ => panic!("expected usernotice"),
        }
    }

    #[test]
    fn threshold_exact_does_not_mark() {
        let mut recent = SimilarityRecent::default();
        recent.remember(&privmsg("alice", "abcd", 1));
        let cfg = SimilarityCfg {
            enabled: true,
            percentage: 1.0,
            ..SimilarityCfg::default()
        };
        let mut ev = privmsg("alice", "abcd", 2);
        mark_similar(&recent, &mut ev, &cfg, None);
        match &ev {
            ChatEvent::Privmsg { disabled, .. } => assert!(!*disabled),
            _ => panic!("expected privmsg"),
        }
    }
}
