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
pub struct ChatPipe {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Badge {
    pub set: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to_text: Option<String>,
        action: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        highlight_color: Option<String>,
    },
    #[serde(rename = "clearchat", rename_all = "camelCase")]
    Clearchat {
        id: String,
        timestamp_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_login: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_sec: Option<u32>,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        privmsg: Option<Box<ChatEvent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        highlight_color: Option<String>,
    },
    #[serde(rename = "roomstate", rename_all = "camelCase")]
    Roomstate {
        id: String,
        timestamp_ms: u64,
        emote_only: bool,
        subs_only: bool,
        slow_sec: u32,
        followers_sec: u32,
    },
    #[serde(rename = "notice", rename_all = "camelCase")]
    Notice {
        id: String,
        timestamp_ms: u64,
        text: String,
    },
}

impl ChatEvent {
    #[cfg(test)]
    pub fn id(&self) -> &str {
        match self {
            ChatEvent::Privmsg { id, .. }
            | ChatEvent::Clearchat { id, .. }
            | ChatEvent::Clearmsg { id, .. }
            | ChatEvent::Usernotice { id, .. }
            | ChatEvent::Roomstate { id, .. }
            | ChatEvent::Notice { id, .. } => id,
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
            }],
            text: "hi".into(),
            emote_spans: vec![EmoteSpan {
                start: 0,
                end: 2,
                emote_id: "25".into(),
                provider: "twitch".into(),
                url: "https://static-cdn.jtvnw.net/x".into(),
                zero_width: false,
            }],
            link_spans: vec![],
            mention_spans: vec![],
            bits: None,
            reply_to_id: None,
            reply_to_login: None,
            reply_to_text: None,
            action: false,
            highlight_color: None,
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
            emote_only: true,
            subs_only: false,
            slow_sec: 5,
            followers_sec: 0,
        })
        .unwrap();
        assert_eq!(room["timestampMs"], 11);
        assert_eq!(room["emoteOnly"], true);
        assert_eq!(room["slowSec"], 5);
    }
}
