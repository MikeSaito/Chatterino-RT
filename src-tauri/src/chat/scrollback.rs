use std::collections::VecDeque;

use super::constants::SCROLLBACK_LIMIT;
use super::types::{ChatEvent, SearchHit};

const SEARCH_LIMIT: usize = 200;

#[derive(Debug, Default)]
pub struct Scrollback {
    items: VecDeque<ChatEvent>,
    limit: usize,
}

impl Scrollback {
    pub fn new() -> Self {
        Self {
            items: VecDeque::with_capacity(SCROLLBACK_LIMIT),
            limit: SCROLLBACK_LIMIT,
        }
    }

    pub fn push(&mut self, event: ChatEvent) {
        if self.items.len() == self.limit {
            self.items.pop_front();
        }
        self.items.push_back(event);
    }

    pub fn snapshot(&self) -> Vec<ChatEvent> {
        self.items.iter().cloned().collect()
    }

    /// Case-insensitive substring match (Chatterino SubstringPredicate).
    /// Empty query: full snapshot capped (SearchPopup with no predicates).
    /// Chronological order; prefer newest when capped.
    pub fn search_hits(&self, query: &str) -> Vec<SearchHit> {
        let needle = query.trim();
        if needle.is_empty() {
            let skip = self.items.len().saturating_sub(SEARCH_LIMIT);
            return self
                .items
                .iter()
                .skip(skip)
                // CLEARMSG не создаёт слот в ring — только soft-disable target
                .filter(|e| !matches!(e, ChatEvent::Clearmsg { .. }))
                .map(ChatEvent::to_search_hit)
                .collect();
        }
        let needle_lower = needle.to_lowercase();
        let mut newest_first = Vec::new();
        for event in self.items.iter().rev() {
            if event.matches_substring(&needle_lower) {
                newest_first.push(event.to_search_hit());
                if newest_first.len() >= SEARCH_LIMIT {
                    break;
                }
            }
        }
        newest_first.reverse();
        newest_first
    }

    #[cfg(test)]
    pub fn search_ids(&self, query: &str) -> Vec<String> {
        self.search_hits(query)
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
    use crate::chat::types::{Badge, ChatEvent, EmoteSpan};

    fn notice(id: &str, text: &str) -> ChatEvent {
        ChatEvent::Notice {
            id: id.to_string(),
            timestamp_ms: 1,
            text: text.to_string(),
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
        }
    }

    #[test]
    fn evicts_oldest_without_growing_past_limit() {
        let mut q = Scrollback::new();
        for i in 0..(SCROLLBACK_LIMIT + 5) {
            q.push(notice(&i.to_string(), &i.to_string()));
        }
        assert!(!q.is_empty());
        assert_eq!(q.len(), SCROLLBACK_LIMIT);
        let snap = q.snapshot();
        assert_eq!(snap.first().unwrap().id(), "5");
        assert_eq!(
            snap.last().unwrap().id(),
            &(SCROLLBACK_LIMIT + 4).to_string()
        );
    }

    #[test]
    fn search_empty_query_returns_recent_snapshot() {
        let mut q = Scrollback::new();
        q.push(privmsg("1", "ann", "hello world"));
        q.push(privmsg("2", "bob", "other"));
        assert_eq!(q.search_ids(""), vec!["1".to_string(), "2".to_string()]);
        assert_eq!(q.search_ids("   "), vec!["1".to_string(), "2".to_string()]);
    }

    #[test]
    fn search_substring_case_insensitive_chronological() {
        let mut q = Scrollback::new();
        q.push(privmsg("1", "ann", "Hello kappa"));
        q.push(privmsg("2", "bob", "nothing"));
        q.push(notice("3", "HELLO again"));
        assert_eq!(
            q.search_ids("hello"),
            vec!["1".to_string(), "3".to_string()]
        );
        assert_eq!(q.search_ids("ANN"), vec!["1".to_string()]);
    }

    #[test]
    fn search_prefers_newest_when_capped() {
        let mut q = Scrollback::new();
        for i in 0..250 {
            q.push(privmsg(&i.to_string(), "ann", "needle here"));
        }
        let ids = q.search_ids("needle");
        assert_eq!(ids.len(), SEARCH_LIMIT);
        assert_eq!(ids.first().unwrap(), "50");
        assert_eq!(ids.last().unwrap(), "249");
    }

    #[test]
    fn search_no_history() {
        let q = Scrollback::new();
        assert!(q.search_ids("x").is_empty());
    }

    #[test]
    fn search_usernotice_jumps_to_nested_privmsg_id() {
        let mut q = Scrollback::new();
        q.push(ChatEvent::Usernotice {
            id: "outer".into(),
            timestamp_ms: 1,
            system_text: "ann subscribed".into(),
            login: Some("ann".into()),
            msg_id: None,
            privmsg: Some(Box::new(privmsg("inner-body", "ann", "hello sub"))),
            highlight_color: None,
        highlight_sound: false,
        highlight_sound_path: None,
        });
        assert_eq!(q.search_ids("hello"), vec!["inner-body".to_string()]);
    }
}
