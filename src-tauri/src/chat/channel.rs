use super::pending::Pending;
use super::scrollback::Scrollback;
use super::types::{ChatBatch, ChatEvent};

pub struct ChannelBuf {
    pub scrollback: Scrollback,
    pub pending: Pending,
}

impl ChannelBuf {
    pub fn new(channel_id: &str) -> Self {
        Self {
            scrollback: Scrollback::new(),
            pending: Pending::new(channel_id),
        }
    }

    pub fn ingest(&mut self, event: ChatEvent) -> Option<ChatBatch> {
        self.scrollback.push(event.clone());
        if self.pending.would_exceed(&event) {
            let flushed = self.pending.take_batch();
            let _accepted = self.pending.push(event);
            debug_assert!(_accepted);
            return flushed;
        }
        let _accepted = self.pending.push(event);
        debug_assert!(_accepted);
        if self.pending.should_flush() {
            return self.pending.take_batch();
        }
        None
    }

    pub fn flush(&mut self) -> Option<ChatBatch> {
        self.pending.take_batch()
    }

    pub fn snapshot_batch(&self, channel_id: &str) -> ChatBatch {
        ChatBatch {
            channel_id: channel_id.to_string(),
            seq: self.pending.seq(),
            dropped: 0,
            events: self.scrollback.snapshot(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::constants::BATCH_MAX_MESSAGES;
    use crate::chat::types::ChatEvent;

    fn notice(id: &str) -> ChatEvent {
        ChatEvent::Notice {
            id: id.to_string(),
            timestamp_ms: 1,
            text: id.to_string(),
        }
    }

    #[test]
    fn snapshot_flushes_pending_and_advances_seq() {
        let mut hub = crate::chat::hub::Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.ingest("xqc", notice("1"));
        let snap = hub.snapshot("xqc").unwrap();
        assert_eq!(snap.seq, 1);
        assert_eq!(snap.events.len(), 1);
        assert!(hub.buffer("xqc").flush().is_none());
        hub.ingest("xqc", notice("2"));
        let live = hub.flush_all();
        assert_eq!(live[0].seq, 2);
        assert_eq!(live[0].events.len(), 1);
        assert_eq!(live[0].events[0].id(), "2");
    }

    #[test]
    fn ingest_keeps_overflow_in_scrollback_not_dropped() {
        let mut buf = ChannelBuf::new("xqc");
        let mut flushed = 0usize;
        for i in 0..(BATCH_MAX_MESSAGES + 3) {
            if buf.ingest(notice(&i.to_string())).is_some() {
                flushed += 1;
            }
        }
        assert_eq!(flushed, 1);
        assert_eq!(buf.scrollback.len(), BATCH_MAX_MESSAGES + 3);
        let rest = buf.flush().unwrap();
        assert_eq!(rest.dropped, 0);
        assert_eq!(rest.events.len(), 3);
    }
}
