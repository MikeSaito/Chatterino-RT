use std::collections::HashMap;

use super::channel::ChannelBuf;
use super::types::{ChatBatch, ChatEvent};

#[derive(Default)]
pub struct Hub {
    pub active: Option<String>,
    buffers: HashMap<String, ChannelBuf>,
}

impl Hub {
    pub fn buffer(&mut self, channel: &str) -> &mut ChannelBuf {
        self.buffers
            .entry(channel.to_string())
            .or_insert_with(|| ChannelBuf::new(channel))
    }

    pub fn ingest(&mut self, channel: &str, event: ChatEvent) -> Option<ChatBatch> {
        if self.active.as_deref() != Some(channel) {
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
        self.active = channel.clone();
        match &self.active {
            Some(ch) => self.buffers.retain(|k, _| k == ch),
            None => self.buffers.clear(),
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
    fn ingest_ignores_inactive_channel() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        assert!(hub.ingest("xqc", notice("1")).is_none());
        assert!(hub.ingest("other", notice("nope")).is_none());
        let snap = hub.snapshot("xqc").unwrap();
        assert_eq!(snap.events.len(), 1);
        assert!(hub.snapshot("other").is_none());
    }
}
