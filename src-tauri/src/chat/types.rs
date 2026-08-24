use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatBatch {
    pub channel_id: String,
    pub seq: u64,
    pub dropped: u32,
    pub events: Vec<ChatEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatConnState {
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    pub state: ChatConnState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelLive {
    pub channel: String,
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatPipe {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendWait {
    pub channel_id: String,
    /// Empty clears the composer countdown for this channel.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatRooms {
    pub active: Option<String>,
    pub open: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmoteSpan {
    pub start: u32,
    pub end: u32,
    pub emote_id: String,
    pub provider: String,
    pub url: String,
    #[serde(default)]
    pub zero_width: bool,
    /// Stacked bits total (stock BitsAmount when emotes.stackBits).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits_amount: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkSpan {
    pub start: u32,
    pub end: u32,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MentionSpan {
    pub start: u32,
    pub end: u32,
    pub login: String,
}

fn default_badge_source() -> String {
    "twitch".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Badge {
    pub set: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default = "default_badge_source")]
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    #[serde(rename = "privmsg", rename_all = "camelCase")]
    Privmsg {
        id: String,
        timestamp_ms: u64,
        user_id: String,
        login: String,
        display_name: String,
        color: String,
        badges: Vec<Badge>,
        text: String,
        emote_spans: Vec<EmoteSpan>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        link_spans: Vec<LinkSpan>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mention_spans: Vec<MentionSpan>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bits: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to_login: Option<String>,
        /// Parent display-name for stripReplyMention (stock); not required by UI.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to_display_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to_text: Option<String>,
        action: bool,
        /// IRC `first-msg=1`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        first_msg: bool,
        /// Channel point redemption id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_reward_id: Option<String>,
        /// IRC `msg-id` tag (e.g. `highlighted-message`), not message `id`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        system_msg_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        highlight_color: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        highlight_sound: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        highlight_sound_path: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        highlight_flash: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        whisper: bool,
        /// Soft-disabled (similar / R9K); Pixi overlay like MessageFlag::Disabled.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        disabled: bool,
        /// IRC `source-room-id` for shared chat messages.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_room_id: Option<String>,
        /// IRC `source-badges` tag (shared chat authority badges from source channel).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        source_badges: Vec<Badge>,
    },
    #[serde(rename = "clearchat", rename_all = "camelCase")]
    Clearchat {
        id: String,
        timestamp_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_login: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_sec: Option<u32>,
        /// Stacked CLEARCHAT count (stock Message::count).
        #[serde(default = "default_stack_count", skip_serializing_if = "stack_count_is_one")]
        stack_count: u32,
    },
    #[serde(rename = "clearmsg", rename_all = "camelCase")]
    Clearmsg {
        id: String,
        timestamp_ms: u64,
        target_id: String,
    },
    #[serde(rename = "usernotice", rename_all = "camelCase")]
    Usernotice {
        id: String,
        timestamp_ms: u64,
        system_text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        login: Option<String>,
        /// IRC `msg-id` (sub / resub / subgift / …).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        msg_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        privmsg: Option<Box<ChatEvent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        highlight_color: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        highlight_sound: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        highlight_sound_path: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        highlight_flash: bool,
    },
    #[serde(rename = "roomstate", rename_all = "camelCase")]
    Roomstate {
        id: String,
        timestamp_ms: u64,
        /// Absent tag → None (partial ROOMSTATE).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emote_only: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subs_only: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slow_sec: Option<u32>,
        /// Twitch minutes; `-1` = off. Absent → None.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        followers_only: Option<i32>,
    },
    /// USERSTATE: not shown in scrollback; clears send-wait when high rate limit.
    #[serde(rename = "userstate", rename_all = "camelCase")]
    Userstate {
        id: String,
        timestamp_ms: u64,
        badges: Vec<Badge>,
        /// Twitch `mod=1` tag (badges sometimes omit moderator).
        #[serde(default)]
        is_mod_tag: bool,
    },
    #[serde(rename = "notice", rename_all = "camelCase")]
    Notice {
        id: String,
        timestamp_ms: u64,
        text: String,
    },
}

fn default_stack_count() -> u32 {
    1
}

fn stack_count_is_one(count: &u32) -> bool {
    *count <= 1
}

impl ChatEvent {
    pub fn id(&self) -> &str {
        match self {
            ChatEvent::Privmsg { id, .. }
            | ChatEvent::Clearchat { id, .. }
            | ChatEvent::Clearmsg { id, .. }
            | ChatEvent::Usernotice { id, .. }
            | ChatEvent::Roomstate { id, .. }
            | ChatEvent::Userstate { id, .. }
            | ChatEvent::Notice { id, .. } => id,
        }
    }

    pub fn timestamp_ms(&self) -> u64 {
        match self {
            ChatEvent::Privmsg { timestamp_ms, .. }
            | ChatEvent::Clearchat { timestamp_ms, .. }
            | ChatEvent::Clearmsg { timestamp_ms, .. }
            | ChatEvent::Usernotice { timestamp_ms, .. }
            | ChatEvent::Roomstate { timestamp_ms, .. }
            | ChatEvent::Userstate { timestamp_ms, .. }
            | ChatEvent::Notice { timestamp_ms, .. } => *timestamp_ms,
        }
    }

    /// Id stored on the Pixi slot (USERNOTICE with body uses nested privmsg id).
    pub fn search_jump_id(&self) -> &str {
        match self {
            ChatEvent::Usernotice {
                privmsg: Some(inner),
                ..
            } => match inner.as_ref() {
                ChatEvent::Privmsg { id, .. } => id,
                _ => self.id(),
            },
            _ => self.id(),
        }
    }

    /// Haystack for Chatterino-style substring search (case folded by caller).
    pub fn matches_substring(&self, needle_lower: &str) -> bool {
        if needle_lower.is_empty() {
            return false;
        }
        match self {
            ChatEvent::Privmsg {
                login,
                display_name,
                text,
                reply_to_login,
                reply_to_text,
                ..
            } => {
                contains_ci(login, needle_lower)
                    || contains_ci(display_name, needle_lower)
                    || contains_ci(text, needle_lower)
                    || reply_to_login
                        .as_deref()
                        .is_some_and(|v| contains_ci(v, needle_lower))
                    || reply_to_text
                        .as_deref()
                        .is_some_and(|v| contains_ci(v, needle_lower))
            }
            ChatEvent::Usernotice {
                system_text,
                login,
                privmsg,
                ..
            } => {
                contains_ci(system_text, needle_lower)
                    || login.as_deref().is_some_and(|v| contains_ci(v, needle_lower))
                    || privmsg
                        .as_ref()
                        .is_some_and(|inner| inner.matches_substring(needle_lower))
            }
            ChatEvent::Notice { text, .. } => contains_ci(text, needle_lower),
            ChatEvent::Clearchat { target_login, .. } => target_login
                .as_deref()
                .is_some_and(|v| contains_ci(v, needle_lower)),
            ChatEvent::Roomstate {
                emote_only,
                subs_only,
                slow_sec,
                followers_only,
                ..
            } => contains_ci(
                &roomstate_text(*emote_only, *subs_only, *slow_sec, *followers_only),
                needle_lower,
            ),
            ChatEvent::Clearmsg { .. } => false,
            ChatEvent::Userstate { .. } => false,
        }
    }
}

fn contains_ci(hay: &str, needle_lower: &str) -> bool {
    hay.to_lowercase().contains(needle_lower)
}

fn roomstate_text(
    emote_only: Option<bool>,
    subs_only: Option<bool>,
    slow_sec: Option<u32>,
    followers_only: Option<i32>,
) -> String {
    format!(
        "emote:{emote_only:?} subs:{subs_only:?} slow:{slow_sec:?} followers:{followers_only:?}"
    )
}

/// Row for SearchPopup-like UI (Chatterino ChannelView filter result).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub timestamp_ms: u64,
    pub nick: String,
    pub login: String,
    pub text: String,
    pub color: String,
}

impl ChatEvent {
    pub fn to_search_hit(&self) -> SearchHit {
        match self {
            ChatEvent::Privmsg {
                timestamp_ms,
                login,
                display_name,
                text,
                color,
                ..
            } => SearchHit {
                id: self.search_jump_id().to_string(),
                timestamp_ms: *timestamp_ms,
                nick: display_name.clone(),
                login: login.clone(),
                text: text.clone(),
                color: color.clone(),
            },
            ChatEvent::Usernotice {
                timestamp_ms,
                system_text,
                login,
                privmsg,
                ..
            } => {
                if let Some(inner) = privmsg {
                    if let ChatEvent::Privmsg {
                        login: pl,
                        display_name,
                        text,
                        color,
                        timestamp_ms: pts,
                        ..
                    } = inner.as_ref()
                    {
                        return SearchHit {
                            id: self.search_jump_id().to_string(),
                            timestamp_ms: *pts,
                            nick: display_name.clone(),
                            login: pl.clone(),
                            text: format!("{system_text} {text}"),
                            color: color.clone(),
                        };
                    }
                }
                SearchHit {
                    id: self.search_jump_id().to_string(),
                    timestamp_ms: *timestamp_ms,
                    nick: "*".into(),
                    login: login.clone().unwrap_or_default(),
                    text: system_text.clone(),
                    color: "#adadc0".into(),
                }
            }
            ChatEvent::Notice {
                timestamp_ms, text, ..
            } => SearchHit {
                id: self.search_jump_id().to_string(),
                timestamp_ms: *timestamp_ms,
                nick: "*".into(),
                login: String::new(),
                text: text.clone(),
                color: "#adadc0".into(),
            },
            ChatEvent::Clearchat {
                timestamp_ms,
                target_login,
                duration_sec,
                stack_count,
                ..
            } => {
                let mut text = match (target_login.as_deref(), *duration_sec) {
                    (None, _) => "чат очищен".to_string(),
                    (Some(login), Some(sec)) => format!("{login} тайм-аут {sec}с"),
                    (Some(login), None) => format!("{login} забанен"),
                };
                if *stack_count > 1 {
                    text.push_str(&format!(" ({stack_count} раз)"));
                }
                SearchHit {
                    id: self.search_jump_id().to_string(),
                    timestamp_ms: *timestamp_ms,
                    nick: "*".into(),
                    login: target_login.clone().unwrap_or_default(),
                    text,
                    color: "#adadc0".into(),
                }
            }
            ChatEvent::Roomstate {
                timestamp_ms,
                emote_only,
                subs_only,
                slow_sec,
                followers_only,
                ..
            } => SearchHit {
                id: self.search_jump_id().to_string(),
                timestamp_ms: *timestamp_ms,
                nick: "*".into(),
                login: String::new(),
                text: roomstate_text(*emote_only, *subs_only, *slow_sec, *followers_only),
                color: "#adadc0".into(),
            },
            ChatEvent::Clearmsg { .. } => SearchHit {
                id: self.search_jump_id().to_string(),
                timestamp_ms: 0,
                nick: "*".into(),
                login: String::new(),
                text: String::new(),
                color: "#adadc0".into(),
            },
            ChatEvent::Userstate { timestamp_ms, .. } => SearchHit {
                id: self.search_jump_id().to_string(),
                timestamp_ms: *timestamp_ms,
                nick: "*".into(),
                login: String::new(),
                text: String::new(),
                color: "#adadc0".into(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privmsg_json_uses_camel_case_fields() {
        let event = ChatEvent::Privmsg {
            id: "1".into(),
            timestamp_ms: 10,
            user_id: "9".into(),
            login: "ann".into(),
            display_name: "Ann".into(),
            color: "#fff".into(),
            badges: vec![Badge {
                set: "moderator".into(),
                version: "1".into(),
                url: None,
                source: "twitch".into(),
                tooltip: None,
            }],
            text: "hi".into(),
            emote_spans: vec![EmoteSpan {
                start: 0,
                end: 2,
                emote_id: "25".into(),
                provider: "twitch".into(),
                url: "https://static-cdn.jtvnw.net/x".into(),
                zero_width: false,
                bits_amount: None,
                bits_color: None,
            }],
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
        };
        let v = serde_json::to_value(&event).unwrap();
        assert_eq!(v["kind"], "privmsg");
        assert_eq!(v["timestampMs"], 10);
        assert_eq!(v["userId"], "9");
        assert_eq!(v["displayName"], "Ann");
        assert!(v.get("emoteSpans").is_some(), "wire key emoteSpans, got {v}");
        assert!(v.get("emote_spans").is_none());
        assert_eq!(v["emoteSpans"][0]["emoteId"], "25");
        assert_eq!(v["emoteSpans"][0]["zeroWidth"], false);
        assert_eq!(v["badges"][0]["set"], "moderator");
        assert!(v.get("highlightColor").is_none());
        let room = serde_json::to_value(&ChatEvent::Roomstate {
            id: "r".into(),
            timestamp_ms: 11,
            emote_only: Some(true),
            subs_only: Some(false),
            slow_sec: Some(5),
            followers_only: Some(-1),
        })
        .unwrap();
        assert_eq!(room["timestampMs"], 11);
        assert_eq!(room["emoteOnly"], true);
        assert_eq!(room["slowSec"], 5);
        assert_eq!(room["followersOnly"], -1);
    }
}
