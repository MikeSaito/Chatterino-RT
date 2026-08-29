//! USERNOTICE `msg-param-*` extraction (Chatterino MessageBuilder / IrcMessageHandler logic).
//! SPDX-FileCopyrightText: Contributors to Chatterino <https://chatterino.com>
//! SPDX-License-Identifier: MIT
//! Reimplementation; not a copy of C++/Qt source.

use super::types::UsernoticeParams;

/// Twitch anonymous gift user-id (stock ANONYMOUS_GIFTER_ID).
pub const ANONYMOUS_GIFTER_ID: &str = "274598607";

/// Pull display fields from IRC tags for JS i18n builders.
pub fn parse_usernotice_params(
    get: &dyn Fn(&str) -> Option<String>,
    msg_id: Option<&str>,
) -> Option<UsernoticeParams> {
    let id = msg_id?.to_ascii_lowercase();
    let mut p = UsernoticeParams {
        display_name: get("display-name"),
        user_id: get("user-id"),
        color: get("color"),
        login: get("login"),
        plan: get("msg-param-sub-plan"),
        months: parse_u32(get("msg-param-months")),
        cumulative_months: parse_u32(get("msg-param-cumulative-months")),
        multimonth_duration: parse_u32(get("msg-param-multimonth-duration")),
        multimonth_tenure: parse_u32(get("msg-param-multimonth-tenure")),
        gift_months: parse_u32(get("msg-param-gift-months")),
        sender_count: parse_u32(get("msg-param-sender-count")),
        mass_gift_count: parse_u32(get("msg-param-mass-gift-count")),
        recipient_login: get("msg-param-recipient-user-name")
            .or_else(|| get("msg-param-recipient-name")),
        recipient_display_name: get("msg-param-recipient-display-name"),
        recipient_id: get("msg-param-recipient-id"),
        viewer_count: parse_u32(get("msg-param-viewerCount")),
        raid_login: get("msg-param-login"),
        raid_display_name: get("msg-param-displayName"),
        bits_threshold: parse_u32(get("msg-param-threshold")),
        ritual_name: get("msg-param-ritual-name"),
        category: get("msg-param-category"),
        value: parse_u32(get("msg-param-value")),
        anon: false,
    };
    if p.user_id.as_deref() == Some(ANONYMOUS_GIFTER_ID)
        || id == "anonsubgift"
        || id == "anonsubmysterygift"
    {
        p.anon = true;
    }
    // Always attach params for known kinds so JS can override system-msg.
    let known = matches!(
        id.as_str(),
        "sub"
            | "resub"
            | "subgift"
            | "anonsubgift"
            | "submysterygift"
            | "anonsubmysterygift"
            | "raid"
            | "unraid"
            | "bitsbadgetier"
            | "ritual"
            | "viewermilestone"
            | "modiversary"
            | "announcement"
    );
    if known {
        Some(p)
    } else {
        // Still useful for mention coloring of display-name on generic notices.
        if p.display_name.is_some() || p.login.is_some() {
            Some(p)
        } else {
            None
        }
    }
}

fn parse_u32(raw: Option<String>) -> Option<u32> {
    raw.and_then(|s| s.parse().ok())
}

fn display_name(p: &UsernoticeParams) -> String {
    p.display_name
        .as_deref()
        .or(p.login.as_deref())
        .unwrap_or("")
        .to_string()
}

/// Chatterino `kFormatNumbers`: threshold/1000 + `K`.
pub fn format_bits_threshold_en(threshold: u32) -> String {
    format!("{}K", threshold / 1000)
}

/// Gift-month tier digit: first char of plan (Chatterino `plan.at(0)`).
fn gift_tier_from_plan(plan: Option<&str>) -> String {
    plan.and_then(|s| s.chars().next())
        .map(|c| c.to_string())
        .unwrap_or_else(|| "1".to_string())
}

fn multimonth_tier(plan: Option<&str>) -> String {
    let n = plan.and_then(|s| s.parse::<u32>().ok()).unwrap_or(0) / 1000;
    if n == 0 {
        "1".to_string()
    } else {
        n.to_string()
    }
}

/// English system-msg overrides for search/log (Chatterino messageText). JS still localizes via params.
pub fn format_usernotice_system_en(
    msg_id: Option<&str>,
    params: Option<&UsernoticeParams>,
    fallback: &str,
) -> String {
    let id = msg_id.map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    let Some(p) = params else {
        return fallback.to_string();
    };
    match id.as_str() {
        "announcement" => "Announcement".to_string(),
        "bitsbadgetier" => {
            let Some(th) = p.bits_threshold else {
                return fallback.to_string();
            };
            format!(
                "{} just earned a new {} Bits badge!",
                display_name(p),
                format_bits_threshold_en(th)
            )
        }
        "sub" | "resub" => {
            if p.multimonth_tenure == Some(0) {
                let months = p.multimonth_duration.unwrap_or(0);
                if months > 1 {
                    let name = display_name(p);
                    let tier = multimonth_tier(p.plan.as_deref());
                    if id == "resub" {
                        let cum = p.cumulative_months.unwrap_or(months);
                        return format!(
                            "{name} subscribed at Tier {tier} for {months} months in advance, reaching {cum} months cumulatively so far!"
                        );
                    }
                    return format!(
                        "{name} subscribed at Tier {tier} for {months} months in advance!"
                    );
                }
            }
            fallback.to_string()
        }
        "subgift" | "anonsubgift" => {
            let gift_months = p.gift_months.unwrap_or(0);
            if gift_months <= 1 {
                return fallback.to_string();
            }
            let gifter = if p.anon {
                "An anonymous user".to_string()
            } else {
                display_name(p)
            };
            let recipient = p
                .recipient_display_name
                .as_deref()
                .or(p.recipient_login.as_deref())
                .unwrap_or("");
            let tier = gift_tier_from_plan(p.plan.as_deref());
            let mut text = format!(
                "{gifter} gifted {gift_months} months of a Tier {tier} sub to {recipient}!"
            );
            if let Some(count) = p.sender_count {
                if count > gift_months {
                    text.push_str(&format!(
                        " They've gifted {count} months in the channel."
                    ));
                }
            }
            text
        }
        "submysterygift" | "anonsubmysterygift" => {
            let count = p.mass_gift_count.unwrap_or(0);
            if count == 0 {
                return fallback.to_string();
            }
            let gifter = if p.anon {
                "An anonymous user".to_string()
            } else {
                display_name(p)
            };
            let tier = gift_tier_from_plan(p.plan.as_deref());
            format!("{gifter} is gifting {count} Tier {tier} Subs to the community!")
        }
        "raid" => {
            let name = p
                .raid_display_name
                .as_deref()
                .or(p.display_name.as_deref())
                .or(p.raid_login.as_deref())
                .or(p.login.as_deref())
                .unwrap_or("");
            let Some(viewers) = p.viewer_count else {
                return fallback.to_string();
            };
            if name.is_empty() {
                return fallback.to_string();
            }
            format!("{name} is raiding with a party of {viewers}!")
        }
        "modiversary" => {
            let name = display_name(p);
            let login = p.login.as_deref().unwrap_or("");
            if name.is_empty() {
                return fallback.to_string();
            }
            let lower = fallback.to_ascii_lowercase();
            if !lower.starts_with(&name.to_ascii_lowercase())
                && !(login.is_empty() || lower.starts_with(&login.to_ascii_lowercase()))
            {
                format!("{name} {fallback}")
            } else {
                fallback.to_string()
            }
        }
        _ => fallback.to_string(),
    }
}

/// Remaining timeout seconds from NOTICE trailing (stock word index 5).
pub fn parse_notice_timeout_remaining(text: &str) -> Option<u32> {
    text.split_whitespace().nth(5)?.parse().ok()
}

/// English duration like Chatterino `formatTime` (d/h/m/s, up to `components` parts).
pub fn format_duration_en(total_seconds: u64, components: u32) -> String {
    if total_seconds == 0 || components == 0 {
        return "0s".to_string();
    }
    let mut left = components;
    let seconds = (total_seconds % 60) as u32;
    let timeout_minutes = total_seconds / 60;
    let minutes = (timeout_minutes % 60) as u32;
    let timeout_hours = timeout_minutes / 60;
    let hours = (timeout_hours % 24) as u32;
    let days = (timeout_hours / 24) as u32;
    let mut parts: Vec<String> = Vec::new();
    if days > 0 && left > 0 {
        parts.push(format!("{days}d"));
        left -= 1;
    }
    if hours > 0 && left > 0 {
        parts.push(format!("{hours}h"));
        left -= 1;
    }
    if minutes > 0 && left > 0 {
        parts.push(format!("{minutes}m"));
        left -= 1;
    }
    if seconds > 0 && left > 0 {
        parts.push(format!("{seconds}s"));
    }
    if parts.is_empty() {
        "0s".to_string()
    } else {
        parts.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn duration_matches_chatterino_shape() {
        assert_eq!(format_duration_en(60, 4), "1m");
        assert_eq!(format_duration_en(3661, 4), "1h 1m 1s");
        assert_eq!(format_duration_en(90_000, 4), "1d 1h");
        assert_eq!(format_duration_en(90_000, 2), "1d 1h");
    }

    #[test]
    fn notice_timeout_word() {
        assert_eq!(
            parse_notice_timeout_remaining("You are timed out for 600 more seconds."),
            Some(600)
        );
    }

    #[test]
    fn subgift_params() {
        let map: HashMap<&str, &str> = HashMap::from([
            ("display-name", "Gifter"),
            ("login", "gifter"),
            ("user-id", "1"),
            ("msg-param-gift-months", "3"),
            ("msg-param-sub-plan", "1000"),
            ("msg-param-recipient-display-name", "Bob"),
            ("msg-param-recipient-user-name", "bob"),
            ("msg-param-sender-count", "10"),
        ]);
        let get = |k: &str| map.get(k).map(|s| (*s).to_string());
        let p = parse_usernotice_params(&get, Some("subgift")).expect("params");
        assert_eq!(p.gift_months, Some(3));
        assert_eq!(p.recipient_login.as_deref(), Some("bob"));
        assert!(!p.anon);
    }

    #[test]
    fn bits_and_multimonth_en() {
        let p = UsernoticeParams {
            display_name: Some("Ann".into()),
            login: Some("ann".into()),
            bits_threshold: Some(1000),
            ..Default::default()
        };
        assert_eq!(
            format_usernotice_system_en(Some("bitsbadgetier"), Some(&p), "x"),
            "Ann just earned a new 1K Bits badge!"
        );
        let multi = UsernoticeParams {
            display_name: Some("Ann".into()),
            plan: Some("1000".into()),
            multimonth_tenure: Some(0),
            multimonth_duration: Some(3),
            ..Default::default()
        };
        assert!(format_usernotice_system_en(Some("sub"), Some(&multi), "x")
            .contains("3 months in advance"));
    }

    #[test]
    fn anon_gifter_id() {
        let map: HashMap<&str, &str> =
            HashMap::from([("user-id", ANONYMOUS_GIFTER_ID), ("display-name", "AnAnonymousGifter")]);
        let get = |k: &str| map.get(k).map(|s| (*s).to_string());
        let p = parse_usernotice_params(&get, Some("subgift")).expect("params");
        assert!(p.anon);
    }
}
