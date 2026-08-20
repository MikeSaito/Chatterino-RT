use std::collections::HashMap;

use super::channel::ChannelBuf;
use super::types::{ChatBatch, ChatEvent};

#[derive(Default)]
pub struct Hub {
    pub active: Option<String>,
    pub joined: bool,
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

    pub fn ingest(&mut self, channel: &str, event: ChatEvent) -> Option<ChatBatch> {
        if self.active.as_deref() != Some(channel) {
            if self.buffers.contains_key(channel) {
                self.buffer(channel).scrollback.push(event);
            }
            return None;
        }
        self.buffer(channel).ingest(event)
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
        let buf = self.buffers.get_mut(channel)?;
        let _ = buf.flush();
        Some(buf.snapshot_batch(channel))
    }

    pub fn set_active(&mut self, channel: Option<String>) {
        self.active = channel;
        self.joined = false;
        if let Some(ch) = self.active.clone() {
            self.buffer(&ch);
        }
    }

    pub fn drop_channel(&mut self, channel: &str) {
        self.buffers.remove(channel);
        if self.active.as_deref() == Some(channel) {
            self.active = None;
            self.joined = false;
        }
    }

    pub fn clear_all(&mut self) {
        self.buffers.clear();
        self.active = None;
        self.joined = false;
    }

    pub fn set_joined(&mut self, channel: &str, yes: bool) {
        if self.active.as_deref() == Some(channel) {
            self.joined = yes;
        }
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
        assert!(hub.ingest("xqc", notice("1")).is_none());
        assert!(hub.ingest("other", notice("nope")).is_none());
        let snap = hub.snapshot("xqc").unwrap();
        assert_eq!(snap.events.len(), 1);
        assert!(hub.snapshot("other").is_none());
    }

    #[test]
    fn inactive_joined_keeps_scrollback() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.buffer("lirik");
        hub.ingest("lirik", notice("a"));
        hub.set_active(Some("lirik".into()));
        let snap = hub.snapshot("lirik").unwrap();
        assert_eq!(snap.events.len(), 1);
        assert!(hub.snapshot("xqc").is_some());
    }

    #[test]
    fn set_active_clears_joined() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.set_joined("xqc", true);
        assert!(hub.joined);
        hub.set_active(Some("lirik".into()));
        assert!(!hub.joined);
    }
}
