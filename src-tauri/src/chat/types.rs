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
pub struct EmoteSpan {
    pub start: u32,
    pub end: u32,
    pub emote_id: String,
    pub provider: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    #[serde(rename = "privmsg")]
    Privmsg {
        id: String,
        timestamp_ms: u64,
        user_id: String,
        login: String,
        display_name: String,
        color: String,
        badges: Vec<String>,
        text: String,
        emote_spans: Vec<EmoteSpan>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bits: Option<u32>,
        #[serde(rename = "replyToId", skip_serializing_if = "Option::is_none")]
        reply_to_id: Option<String>,
        action: bool,
    },
    #[serde(rename = "clearchat")]
    Clearchat {
        id: String,
        timestamp_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_login: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_sec: Option<u32>,
    },
    #[serde(rename = "clearmsg")]
    Clearmsg {
        id: String,
        timestamp_ms: u64,
        target_id: String,
    },
    #[serde(rename = "usernotice")]
    Usernotice {
        id: String,
        timestamp_ms: u64,
        system_text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        login: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        privmsg: Option<Box<ChatEvent>>,
    },
    #[serde(rename = "roomstate")]
    Roomstate {
        id: String,
        timestamp_ms: u64,
        emote_only: bool,
        subs_only: bool,
        slow_sec: u32,
        followers_sec: u32,
    },
    #[serde(rename = "notice")]
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
