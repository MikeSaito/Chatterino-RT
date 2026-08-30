//! ROOMSTATE mode merge (Chatterino TwitchChannel room modes). MIT logic; no C++/Qt.

use super::types::ChatEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoomModes {
    pub emote_only: bool,
    pub subs_only: bool,
    pub slow_sec: u32,
    /// Twitch followers-only minutes; `-1` = off (including absent).
    pub followers_only: i32,
}

impl Default for RoomModes {
    fn default() -> Self {
        Self {
            emote_only: false,
            subs_only: false,
            slow_sec: 0,
            followers_only: -1,
        }
    }
}

impl RoomModes {
    /// Merge only tags present on this ROOMSTATE (partial updates).
    pub fn merge_event(self, event: &ChatEvent) -> Option<Self> {
        let ChatEvent::Roomstate {
            emote_only,
            subs_only,
            slow_sec,
            followers_only,
            ..
        } = event
        else {
            return None;
        };
        let mut next = self;
        if let Some(v) = *emote_only {
            next.emote_only = v;
        }
        if let Some(v) = *subs_only {
            next.subs_only = v;
        }
        if let Some(v) = *slow_sec {
            next.slow_sec = v;
        }
        if let Some(v) = *followers_only {
            next.followers_only = v;
        }
        Some(next)
    }

    pub fn to_payload(self, channel: &str) -> super::types::ChannelRoomState {
        super::types::ChannelRoomState {
            channel: channel.to_string(),
            emote_only: self.emote_only,
            subs_only: self.subs_only,
            slow_sec: self.slow_sec,
            followers_only: self.followers_only,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(
        emote_only: Option<bool>,
        subs_only: Option<bool>,
        slow_sec: Option<u32>,
        followers_only: Option<i32>,
    ) -> ChatEvent {
        ChatEvent::Roomstate {
            id: "r".into(),
            timestamp_ms: 1,
            emote_only,
            subs_only,
            slow_sec,
            followers_only,
        }
    }

    #[test]
    fn partial_slow_keeps_emote_only() {
        let prev = RoomModes {
            emote_only: true,
            ..RoomModes::default()
        };
        let next = prev
            .merge_event(&patch(None, None, Some(30), None))
            .unwrap();
        assert!(next.emote_only);
        assert_eq!(next.slow_sec, 30);
    }

    #[test]
    fn followers_zero_is_on() {
        let next = RoomModes::default()
            .merge_event(&patch(None, None, None, Some(0)))
            .unwrap();
        assert_eq!(next.followers_only, 0);
    }

    #[test]
    fn followers_minus_one_is_off() {
        let prev = RoomModes {
            followers_only: 10,
            ..RoomModes::default()
        };
        let next = prev
            .merge_event(&patch(None, None, None, Some(-1)))
            .unwrap();
        assert_eq!(next.followers_only, -1);
    }
}
