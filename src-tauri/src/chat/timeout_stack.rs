//! CLEARCHAT timeout stacking (stock Chatterino ChannelHelpers.hpp).
//! MIT reimplementation; no C++/Qt copy.

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
        _ => TimeoutStackStyle::StackUntilUserMessage,
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
        ..
    } = &incoming
    else {
        push_back(items, incoming.clone(), limit);
        return PushOutcome::Added(incoming);
    };

    if style == TimeoutStackStyle::DontStack {
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
) -> Option<ChatEvent> {
    let ChatEvent::Clearchat {
        id,
        timestamp_ms: _,
        target_login,
        duration_sec: _,
        stack_count,
    } = existing
    else {
        return None;
    };

    match (incoming_target, target_login.as_deref()) {
        (Some(in_user), Some(ex_user)) if in_user.eq_ignore_ascii_case(ex_user) => {}
        (None, None) => {}
        _ => return None,
    }

    let count = stack_count.saturating_add(1);
    Some(ChatEvent::Clearchat {
        id: id.clone(),
        timestamp_ms: incoming_ts,
        target_login: target_login.clone(),
        duration_sec: incoming_duration,
        stack_count: count,
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
        }
    }

    fn timeout(id: &str, ts: u64, login: &str, secs: u32) -> ChatEvent {
        ChatEvent::Clearchat {
            id: id.into(),
            timestamp_ms: ts,
            target_login: Some(login.into()),
            duration_sec: Some(secs),
            stack_count: 1,
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
    fn stacks_full_clear_four_times() {
        let mut items = VecDeque::new();
        for i in 0..4 {
            push_clearchat(
                &mut items,
                clear(&format!("c{i}"), 1000 + i),
                TimeoutStackStyle::Stack,
                1000,
            );
        }
        assert_eq!(items.len(), 1);
        match &items[0] {
            ChatEvent::Clearchat { stack_count, .. } => assert_eq!(*stack_count, 4),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn stacks_user_timeout_three_times() {
        let mut items = VecDeque::new();
        for i in 0..3 {
            push_clearchat(
                &mut items,
                timeout(&format!("t{i}"), 2000 + i, "dev", 600),
                TimeoutStackStyle::Stack,
                1000,
            );
        }
        assert_eq!(items.len(), 1);
        match &items[0] {
            ChatEvent::Clearchat {
                stack_count,
                duration_sec,
                ..
            } => {
                assert_eq!(*stack_count, 3);
                assert_eq!(*duration_sec, Some(600));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn dont_stack_keeps_separate_lines() {
        let mut items = VecDeque::new();
        for i in 0..4 {
            push_clearchat(
                &mut items,
                clear(&format!("c{i}"), 1000 + i),
                TimeoutStackStyle::DontStack,
                1000,
            );
        }
        assert_eq!(items.len(), 4);
    }

    #[test]
    fn stack_until_user_message_breaks_on_privmsg() {
        let mut items = VecDeque::new();
        push_clearchat(
            &mut items,
            timeout("t1", 1000, "dev", 60),
            TimeoutStackStyle::StackUntilUserMessage,
            1000,
        );
        push_clearchat(
            &mut items,
            privmsg("p1", 1001, "dev"),
            TimeoutStackStyle::StackUntilUserMessage,
            1000,
        );
        push_clearchat(
            &mut items,
            timeout("t2", 1002, "dev", 120),
            TimeoutStackStyle::StackUntilUserMessage,
            1000,
        );
        assert_eq!(items.len(), 3);
        match &items[2] {
            ChatEvent::Clearchat { stack_count, .. } => assert_eq!(*stack_count, 1),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn style_from_knobs_defaults_to_stack_until() {
        assert_eq!(
            style_from_knobs(&BTreeMap::new()),
            TimeoutStackStyle::StackUntilUserMessage
        );
        let mut knobs = BTreeMap::new();
        knobs.insert(
            "moderation.timeoutStackStyle".into(),
            Value::String("0".into()),
        );
        assert_eq!(style_from_knobs(&knobs), TimeoutStackStyle::Stack);
    }
}
