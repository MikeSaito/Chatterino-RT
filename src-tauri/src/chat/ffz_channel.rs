// MIT reimpl: Chatterino FfzEmotes.cpp (channel badges, custom mod/vip).

use std::collections::HashMap;

use serde_json::Value;

use super::fetch::allowed_ffz_url;
use super::ffz_badges::FfzBadgeCatalog;
use super::types::Badge;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthorityBadge {
    pub url: String,
    pub tooltip: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FfzChannelExtras {
    pub user_badges: HashMap<String, Vec<i32>>,
    pub custom_mod: Option<AuthorityBadge>,
    pub custom_vip: Option<AuthorityBadge>,
}

pub fn parse_ffz_room_extras(value: &Value) -> FfzChannelExtras {
    let Some(room) = value.get("room") else {
        return FfzChannelExtras::default();
    };
    FfzChannelExtras {
        user_badges: parse_user_badge_ids(room.get("user_badge_ids")),
        custom_mod: room
            .get("mod_urls")
            .and_then(|v| parse_authority_badge(v, "Moderator")),
        custom_vip: room
            .get("vip_badge")
            .and_then(|v| parse_authority_badge(v, "VIP")),
    }
}

fn parse_authority_badge(urls: &Value, tooltip: &str) -> Option<AuthorityBadge> {
    let url = urls.get("1").and_then(Value::as_str).and_then(allowed_ffz_url)?;
    Some(AuthorityBadge {
        url,
        tooltip: tooltip.to_string(),
    })
}

fn parse_user_badge_ids(value: Option<&Value>) -> HashMap<String, Vec<i32>> {
    let mut out = HashMap::new();
    let Some(obj) = value.and_then(Value::as_object) else {
        return out;
    };
    for (badge_id_str, users_val) in obj {
        let Ok(badge_id) = badge_id_str.parse::<i32>() else {
            continue;
        };
        if badge_id < 0 {
            continue;
        }
        let Some(arr) = users_val.as_array() else {
            continue;
        };
        for user_val in arr {
            let user_id = match user_val {
                Value::String(s) if !s.is_empty() => Some(s.clone()),
                Value::Number(n) => n.as_i64().map(|v| v.to_string()),
                _ => None,
            };
            let Some(user_id) = user_id else {
                continue;
            };
            let entry = out.entry(user_id).or_default();
            if !entry.contains(&badge_id) {
                entry.push(badge_id);
            }
        }
    }
    out
}

pub fn apply_custom_authority(
    badges: &mut [Badge],
    extras: &FfzChannelExtras,
    use_mod: bool,
    use_vip: bool,
) {
    for badge in badges.iter_mut() {
        if use_mod && badge.set == "moderator" {
            if let Some(custom) = &extras.custom_mod {
                badge.url = Some(custom.url.clone());
                badge.tooltip = Some(custom.tooltip.clone());
            }
        } else if use_vip && badge.set == "vip" {
            if let Some(custom) = &extras.custom_vip {
                badge.url = Some(custom.url.clone());
                badge.tooltip = Some(custom.tooltip.clone());
            }
        }
    }
}

pub fn append_channel_badges(
    global: &FfzBadgeCatalog,
    extras: &FfzChannelExtras,
    badges: &mut Vec<Badge>,
    user_id: &str,
) {
    let Some(ids) = extras.user_badges.get(user_id) else {
        return;
    };
    for id in ids {
        if let Some(badge) = global.badge_for_id(*id) {
            badges.push(badge);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room_json() -> Value {
        serde_json::json!({
            "room": {
                "mod_urls": {
                    "1": "//cdn.frankerfacez.com/room-badge/mod/1/1",
                    "2": "//cdn.frankerfacez.com/room-badge/mod/1/2"
                },
                "vip_badge": {
                    "1": "//cdn.frankerfacez.com/room-badge/vip/1/1"
                },
                "user_badge_ids": {
                    "42": [12345, "67890", 12345],
                    "bad": ["111"],
                    "99": [12345]
                }
            }
        })
    }

    #[test]
    fn parse_user_badge_ids_inverts_and_dedupes() {
        let extras = parse_ffz_room_extras(&room_json());
        assert_eq!(
            extras.user_badges.get("12345").map(|v| v.as_slice()),
            Some(&[42, 99][..])
        );
        assert_eq!(
            extras.user_badges.get("67890").map(|v| v.as_slice()),
            Some(&[42][..])
        );
        assert!(!extras.user_badges.contains_key("111"));
    }

    #[test]
    fn parse_authority_badge_from_mod_urls() {
        let extras = parse_ffz_room_extras(&room_json());
        let custom_mod = extras.custom_mod.expect("mod badge");
        assert!(custom_mod.url.contains("room-badge/mod"));
        assert_eq!(custom_mod.tooltip, "Moderator");
        let custom_vip = extras.custom_vip.expect("vip badge");
        assert!(custom_vip.url.contains("room-badge/vip"));
        assert_eq!(custom_vip.tooltip, "VIP");
    }

    #[test]
    fn parse_rejects_bad_authority_urls() {
        let value = serde_json::json!({
            "room": {
                "mod_urls": { "1": "https://evil.example/x.png" },
                "vip_badge": null
            }
        });
        let extras = parse_ffz_room_extras(&value);
        assert!(extras.custom_mod.is_none());
        assert!(extras.custom_vip.is_none());
    }

    #[test]
    fn apply_custom_authority_swaps_when_knobs_on() {
        let extras = parse_ffz_room_extras(&room_json());
        let mut badges = vec![
            Badge {
                set: "moderator".into(),
                version: "1".into(),
                url: Some("https://static-cdn.jtvnw.net/badges/v1/...".into()),
                source: "twitch".into(),
                tooltip: Some("Moderator".into()),
            },
            Badge {
                set: "vip".into(),
                version: "1".into(),
                url: Some("https://static-cdn.jtvnw.net/badges/v1/...".into()),
                source: "twitch".into(),
                tooltip: Some("VIP".into()),
            },
        ];
        apply_custom_authority(&mut badges, &extras, true, true);
        assert!(badges[0].url.as_ref().is_some_and(|u| u.contains("room-badge/mod")));
        assert_eq!(badges[0].set, "moderator");
        assert_eq!(badges[0].source, "twitch");
        assert!(badges[1].url.as_ref().is_some_and(|u| u.contains("room-badge/vip")));
    }

    #[test]
    fn apply_custom_authority_noop_when_knobs_off() {
        let extras = parse_ffz_room_extras(&room_json());
        let original = "https://static-cdn.jtvnw.net/badges/v1/mod".to_string();
        let mut badges = vec![Badge {
            set: "moderator".into(),
            version: "1".into(),
            url: Some(original.clone()),
            source: "twitch".into(),
            tooltip: None,
        }];
        apply_custom_authority(&mut badges, &extras, false, false);
        assert_eq!(badges[0].url.as_deref(), Some(original.as_str()));
    }

    #[test]
    fn append_channel_badges_uses_global_catalog() {
        let extras = parse_ffz_room_extras(&room_json());
        let global = super::super::ffz_badges::parse_ffz_badges(&serde_json::json!({
            "badges": [{
                "id": 42,
                "title": "Channel Dev",
                "urls": { "1": "//cdn.frankerfacez.com/badge/42/1" }
            }],
            "users": {}
        }));
        let mut badges = Vec::new();
        append_channel_badges(&global, &extras, &mut badges, "12345");
        assert_eq!(badges.len(), 1);
        assert_eq!(badges[0].source, "ffz");
        assert_eq!(badges[0].set, "ffz");
        assert_eq!(badges[0].version, "42");
        assert_eq!(badges[0].tooltip.as_deref(), Some("Channel Dev"));
    }

    #[test]
    fn append_channel_badges_skips_unknown_ids() {
        let extras = parse_ffz_room_extras(&room_json());
        let global = FfzBadgeCatalog::default();
        let mut badges = Vec::new();
        append_channel_badges(&global, &extras, &mut badges, "12345");
        assert!(badges.is_empty());
    }

    #[test]
    fn parse_empty_user_ids_rejected() {
        let value = serde_json::json!({
            "room": {
                "user_badge_ids": { "1": ["", 0] }
            }
        });
        let extras = parse_ffz_room_extras(&value);
        assert_eq!(extras.user_badges.get("0").map(|v| v.as_slice()), Some(&[1][..]));
        assert!(!extras.user_badges.contains_key(""));
    }
}
