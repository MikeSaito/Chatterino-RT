use super::pending::Pending;
use super::room_modes::RoomModes;
use super::scrollback::Scrollback;
use super::types::{ChatBatch, ChatEvent};

pub struct ChannelBuf {
    pub scrollback: Scrollback,
    pub pending: Pending,
    room_modes: Option<RoomModes>,
}

impl ChannelBuf {
    pub fn new(channel_id: &str) -> Self {
        Self {
            scrollback: Scrollback::new(),
            pending: Pending::new(channel_id),
            room_modes: None,
        }
    }

    /// ROOMSTATE: merge channel modes only (notices come from Twitch NOTICE). Drop from scrollback.
    fn expand(&mut self, event: ChatEvent) -> Vec<ChatEvent> {
        if matches!(&event, ChatEvent::Roomstate { .. }) {
            let base = self.room_modes.unwrap_or_default();
            if let Some(next) = base.merge_event(&event) {
                self.room_modes = Some(next);
            }
            return Vec::new();
        }
        vec![event]
    }

    pub fn ingest(&mut self, event: ChatEvent) -> Option<ChatBatch> {
        let mut flushed: Option<ChatBatch> = None;
        for item in self.expand(event) {
            if let Some(batch) = self.ingest_one(item) {
                flushed = Some(merge_batches(flushed, batch));
            }
        }
        flushed
    }

    /// Inactive channel: keep scrollback + room mode state, no live pending.
    pub fn push_scrollback_only(&mut self, event: ChatEvent) {
        for item in self.expand(event) {
            self.scrollback.push(item);
        }
    }

    fn ingest_one(&mut self, event: ChatEvent) -> Option<ChatBatch> {
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

fn merge_batches(prev: Option<ChatBatch>, next: ChatBatch) -> ChatBatch {
    match prev {
        None => next,
        Some(mut a) => {
            a.events.extend(next.events);
            a.dropped = a.dropped.saturating_add(next.dropped);
            a.seq = next.seq;
            a
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
        for i in 0..(BATCH_MAX_MESSAGES + 2) {
            let _ = buf.ingest(notice(&i.to_string()));
        }
        assert!(buf.scrollback.len() >= BATCH_MAX_MESSAGES);
    }

    #[test]
    fn roomstate_not_pushed_to_scrollback() {
        let mut buf = ChannelBuf::new("xqc");
        let _ = buf.ingest(ChatEvent::Roomstate {
            id: "r1".into(),
            timestamp_ms: 1,
            emote_only: Some(true),
            subs_only: None,
            slow_sec: None,
            followers_only: None,
        });
        let snap = buf.snapshot_batch("xqc");
        assert!(snap.events.is_empty());
        assert_eq!(buf.room_modes.map(|m| m.emote_only), Some(true));
    }

    #[test]
    fn partial_roomstate_preserves_prior_flags() {
        let mut buf = ChannelBuf::new("xqc");
        let _ = buf.ingest(ChatEvent::Roomstate {
            id: "r1".into(),
            timestamp_ms: 1,
            emote_only: Some(true),
            subs_only: Some(false),
            slow_sec: Some(0),
            followers_only: Some(-1),
        });
        let _ = buf.ingest(ChatEvent::Roomstate {
            id: "r2".into(),
            timestamp_ms: 2,
            emote_only: None,
            subs_only: None,
            slow_sec: Some(30),
            followers_only: None,
        });
        let modes = buf.room_modes.expect("modes");
        assert!(modes.emote_only);
        assert_eq!(modes.slow_sec, 30);
    }
}
