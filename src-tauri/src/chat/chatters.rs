// Reimplementation of Chatterino ChatterSet (MIT). No C++/Qt copied.
// chatterino2/src/common/ChatterSet.hpp CHATTER_LIMIT = 2000.

use std::collections::{HashMap, VecDeque};

pub const CHATTER_LIMIT: usize = 2000;

#[derive(Debug, Default)]
pub struct Chatters {
    channel: Option<String>,
    order: VecDeque<String>,
    names: HashMap<String, String>,
}

impl Chatters {
    pub fn retain_channel(&mut self, channel: &str) {
        if self.channel.as_deref() == Some(channel) {
            return;
        }
        self.clear();
        self.channel = Some(channel.to_string());
    }

    pub fn clear(&mut self) {
        self.channel = None;
        self.order.clear();
        self.names.clear();
    }

    pub fn add(&mut self, channel: &str, login: &str, display: &str) {
        if self.channel.as_deref() != Some(channel) {
            return;
        }
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
        if self.names.contains_key(&key) {
            self.names.insert(key.clone(), shown.to_string());
            touch(&mut self.order, &key);
            return;
        }
        while self.names.len() >= CHATTER_LIMIT {
            if let Some(old) = self.order.pop_front() {
                self.names.remove(&old);
            } else {
                break;
            }
        }
        self.names.insert(key.clone(), shown.to_string());
        self.order.push_back(key);
    }

    pub fn remove(&mut self, channel: &str, login: &str) {
        if self.channel.as_deref() != Some(channel) {
            return;
        }
        let key = login
            .trim()
            .trim_start_matches(['@', '+', '%', '~', '&'])
            .to_ascii_lowercase();
        if self.names.remove(&key).is_some() {
            if let Some(pos) = self.order.iter().position(|k| k == &key) {
                self.order.remove(pos);
            }
        }
    }

    pub fn add_many(&mut self, channel: &str, logins: &[String]) {
        for login in logins {
            self.add(channel, login, login);
        }
    }

    pub fn prefixed(&self, channel: &str, prefix: &str) -> Vec<String> {
        if self.channel.as_deref() != Some(channel) {
            return Vec::new();
        }
        let needle = prefix
            .strip_prefix('@')
            .unwrap_or(prefix)
            .to_ascii_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let out: Vec<String> = self
            .names
            .iter()
            .filter(|(k, _)| k.starts_with(&needle))
            .map(|(_, display)| display.clone())
            .collect();
        out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_and_at() {
        let mut set = Chatters::default();
        set.retain_channel("xqc");
        set.add("xqc", "Xqc", "xQc");
        set.add("xqc", "xqcow", "xqcow");
        let mut got = set.prefixed("xqc", "xq");
        crate::chat::complete::rank_prefix(&mut got, "xq");
        assert_eq!(got, vec!["xQc".to_string(), "xqcow".to_string()]);
        let mut at = set.prefixed("xqc", "@xq");
        crate::chat::complete::rank_prefix(&mut at, "@xq");
        assert_eq!(at, vec!["xQc".to_string(), "xqcow".to_string()]);
        assert!(set.prefixed("other", "xq").is_empty());
        set.add("xqc", "%modder", "Modder");
        let mut mods = set.prefixed("xqc", "mo");
        crate::chat::complete::rank_prefix(&mut mods, "mo");
        assert!(mods.iter().any(|n| n == "Modder"));
    }

    #[test]
    fn evicts_oldest() {
        let mut set = Chatters::default();
        set.retain_channel("xqc");
        for i in 0..CHATTER_LIMIT {
            set.add("xqc", &format!("u{i}"), &format!("u{i}"));
        }
        set.add("xqc", "fresh", "fresh");
        assert_eq!(set.names.len(), CHATTER_LIMIT);
        assert!(!set.names.contains_key("u0"));
        assert!(set.names.contains_key("fresh"));
        assert!(set.names.contains_key(&format!("u{}", CHATTER_LIMIT - 1)));
    }

    #[test]
    fn part_removes() {
        let mut set = Chatters::default();
        set.retain_channel("xqc");
        set.add("xqc", "bob", "bob");
        set.remove("xqc", "bob");
        assert!(set.prefixed("xqc", "bo").is_empty());
    }

    #[test]
    fn completion_uses_ascii_case_not_localized() {
        let mut set = Chatters::default();
        set.retain_channel("xqc");
        set.add("xqc", "bob", "밥");
        set.add("xqc", "alice", "Alice");
        let mut bob = set.prefixed("xqc", "bo");
        crate::chat::complete::rank_prefix(&mut bob, "bo");
        assert_eq!(bob, vec!["bob".to_string()]);
        let mut alice = set.prefixed("xqc", "al");
        crate::chat::complete::rank_prefix(&mut alice, "al");
        assert_eq!(alice, vec!["Alice".to_string()]);
        set.add("xqc", "eve", "@@eve");
        let mut eve = set.prefixed("xqc", "ev");
        crate::chat::complete::rank_prefix(&mut eve, "ev");
        assert_eq!(eve, vec!["eve".to_string()]);
        assert!(set.prefixed("xqc", "@@ev").is_empty());
    }
}
