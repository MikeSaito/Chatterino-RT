use std::collections::{HashSet, VecDeque};

use super::scrollback_config::DEFAULT_SCROLLBACK_LIMIT;
use super::timeout_stack::{self, PushOutcome, TimeoutStackStyle};
use super::types::{ChatEvent, SearchHit};

const LOCAL_ECHO_ID_PREFIX: &str = "l-";
const ECHO_DEDUP_WINDOW_MS: u64 = 15_000;

/// Gap fill may return the same self PRIVMSG with a real Twitch id after local echo.
fn upgrade_local_echo_id(items: &mut VecDeque<ChatEvent>, incoming: &ChatEvent) -> bool {
    let ChatEvent::Privmsg {
        login: in_login,
        text: in_text,
        timestamp_ms: in_ts,
        id: in_id,
        ..
    } = incoming
    else {
        return false;
    };
    if in_id.starts_with(LOCAL_ECHO_ID_PREFIX) {
        return false;
    }
    for existing in items.iter_mut() {
        let ChatEvent::Privmsg {
            id,
            login,
            text,
            timestamp_ms,
            ..
        } = existing
        else {
            continue;
        };
        if !id.starts_with(LOCAL_ECHO_ID_PREFIX) {
            continue;
        }
        if !login.eq_ignore_ascii_case(in_login) || text != in_text {
            continue;
        }
        if timestamp_ms.abs_diff(*in_ts) > ECHO_DEDUP_WINDOW_MS {
            continue;
        }
        *id = in_id.clone();
        return true;
    }
    false
}

#[derive(Debug, Default)]
pub struct Scrollback {
    items: VecDeque<ChatEvent>,
    limit: usize,
}

impl Scrollback {
    pub fn new() -> Self {
        Self::with_limit(DEFAULT_SCROLLBACK_LIMIT)
    }

    pub fn with_limit(limit: usize) -> Self {
        Self {
            items: VecDeque::with_capacity(limit.min(DEFAULT_SCROLLBACK_LIMIT)),
            limit,
        }
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn set_limit(&mut self, limit: usize) {
        self.limit = limit;
        while self.items.len() > self.limit {
            self.items.pop_front();
        }
    }

    pub fn push(&mut self, event: ChatEvent, stack_style: TimeoutStackStyle) -> PushOutcome {
        match &event {
            ChatEvent::Clearchat { .. } => {
                timeout_stack::push_clearchat(&mut self.items, event, stack_style, self.limit)
            }
            _ => {
                if self.items.len() == self.limit {
                    self.items.pop_front();
                }
                self.items.push_back(event.clone());
                PushOutcome::Added(event)
            }
        }
    }

    /// Prepend oldest→newest without evicting the live tail (Chatterino pushFront).
    pub fn prepend_front(&mut self, events: &[ChatEvent]) -> usize {
        let space = self.limit.saturating_sub(self.items.len());
        if space == 0 || events.is_empty() {
            return 0;
        }
        let start = events.len().saturating_sub(space);
        let slice = &events[start..];
        for event in slice.iter().rev() {
            self.items.push_front(event.clone());
        }
        slice.len()
    }

    /// Insert missing history by timestamp (Chatterino fillInMissingMessages).
    pub fn fill_in_missing(&mut self, events: &[ChatEvent]) -> usize {
        if events.is_empty() {
            return 0;
        }
        let existing: HashSet<String> = self.items.iter().map(|e| e.id().to_string()).collect();
        let mut incoming: Vec<ChatEvent> = events
            .iter()
            .filter(|e| !e.id().is_empty() && !existing.contains(e.id()))
            .cloned()
            .collect();
        if incoming.is_empty() {
            return 0;
        }
        incoming.sort_by_key(|e| e.timestamp_ms());
        let mut inserted = 0usize;
        let mut seen = existing;
        for event in incoming {
            let id = event.id().to_string();
            if id.is_empty() || seen.contains(&id) {
                continue;
            }
            if upgrade_local_echo_id(&mut self.items, &event) {
                seen.insert(id);
                continue;
            }
            seen.insert(id);
            let ts = event.timestamp_ms();
            let pos = self
                .items
                .iter()
                .position(|e| e.timestamp_ms() > ts)
                .unwrap_or(self.items.len());
            self.items.insert(pos, event);
            inserted += 1;
        }
        while self.items.len() > self.limit {
            self.items.pop_front();
        }
        inserted
    }

    pub fn snapshot(&self) -> Vec<ChatEvent> {
        self.items.iter().cloned().collect()
    }

    /// Stock SearchPopup predicates (AND). Empty query: full snapshot capped.
    /// Chronological order; prefer newest when capped. `channel`/`room_id` for `in:`/`is:shared`.
    pub fn search_hits(&self, query: &str, channel: &str, room_id: Option<&str>) -> Vec<SearchHit> {
        let cap = self.limit;
        let needle = query.trim();
        if needle.is_empty() {
            let skip = self.items.len().saturating_sub(cap);
            return self
                .items
                .iter()
                .skip(skip)
                // CLEARMSG не создаёт слот в ring — только soft-disable target
                .filter(|e| !matches!(e, ChatEvent::Clearmsg { .. }))
                .map(ChatEvent::to_search_hit)
                .collect();
        }
        let preds = crate::chat::search_pred::parse_predicates(needle);
        let mut newest_first = Vec::new();
        for event in self.items.iter().rev() {
            if matches!(event, ChatEvent::Clearmsg { .. }) {
                continue;
            }
            if crate::chat::search_pred::applies_all(&preds, event, channel, room_id) {
                newest_first.push(event.to_search_hit());
                if newest_first.len() >= cap {
                    break;
                }
            }
        }
        newest_first.reverse();
        newest_first
    }

    #[cfg(test)]
    pub fn search_ids(&self, query: &str) -> Vec<String> {
        self.search_hits(query, "test", None)
            .into_iter()
            .map(|h| h.id)
            .collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::timeout_stack::TimeoutStackStyle;
    use crate::chat::types::{Badge, ChatEvent, EmoteSpan};

    fn no_stack() -> TimeoutStackStyle {
        TimeoutStackStyle::DontStack
    }

    fn notice(id: &str, text: &str) -> ChatEvent {
        ChatEvent::Notice {
            id: id.to_string(),
            timestamp_ms: 1,
            text: text.to_string(),

        msg_id: None,

        timeout_remaining_sec: None,
        }
    }

    fn notice_ts(id: &str, ts: u64) -> ChatEvent {
        ChatEvent::Notice {
            id: id.to_string(),
            timestamp_ms: ts,
            text: id.to_string(),

        msg_id: None,

        timeout_remaining_sec: None,
        }
    }

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

    #[test]
    fn evicts_oldest_without_growing_past_limit() {
        let mut q = Scrollback::with_limit(DEFAULT_SCROLLBACK_LIMIT);
        for i in 0..(DEFAULT_SCROLLBACK_LIMIT + 5) {
            q.push(notice(&i.to_string(), &i.to_string()), no_stack());
        }
        assert!(!q.is_empty());
        assert_eq!(q.len(), DEFAULT_SCROLLBACK_LIMIT);
        let snap = q.snapshot();
        assert_eq!(snap.first().unwrap().id(), "5");
        assert_eq!(
            snap.last().unwrap().id(),
            &(DEFAULT_SCROLLBACK_LIMIT + 4).to_string()
        );
    }

    #[test]
    fn set_limit_trims_oldest() {
        let mut q = Scrollback::with_limit(5);
        for i in 0..5 {
            q.push(notice(&i.to_string(), "x"), no_stack());
        }
        q.set_limit(2);
        assert_eq!(q.len(), 2);
        assert_eq!(q.snapshot()[0].id(), "3");
        assert_eq!(q.snapshot()[1].id(), "4");
    }

    #[test]
    fn search_empty_query_returns_recent_snapshot() {
        let mut q = Scrollback::new();
        q.push(privmsg("1", "ann", "hello world"), no_stack());
        q.push(privmsg("2", "bob", "other"), no_stack());
        assert_eq!(q.search_ids(""), vec!["1".to_string(), "2".to_string()]);
        assert_eq!(q.search_ids("   "), vec!["1".to_string(), "2".to_string()]);
    }

    #[test]
    fn search_substring_case_insensitive_chronological() {
        let mut q = Scrollback::new();
        q.push(privmsg("1", "ann", "Hello kappa"), no_stack());
        q.push(privmsg("2", "bob", "nothing"), no_stack());
        q.push(notice("3", "HELLO again"), no_stack());
        assert_eq!(
            q.search_ids("hello"),
            vec!["1".to_string(), "3".to_string()]
        );
        assert_eq!(q.search_ids("ANN"), vec!["1".to_string()]);
    }

    #[test]
    fn search_prefers_newest_when_capped() {
        let cap = 200;
        let mut q = Scrollback::with_limit(cap);
        for i in 0..250 {
            q.push(privmsg(&i.to_string(), "ann", "needle here"), no_stack());
        }
        let ids = q.search_ids("needle");
        assert_eq!(ids.len(), cap);
        assert_eq!(ids.first().unwrap(), "50");
        assert_eq!(ids.last().unwrap(), "249");
    }

    #[test]
    fn search_no_history() {
        let q = Scrollback::new();
        assert!(q.search_ids("x").is_empty());
    }

    #[test]
    fn prepend_front_preserves_order_without_evicting_live() {
        let mut q = Scrollback::new();
        q.push(notice("live-1", "live"), no_stack());
        let history: Vec<ChatEvent> = (0..5)
            .map(|i| notice(&format!("h-{i}"), &format!("hist {i}")))
            .collect();
        let n = q.prepend_front(&history);
        assert_eq!(n, 5);
        let snap = q.snapshot();
        assert_eq!(snap.len(), 6);
        assert_eq!(snap[0].id(), "h-0");
        assert_eq!(snap[4].id(), "h-4");
        assert_eq!(snap[5].id(), "live-1");
    }

    #[test]
    fn prepend_front_respects_remaining_space() {
        let mut q = Scrollback::new();
        for i in 0..DEFAULT_SCROLLBACK_LIMIT {
            q.push(notice(&i.to_string(), "x"), no_stack());
        }
        let extra = notice("new-live", "live");
        q.push(extra, no_stack());
        assert_eq!(q.len(), DEFAULT_SCROLLBACK_LIMIT);
        let history: Vec<ChatEvent> = (0..10).map(|i| notice(&format!("hist-{i}"), "h")).collect();
        assert_eq!(q.prepend_front(&history), 0);
        assert_eq!(q.snapshot().first().unwrap().id(), "1");
    }

    #[test]
    fn fill_in_missing_inserts_in_timestamp_order() {
        let mut q = Scrollback::new();
        q.push(notice_ts("a", 100), no_stack());
        q.push(notice_ts("c", 300), no_stack());
        let gap = vec![notice_ts("b", 200)];
        assert_eq!(q.fill_in_missing(&gap), 1);
        let snap = q.snapshot();
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].id(), "a");
        assert_eq!(snap[1].id(), "b");
        assert_eq!(snap[2].id(), "c");
    }

    #[test]
    fn fill_in_missing_skips_duplicate_ids() {
        let mut q = Scrollback::new();
        q.push(notice_ts("a", 100), no_stack());
        let gap = vec![notice_ts("a", 100), notice_ts("b", 150)];
        assert_eq!(q.fill_in_missing(&gap), 1);
        assert_eq!(q.snapshot().len(), 2);
    }

    #[test]
    fn fill_in_missing_upgrades_local_echo_id() {
        let mut q = Scrollback::new();
        q.push(privmsg("l-1-0-5", "me", "hello"), no_stack());
        let gap = vec![privmsg("real-twitch-id", "me", "hello")];
        assert_eq!(q.fill_in_missing(&gap), 0);
        assert_eq!(q.snapshot().len(), 1);
        assert_eq!(q.snapshot()[0].id(), "real-twitch-id");
    }

    #[test]
    fn push_stacks_clearchat_when_enabled() {
        use crate::chat::timeout_stack::TimeoutStackStyle;

        let mut q = Scrollback::new();
        for i in 0..3 {
            q.push(
                ChatEvent::Clearchat {
                    id: format!("c{i}"),
                    timestamp_ms: 1000 + i,
                    target_login: None,
                    duration_sec: None,
                    stack_count: 1,
                },
                TimeoutStackStyle::Stack,
            );
        }
        assert_eq!(q.len(), 1);
        match q.snapshot().last().unwrap() {
            ChatEvent::Clearchat { stack_count, .. } => assert_eq!(*stack_count, 3),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn search_clearchat_stack_count_in_hit() {
        use crate::chat::timeout_stack::TimeoutStackStyle;

        let mut q = Scrollback::new();
        q.push(
            ChatEvent::Clearchat {
                id: "c1".into(),
                timestamp_ms: 1000,
                target_login: Some("dev".into()),
                duration_sec: Some(60),
                stack_count: 3,
            },
            TimeoutStackStyle::DontStack,
        );
        let hits = q.search_hits("dev", "test", None);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.contains("(3 times)"));
        assert_eq!(hits[0].clear_login.as_deref(), Some("dev"));
        assert_eq!(hits[0].clear_duration_sec, Some(60));
        assert_eq!(hits[0].clear_stack_count, Some(3));
    }

    #[test]
    fn search_usernotice_jumps_to_nested_privmsg_id() {
        let mut q = Scrollback::new();
        q.push(
            ChatEvent::Usernotice {
                id: "outer".into(),
                timestamp_ms: 1,
                system_text: "ann subscribed".into(),
                login: Some("ann".into()),
                msg_id: None,
                params: None,
                privmsg: Some(Box::new(privmsg("inner-body", "ann", "hello sub"))),
                highlight_color: None,
                highlight_sound: false,
                highlight_sound_path: None,
                highlight_flash: false,
            },
            no_stack(),
        );
        assert_eq!(q.search_ids("hello"), vec!["inner-body".to_string()]);
    }
}
