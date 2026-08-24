// MIT reimpl: Chatterino FilterSet.cpp + FilterRecord validity.

use std::collections::BTreeMap;

use serde_json::Value;

use super::filter_lang::{CompiledFilter, RunContext};
use super::settings::FilterRow;
use super::types::ChatEvent;

#[derive(Default, Clone)]
pub struct ExpressionFilterSet {
    filters: Vec<CompiledFilter>,
    has_invalid: bool,
}

impl ExpressionFilterSet {
    pub fn is_empty(&self) -> bool {
        self.filters.is_empty() && !self.has_invalid
    }

    pub fn has_invalid(&self) -> bool {
        self.has_invalid
    }

    pub fn fail_closed() -> Self {
        Self {
            filters: Vec::new(),
            has_invalid: true,
        }
    }

    pub fn passes(&self, ctx: &RunContext<'_>) -> bool {
        if self.has_invalid {
            return false;
        }
        if self.filters.is_empty() {
            return true;
        }
        self.filters.iter().all(|f| f.execute(ctx))
    }
}

pub fn compile_filter_rows(rows: &[FilterRow]) -> (ExpressionFilterSet, Vec<bool>) {
    let mut compiled = Vec::new();
    let mut valid_flags = Vec::with_capacity(rows.len());
    let mut has_invalid = false;
    for row in rows {
        let text = row.filter.trim();
        if text.is_empty() {
            valid_flags.push(false);
            has_invalid = true;
            continue;
        }
        match CompiledFilter::from_string(text) {
            Ok(f) => {
                valid_flags.push(true);
                compiled.push(f);
            }
            Err(_) => {
                valid_flags.push(false);
                has_invalid = true;
            }
        }
    }
    (
        ExpressionFilterSet {
            filters: compiled,
            has_invalid,
        },
        valid_flags,
    )
}

pub fn exclude_own_from_filter(knobs: &BTreeMap<String, Value>) -> bool {
    knobs
        .get("filtering.excludeUserMessagesFromFilter")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn expression_filter_passes(
    set: &ExpressionFilterSet,
    exclude_own: bool,
    event: &ChatEvent,
    channel: &str,
    channel_live: bool,
    self_login: Option<&str>,
) -> bool {
    if set.is_empty() {
        return true;
    }
    if exclude_own {
        if let Some(login) = super::filters::event_sender_login(event) {
            if self_login.is_some_and(|self_l| self_l.eq_ignore_ascii_case(login)) {
                return true;
            }
        }
    }
    let ctx = RunContext {
        event,
        channel,
        channel_live,
    };
    set.passes(&ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::ChatEvent;

    #[test]
    fn invalid_row_blocks_all() {
        let rows = vec![
            FilterRow {
                name: "bad".into(),
                filter: "unknown.identifier".into(),
                valid: true,
            },
            FilterRow {
                name: "good".into(),
                filter: r#"author.name contains "x""#.into(),
                valid: true,
            },
        ];
        let (set, flags) = compile_filter_rows(&rows);
        assert_eq!(flags, vec![false, true]);
        assert_eq!(set.filters.len(), 1);
        assert!(set.has_invalid());
    }

    #[test]
    fn exclude_own_skips_filter() {
        let rows = vec![FilterRow {
            name: "hide others".into(),
            filter: r#"author.name contains "other""#.into(),
            valid: true,
        }];
        let (set, _) = compile_filter_rows(&rows);
        let event = ChatEvent::Privmsg {
            id: "1".into(),
            timestamp_ms: 0,
            user_id: "1".into(),
            login: "me".into(),
            display_name: "me".into(),
            color: String::new(),
            badges: vec![],
            text: "hello".into(),
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
        };
        assert!(!expression_filter_passes(
            &set, false, &event, "xqc", false, Some("me")
        ));
        assert!(expression_filter_passes(
            &set, true, &event, "xqc", false, Some("me")
        ));
    }
}
