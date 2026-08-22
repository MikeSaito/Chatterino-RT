use super::types::ChatBatch;

pub fn encode_batch(batch: &ChatBatch) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    rmp_serde::to_vec_named(batch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::{Badge, ChatEvent, EmoteSpan};

    fn decode_batch(bytes: &[u8]) -> Result<ChatBatch, rmp_serde::decode::Error> {
        rmp_serde::from_slice(bytes)
    }

    fn sample_batch() -> ChatBatch {
        ChatBatch {
            channel_id: "xqc".into(),
            seq: 3,
            dropped: 1,
            events: vec![
                ChatEvent::Privmsg {
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
                },
                ChatEvent::Roomstate {
                    id: "r".into(),
                    timestamp_ms: 11,
                    emote_only: Some(true),
                    subs_only: Some(false),
                    slow_sec: Some(5),
                    followers_only: Some(-1),
                },
                ChatEvent::Notice {
                    id: "n".into(),
                    timestamp_ms: 12,
                    text: "ok".into(),
                },
            ],
        }
    }

    #[test]
    fn messagepack_roundtrip_preserves_batch() {
        let batch = sample_batch();
        let bytes = encode_batch(&batch).expect("encode");
        assert!(!bytes.is_empty());
        let back = decode_batch(&bytes).expect("decode");
        assert_eq!(back, batch);
        assert_eq!(back.events[0].id(), "1");
        assert_eq!(back.channel_id, "xqc");
        assert_eq!(back.dropped, 1);
    }
}
