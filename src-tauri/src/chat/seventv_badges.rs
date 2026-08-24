// MIT reimpl: Chatterino SeventvBadges.cpp + BadgeRegistry.cpp (7TV badge cosmetics via EventAPI).

use std::collections::HashMap;

use serde_json::Value;

use super::fetch::{safe_object_id, seventv_badge_url};
use super::types::Badge;

#[derive(Debug, Default)]
pub struct SeventvBadgeCatalog {
    known: HashMap<String, Badge>,
    user_badges: HashMap<String, String>,
}

impl SeventvBadgeCatalog {
    pub fn register_badge(&mut self, data: &Value) -> Option<String> {
        let id = data
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| safe_object_id(s))?;
        if self.known.contains_key(id) {
            return Some(id.to_string());
        }
        let url = seventv_badge_url(data)?;
        let name = data
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let tooltip = data
            .get("tooltip")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                if name.is_empty() {
                    None
                } else {
                    Some(name.to_string())
                }
            });
        let badge = Badge {
            set: "7tv".into(),
            version: id.to_string(),
            url: Some(url),
            source: "7tv".into(),
            tooltip,
        };
        self.known.insert(id.to_string(), badge);
        Some(id.to_string())
    }

    pub fn assign_user(&mut self, ref_id: &str, user_id: &str) {
        if ref_id.is_empty() || user_id.is_empty() || !safe_object_id(ref_id) {
            return;
        }
        if !self.known.contains_key(ref_id) {
            return;
        }
        self.user_badges.insert(user_id.to_string(), ref_id.to_string());
    }

    pub fn clear_user(&mut self, ref_id: &str, user_id: &str) {
        if ref_id.is_empty() || user_id.is_empty() {
            return;
        }
        if self
            .user_badges
            .get(user_id)
            .is_some_and(|id| id == ref_id)
        {
            self.user_badges.remove(user_id);
        }
    }

    pub fn badge_for_user(&self, user_id: &str) -> Option<Badge> {
        let ref_id = self.user_badges.get(user_id)?;
        self.known.get(ref_id).cloned()
    }

    pub fn append_for_user(&self, badges: &mut Vec<Badge>, user_id: &str) {
        if let Some(badge) = self.badge_for_user(user_id) {
            badges.push(badge);
        }
    }
}

pub fn apply_cosmetic_create(catalog: &mut SeventvBadgeCatalog, data: &Value) -> bool {
    let Some(obj) = data.get("body").and_then(|b| b.get("object")) else {
        return false;
    };
    if obj.get("kind").and_then(Value::as_str) != Some("BADGE") {
        return false;
    }
    let Some(badge_data) = obj.get("data") else {
        return false;
    };
    catalog.register_badge(badge_data).is_some()
}

pub fn parse_entitlement(data: &Value) -> Option<(String, String)> {
    let obj = data.get("body")?.get("object")?;
    if obj.get("kind").and_then(Value::as_str)? != "BADGE" {
        return None;
    }
    let ref_id = obj.get("ref_id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let connections = obj.get("user")?.get("connections")?.as_array()?;
    for conn in connections {
        if conn.get("platform").and_then(Value::as_str) != Some("TWITCH") {
            continue;
        }
        let user_id = conn.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
        return Some((ref_id.to_string(), user_id.to_string()));
    }
    None
}

pub fn apply_entitlement_create(catalog: &mut SeventvBadgeCatalog, data: &Value) -> bool {
    let Some((ref_id, user_id)) = parse_entitlement(data) else {
        return false;
    };
    catalog.assign_user(&ref_id, &user_id);
    true
}

pub fn apply_entitlement_delete(catalog: &mut SeventvBadgeCatalog, data: &Value) -> bool {
    let Some((ref_id, user_id)) = parse_entitlement(data) else {
        return false;
    };
    catalog.clear_user(&ref_id, &user_id);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_badge_data() -> Value {
        serde_json::json!({
            "id": "badge1",
            "name": "NNYS 2024",
            "tooltip": "New Year's Badge",
            "host": {
                "url": "//cdn.7tv.app/badge/badge1",
                "files": [{
                    "format": "WEBP",
                    "name": "1x.webp",
                    "static_name": "1x_static.webp",
                    "width": 18,
                    "height": 18
                }]
            }
        })
    }

    #[test]
    fn register_badge_uses_static_webp() {
        let mut cat = SeventvBadgeCatalog::default();
        let id = cat.register_badge(&sample_badge_data()).expect("registered");
        assert_eq!(id, "badge1");
        let badge = cat.known.get("badge1").expect("known");
        assert_eq!(badge.source, "7tv");
        assert_eq!(badge.set, "7tv");
        assert_eq!(badge.version, "badge1");
        assert_eq!(
            badge.url.as_deref(),
            Some("https://cdn.7tv.app/badge/badge1/1x_static.webp")
        );
        assert_eq!(badge.tooltip.as_deref(), Some("New Year's Badge"));
    }

    #[test]
    fn entitlement_create_and_delete() {
        let mut cat = SeventvBadgeCatalog::default();
        cat.register_badge(&sample_badge_data());
        let create = serde_json::json!({
            "type": "entitlement.create",
            "body": {
                "object": {
                    "kind": "BADGE",
                    "ref_id": "badge1",
                    "user": {
                        "connections": [{
                            "platform": "TWITCH",
                            "id": "12345",
                            "username": "viewer"
                        }]
                    }
                }
            }
        });
        assert!(apply_entitlement_create(&mut cat, &create));
        assert!(cat.badge_for_user("12345").is_some());

        let delete = serde_json::json!({
            "type": "entitlement.delete",
            "body": {
                "object": {
                    "kind": "BADGE",
                    "ref_id": "badge1",
                    "user": {
                        "connections": [{
                            "platform": "TWITCH",
                            "id": "12345",
                            "username": "viewer"
                        }]
                    }
                }
            }
        });
        assert!(apply_entitlement_delete(&mut cat, &delete));
        assert!(cat.badge_for_user("12345").is_none());
    }

    #[test]
    fn cosmetic_create_registers_badge() {
        let mut cat = SeventvBadgeCatalog::default();
        let data = serde_json::json!({
            "type": "cosmetic.create",
            "body": {
                "object": {
                    "kind": "BADGE",
                    "data": sample_badge_data()
                }
            }
        });
        assert!(apply_cosmetic_create(&mut cat, &data));
        assert!(cat.known.contains_key("badge1"));
    }

    #[test]
    fn rejects_invalid_host() {
        let mut cat = SeventvBadgeCatalog::default();
        let bad = serde_json::json!({
            "id": "x",
            "host": { "url": "//evil.example/x", "files": [{ "format": "WEBP", "name": "1x.webp" }] }
        });
        assert!(cat.register_badge(&bad).is_none());
    }

    #[test]
    fn assign_before_register_is_noop() {
        let mut cat = SeventvBadgeCatalog::default();
        cat.assign_user("missing", "1");
        assert!(cat.badge_for_user("1").is_none());
    }

    #[test]
    fn append_for_user_extends_existing() {
        let mut cat = SeventvBadgeCatalog::default();
        cat.register_badge(&sample_badge_data());
        cat.assign_user("badge1", "99");
        let mut badges = vec![Badge {
            set: "moderator".into(),
            version: "1".into(),
            url: None,
            source: "twitch".into(),
            tooltip: None,
        }];
        cat.append_for_user(&mut badges, "99");
        assert_eq!(badges.len(), 2);
        assert_eq!(badges[1].source, "7tv");
    }
}
