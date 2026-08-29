// MIT reimpl: Chatterino filters/lang/Filter.cpp + FilterRecord.cpp

use super::context::RunContext;
use super::expr::{Expression, FilterParser};
use super::types::{FilterType, PossibleType};

#[derive(Clone)]
pub struct CompiledFilter {
    expr: Expression,
    return_type: FilterType,
}

impl CompiledFilter {
    pub fn from_string(text: &str) -> Result<Self, Vec<String>> {
        let parser = FilterParser::new(text);
        if !parser.valid() {
            return Err(parser.errors().to_vec());
        }
        if parser.return_type() != FilterType::Bool {
            return Err(vec!["Filter must return Bool".into()]);
        }
        let return_type = parser.return_type();
        let Some(expr) = parser.release() else {
            return Err(vec!["Empty filter".into()]);
        };
        Ok(Self { expr, return_type })
    }

    pub fn execute(&self, ctx: &RunContext<'_>) -> bool {
        self.expr.execute(ctx).as_bool().unwrap_or(false)
    }

    pub fn is_valid_syntax(text: &str) -> bool {
        Self::from_string(text).is_ok()
    }
}

pub fn compile_filter(text: &str) -> (bool, Option<CompiledFilter>) {
    match CompiledFilter::from_string(text) {
        Ok(f) => (true, Some(f)),
        Err(_) => (false, None),
    }
}

pub fn check_return_type(text: &str) -> Option<FilterType> {
    let parser = FilterParser::new(text);
    if parser.valid() {
        Some(parser.return_type())
    } else {
        None
    }
}

pub fn synthesize_type(expr: &Expression) -> PossibleType {
    expr.synthesize_type()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::filter_lang::context::RunContext;
    use crate::chat::types::{Badge, ChatEvent};

    fn sample_ctx() -> ChatEvent {
        ChatEvent::Privmsg {
            id: "1".into(),
            timestamp_ms: 0,
            user_id: "123".into(),
            login: "icelys".into(),
            display_name: "icelys".into(),
            color: "#FF0000".into(),
            badges: vec![
                Badge {
                    set: "moderator".into(),
                    version: "1".into(),
                    url: None,
                    source: "twitch".into(),
                    tooltip: None,
                },
                Badge {
                    set: "staff".into(),
                    version: "1".into(),
                    url: None,
                    source: "twitch".into(),
                    tooltip: None,
                },
                Badge {
                    set: "bot".into(),
                    version: "1".into(),
                    url: None,
                    source: "frankerfacez".into(),
                    tooltip: None,
                },
            ],
            text: "hey there :) 2038-01-19 123 456".into(),
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
        }
    }

    #[test]
    fn validity_cases() {
        let cases: &[(&str, bool)] = &[
            ("", false),
            ("1 + 1", false),
            (r#"author.name contains "icelys""#, true),
            (r##"author.color == "#ff0000""##, true),
            ("unknown.identifier", false),
            (r#"message.content match r"[""#, false),
        ];
        for (input, expected) in cases {
            assert_eq!(
                CompiledFilter::is_valid_syntax(input),
                *expected,
                "input={input:?}"
            );
        }
    }

    #[test]
    fn evaluation_sample() {
        let event = sample_ctx();
        let ctx = RunContext {
            event: &event,
            channel: "forsen",
            channel_live: false,
        };
        let f = CompiledFilter::from_string(r#"author.name == "icelys""#).unwrap();
        assert!(f.execute(&ctx));
        let f2 = CompiledFilter::from_string(
            r#"channel.name == "forsen" && author.badges contains "moderator""#,
        )
        .unwrap();
        assert!(f2.execute(&ctx));
        let f3 =
            CompiledFilter::from_string(r#"author.external_badges contains "frankerfacez:bot""#)
                .unwrap();
        assert!(f3.execute(&ctx));
    }

    #[test]
    fn usernotice_author_name_without_privmsg_body() {
        let event = ChatEvent::Usernotice {
            id: "1".into(),
            timestamp_ms: 0,
            system_text: "subscribed".into(),
            login: Some("streamer".into()),
            msg_id: Some("sub".into()),
            privmsg: None,
            highlight_color: None,
            highlight_sound: false,
            highlight_sound_path: None,
            highlight_flash: false,
        };
        let ctx = RunContext {
            event: &event,
            channel: "xqc",
            channel_live: false,
        };
        let f = CompiledFilter::from_string(r#"author.name == "streamer""#).unwrap();
        assert!(f.execute(&ctx));
    }
}
