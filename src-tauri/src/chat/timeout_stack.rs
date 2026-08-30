//! CLEARCHAT timeout stacking (stock Chatterino ChannelHelpers.hpp).
//! MIT reimplementation; no C++/Qt copy.
//! Shared-ban EventSub enrich replaces IRC CLEARCHAT without bumping stack.

use std::collections::{BTreeMap, VecDeque};

use serde_json::Value;

use super::state::Shared;
use super::types::ChatEvent;

const WINDOW_MSGS: usize = 20;
const WINDOW_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutStackStyle {
    Stack = 0,
    StackUntilUserMessage = 1,
    DontStack = 2,
}

impl Default for TimeoutStackStyle {
    fn default() -> Self {
        Self::StackUntilUserMessage
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    Added(ChatEvent),
    Replaced(ChatEvent),
}

pub fn style_from_shared(shared: &Shared) -> TimeoutStackStyle {
    match shared.settings.lock() {
        Ok(inner) => style_from_knobs(&inner.data.knobs),
        Err(_) => TimeoutStackStyle::default(),
    }
}

pub fn style_from_knobs(knobs: &BTreeMap<String, Value>) -> TimeoutStackStyle {
    match knobs
        .get("moderation.timeoutStackStyle")
        .and_then(|v| v.as_str())
    {
        Some("0") => TimeoutStackStyle::Stack,
        Some("2") => TimeoutStackStyle::DontStack,
        _ => TimeoutStackStyle::default(),
    }
}

/// Push or stack-replace a CLEARCHAT event in scrollback.
pub fn push_clearchat(
    items: &mut VecDeque<ChatEvent>,
    incoming: ChatEvent,
    style: TimeoutStackStyle,
    limit: usize,
) -> PushOutcome {
    let ChatEvent::Clearchat {
        timestamp_ms: incoming_ts,
        target_login: incoming_target,
        duration_sec: incoming_duration,
        source_login: incoming_source,
        moderator_login: incoming_mod,
        ..
    } = &incoming
    else {
        push_back(items, incoming.clone(), limit);
        return PushOutcome::Added(incoming);
    };

    if style == TimeoutStackStyle::DontStack {
        // Still enrich IRC CLEARCHAT with shared-ban EventSub metadata (no stack bump).
        if incoming_source.is_some() || incoming_mod.is_some() {
            let min_ts = incoming_ts.saturating_sub(WINDOW_MS);
            let len = items.len();
            let start = len.saturating_sub(WINDOW_MSGS);
            for i in (start..len).rev() {
                let existing = &items[i];
                if existing.timestamp_ms() < min_ts {
                    break;
                }
                if let Some(updated) = try_stack_pair(
                    existing,
                    incoming_target.as_deref(),
                    *incoming_duration,
                    *incoming_ts,
                    incoming_source.as_deref(),
                    incoming_mod.as_deref(),
                ) {
                    items[i] = updated.clone();
                    return PushOutcome::Replaced(updated);
                }
            }
        }
        push_back(items, incoming.clone(), limit);
        return PushOutcome::Added(incoming);
    }

    let min_ts = incoming_ts.saturating_sub(WINDOW_MS);
    let len = items.len();
    let start = len.saturating_sub(WINDOW_MSGS);

    for i in (start..len).rev() {
        let existing = &items[i];
        if existing.timestamp_ms() < min_ts {
            break;
        }

        if style == TimeoutStackStyle::StackUntilUserMessage {
            if breaks_stack_before(existing, incoming_target.as_deref()) {
                break;
            }
        }

        if let Some(updated) = try_stack_pair(
            existing,
            incoming_target.as_deref(),
            *incoming_duration,
            *incoming_ts,
            incoming_source.as_deref(),
            incoming_mod.as_deref(),
        ) {
            items[i] = updated.clone();
            return PushOutcome::Replaced(updated);
        }
    }

    push_back(items, incoming.clone(), limit);
    PushOutcome::Added(incoming)
}

fn breaks_stack_before(existing: &ChatEvent, incoming_target: Option<&str>) -> bool {
    match existing {
        ChatEvent::Privmsg {
            login,
            disabled: false,
            ..
        } => incoming_target.is_some_and(|t| login.eq_ignore_ascii_case(t)),
        ChatEvent::Clearchat { .. } => false,
        _ => incoming_target.is_none(),
    }
}

fn try_stack_pair(
    existing: &ChatEvent,
    incoming_target: Option<&str>,
    incoming_duration: Option<u32>,
    incoming_ts: u64,
    incoming_source: Option<&str>,
    incoming_mod: Option<&str>,
) -> Option<ChatEvent> {
    let ChatEvent::Clearchat {
        id,
        timestamp_ms: _,
        target_login,
        duration_sec: existing_duration,
        stack_count,
        source_login: existing_source,
        moderator_login: existing_mod,
    } = existing
    else {
        return None;
    };

    match (incoming_target, target_login.as_deref()) {
        (Some(in_user), Some(ex_user)) if in_user.eq_ignore_ascii_case(ex_user) => {}
        (None, None) => {}
        _ => return None,
    }

    let enriching = incoming_source.is_some() && existing_source.is_none();
    let keep_enriched = existing_source.is_some() && incoming_source.is_none();
    let count = if enriching || keep_enriched {
        *stack_count
    } else {
        stack_count.saturating_add(1)
    };

    let source_login = if keep_enriched {
        existing_source.clone()
    } else {
        incoming_source
            .map(str::to_string)
            .or_else(|| existing_source.clone())
    };
    let moderator_login = if keep_enriched {
        existing_mod.clone()
    } else {
        incoming_mod
            .map(str::to_string)
            .or_else(|| existing_mod.clone())
    };
    let duration_sec = if keep_enriched && incoming_duration.is_none() {
        *existing_duration
    } else {
        incoming_duration.or(*existing_duration)
    };

    Some(ChatEvent::Clearchat {
        id: id.clone(),
        timestamp_ms: incoming_ts,
        target_login: target_login.clone(),
        duration_sec,
        stack_count: count,
        source_login,
        moderator_login,
    })
}

fn push_back(items: &mut VecDeque<ChatEvent>, event: ChatEvent, limit: usize) {
    if items.len() == limit {
        items.pop_front();
    }
    items.push_back(event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::ChatEvent;

    fn clear(id: &str, ts: u64) -> ChatEvent {
        ChatEvent::Clearchat {
            id: id.into(),
            timestamp_ms: ts,
            target_login: None,
            duration_sec: None,
            stack_count: 1,
            source_login: None,
            moderator_login: None,
        }
    }

    fn timeout(id: &str, ts: u64, login: &str, secs: u32) -> ChatEvent {
        ChatEvent::Clearchat {
            id: id.into(),
            timestamp_ms: ts,
            target_login: Some(login.into()),
            duration_sec: Some(secs),
            stack_count: 1,
            source_login: None,
            moderator_login: None,
        }
    }

    fn shared_ban(id: &str, ts: u64, login: &str, source: &str, moderator: &str) -> ChatEvent {
        ChatEvent::Clearchat {
            id: id.into(),
            timestamp_ms: ts,
            target_login: Some(login.into()),
            duration_sec: None,
            stack_count: 1,
            source_login: Some(source.into()),
            moderator_login: Some(moderator.into()),
        }
    }

    fn privmsg(id: &str, ts: u64, login: &str) -> ChatEvent {
        ChatEvent::Privmsg {
            id: id.into(),
            timestamp_ms: ts,
            user_id: "1".into(),
            login: login.into(),
            display_name: login.into(),
            color: "#fff".into(),
            badges: vec![],
            text: "hi".into(),
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
            whisper: false,
            disabled: false,
            source_room_id: None,
            source_badges: vec![],
            paint: None,
        }
    }

    #[test]
    fn stacks_same_user_timeouts() {
        let mut items = VecDeque::new();
        let _ = push_clearchat(&mut items, timeout("a", 1000, "bob", 60), TimeoutStackStyle::Stack, 100);
        let out = push_clearchat(
            &mut items,
            timeout("b", 1500, "bob", 60),
            TimeoutStackStyle::Stack,
            100,
        );
        match out {
            PushOutcome::Replaced(ChatEvent::Clearchat { stack_count, .. }) => {
                assert_eq!(stack_count, 2)
            }
            _ => panic!("expected replace"),
        }
    }

    #[test]
    fn enrich_shared_ban_keeps_stack() {
        let irc = ChatEvent::Clearchat {
            id: "a".into(),
            timestamp_ms: 1000,
            target_login: Some("bob".into()),
            duration_sec: None,
            stack_count: 1,
            source_login: None,
            moderator_login: None,
        };
        let mut items = VecDeque::from([irc]);
        let out = push_clearchat(
            &mut items,
            shared_ban("b", 1100, "bob", "srcchan", "mod"),
            TimeoutStackStyle::Stack,
            100,
        );
        match out {
            PushOutcome::Replaced(ChatEvent::Clearchat {
                stack_count,
                source_login,
                moderator_login,
                ..
            }) => {
                assert_eq!(stack_count, 1);
                assert_eq!(source_login.as_deref(), Some("srcchan"));
                assert_eq!(moderator_login.as_deref(), Some("mod"));
            }
            _ => panic!("expected enrich replace"),
        }
    }

    #[test]
    fn stacks_room_clears() {
        let mut items = VecDeque::new();
        for i in 0..3 {
            let _ = push_clearchat(
                &mut items,
                clear(&format!("c{i}"), 1000 + i * 10),
                TimeoutStackStyle::Stack,
                100,
            );
        }
        match items.back() {
            Some(ChatEvent::Clearchat { stack_count, .. }) => assert_eq!(*stack_count, 3),
            _ => panic!("expected clearchat"),
        }
    }

    #[test]
    fn stack_until_user_message_breaks() {
        let mut items = VecDeque::from([
            timeout("a", 1000, "bob", 60),
            privmsg("p", 1200, "bob"),
        ]);
        let out = push_clearchat(
            &mut items,
            timeout("b", 1300, "bob", 60),
            TimeoutStackStyle::StackUntilUserMessage,
            100,
        );
        match out {
            PushOutcome::Added(ChatEvent::Clearchat { stack_count, .. }) => {
                assert_eq!(stack_count, 1)
            }
            _ => panic!("expected add after break"),
        }
    }
}
