// MIT reimplementation of Chatterino ChannelChatters join/part batching (500ms merge).

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use tauri::AppHandle;

use super::filters;
use super::state::Shared;

const SHOW_CHATTER_LIMIT: usize = 1000;
const BATCH_DELAY_MS: u64 = 500;

#[derive(Default)]
struct PendingBatch {
    logins: BTreeSet<String>,
    generation: u64,
    timer_armed: bool,
}

#[derive(Default)]
pub struct MembershipBatcher {
    joined: HashMap<String, PendingBatch>,
    parted: HashMap<String, PendingBatch>,
    next_gen: u64,
}

impl MembershipBatcher {
    fn next_generation(&mut self) -> u64 {
        self.next_gen = self.next_gen.wrapping_add(1);
        self.next_gen
    }

    pub fn push_join(&mut self, channel: &str, login: &str) -> Option<u64> {
        let key = login.trim().to_ascii_lowercase();
        if key.is_empty() {
            return None;
        }
        let needs_timer = {
            let entry = self.joined.entry(channel.to_string()).or_default();
            entry.logins.insert(key);
            !entry.timer_armed
        };
        if !needs_timer {
            return None;
        }
        let gen = self.next_generation();
        let entry = self.joined.get_mut(channel).expect("channel batch");
        entry.timer_armed = true;
        entry.generation = gen;
        Some(gen)
    }

    pub fn push_part(&mut self, channel: &str, login: &str) -> Option<u64> {
        let key = login.trim().to_ascii_lowercase();
        if key.is_empty() {
            return None;
        }
        let needs_timer = {
            let entry = self.parted.entry(channel.to_string()).or_default();
            entry.logins.insert(key);
            !entry.timer_armed
        };
        if !needs_timer {
            return None;
        }
        let gen = self.next_generation();
        let entry = self.parted.get_mut(channel).expect("channel batch");
        entry.timer_armed = true;
        entry.generation = gen;
        Some(gen)
    }

    pub fn take_join(&mut self, channel: &str, generation: u64) -> Option<String> {
        let entry = self.joined.get_mut(channel)?;
        if entry.generation != generation || entry.logins.is_empty() {
            return None;
        }
        let text = format_user_list("Users joined:", &entry.logins);
        entry.logins.clear();
        entry.timer_armed = false;
        Some(text)
    }

    pub fn take_part(&mut self, channel: &str, generation: u64) -> Option<String> {
        let entry = self.parted.get_mut(channel)?;
        if entry.generation != generation || entry.logins.is_empty() {
            return None;
        }
        let text = format_user_list("Users parted:", &entry.logins);
        entry.logins.clear();
        entry.timer_armed = false;
        Some(text)
    }
}

pub fn knob_enabled(shared: &Shared, join: bool) -> bool {
    let key = if join {
        "behaviour.showJoins"
    } else {
        "behaviour.showParts"
    };
    shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| inner.data.knobs.get(key).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

pub fn should_show(
    shared: &Shared,
    channel: &str,
    login: &str,
    self_login: Option<&str>,
    join: bool,
) -> bool {
    if !knob_enabled(shared, join) {
        return false;
    }
    if self_login.is_some_and(|s| s.eq_ignore_ascii_case(login)) {
        return false;
    }
    if !shared
        .hub
        .lock()
        .ok()
        .is_some_and(|hub| hub.has_channel(channel))
    {
        return false;
    }
    let count = shared
        .chatters
        .lock()
        .ok()
        .map(|set| set.len(channel))
        .unwrap_or(0);
    if count >= SHOW_CHATTER_LIMIT {
        return false;
    }
    !filters::membership_login_ignored(shared, channel, login)
}

pub fn record_join(shared: &Shared, app: &AppHandle, channel: String, login: String) {
    let gen = match shared.membership_batch.lock() {
        Ok(mut batcher) => batcher.push_join(&channel, &login),
        Err(_) => return,
    };
    if let Some(gen) = gen {
        let shared = shared.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(BATCH_DELAY_MS)).await;
            flush_join(shared, app, channel, gen);
        });
    }
}

pub fn record_part(shared: &Shared, app: &AppHandle, channel: String, login: String) {
    let gen = match shared.membership_batch.lock() {
        Ok(mut batcher) => batcher.push_part(&channel, &login),
        Err(_) => return,
    };
    if let Some(gen) = gen {
        let shared = shared.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(BATCH_DELAY_MS)).await;
            flush_part(shared, app, channel, gen);
        });
    }
}

fn flush_join(shared: Shared, app: AppHandle, channel: String, generation: u64) {
    let text = match shared.membership_batch.lock() {
        Ok(mut batcher) => batcher.take_join(&channel, generation),
        Err(_) => return,
    };
    if let Some(text) = text {
        shared.post_channel_notice(&app, &channel, text);
    }
}

fn flush_part(shared: Shared, app: AppHandle, channel: String, generation: u64) {
    let text = match shared.membership_batch.lock() {
        Ok(mut batcher) => batcher.take_part(&channel, generation),
        Err(_) => return,
    };
    if let Some(text) = text {
        shared.post_channel_notice(&app, &channel, text);
    }
}

pub(crate) fn format_user_list(prefix: &str, logins: &BTreeSet<String>) -> String {
    let joined = logins
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    format!("{prefix} {joined}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::state::Shared;
    use serde_json::json;

    #[test]
    fn merges_sorted_join_logins() {
        let mut batcher = MembershipBatcher::default();
        let gen = batcher.push_join("xqc", "zebra").unwrap();
        assert!(batcher.push_join("xqc", "alpha").is_none());
        let text = batcher.take_join("xqc", gen).unwrap();
        assert_eq!(text, "Users joined: alpha, zebra");
        assert!(batcher.take_join("xqc", gen).is_none());
    }

    #[test]
    fn stale_generation_does_not_flush() {
        let mut batcher = MembershipBatcher::default();
        let gen1 = batcher.push_join("xqc", "a").unwrap();
        let gen2 = batcher.push_join("lirik", "b").unwrap();
        assert!(batcher.take_join("xqc", gen2).is_none());
        let text = batcher.take_join("xqc", gen1).unwrap();
        assert_eq!(text, "Users joined: a");
    }

    #[test]
    fn knob_defaults_off() {
        let shared = Shared::new();
        assert!(!knob_enabled(&shared, true));
        assert!(!knob_enabled(&shared, false));
    }

    #[test]
    fn should_show_respects_knob_and_limit() {
        let shared = Shared::new();
        {
            let mut hub = shared.hub.lock().unwrap();
            hub.set_active(Some("xqc".into()));
        }
        assert!(!should_show(&shared, "xqc", "ann", Some("me"), true));
        {
            let mut inner = shared.settings.lock().unwrap();
            inner
                .data
                .knobs
                .insert("behaviour.showJoins".into(), json!(true));
        }
        assert!(should_show(&shared, "xqc", "ann", Some("me"), true));
        assert!(!should_show(&shared, "xqc", "me", Some("me"), true));
        {
            let mut set = shared.chatters.lock().unwrap();
            for i in 0..SHOW_CHATTER_LIMIT {
                set.add("xqc", &format!("user{i}"), &format!("user{i}"));
            }
        }
        assert!(!should_show(&shared, "xqc", "ann", Some("me"), true));
    }

    #[test]
    fn format_user_list_sorted() {
        let mut logins = BTreeSet::new();
        logins.insert("bob".into());
        logins.insert("ann".into());
        assert_eq!(
            format_user_list("Users parted:", &logins),
            "Users parted: ann, bob"
        );
    }
}
