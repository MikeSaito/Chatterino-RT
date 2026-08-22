// Reimplementation of Chatterino ChatterSet (MIT). No C++/Qt copied.
// chatterino2/src/common/ChatterSet.hpp CHATTER_LIMIT = 2000.

use std::collections::{HashMap, VecDeque};

pub const CHATTER_LIMIT: usize = 2000;

#[derive(Debug, Default)]
struct ChannelChatters {
    order: VecDeque<String>,
    names: HashMap<String, String>,
}

#[derive(Debug, Default)]
pub struct Chatters {
    by_channel: HashMap<String, ChannelChatters>,
}

impl Chatters {
    pub fn ensure_channel(&mut self, channel: &str) {
        self.by_channel
            .entry(channel.to_string())
            .or_insert_with(ChannelChatters::default);
    }

    pub fn drop_channel(&mut self, channel: &str) {
        self.by_channel.remove(channel);
    }

    pub fn clear(&mut self) {
        self.by_channel.clear();
    }

    pub fn add(&mut self, channel: &str, login: &str, display: &str) {
        let key = login
            .trim()
            .trim_start_matches(['@', '+', '%', '~', '&'])
            .to_ascii_lowercase();
        if !valid_login(&key) {
            return;
        }
        let shown = display
            .trim()
            .trim_start_matches(['@', '+', '%', '~', '&']);
        let shown = if shown.eq_ignore_ascii_case(&key) && shown.is_ascii() {
            shown
        } else {
            key.as_str()
        };
        let room = self
            .by_channel
            .entry(channel.to_string())
            .or_insert_with(ChannelChatters::default);
        if room.names.contains_key(&key) {
            room.names.insert(key.clone(), shown.to_string());
            touch(&mut room.order, &key);
            return;
        }
        while room.names.len() >= CHATTER_LIMIT {
            if let Some(old) = room.order.pop_front() {
                room.names.remove(&old);
            } else {
                break;
            }
        }
        room.names.insert(key.clone(), shown.to_string());
        room.order.push_back(key);
    }

    pub fn remove(&mut self, channel: &str, login: &str) {
        let Some(room) = self.by_channel.get_mut(channel) else {
            return;
        };
        let key = login
            .trim()
            .trim_start_matches(['@', '+', '%', '~', '&'])
            .to_ascii_lowercase();
        if room.names.remove(&key).is_some() {
            if let Some(pos) = room.order.iter().position(|k| k == &key) {
                room.order.remove(pos);
            }
        }
    }

    pub fn add_many(&mut self, channel: &str, logins: &[String]) {
        for login in logins {
            self.add(channel, login, login);
        }
    }

    pub fn len(&self, channel: &str) -> usize {
        self.by_channel
            .get(channel)
            .map(|room| room.names.len())
            .unwrap_or(0)
    }

    pub fn prefixed(
        &self,
        channel: &str,
        prefix: &str,
        include_broadcaster: bool,
    ) -> Vec<String> {
        let needle = prefix
            .strip_prefix('@')
            .unwrap_or(prefix)
            .to_ascii_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let mut out = if let Some(room) = self.by_channel.get(channel) {
            room.names
                .iter()
                .filter(|(k, _)| k.starts_with(&needle))
                .map(|(_, display)| display.clone())
                .collect()
        } else {
            Vec::new()
        };
        if include_broadcaster {
            push_broadcaster_if_missing(channel, &needle, &mut out);
        }
        out
    }

    pub fn contains(&self, channel: &str, login: &str) -> bool {
        let key = login
            .trim()
            .trim_start_matches(['@', '+', '%', '~', '&'])
            .to_ascii_lowercase();
        if !valid_login(&key) {
            return false;
        }
        self.by_channel
            .get(channel)
            .is_some_and(|room| room.names.contains_key(&key))
    }
}

fn touch(order: &mut VecDeque<String>, key: &str) {
    if let Some(pos) = order.iter().position(|k| k == key) {
        order.remove(pos);
    }
    order.push_back(key.to_string());
}

fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 25
        && login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn push_broadcaster_if_missing(channel: &str, needle: &str, out: &mut Vec<String>) {
    let login = channel.trim().to_ascii_lowercase();
    if !valid_login(&login) || !login.starts_with(needle) {
        return;
    }
    if out.iter().any(|n| n.eq_ignore_ascii_case(&login)) {
        return;
    }
    out.push(login);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_and_at() {
        let mut set = Chatters::default();
        set.add("xqc", "Xqc", "xQc");
        set.add("xqc", "xqcow", "xqcow");
        let mut got = set.prefixed("xqc", "xq", false);
        crate::chat::complete::rank_prefix(&mut got, "xq");
        assert_eq!(got, vec!["xQc".to_string(), "xqcow".to_string()]);
        let mut at = set.prefixed("xqc", "@xq", false);
        crate::chat::complete::rank_prefix(&mut at, "@xq");
        assert_eq!(at, vec!["xQc".to_string(), "xqcow".to_string()]);
        assert!(set.prefixed("other", "xq", false).is_empty());
        set.add("xqc", "%modder", "Modder");
        let mut mods = set.prefixed("xqc", "mo", false);
        crate::chat::complete::rank_prefix(&mut mods, "mo");
        assert!(mods.iter().any(|n| n == "Modder"));
    }

    #[test]
    fn keeps_separate_channels() {
        let mut set = Chatters::default();
        set.add("xqc", "bob", "bob");
        set.add("lirik", "alice", "alice");
        assert_eq!(set.prefixed("xqc", "bo", false), vec!["bob".to_string()]);
        assert_eq!(set.prefixed("lirik", "al", false), vec!["alice".to_string()]);
        set.drop_channel("xqc");
        assert!(set.prefixed("xqc", "bo", false).is_empty());
        assert_eq!(set.prefixed("lirik", "al", false), vec!["alice".to_string()]);
    }

    #[test]
    fn evicts_oldest() {
        let mut set = Chatters::default();
        for i in 0..CHATTER_LIMIT {
            set.add("xqc", &format!("u{i}"), &format!("u{i}"));
        }
        set.add("xqc", "fresh", "fresh");
        let room = set.by_channel.get("xqc").unwrap();
        assert_eq!(room.names.len(), CHATTER_LIMIT);
        assert!(!room.names.contains_key("u0"));
        assert!(room.names.contains_key("fresh"));
        assert!(room.names.contains_key(&format!("u{}", CHATTER_LIMIT - 1)));
    }

    #[test]
    fn part_removes() {
        let mut set = Chatters::default();
        set.add("xqc", "bob", "bob");
        set.remove("xqc", "bob");
        assert!(set.prefixed("xqc", "bo", false).is_empty());
    }

    #[test]
    fn completion_uses_ascii_case_not_localized() {
        let mut set = Chatters::default();
        set.add("xqc", "bob", "밥");
        set.add("xqc", "alice", "Alice");
        let mut bob = set.prefixed("xqc", "bo", false);
        crate::chat::complete::rank_prefix(&mut bob, "bo");
        assert_eq!(bob, vec!["bob".to_string()]);
        let mut alice = set.prefixed("xqc", "al", false);
        crate::chat::complete::rank_prefix(&mut alice, "al");
        assert_eq!(alice, vec!["Alice".to_string()]);
        set.add("xqc", "eve", "@@eve");
        let mut eve = set.prefixed("xqc", "ev", false);
        crate::chat::complete::rank_prefix(&mut eve, "ev");
        assert_eq!(eve, vec!["eve".to_string()]);
        assert!(set.prefixed("xqc", "@@ev", false).is_empty());
    }

    #[test]
    fn contains_login() {
        let mut set = Chatters::default();
        set.add("xqc", "Bob", "Bob");
        assert!(set.contains("xqc", "bob"));
        assert!(set.contains("xqc", "@Bob"));
        assert!(!set.contains("xqc", "alice"));
        assert!(!set.contains("other", "bob"));
    }

    #[test]
    fn len_tracks_channel_size() {
        let mut set = Chatters::default();
        assert_eq!(set.len("xqc"), 0);
        set.add("xqc", "a", "a");
        set.add("xqc", "b", "b");
        assert_eq!(set.len("xqc"), 2);
        set.remove("xqc", "a");
        assert_eq!(set.len("xqc"), 1);
    }

    #[test]
    fn include_broadcaster_injects_when_absent() {
        let set = Chatters::default();
        let got = set.prefixed("xqc", "xq", true);
        assert_eq!(got, vec!["xqc".to_string()]);
    }

    #[test]
    fn include_broadcaster_no_duplicate() {
        let mut set = Chatters::default();
        set.add("xqc", "xqc", "xQc");
        set.add("xqc", "xqcow", "xqcow");
        let got = set.prefixed("xqc", "xq", true);
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|n| n == "xQc"));
        assert!(got.iter().any(|n| n == "xqcow"));
    }

    #[test]
    fn include_broadcaster_off() {
        let set = Chatters::default();
        assert!(set.prefixed("xqc", "xq", false).is_empty());
    }

    #[test]
    fn include_broadcaster_respects_prefix() {
        let set = Chatters::default();
        assert!(set.prefixed("xqc", "zz", true).is_empty());
    }
}
