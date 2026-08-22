use std::collections::{HashMap, HashSet};

use super::channel::ChannelBuf;
use super::types::{ChatBatch, ChatEvent};

#[derive(Default)]
pub struct Hub {
    pub active: Option<String>,
    joined: HashSet<String>,
    buffers: HashMap<String, ChannelBuf>,
}

impl Hub {
    pub fn buffer(&mut self, channel: &str) -> &mut ChannelBuf {
        self.buffers
            .entry(channel.to_string())
            .or_insert_with(|| ChannelBuf::new(channel))
    }

    pub fn has_channel(&self, channel: &str) -> bool {
        self.buffers.contains_key(channel)
    }

    pub fn channels(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.buffers.keys().cloned().collect();
        keys.sort();
        keys
    }

    pub fn joined_active(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|ch| self.joined.contains(ch))
    }

    pub fn is_joined(&self, channel: &str) -> bool {
        self.joined.contains(channel)
    }

    pub fn joined_channels(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.joined.iter().cloned().collect();
        keys.sort();
        keys
    }

    pub fn ingest_fanout_joined(
        &mut self,
        event: ChatEvent,
        self_login: Option<&str>,
    ) -> Vec<ChatBatch> {
        let channels = self.channels();
        let mut batches = Vec::new();
        for ch in channels {
            if let Some(batch) = self.ingest(&ch, event.clone(), self_login) {
                batches.push(batch);
            }
        }
        batches
    }

    pub fn ingest(
        &mut self,
        channel: &str,
        event: ChatEvent,
        self_login: Option<&str>,
    ) -> Option<ChatBatch> {
        if self.active.as_deref() != Some(channel) {
            if self.buffers.contains_key(channel) {
                self.buffer(channel)
                    .push_scrollback_only(event, self_login);
            }
            return None;
        }
        self.buffer(channel).ingest(event, self_login)
    }

    /// Poll all buffers for changed send-wait labels.
    pub fn poll_send_waits(&mut self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (ch, buf) in self.buffers.iter_mut() {
            if let Some(text) = buf.poll_send_wait() {
                out.push((ch.clone(), text));
            }
        }
        out
    }

    pub fn flush_all(&mut self) -> Vec<ChatBatch> {
        match &self.active {
            Some(ch) => self
                .buffers
                .get_mut(ch)
                .and_then(|b| b.flush())
                .into_iter()
                .collect(),
            None => Vec::new(),
        }
    }

    pub fn snapshot(&mut self, channel: &str) -> Option<ChatBatch> {
        // Flush pending into seq so live Channel does not re-send the same
        // events after UI applies this scrollback snapshot (events already in scrollback).
        let buf = self.buffers.get_mut(channel)?;
        let _ = buf.flush();
        Some(buf.snapshot_batch(channel))
    }

    pub fn set_active(&mut self, channel: Option<String>) {
        let changed = self.active != channel;
        self.active = channel;
        if let Some(ch) = self.active.clone() {
            if changed {
                self.buffer(&ch).set_live(false);
            } else {
                self.buffer(&ch);
            }
        }
    }

    pub fn drop_channel(&mut self, channel: &str) -> Option<String> {
        let clear = self
            .buffers
            .get_mut(channel)
            .and_then(|b| b.clear_send_wait_for_drop());
        self.buffers.remove(channel);
        self.joined.remove(channel);
        if self.active.as_deref() == Some(channel) {
            self.active = None;
        }
        clear
    }

    pub fn clear_all(&mut self) {
        self.buffers.clear();
        self.joined.clear();
        self.active = None;
    }

    pub fn set_joined(&mut self, channel: &str, yes: bool) {
        if yes {
            self.joined.insert(channel.to_string());
        } else {
            self.joined.remove(channel);
        }
    }

    pub fn channel_live(&self, channel: &str) -> bool {
        self.buffers
            .get(channel)
            .is_some_and(|buf| buf.is_live())
    }

    /// Returns true when the stored live flag changed.
    pub fn set_channel_live(&mut self, channel: &str, live: bool) -> bool {
        self.buffer(channel).set_live(live)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::ChatEvent;

    fn notice(id: &str) -> ChatEvent {
        ChatEvent::Notice {
            id: id.to_string(),
            timestamp_ms: 1,
            text: id.to_string(),
        }
    }

    #[test]
    fn ingest_ignores_unknown_inactive() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        assert!(hub.ingest("xqc", notice("1"), None).is_none());
        assert!(hub.ingest("other", notice("nope"), None).is_none());
        let snap = hub.snapshot("xqc").unwrap();
        assert_eq!(snap.events.len(), 1);
        assert!(hub.snapshot("other").is_none());
    }

    #[test]
    fn inactive_joined_keeps_scrollback() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.buffer("lirik");
        hub.ingest("lirik", notice("a"), None);
        hub.set_active(Some("lirik".into()));
        let snap = hub.snapshot("lirik").unwrap();
        assert_eq!(snap.events.len(), 1);
        assert!(hub.snapshot("xqc").is_some());
    }

    #[test]
    fn set_active_preserves_joined_flag() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.set_joined("xqc", true);
        assert!(hub.joined_active());
        hub.set_active(Some("lirik".into()));
        assert!(!hub.joined_active());
        assert!(hub.is_joined("xqc"));
        hub.set_active(Some("xqc".into()));
        assert!(hub.joined_active());
    }

    #[test]
    fn set_channel_live_tracks_per_buffer() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        assert!(!hub.channel_live("xqc"));
        assert!(hub.set_channel_live("xqc", true));
        assert!(hub.channel_live("xqc"));
        assert!(!hub.set_channel_live("xqc", true));
        assert!(hub.set_channel_live("xqc", false));
        assert!(!hub.channel_live("xqc"));
    }

    #[test]
    fn ingest_fanout_joined_delivers_to_active_and_scrollback() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.set_joined("xqc", true);
        hub.buffer("lirik");
        hub.set_joined("lirik", true);

        let batches = hub.ingest_fanout_joined(notice("w"), None);
        assert!(batches.is_empty());
        let snap_xqc = hub.snapshot("xqc").unwrap();
        assert_eq!(snap_xqc.events.len(), 1);

        hub.set_active(Some("lirik".into()));
        let snap = hub.snapshot("lirik").unwrap();
        assert_eq!(snap.events.len(), 1);
    }
}
