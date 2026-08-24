// MIT reimpl: Chatterino BttvBadges.cpp + BadgeRegistry.cpp (BTTV Pro via lookup_user).

use std::collections::HashMap;

use serde_json::Value;

use super::fetch::allowed_bttv_url;
use super::types::Badge;

const BTTV_PRO_TOOLTIP: &str = "BTTV Pro";

#[derive(Debug, Default)]
pub struct BttvBadgeCatalog {
    known: HashMap<String, Badge>,
    user_badges: HashMap<String, String>,
}

impl BttvBadgeCatalog {
    pub fn register_badge(&mut self, url: &str) -> Option<String> {
        let url = allowed_bttv_url(url)?;
        if self.known.contains_key(&url) {
            return Some(url);
        }
        let badge = Badge {
            set: "bttv".into(),
            version: url.clone(),
            url: Some(url.clone()),
            source: "bttv".into(),
            tooltip: Some(BTTV_PRO_TOOLTIP.into()),
        };
        self.known.insert(url.clone(), badge);
        Some(url)
    }

    pub fn assign_user(&mut self, user_id: &str, url: &str) {
        if user_id.is_empty() {
            return;
        }
        let Some(url) = self.register_badge(url) else {
            return;
        };
        self.user_badges.insert(user_id.to_string(), url);
    }

    pub fn badge_for_user(&self, user_id: &str) -> Option<Badge> {
        let url = self.user_badges.get(user_id)?;
        self.known.get(url).cloned()
    }

    pub fn append_for_user(&self, badges: &mut Vec<Badge>, user_id: &str) {
        if let Some(badge) = self.badge_for_user(user_id) {
            badges.push(badge);
        }
    }
}

pub fn apply_lookup_user(catalog: &mut BttvBadgeCatalog, data: &Value) -> bool {
    let Some(user_id) = data
        .get("providerId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Some(badge_obj) = data.get("badge").and_then(Value::as_object) else {
        return false;
    };
    if badge_obj.is_empty() {
        return false;
    }
    let Some(url) = badge_obj.get("url").and_then(Value::as_str) else {
        return false;
    };
    catalog.assign_user(user_id, url);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRO_URL: &str = "https://cdn.betterttv.net/badge/pro/1";

    #[test]
    fn register_and_assign_pro_badge() {
        let mut cat = BttvBadgeCatalog::default();
        cat.assign_user("12345", PRO_URL);
        let badge = cat.badge_for_user("12345").expect("badge");
        assert_eq!(badge.source, "bttv");
        assert_eq!(badge.set, "bttv");
        assert_eq!(badge.version, PRO_URL);
        assert_eq!(badge.tooltip.as_deref(), Some(BTTV_PRO_TOOLTIP));
    }

    #[test]
    fn rejects_invalid_url() {
        let mut cat = BttvBadgeCatalog::default();
        cat.assign_user("1", "https://evil.example/x.png");
        assert!(cat.badge_for_user("1").is_none());
    }

    #[test]
    fn apply_lookup_user_parses_payload() {
        let mut cat = BttvBadgeCatalog::default();
        let ok = apply_lookup_user(
            &mut cat,
            &serde_json::json!({
                "providerId": "999",
                "badge": { "url": PRO_URL }
            }),
        );
        assert!(ok);
        assert!(cat.badge_for_user("999").is_some());
    }

    #[test]
    fn apply_lookup_user_without_badge_is_noop() {
        let mut cat = BttvBadgeCatalog::default();
        assert!(!apply_lookup_user(
            &mut cat,
            &serde_json::json!({ "providerId": "1" })
        ));
    }

    #[test]
    fn append_for_user_extends_existing() {
        let mut cat = BttvBadgeCatalog::default();
        cat.assign_user("1", PRO_URL);
        let mut badges = vec![Badge {
            set: "moderator".into(),
            version: "1".into(),
            url: None,
            source: "twitch".into(),
            tooltip: None,
        }];
        cat.append_for_user(&mut badges, "1");
        assert_eq!(badges.len(), 2);
        assert_eq!(badges[1].source, "bttv");
    }
}
