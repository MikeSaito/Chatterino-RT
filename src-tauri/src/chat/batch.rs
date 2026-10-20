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
                        display_width: None,
                        display_height: None,
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
                    paint: None,
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

                    msg_id: None,

                    timeout_remaining_sec: None,
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
    #[test]
    fn export_typescript_contract() {
        let Some(output) = std::env::var_os("CRT_CONTRACT_DIR") else {
            return;
        };
        let output = std::path::PathBuf::from(output);
        std::fs::create_dir_all(&output).unwrap();
        let mut batch = sample_batch();
        if let ChatEvent::Privmsg {
            text, display_name, ..
        } = &mut batch.events[0]
        {
            *text = "Привет 👋 日本語".into();
            *display_name = "Анна".into();
        }
        let nested = serde_json::to_value(&batch.events[0]).unwrap();
        let variants = serde_json::json!([
            {"kind":"clearchat","id":"cc","timestampMs":20,"targetLogin":"ann","durationSec":30,"stackCount":2},
            {"kind":"clearmsg","id":"cm","timestampMs":21,"targetId":"1"},
            {"kind":"usernotice","id":"un","timestampMs":22,"systemText":"Спасибо 🎉","privmsg":nested,"params":{"months":3,"displayName":"Анна"}},
            {"kind":"userstate","id":"us","timestampMs":23,"badges":[],"isModTag":true},
            {"kind":"automodHeld","id":"ah","timestampMs":24,"messageId":"held","channelId":"xqc","authorUserId":"9","authorLogin":"ann","authorDisplayName":"Анна","text":"проверка","status":"pending","caughtRanges":[{"start":0,"end":2}]},
            {"kind":"automodStatus","id":"as","timestampMs":25,"targetId":"held","status":"approved"},
            {"kind":"lowTrustHeader","id":"lh","timestampMs":26,"status":"restricted","detail":"проверка"},
            {"kind":"lowTrustMessage","id":"lm","timestampMs":27,"messageId":"low","userId":"9","login":"ann","displayName":"Анна","text":"日本語","status":"restricted","channelLogin":"xqc"},
            {"kind":"roomstate","id":"partial","timestampMs":28}
        ]);
        for value in variants.as_array().unwrap() {
            batch
                .events
                .push(serde_json::from_value(value.clone()).unwrap());
        }
        std::fs::write(
            output.join("batch.json"),
            serde_json::to_vec_pretty(&batch).unwrap(),
        )
        .unwrap();
        std::fs::write(output.join("batch.msgpack"), encode_batch(&batch).unwrap()).unwrap();
    }
}
