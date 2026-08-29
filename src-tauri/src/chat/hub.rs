use std::collections::{HashMap, HashSet};

use super::channel::ChannelBuf;
use super::scrollback_config::DEFAULT_SCROLLBACK_LIMIT;
use super::similarity::SimilarityCfg;
use super::timeout_stack::TimeoutStackStyle;
use super::types::{ChatBatch, ChatEvent};

pub struct Hub {
    pub active: Option<String>,
    joined: HashSet<String>,
    buffers: HashMap<String, ChannelBuf>,
    /// Twitch numeric room-id per channel login (from IRC tags).
    room_ids: HashMap<String, String>,
    /// Channels that already received a recent-messages fetch this session.
    recent_loaded: HashSet<String>,
    /// IRC disconnect time per channel (epoch ms) for reconnect gap fill.
    disconnect_at_ms: HashMap<String, u64>,
    stream_game: HashMap<String, String>,
    stream_title: HashMap<String, String>,
    stream_id: HashMap<String, String>,
    scrollback_limit: usize,
}

impl Default for Hub {
    fn default() -> Self {
        Self {
            active: None,
            joined: HashSet::new(),
            buffers: HashMap::new(),
            room_ids: HashMap::new(),
            recent_loaded: HashSet::new(),
            disconnect_at_ms: HashMap::new(),
            stream_game: HashMap::new(),
            stream_title: HashMap::new(),
            stream_id: HashMap::new(),
            scrollback_limit: DEFAULT_SCROLLBACK_LIMIT,
        }
    }
}

impl Hub {
    pub fn scrollback_limit(&self) -> usize {
        self.scrollback_limit
    }

    pub fn set_scrollback_limit(&mut self, limit: usize) {
        self.scrollback_limit = limit;
        for buf in self.buffers.values_mut() {
            buf.set_scrollback_limit(limit);
        }
    }

    pub fn buffer(&mut self, channel: &str) -> &mut ChannelBuf {
        let limit = self.scrollback_limit;
        self.buffers
            .entry(channel.to_string())
            .or_insert_with(|| ChannelBuf::new(channel, limit))
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
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
    ) -> Vec<ChatBatch> {
        let channels = self.channels();
        let mut batches = Vec::new();
        for ch in channels {
            if let Some(batch) = self.ingest(&ch, event.clone(), self_login, sim, stack_style) {
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
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
    ) -> Option<ChatBatch> {
        self.ingest_logged(channel, event, self_login, sim, stack_style, |_| {})
    }

    pub fn ingest_logged(
        &mut self,
        channel: &str,
        event: ChatEvent,
        self_login: Option<&str>,
        sim: &SimilarityCfg,
        stack_style: TimeoutStackStyle,
        on_added: impl FnMut(&ChatEvent),
    ) -> Option<ChatBatch> {
        if self.active.as_deref() != Some(channel) {
            if self.buffers.contains_key(channel) {
                self.buffer(channel).push_scrollback_only_logged(
                    event,
                    self_login,
                    sim,
                    stack_style,
                    on_added,
                );
            }
            return None;
        }
        self.buffer(channel)
            .ingest_logged(event, self_login, sim, stack_style, on_added)
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

    /// Read-only поиск события по id в скроллбэке (без flush pending).
    /// Для локального echo reply-контекста: snapshot() здесь нельзя — он
    /// сбрасывает недоставленные live-события.
    pub fn peek_event(&self, channel: &str, id: &str) -> Option<ChatEvent> {
        if id.is_empty() {
            return None;
        }
        let buf = self.buffers.get(channel)?;
        buf.snapshot_batch(channel)
            .events
            .into_iter()
            .find(|e| e.id() == id)
    }

    pub fn set_room_id(&mut self, channel: &str, room_id: String) {
        if room_id.is_empty() || !room_id.chars().all(|c| c.is_ascii_digit()) {
            return;
        }
        self.room_ids.insert(channel.to_string(), room_id);
    }

    pub fn room_id(&self, channel: &str) -> Option<&str> {
        self.room_ids.get(channel).map(|s| s.as_str())
    }

    pub fn channel_self_high_rate(&self, channel: &str) -> bool {
        self.buffers
            .get(channel)
            .is_some_and(|b| b.self_high_rate())
    }

    pub fn viewer_role(
        &self,
        channel: &str,
        self_user_id: Option<&str>,
    ) -> super::twitch_blocks::ViewerRole {
        let buf = self.buffers.get(channel);
        let mut is_broadcaster = buf.is_some_and(|b| b.self_is_broadcaster());
        if !is_broadcaster {
            if let (Some(uid), Some(rid)) = (self_user_id, self.room_id(channel)) {
                is_broadcaster = uid == rid;
            }
        }
        let is_mod = buf.is_some_and(|b| b.self_is_mod()) || is_broadcaster;
        super::twitch_blocks::ViewerRole {
            is_mod,
            is_broadcaster,
        }
    }

    pub fn recent_already_loaded(&self, channel: &str) -> bool {
        self.recent_loaded.contains(channel)
    }

    pub fn mark_recent_loaded(&mut self, channel: &str) {
        self.recent_loaded.insert(channel.to_string());
    }

    pub fn mark_disconnect_at(&mut self, channels: &HashSet<String>, at_ms: u64) {
        for ch in channels {
            self.disconnect_at_ms.entry(ch.clone()).or_insert(at_ms);
        }
    }

    pub fn disconnect_at(&self, channel: &str) -> Option<u64> {
        self.disconnect_at_ms.get(channel).copied()
    }

    pub fn take_disconnect_at(&mut self, channel: &str) -> Option<u64> {
        self.disconnect_at_ms.remove(channel)
    }

    pub fn prepend_history(&mut self, channel: &str, events: Vec<ChatEvent>) -> usize {
        self.buffer(channel).prepend_history(events)
    }

    pub fn fill_in_missing(&mut self, channel: &str, events: Vec<ChatEvent>) -> usize {
        self.buffer(channel).fill_in_missing(events)
    }

    pub fn set_active(&mut self, channel: Option<String>) {
        self.active = channel;
        if let Some(ch) = self.active.clone() {
            // Keep per-channel live flag (stock TwitchChannel); tab switch must not
            // look like an offline→online transition.
            self.buffer(&ch);
        }
    }

    pub fn drop_channel(&mut self, channel: &str) -> Option<String> {
        let clear = self
            .buffers
            .get_mut(channel)
            .and_then(|b| b.clear_send_wait_for_drop());
        self.buffers.remove(channel);
        self.joined.remove(channel);
        self.room_ids.remove(channel);
        self.recent_loaded.remove(channel);
        self.disconnect_at_ms.remove(channel);
        self.stream_game.remove(channel);
        self.stream_title.remove(channel);
        self.stream_id.remove(channel);
        if self.active.as_deref() == Some(channel) {
            self.active = None;
        }
        clear
    }

    pub fn clear_all(&mut self) {
        self.buffers.clear();
        self.joined.clear();
        self.room_ids.clear();
        self.recent_loaded.clear();
        self.disconnect_at_ms.clear();
        self.stream_game.clear();
        self.stream_title.clear();
        self.stream_id.clear();
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
        self.buffers.get(channel).is_some_and(|buf| buf.is_live())
    }

    /// Returns true when the stored live flag changed.
    pub fn set_channel_live(&mut self, channel: &str, live: bool) -> bool {
        if !live {
            self.stream_game.remove(channel);
            self.stream_title.remove(channel);
            self.stream_id.remove(channel);
        }
        self.buffer(channel).set_live(live)
    }

    pub fn set_stream_meta(
        &mut self,
        channel: &str,
        game: Option<String>,
        title: Option<String>,
        stream_id: Option<String>,
    ) {
        match game {
            Some(v) => {
                self.stream_game.insert(channel.to_string(), v);
            }
            None => {}
        }
        match title {
            Some(v) => {
                self.stream_title.insert(channel.to_string(), v);
            }
            None => {}
        }
        match stream_id {
            Some(v) => {
                self.stream_id.insert(channel.to_string(), v);
            }
            None => {}
        }
    }

    pub fn stream_game(&self, channel: &str) -> Option<&str> {
        self.stream_game.get(channel).map(|s| s.as_str())
    }

    pub fn stream_title(&self, channel: &str) -> Option<&str> {
        self.stream_title.get(channel).map(|s| s.as_str())
    }

    pub fn stream_id(&self, channel: &str) -> Option<&str> {
        self.stream_id.get(channel).map(|s| s.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::timeout_stack::TimeoutStackStyle;
    use crate::chat::types::ChatEvent;

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
    fn ingest_ignores_unknown_inactive() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        assert!(hub
            .ingest(
                "xqc",
                notice("1"),
                None,
                &SimilarityCfg::default(),
                no_stack()
            )
            .is_none());
        assert!(hub
            .ingest(
                "other",
                notice("nope"),
                None,
                &SimilarityCfg::default(),
                no_stack()
            )
            .is_none());
        let snap = hub.snapshot("xqc").unwrap();
        assert_eq!(snap.events.len(), 1);
        assert!(hub.snapshot("other").is_none());
    }

    #[test]
    fn inactive_joined_keeps_scrollback() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.buffer("lirik");
        hub.ingest(
            "lirik",
            notice("a"),
            None,
            &SimilarityCfg::default(),
            no_stack(),
        );
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
    fn set_active_does_not_reset_live_flag() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        assert!(hub.set_channel_live("xqc", true));
        hub.set_active(Some("lirik".into()));
        hub.set_active(Some("xqc".into()));
        assert!(hub.channel_live("xqc"));
        assert!(!hub.set_channel_live("xqc", true));
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
    fn mark_disconnect_at_keeps_earliest_timestamp() {
        let mut hub = Hub::default();
        let mut wanted = HashSet::new();
        wanted.insert("xqc".into());
        hub.mark_disconnect_at(&wanted, 1000);
        hub.mark_disconnect_at(&wanted, 2000);
        assert_eq!(hub.disconnect_at("xqc"), Some(1000));
    }

    #[test]
    fn disconnect_at_take_once() {
        let mut hub = Hub::default();
        let mut wanted = HashSet::new();
        wanted.insert("xqc".into());
        hub.mark_disconnect_at(&wanted, 1000);
        assert_eq!(hub.take_disconnect_at("xqc"), Some(1000));
        assert_eq!(hub.take_disconnect_at("xqc"), None);
    }

    #[test]
    fn ingest_fanout_joined_delivers_to_active_and_scrollback() {
        let mut hub = Hub::default();
        hub.set_active(Some("xqc".into()));
        hub.set_joined("xqc", true);
        hub.buffer("lirik");
        hub.set_joined("lirik", true);

        let batches =
            hub.ingest_fanout_joined(notice("w"), None, &SimilarityCfg::default(), no_stack());
        assert!(batches.is_empty());
        let snap_xqc = hub.snapshot("xqc").unwrap();
        assert_eq!(snap_xqc.events.len(), 1);

        hub.set_active(Some("lirik".into()));
        let snap = hub.snapshot("lirik").unwrap();
        assert_eq!(snap.events.len(), 1);
    }
}
