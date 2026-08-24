// MIT reimpl: Chatterino RunContext + IdentifierExpression accessors.

use super::types::{FilterType, FilterValue};
use crate::chat::types::{Badge, ChatEvent};

#[derive(Debug, Clone)]
pub struct RunContext<'a> {
    pub event: &'a ChatEvent,
    pub channel: &'a str,
    pub channel_live: bool,
}

pub fn resolve_identifier(name: &str, ctx: &RunContext<'_>) -> FilterValue {
    match name {
        "author.badges" => FilterValue::StringList(twitch_badge_keys(ctx.event)),
        "author.external_badges" => FilterValue::StringList(external_badge_keys(ctx.event)),
        "author.color" => FilterValue::Color(author_color(ctx.event)),
        "author.name" => FilterValue::String(author_name(ctx.event)),
        "author.user_id" => FilterValue::String(author_user_id(ctx.event)),
        "author.no_color" => FilterValue::Bool(author_color(ctx.event).is_empty()),
        "author.subbed" => FilterValue::Bool(has_badge(ctx.event, "subscriber") || has_badge(ctx.event, "founder")),
        "author.sub_length" => FilterValue::Int(0),
        "bits.amount" => FilterValue::Int(bits_amount(ctx.event)),
        "channel.name" => FilterValue::String(ctx.channel.to_string()),
        "channel.watching" => FilterValue::Bool(false),
        "channel.live" => FilterValue::Bool(ctx.channel_live),
        "flags.action" => FilterValue::Bool(flag_action(ctx.event)),
        "flags.highlighted" => FilterValue::Bool(flag_highlighted(ctx.event)),
        "flags.points_redeemed" => FilterValue::Bool(flag_points_redeemed(ctx.event)),
        "flags.sub_message" => FilterValue::Bool(flag_sub_message(ctx.event)),
        "flags.system_message" => FilterValue::Bool(flag_system_message(ctx.event)),
        "flags.reward_message" => FilterValue::Bool(flag_reward_message(ctx.event)),
        "flags.first_message" => FilterValue::Bool(flag_first_message(ctx.event)),
        "flags.elevated_message" | "flags.hype_chat" => FilterValue::Bool(false),
        "flags.cheer_message" => FilterValue::Bool(flag_cheer_message(ctx.event)),
        "flags.whisper" => FilterValue::Bool(flag_whisper(ctx.event)),
        "flags.reply" => FilterValue::Bool(flag_reply(ctx.event)),
        "flags.automod" => FilterValue::Bool(flag_automod(ctx.event)),
        "flags.restricted" => FilterValue::Bool(false),
        "flags.monitored" => FilterValue::Bool(false),
        "flags.shared" => FilterValue::Bool(flag_shared(ctx.event)),
        "flags.similar" => FilterValue::Bool(flag_similar(ctx.event)),
        "flags.watch_streak" => FilterValue::Bool(false),
        "flags.announcement" => FilterValue::Bool(false),
        "message.content" => FilterValue::String(message_content(ctx.event)),
        "message.length" => FilterValue::Int(message_length(ctx.event)),
        "reward.cost" => FilterValue::Int(-1),
        "reward.id" => FilterValue::String(reward_id(ctx.event)),
        "reward.title" => FilterValue::String(String::new()),
        _ => FilterValue::Bool(false),
    }
}

fn privmsg_event<'a>(event: &'a ChatEvent) -> Option<&'a ChatEvent> {
    match event {
        ChatEvent::Privmsg { .. } => Some(event),
        ChatEvent::Usernotice {
            privmsg: Some(inner),
            ..
        } => match inner.as_ref() {
            ChatEvent::Privmsg { .. } => Some(inner.as_ref()),
            _ => None,
        },
        _ => None,
    }
}

fn privmsg_badges(event: &ChatEvent) -> Option<&[Badge]> {
    match privmsg_event(event) {
        Some(ChatEvent::Privmsg { badges, .. }) => Some(badges.as_slice()),
        _ => None,
    }
}

fn twitch_badge_keys(event: &ChatEvent) -> Vec<String> {
    privmsg_badges(event)
        .map(|badges| {
            badges
                .iter()
                .filter(|b| b.source == "twitch")
                .map(|b| b.set.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn external_badge_keys(event: &ChatEvent) -> Vec<String> {
    privmsg_badges(event)
        .map(|badges| {
            badges
                .iter()
                .filter(|b| b.source != "twitch")
                .map(|b| format!("{}:{}", b.source, b.set))
                .collect()
        })
        .unwrap_or_default()
}

fn author_color(event: &ChatEvent) -> String {
    match privmsg_event(event) {
        Some(ChatEvent::Privmsg { color, .. }) => normalize_color(color),
        _ => String::new(),
    }
}

fn author_login_fallback(event: &ChatEvent) -> Option<String> {
    match event {
        ChatEvent::Usernotice { login, .. } => login.clone().filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn normalize_color(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }
    if s.starts_with('#') {
        return s.to_ascii_lowercase();
    }
    format!("#{s}")
}

fn author_name(event: &ChatEvent) -> String {
    match privmsg_event(event) {
        Some(ChatEvent::Privmsg { display_name, .. }) => display_name.clone(),
        _ => author_login_fallback(event).unwrap_or_default(),
    }
}

fn author_user_id(event: &ChatEvent) -> String {
    match privmsg_event(event) {
        Some(ChatEvent::Privmsg { user_id, .. }) => user_id.clone(),
        _ => String::new(),
    }
}

fn message_length(event: &ChatEvent) -> i32 {
    message_content(event).encode_utf16().count() as i32
}

fn has_badge(event: &ChatEvent, key: &str) -> bool {
    privmsg_badges(event)
        .is_some_and(|badges| badges.iter().any(|b| b.source == "twitch" && b.set == key))
}

fn bits_amount(event: &ChatEvent) -> i32 {
    match privmsg_event(event) {
        Some(ChatEvent::Privmsg { bits, .. }) => bits.map(|b| b as i32).unwrap_or(0),
        _ => 0,
    }
}

fn flag_action(event: &ChatEvent) -> bool {
    matches!(privmsg_event(event), Some(ChatEvent::Privmsg { action: true, .. }))
}

fn flag_highlighted(event: &ChatEvent) -> bool {
    match event {
        ChatEvent::Privmsg { system_msg_id, .. } => system_msg_id
            .as_deref()
            .is_some_and(|id| id.eq_ignore_ascii_case("highlighted-message")),
        _ => false,
    }
}

fn flag_points_redeemed(event: &ChatEvent) -> bool {
    match event {
        ChatEvent::Privmsg {
            custom_reward_id,
            system_msg_id,
            ..
        } => custom_reward_id.is_some()
            || system_msg_id
                .as_deref()
                .is_some_and(|id| id.contains("redemption") || id.contains("reward")),
        _ => false,
    }
}

fn flag_sub_message(event: &ChatEvent) -> bool {
    match event {
        ChatEvent::Usernotice { msg_id, .. } => msg_id.as_deref().is_some_and(|id| {
            id.eq_ignore_ascii_case("sub")
                || id.eq_ignore_ascii_case("resub")
                || id.eq_ignore_ascii_case("subgift")
                || id.eq_ignore_ascii_case("anonsubgift")
        }),
        _ => false,
    }
}

fn flag_system_message(event: &ChatEvent) -> bool {
    matches!(
        event,
        ChatEvent::Notice { .. }
            | ChatEvent::Clearchat { .. }
            | ChatEvent::Clearmsg { .. }
            | ChatEvent::Usernotice { .. }
    )
}

fn flag_reward_message(event: &ChatEvent) -> bool {
    matches!(
        event,
        ChatEvent::Privmsg {
            custom_reward_id: Some(_),
            ..
        }
    )
}

fn flag_first_message(event: &ChatEvent) -> bool {
    matches!(event, ChatEvent::Privmsg { first_msg: true, .. })
}

fn flag_cheer_message(event: &ChatEvent) -> bool {
    matches!(event, ChatEvent::Privmsg { bits: Some(_), .. })
}

fn flag_whisper(event: &ChatEvent) -> bool {
    matches!(event, ChatEvent::Privmsg { whisper: true, .. })
}

fn flag_reply(event: &ChatEvent) -> bool {
    matches!(
        event,
        ChatEvent::Privmsg {
            reply_to_id: Some(_),
            ..
        }
    )
}

fn flag_automod(event: &ChatEvent) -> bool {
    match event {
        ChatEvent::Privmsg { system_msg_id, .. } => system_msg_id
            .as_deref()
            .is_some_and(|id| id.contains("automod")),
        _ => false,
    }
}

fn flag_shared(event: &ChatEvent) -> bool {
    matches!(
        event,
        ChatEvent::Privmsg {
            source_room_id: Some(_),
            ..
        }
    )
}

fn flag_similar(event: &ChatEvent) -> bool {
    matches!(event, ChatEvent::Privmsg { disabled: true, .. })
}

fn reward_id(event: &ChatEvent) -> String {
    match privmsg_event(event) {
        Some(ChatEvent::Privmsg {
            custom_reward_id,
            ..
        }) => custom_reward_id.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

fn message_content(event: &ChatEvent) -> String {
    match event {
        ChatEvent::Privmsg { text, .. } => text.clone(),
        ChatEvent::Notice { text, .. } => text.clone(),
        ChatEvent::Usernotice { system_text, .. } => system_text.clone(),
        _ => String::new(),
    }
}

pub fn identifier_return_type(name: &str) -> Option<FilterType> {
    super::tokenizer::identifier_type(name)
}
