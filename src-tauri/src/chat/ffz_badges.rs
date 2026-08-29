// MIT reimpl: Chatterino FfzBadges.cpp (global badges from /v1/badges/ids).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::fetch::allowed_ffz_url;
use super::types::Badge;

const FFZ_BADGES_URL: &str = "https://api.frankerfacez.com/v1/badges/ids";
const ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Default)]
struct FfzBadgeDef {
    url: String,
    tooltip: Option<String>,
}

#[derive(Debug, Default)]
pub struct FfzBadgeCatalog {
    badges: HashMap<i32, FfzBadgeDef>,
    user_badges: HashMap<String, Vec<i32>>,
}

impl FfzBadgeCatalog {
    pub fn replace(&mut self, parsed: FfzBadgeCatalog) {
        self.badges = parsed.badges;
        self.user_badges = parsed.user_badges;
    }

    pub fn badge_for_id(&self, id: i32) -> Option<Badge> {
        let def = self.badges.get(&id)?;
        Some(Badge {
            set: "ffz".into(),
            version: id.to_string(),
            url: Some(def.url.clone()),
            source: "ffz".into(),
            tooltip: def.tooltip.clone(),
        })
    }

    pub fn badges_for_user(&self, user_id: &str) -> Vec<Badge> {
        let Some(ids) = self.user_badges.get(user_id) else {
            return Vec::new();
        };
        ids.iter().filter_map(|id| self.badge_for_id(*id)).collect()
    }

    pub fn append_for_user(&self, badges: &mut Vec<Badge>, user_id: &str) {
        badges.extend(self.badges_for_user(user_id));
    }
}

pub fn parse_ffz_badges(value: &Value) -> FfzBadgeCatalog {
    let mut catalog = FfzBadgeCatalog::default();
    let users_root = value.get("users").and_then(Value::as_object);
    let Some(badge_arr) = value.get("badges").and_then(Value::as_array) else {
        return catalog;
    };
    for item in badge_arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let id = obj.get("id").and_then(Value::as_i64).unwrap_or(-1) as i32;
        if id < 0 {
            continue;
        }
        let url = obj
            .get("urls")
            .and_then(Value::as_object)
            .and_then(|urls| urls.get("1"))
            .and_then(Value::as_str)
            .and_then(allowed_ffz_url);
        let Some(url) = url else {
            continue;
        };
        let tooltip = obj
            .get("title")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        catalog.badges.insert(id, FfzBadgeDef { url, tooltip });
        let badge_id_str = id.to_string();
        let Some(user_list) = users_root.and_then(|u| u.get(&badge_id_str)) else {
            continue;
        };
        let Some(arr) = user_list.as_array() else {
            continue;
        };
        for user_val in arr {
            let user_id = match user_val {
                Value::Number(n) => n.as_i64().map(|v| v.to_string()),
                Value::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            };
            let Some(user_id) = user_id else {
                continue;
            };
            let entry = catalog.user_badges.entry(user_id).or_default();
            if !entry.contains(&id) {
                entry.push(id);
            }
        }
    }
    catalog
}

pub async fn load(catalog: &Arc<Mutex<FfzBadgeCatalog>>) {
    let client = http_client();
    let Some(value) = get_json(&client, FFZ_BADGES_URL).await.ok() else {
        return;
    };
    let parsed = parse_ffz_badges(&value);
    if let Ok(mut slot) = catalog.lock() {
        slot.replace(parsed);
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Chatterino-RT/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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
                "id": 42,
                "name": "developer",
                "title": "FFZ Developer",
                "urls": { "1": "//cdn.frankerfacez.com/badge/42/1" }
            }, {
                "id": 99,
                "name": "broken",
                "urls": { "1": "https://evil.example/x.png" }
            }],
            "users": {
                "42": [12345, "67890", 12345],
                "99": [12345]
            }
        })
    }

    #[test]
    fn parse_ffz_badges_builds_user_map() {
        let cat = parse_ffz_badges(&sample_json());
        assert_eq!(cat.badges.len(), 1);
        assert!(cat.badges.contains_key(&42));
        assert!(!cat.badges.contains_key(&99));
        assert_eq!(
            cat.user_badges.get("12345").map(|v| v.as_slice()),
            Some(&[42][..])
        );
        assert_eq!(
            cat.user_badges.get("67890").map(|v| v.as_slice()),
            Some(&[42][..])
        );
    }

    #[test]
    fn badges_for_user_returns_ffz_source_and_tooltip() {
        let cat = parse_ffz_badges(&sample_json());
        let badges = cat.badges_for_user("12345");
        assert_eq!(badges.len(), 1);
        assert_eq!(badges[0].source, "ffz");
        assert_eq!(badges[0].set, "ffz");
        assert_eq!(badges[0].version, "42");
        assert_eq!(badges[0].tooltip.as_deref(), Some("FFZ Developer"));
        assert!(badges[0]
            .url
            .as_ref()
            .is_some_and(|u| u.contains("frankerfacez")));
    }

    #[test]
    fn badges_for_user_unknown_returns_empty() {
        let cat = parse_ffz_badges(&sample_json());
        assert!(cat.badges_for_user("0").is_empty());
    }

    #[test]
    fn append_for_user_extends_existing() {
        let cat = parse_ffz_badges(&sample_json());
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
        assert_eq!(badges[1].source, "ffz");
    }
}
