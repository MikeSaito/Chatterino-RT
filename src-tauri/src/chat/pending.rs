use super::constants::{BATCH_MAX_BYTES, BATCH_MAX_MESSAGES};
use super::types::{ChatBatch, ChatEvent};

#[derive(Debug, Default)]
pub struct Pending {
    channel_id: String,
    seq: u64,
    dropped: u32,
    events: Vec<ChatEvent>,
    bytes: usize,
}

impl Pending {
    pub fn new(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            seq: 0,
            dropped: 0,
            events: Vec::with_capacity(BATCH_MAX_MESSAGES),
            bytes: 0,
        }
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    fn event_bytes(event: &ChatEvent) -> usize {
        rmp_serde::to_vec_named(event).map(|v| v.len()).unwrap_or(0)
    }

    pub fn would_exceed(&self, event: &ChatEvent) -> bool {
        if self.events.is_empty() {
            return false;
        }
        let extra = Self::event_bytes(event);
        self.events.len() >= BATCH_MAX_MESSAGES || self.bytes + extra > BATCH_MAX_BYTES
    }

    pub fn push(&mut self, event: ChatEvent) -> bool {
        if self.would_exceed(&event) {
            self.dropped = self.dropped.saturating_add(1);
            return false;
        }
        self.bytes += Self::event_bytes(&event);
        self.events.push(event);
        true
    }

    pub fn should_flush(&self) -> bool {
        self.events.len() >= BATCH_MAX_MESSAGES || self.bytes >= BATCH_MAX_BYTES
    }

    pub fn note_undelivered(&mut self, count: u32) {
        self.dropped = self.dropped.saturating_add(count.max(1));
    }

    pub fn take_batch(&mut self) -> Option<ChatBatch> {
        if self.events.is_empty() {
            return None;
        }
        self.seq = self.seq.saturating_add(1);
        let dropped = self.dropped;
        self.dropped = 0;
        self.bytes = 0;
        Some(ChatBatch {
            channel_id: self.channel_id.clone(),
            seq: self.seq,
            dropped,
            events: std::mem::take(&mut self.events),
        })
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
            text: "x".repeat(8),
        }
    }

    #[test]
    fn flush_on_message_limit() {
        let mut p = Pending::new("xqc");
        for i in 0..BATCH_MAX_MESSAGES {
            assert!(p.push(notice(&i.to_string())));
        }
        assert!(p.should_flush());
        let batch = p.take_batch().unwrap();
        assert_eq!(batch.seq, 1);
        assert_eq!(batch.dropped, 0);
        assert_eq!(batch.events.len(), BATCH_MAX_MESSAGES);
        assert_eq!(batch.channel_id, "xqc");
    }

    #[test]
    fn overflow_increments_dropped_not_scrollback() {
        let mut p = Pending::new("xqc");
        for i in 0..BATCH_MAX_MESSAGES {
            assert!(p.push(notice(&i.to_string())));
        }
        assert!(!p.push(notice("overflow")));
        let batch = p.take_batch().unwrap();
        assert_eq!(batch.dropped, 1);
        assert_eq!(batch.events.len(), BATCH_MAX_MESSAGES);
        assert!(batch.events.iter().all(|e| e.id() != "overflow"));
    }

    #[test]
    fn seq_is_monotonic() {
        let mut p = Pending::new("a");
        p.push(notice("1"));
        assert_eq!(p.take_batch().unwrap().seq, 1);
        p.push(notice("2"));
        assert_eq!(p.take_batch().unwrap().seq, 2);
    }
}
