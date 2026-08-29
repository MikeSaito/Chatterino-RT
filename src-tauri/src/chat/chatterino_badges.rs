// MIT reimpl: Chatterino ChatterinoBadges.cpp (GET api.chatterino.com/badges).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::fetch::allowed_chatterino_badge_url;
use super::types::Badge;

const CHATTERINO_BADGES_URL: &str = "https://api.chatterino.com/badges";
const ATTEMPTS: u32 = 3;

#[derive(Debug, Default)]
pub struct ChatterinoBadgeCatalog {
    known: HashMap<String, Badge>,
    user_badges: HashMap<String, String>,
}

impl ChatterinoBadgeCatalog {
    pub fn replace(&mut self, parsed: ChatterinoBadgeCatalog) {
        self.known = parsed.known;
        self.user_badges = parsed.user_badges;
    }

    pub fn badge_for_user(&self, user_id: &str) -> Option<Badge> {
        let version = self.user_badges.get(user_id)?;
        self.known.get(version).cloned()
    }

    pub fn append_for_user(&self, badges: &mut Vec<Badge>, user_id: &str) {
        if let Some(badge) = self.badge_for_user(user_id) {
            badges.push(badge);
        }
    }
}

fn valid_user_id(user_id: &str) -> bool {
    !user_id.is_empty() && user_id != "-1"
}

pub fn parse_chatterino_badges(value: &Value) -> ChatterinoBadgeCatalog {
    let mut catalog = ChatterinoBadgeCatalog::default();
    let Some(badge_arr) = value.get("badges").and_then(Value::as_array) else {
        return catalog;
    };
    for (index, item) in badge_arr.iter().enumerate() {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(url) = obj
            .get("image1")
            .and_then(Value::as_str)
            .and_then(allowed_chatterino_badge_url)
        else {
            continue;
        };
        let tooltip = obj
            .get("tooltip")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let version = index.to_string();
        let badge = Badge {
            set: "chatterino".into(),
            version: version.clone(),
            url: Some(url),
            source: "chatterino".into(),
            tooltip,
        };
        catalog.known.insert(version.clone(), badge);
        let Some(users) = obj.get("users").and_then(Value::as_array) else {
            continue;
        };
        for user_val in users {
            let user_id = match user_val {
                Value::String(s) => s.as_str(),
                Value::Number(n) => {
                    if let Some(v) = n.as_i64() {
                        if v < 0 {
                            continue;
                        }
                        // Store via temporary; numbers become strings below
                        let id = v.to_string();
                        if valid_user_id(&id) {
                            catalog.user_badges.insert(id, version.clone());
                        }
                        continue;
                    }
                    continue;
                }
                _ => continue,
            };
            if valid_user_id(user_id) {
                catalog
                    .user_badges
                    .insert(user_id.to_string(), version.clone());
            }
        }
    }
    catalog
}

pub async fn load(catalog: &Arc<Mutex<ChatterinoBadgeCatalog>>) {
    let client = http_client();
    let Some(value) = get_json(&client, CHATTERINO_BADGES_URL).await.ok() else {
        return;
    };
    let parsed = parse_chatterino_badges(&value);
    if let Ok(mut slot) = catalog.lock() {
        slot.replace(parsed);
    }
}

fn http_client() -> reqwest::Client {
    super::http_client::build(Duration::from_secs(12))
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, ()> {
    let mut delay = Duration::from_millis(200);
    for attempt in 0..ATTEMPTS {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(v) = resp.json::<Value>().await {
                    return Ok(v);
                }
            }
            Ok(_) | Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay = delay.saturating_mul(2);
        }
    }
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_json() -> Value {
        serde_json::json!({
            "badges": [{
                "tooltip": "Chatterino Contributor",
                "image1": "https://fourtf.com/chatterino/badges/helper.png",
                "image2": "https://fourtf.com/chatterino/badges/helper2x.png",
                "users": ["12345", "-1", ""]
            }, {
                "tooltip": "Evil Badge",
                "image1": "https://evil.example/x.png",
                "users": ["999"]
            }]
        })
    }

    #[test]
    fn parse_builds_user_map_with_tooltip() {
        let cat = parse_chatterino_badges(&sample_json());
        assert_eq!(cat.known.len(), 1);
        let badge = cat.badge_for_user("12345").expect("badge");
        assert_eq!(badge.source, "chatterino");
        assert_eq!(badge.set, "chatterino");
        assert_eq!(badge.version, "0");
        assert_eq!(badge.tooltip.as_deref(), Some("Chatterino Contributor"));
        assert!(badge
            .url
            .as_ref()
            .is_some_and(|u| u.contains("fourtf.com/chatterino/badges/helper.png")));
        assert!(cat.badge_for_user("-1").is_none());
        assert!(cat.badge_for_user("999").is_none());
    }

    #[test]
    fn append_for_user_extends_existing() {
        let cat = parse_chatterino_badges(&sample_json());
        let mut badges = vec![Badge {
            set: "moderator".into(),
            version: "1".into(),
            url: None,
            source: "twitch".into(),
            tooltip: None,
        }];
        cat.append_for_user(&mut badges, "12345");
        assert_eq!(badges.len(), 2);
        assert_eq!(badges[0].source, "twitch");
        assert_eq!(badges[1].source, "chatterino");
    }

    #[test]
    fn rejects_invalid_image_url() {
        let cat = parse_chatterino_badges(&serde_json::json!({
            "badges": [{
                "tooltip": "Bad",
                "image1": "https://fourtf.com/other/x.png",
                "users": ["1"]
            }]
        }));
        assert!(cat.badge_for_user("1").is_none());
    }
}
