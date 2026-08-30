use super::pending::Pending;
use super::room_modes::RoomModes;
use super::scrollback::Scrollback;
use super::send_wait::{self, SendWait};
use super::similarity::{self, SimilarityCfg, SimilarityRecent};
use super::timeout_stack::{PushOutcome, TimeoutStackStyle};
use super::types::{ChatBatch, ChatEvent};

use std::collections::HashSet;

pub struct ChannelBuf {
    pub scrollback: Scrollback,
    pub pending: Pending,
    room_modes: Option<RoomModes>,
    send_wait: SendWait,
    self_high_rate: bool,
    self_is_mod: bool,
    self_is_broadcaster: bool,
    live: bool,
    similarity_recent: SimilarityRecent,
}

impl ChannelBuf {
    pub fn new(channel_id: &str, scrollback_limit: usize) -> Self {
        Self {
            scrollback: Scrollback::with_limit(scrollback_limit),
            pending: Pending::new(channel_id),
            room_modes: None,
            send_wait: SendWait::default(),
            self_high_rate: false,
            self_is_mod: false,
            self_is_broadcaster: false,
            live: false,
            similarity_recent: SimilarityRecent::default(),
        }
    }

    pub fn set_scrollback_limit(&mut self, limit: usize) {
        self.scrollback.set_limit(limit);
    }

    pub fn is_live(&self) -> bool {
        self.live
    }

    pub fn self_high_rate(&self) -> bool {
        self.self_high_rate
    }

    pub fn self_is_mod(&self) -> bool {
        self.self_is_mod
    }

    pub fn self_is_broadcaster(&self) -> bool {
        self.self_is_broadcaster
    }

    fn self_rate_limit(&self) -> bool {
        self.self_high_rate
    }

    /// Returns true when the live flag changed.
    pub fn set_live(&mut self, live: bool) -> bool {
        if self.live == live {
            return false;
        }
        self.live = live;
        true
    }

    pub fn room_modes(&self) -> Option<RoomModes> {
        self.room_modes
    }

    /// ROOMSTATE / USERSTATE: merge or send-wait side effects; drop from scrollback.
    fn expand(&mut self, event: ChatEvent) -> Vec<ChatEvent> {
        match &event {
            ChatEvent::Roomstate { .. } => {
                let base = self.room_modes.unwrap_or_default();
                if let Some(next) = base.merge_event(&event) {
                    if next.slow_sec == 0 {
                        self.send_wait.clear();
                    }
                    self.room_modes = Some(next);
                }
                return Vec::new();
            }
            ChatEvent::Userstate {
                badges, is_mod_tag, ..
            } => {
                self.self_is_mod = *is_mod_tag || send_wait::is_mod_badges(badges);
                self.self_is_broadcaster = send_wait::is_broadcaster_badges(badges);
                self.self_high_rate = send_wait::has_high_rate_limit(badges) || *is_mod_tag;
                if self.self_rate_limit() {
                    self.send_wait.clear();
                }
                return Vec::new();
            }
            _ => {}
        }
        vec![event]
    }

    pub fn ingest(
        &mut self,
        event: ChatEvent,
        self_login: Option<&str>,
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
    ) -> Option<ChatBatch> {
        self.ingest_logged(event, self_login, sim, stack_style, |_| {})
    }

    pub fn ingest_logged(
        &mut self,
        event: ChatEvent,
        self_login: Option<&str>,
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
        mut on_added: impl FnMut(&ChatEvent),
    ) -> Option<ChatBatch> {
        let mut flushed: Option<ChatBatch> = None;
        for item in self.expand(event) {
            self.note_send_wait(&item, self_login);
            if let Some(batch) = self.ingest_one(item, self_login, sim, stack_style, &mut on_added)
            {
                flushed = Some(merge_batches(flushed, batch));
            }
        }
        flushed
    }

    /// Inactive channel: keep scrollback + room mode state, no live pending.
    pub fn push_scrollback_only(
        &mut self,
        event: ChatEvent,
        self_login: Option<&str>,
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
    ) {
        self.push_scrollback_only_logged(event, self_login, sim, stack_style, |_| {});
    }

    pub fn push_scrollback_only_logged(
        &mut self,
        event: ChatEvent,
        self_login: Option<&str>,
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
        mut on_added: impl FnMut(&ChatEvent),
    ) {
        for mut item in self.expand(event) {
            self.note_send_wait(&item, self_login);
            similarity::mark_similar(&self.similarity_recent, &mut item, sim, self_login);
            self.similarity_recent.remember(&item);
            let outcome = self.scrollback.push(item, stack_style);
            if let PushOutcome::Added(ev) = &outcome {
                on_added(ev);
            }
        }
    }

    fn note_send_wait(&mut self, event: &ChatEvent, self_login: Option<&str>) {
        let slow = self.room_modes.map(|m| m.slow_sec).unwrap_or(0);
        send_wait::apply_event(&mut self.send_wait, event, self_login, slow);
    }

    fn ingest_one(
        &mut self,
        mut event: ChatEvent,
        self_login: Option<&str>,
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
        on_added: &mut impl FnMut(&ChatEvent),
    ) -> Option<ChatBatch> {
        similarity::mark_similar(&self.similarity_recent, &mut event, sim, self_login);
        self.similarity_recent.remember(&event);
        let outcome = self.scrollback.push(event, stack_style);
        let live_event = match &outcome {
            PushOutcome::Added(ev) | PushOutcome::Replaced(ev) => ev.clone(),
        };
        if matches!(outcome, PushOutcome::Added(_)) {
            on_added(&live_event);
        }
        if matches!(outcome, PushOutcome::Replaced(_))
            && self.pending.upsert_by_id(live_event.clone())
        {
            return None;
        }
        if self.pending.would_exceed(&live_event) {
            let flushed = self.pending.take_batch();
            let _accepted = self.pending.push(live_event);
            debug_assert!(_accepted);
            return flushed;
        }
        let _accepted = self.pending.push(live_event);
        debug_assert!(_accepted);
        if self.pending.should_flush() {
            return self.pending.take_batch();
        }
        None
    }

    pub fn flush(&mut self) -> Option<ChatBatch> {
        self.pending.take_batch()
    }

    /// Prepend history snapshot events; dedup by id against existing scrollback.
    pub fn prepend_history(&mut self, events: Vec<ChatEvent>) -> usize {
        let existing: HashSet<String> = self
            .scrollback
            .snapshot()
            .iter()
            .map(|e| e.id().to_string())
            .collect();
        let filtered: Vec<ChatEvent> = events
            .into_iter()
            .filter(|e| !existing.contains(e.id()))
            .collect();
        self.scrollback.prepend_front(&filtered)
    }

    /// Merge gap history into scrollback in timestamp order.
    pub fn fill_in_missing(&mut self, events: Vec<ChatEvent>) -> usize {
        self.scrollback.fill_in_missing(&events)
    }

    pub fn snapshot_batch(&self, channel_id: &str) -> ChatBatch {
        ChatBatch {
            channel_id: channel_id.to_string(),
            seq: self.pending.seq(),
            dropped: 0,
            events: self.scrollback.snapshot(),
        }
    }

    /// Changed wait label for `chat:send-wait` (empty string clears UI).
    pub fn poll_send_wait(&mut self) -> Option<String> {
        self.send_wait.poll_emit()
    }

    /// On channel drop: clear timer and emit "" if UI had a countdown.
    pub fn clear_send_wait_for_drop(&mut self) -> Option<String> {
        self.send_wait.clear_for_drop()
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
    use crate::chat::timeout_stack::TimeoutStackStyle;
    use crate::chat::types::{Badge, ChatEvent};

    fn no_stack() -> TimeoutStackStyle {
        TimeoutStackStyle::DontStack
    }

    fn notice(id: &str) -> ChatEvent {
        ChatEvent::Notice {
            id: id.to_string(),
            timestamp_ms: 1,
            text: id.to_string(),

        msg_id: None,

        timeout_remaining_sec: None,
        }
    }

    #[test]
    fn ingest_stacks_clearchat_and_emits_updated_event() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        let style = TimeoutStackStyle::Stack;
        for i in 0..2 {
            let _ = buf.ingest(
                ChatEvent::Clearchat {
                    id: format!("c{i}"),
                    timestamp_ms: 1000 + i,
                    target_login: Some("dev".into()),
                    duration_sec: Some(600),
                    stack_count: 1,
                },
                None,
                &SimilarityCfg::default(),
                style,
            );
        }
        let snap = buf.snapshot_batch("xqc");
        assert_eq!(snap.events.len(), 1);
        match &snap.events[0] {
            ChatEvent::Clearchat { stack_count, .. } => assert_eq!(*stack_count, 2),
            other => panic!("{other:?}"),
        }
        let live = buf.flush().expect("batch");
        assert_eq!(live.events.len(), 1);
        match &live.events[0] {
            ChatEvent::Clearchat { stack_count, .. } => assert_eq!(*stack_count, 2),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn prepend_history_dedups_existing_ids() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        assert_eq!(buf.prepend_history(vec![notice("a"), notice("b")]), 2);
        assert_eq!(buf.prepend_history(vec![notice("b"), notice("c")]), 1);
        let ids: Vec<String> = buf
            .scrollback
            .snapshot()
            .iter()
            .map(|e| e.id().to_string())
            .collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(ids.iter().filter(|id| id.as_str() == "b").count(), 1);
        assert!(ids.contains(&"a".to_string()));
        assert!(ids.contains(&"c".to_string()));
    }

    #[test]
    fn snapshot_flushes_pending_and_advances_seq() {
        let mut hub = crate::chat::hub::Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.ingest(
            "xqc",
            notice("1"),
            None,
            &SimilarityCfg::default(),
            no_stack(),
        );
        let snap = hub.snapshot("xqc").unwrap();
        assert_eq!(snap.seq, 1);
        assert_eq!(snap.events.len(), 1);
        assert!(hub.buffer("xqc").flush().is_none());
        hub.ingest(
            "xqc",
            notice("2"),
            None,
            &SimilarityCfg::default(),
            no_stack(),
        );
        let live = hub.flush_all();
        assert_eq!(live[0].seq, 2);
        assert_eq!(live[0].events.len(), 1);
        assert_eq!(live[0].events[0].id(), "2");
    }

    #[test]
    fn ingest_keeps_overflow_in_scrollback_not_dropped() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        for i in 0..(BATCH_MAX_MESSAGES + 2) {
            let _ = buf.ingest(
                notice(&i.to_string()),
                None,
                &SimilarityCfg::default(),
                no_stack(),
            );
        }
        assert!(buf.scrollback.len() >= BATCH_MAX_MESSAGES);
    }

    #[test]
    fn roomstate_not_pushed_to_scrollback() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        let _ = buf.ingest(
            ChatEvent::Roomstate {
                id: "r1".into(),
                timestamp_ms: 1,
                emote_only: Some(true),
                subs_only: None,
                slow_sec: None,
                followers_only: None,
            },
            None,
            &SimilarityCfg::default(),
            no_stack(),
        );
        let snap = buf.snapshot_batch("xqc");
        assert!(snap.events.is_empty());
        assert_eq!(buf.room_modes.map(|m| m.emote_only), Some(true));
    }

    #[test]
    fn partial_roomstate_preserves_prior_flags() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        let _ = buf.ingest(
            ChatEvent::Roomstate {
                id: "r1".into(),
                timestamp_ms: 1,
                emote_only: Some(true),
                subs_only: Some(false),
                slow_sec: Some(0),
                followers_only: Some(-1),
            },
            None,
            &SimilarityCfg::default(),
            no_stack(),
        );
        let _ = buf.ingest(
            ChatEvent::Roomstate {
                id: "r2".into(),
                timestamp_ms: 2,
                emote_only: None,
                subs_only: None,
                slow_sec: Some(30),
                followers_only: None,
            },
            None,
            &SimilarityCfg::default(),
            no_stack(),
        );
        let modes = buf.room_modes.expect("modes");
        assert!(modes.emote_only);
        assert_eq!(modes.slow_sec, 30);
    }

    #[test]
    fn own_privmsg_starts_slow_wait() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        let _ = buf.ingest(
            ChatEvent::Roomstate {
                id: "r".into(),
                timestamp_ms: 1,
                emote_only: None,
                subs_only: None,
                slow_sec: Some(10),
                followers_only: None,
            },
            Some("me"),
            &SimilarityCfg::default(),
            no_stack(),
        );
        let _ = buf.ingest(
            ChatEvent::Privmsg {
                id: "p".into(),
                timestamp_ms: 2,
                user_id: "1".into(),
                login: "me".into(),
                display_name: "Me".into(),
                color: "#fff".into(),
                badges: vec![],
                text: "hi".into(),
                emote_spans: vec![],
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
                highlight_flash: false,
                whisper: false,
                disabled: false,
                source_room_id: None,
                source_badges: vec![],
                paint: None,
            },
            Some("me"),
            &SimilarityCfg::default(),
            no_stack(),
        );
        let text = buf.poll_send_wait().expect("wait");
        assert!(text.contains('s') || text.contains('m'), "{text}");
    }

    #[test]
    fn slow_zero_clears_wait() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        let _ = buf.ingest(
            ChatEvent::Roomstate {
                id: "r1".into(),
                timestamp_ms: 1,
                emote_only: None,
                subs_only: None,
                slow_sec: Some(30),
                followers_only: None,
            },
            Some("me"),
            &SimilarityCfg::default(),
            no_stack(),
        );
        let _ = buf.ingest(
            ChatEvent::Privmsg {
                id: "p".into(),
                timestamp_ms: 2,
                user_id: "1".into(),
                login: "me".into(),
                display_name: "Me".into(),
                color: "#fff".into(),
                badges: vec![],
                text: "hi".into(),
                emote_spans: vec![],
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
                highlight_flash: false,
                whisper: false,
                disabled: false,
                source_room_id: None,
                source_badges: vec![],
                paint: None,
            },
            Some("me"),
            &SimilarityCfg::default(),
            no_stack(),
        );
        assert!(buf.poll_send_wait().is_some());
        let _ = buf.ingest(
            ChatEvent::Roomstate {
                id: "r2".into(),
                timestamp_ms: 3,
                emote_only: None,
                subs_only: None,
                slow_sec: Some(0),
                followers_only: None,
            },
            Some("me"),
            &SimilarityCfg::default(),
            no_stack(),
        );
        assert_eq!(buf.poll_send_wait().as_deref(), Some(""));
    }

    #[test]
    fn mod_badge_skips_slow_wait() {
        let mut buf = ChannelBuf::new("xqc", 1000);
        let _ = buf.ingest(
            ChatEvent::Roomstate {
                id: "r".into(),
                timestamp_ms: 1,
                emote_only: None,
                subs_only: None,
                slow_sec: Some(10),
                followers_only: None,
            },
            Some("me"),
            &SimilarityCfg::default(),
            no_stack(),
        );
        let _ = buf.ingest(
            ChatEvent::Privmsg {
                id: "p".into(),
                timestamp_ms: 2,
                user_id: "1".into(),
                login: "me".into(),
                display_name: "Me".into(),
                color: "#fff".into(),
                badges: vec![Badge {
                    set: "moderator".into(),
                    version: "1".into(),
                    url: None,
                    source: "twitch".into(),
                    tooltip: None,
                }],
                text: "hi".into(),
                emote_spans: vec![],
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
                highlight_flash: false,
                whisper: false,
                disabled: false,
                source_room_id: None,
                source_badges: vec![],
                paint: None,
            },
            Some("me"),
            &SimilarityCfg::default(),
            no_stack(),
        );
        assert!(buf.poll_send_wait().is_none());
    }
}
