// SPDX-FileCopyrightText: 2018 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of Helix badge and cheermote catalog loading from Chatterino
// src/providers/twitch/TwitchBadges.cpp, TwitchChannel.cpp, and api/Helix.cpp.
// Not a copy of C++/Qt source.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use url::Url;

use super::cheers::{CheerCatalog, CheerSet, CheerTier};
use super::hub::Hub;
use super::types::Badge;

const ATTEMPTS: u32 = 3;
const HELIX: &str = "https://api.twitch.tv/helix";
const BADGE_HOSTS: &[&str] = &["static-cdn.jtvnw.net"];
const CHEER_HOSTS: &[&str] = &["d3aqoihi2n8ty8.cloudfront.net"];
const RETRY_WAIT: Duration = Duration::from_secs(2);

enum HelixFetch {
    Ok(Value),
    Auth,
    Fail,
}

pub type BadgeMap = HashMap<String, String>;

#[derive(Debug, Default)]
pub struct BadgeCatalog {
    global: BadgeMap,
    channel: HashMap<String, BadgeMap>,
}

impl BadgeCatalog {
    pub fn replace_global(&mut self, map: BadgeMap) {
        self.global = map;
    }

    pub fn replace_channel(&mut self, channel: String, map: BadgeMap) {
        self.channel.insert(channel, map);
    }

    pub fn retain_channel(&mut self, channel: &str) {
        self.channel.retain(|k, _| k == channel);
    }

    pub fn clear_channels(&mut self) {
        self.channel.clear();
    }

    pub fn lookup(&self, channel: &str, set: &str, version: &str) -> Option<&str> {
        let key = badge_key(set, version);
        self.channel
            .get(channel)
            .and_then(|m| m.get(&key))
            .or_else(|| self.global.get(&key))
            .map(String::as_str)
    }
}

pub fn resolve_badge_urls(badges: &mut [Badge], catalog: &BadgeCatalog, channel: &str) {
    for badge in badges {
        if let Some(url) = catalog.lookup(channel, &badge.set, &badge.version) {
            badge.url = Some(url.to_string());
        }
    }
}

pub async fn load_global_badges(catalog: &Arc<Mutex<BadgeCatalog>>, token: Option<&str>) {
    let Some((client_id, token)) = helix_creds(token) else {
        return;
    };
    let client = http_client();
    let url = format!("{HELIX}/chat/badges/global");
    let v = match get_helix(&client, &url, &client_id, &token).await {
        HelixFetch::Ok(v) => v,
        HelixFetch::Auth => return,
        HelixFetch::Fail => {
            tokio::time::sleep(RETRY_WAIT).await;
            match get_helix(&client, &url, &client_id, &token).await {
                HelixFetch::Ok(v) => v,
                HelixFetch::Auth | HelixFetch::Fail => return,
            }
        }
    };
    let map = parse_badge_sets(&v);
    if let Ok(mut cat) = catalog.lock() {
        cat.replace_global(map);
    }
}

pub async fn load_channel(
    badges: &Arc<Mutex<BadgeCatalog>>,
    cheers: &Arc<Mutex<CheerCatalog>>,
    hub: &Arc<Mutex<Hub>>,
    login: &str,
    room_id: &str,
    token: Option<&str>,
) {
    let Some((client_id, token)) = helix_creds(token) else {
        return;
    };
    if !still_active(hub, login) {
        return;
    }
    let client = http_client();
    let badge_url = helix_query("/chat/badges", &[("broadcaster_id", room_id)]);
    let cheer_url = helix_query("/bits/cheermotes", &[("broadcaster_id", room_id)]);
    let (badge_json, cheer_json) = tokio::join!(
        get_helix(&client, &badge_url, &client_id, &token),
        get_helix(&client, &cheer_url, &client_id, &token),
    );
    let badge_json = recover_helix(&client, &badge_url, &client_id, &token, hub, login, badge_json).await;
    let cheer_json = recover_helix(&client, &cheer_url, &client_id, &token, hub, login, cheer_json).await;
    if let Some(v) = badge_json {
        let map = parse_badge_sets(&v);
        commit_if_active(hub, login, badges, |cat| {
            cat.replace_channel(login.to_string(), map);
        });
    }
    if let Some(v) = cheer_json {
        let sets = parse_cheermote_sets(&v);
        commit_if_active(hub, login, cheers, |cat| {
            cat.replace_channel(login.to_string(), sets);
        });
    }
}

async fn recover_helix(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    token: &str,
    hub: &Arc<Mutex<Hub>>,
    login: &str,
    first: HelixFetch,
) -> Option<Value> {
    match first {
        HelixFetch::Ok(v) => Some(v),
        HelixFetch::Auth => None,
        HelixFetch::Fail => {
            if !still_active(hub, login) {
                return None;
            }
            tokio::time::sleep(RETRY_WAIT).await;
            if !still_active(hub, login) {
                return None;
            }
            match get_helix(client, url, client_id, token).await {
                HelixFetch::Ok(v) => Some(v),
                HelixFetch::Auth | HelixFetch::Fail => None,
            }
        }
    }
}

fn commit_if_active<T>(
    hub: &Arc<Mutex<Hub>>,
    login: &str,
    catalog: &Arc<Mutex<T>>,
    write: impl FnOnce(&mut T),
) {
    let Ok(h) = hub.lock() else {
        return;
    };
    if h.active.as_deref() != Some(login) {
        return;
    }
    let Ok(mut cat) = catalog.lock() else {
        return;
    };
    write(&mut cat);
}

pub fn helix_creds(token: Option<&str>) -> Option<(String, String)> {
    let client_id = env_secret("TWITCH_CLIENT_ID")?;
    let token = if let Some(t) = token {
        let t = t.trim().trim_start_matches("oauth:");
        if t.is_empty() || t == "YOUR_API_KEY_HERE" {
            return None;
        }
        t.to_string()
    } else {
        let raw = env_secret("TWITCH_OAUTH_TOKEN")?;
        let t = raw.trim_start_matches("oauth:").to_string();
        if t.is_empty() || t == "YOUR_API_KEY_HERE" {
            return None;
        }
        t
    };
    Some((client_id, token))
}

pub fn allowed_badge_url(raw: &str) -> Option<String> {
    allowed_https_host(raw, BADGE_HOSTS)
}

pub fn allowed_cheer_url(raw: &str) -> Option<String> {
    allowed_https_host(raw, CHEER_HOSTS)
}

fn allowed_https_host(raw: &str, hosts: &[&str]) -> Option<String> {
    let parsed = Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?;
    if !hosts.iter().any(|h| *h == host) {
        return None;
    }
    Some(parsed.as_str().to_string())
}

pub fn parse_badge_sets(value: &Value) -> BadgeMap {
    let mut map = BadgeMap::new();
    let Some(arr) = value.get("data").and_then(Value::as_array) else {
        return map;
    };
    for set in arr {
        let set_id = set.get("set_id").and_then(Value::as_str).unwrap_or("");
        if set_id.is_empty() {
            continue;
        }
        let Some(versions) = set.get("versions").and_then(Value::as_array) else {
            continue;
        };
        for ver in versions {
            let id = ver.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let Some(url) = ver
                .get("image_url_1x")
                .and_then(Value::as_str)
                .and_then(allowed_badge_url)
            else {
                continue;
            };
            map.insert(badge_key(set_id, id), url);
        }
    }
    map
}

pub fn parse_cheermote_sets(value: &Value) -> Vec<CheerSet> {
    let Some(arr) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut sets = Vec::new();
    for item in arr {
        let prefix = item.get("prefix").and_then(Value::as_str).unwrap_or("");
        if prefix.is_empty() || !prefix.is_ascii() {
            continue;
        }
        let Some(tiers_json) = item.get("tiers").and_then(Value::as_array) else {
            continue;
        };
        let mut tiers = Vec::new();
        for tier in tiers_json {
            let min_bits = tier.get("min_bits").and_then(Value::as_u64).unwrap_or(0);
            if min_bits == 0 || min_bits > u64::from(u32::MAX) {
                continue;
            }
            let Some(url) = tier
                .get("images")
                .and_then(|im| im.get("dark"))
                .and_then(|d| d.get("static"))
                .and_then(|s| s.get("1"))
                .and_then(Value::as_str)
                .and_then(allowed_cheer_url)
            else {
                continue;
            };
            tiers.push(CheerTier {
                min_bits: min_bits as u32,
                url,
            });
        }
        if tiers.is_empty() {
            continue;
        }
        tiers.sort_by(|a, b| b.min_bits.cmp(&a.min_bits));
        sets.push(CheerSet {
            prefix: prefix.to_string(),
            tiers,
        });
    }
    sets.sort_by(|a, b| b.prefix.len().cmp(&a.prefix.len()));
    sets
}

fn badge_key(set: &str, version: &str) -> String {
    format!("{set}/{version}")
}

fn still_active(hub: &Arc<Mutex<Hub>>, login: &str) -> bool {
    hub.lock()
        .ok()
        .and_then(|h| h.active.clone())
        .is_some_and(|ch| ch == login)
}

pub(crate) fn env_secret(name: &str) -> Option<String> {
    let s = std::env::var(name).ok()?.trim().to_string();
    if s.is_empty() || s == "YOUR_API_KEY_HERE" {
        None
    } else {
        Some(s)
    }
}

fn helix_query(path: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse(&format!("{HELIX}{path}")).expect("helix base");
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in pairs {
            q.append_pair(k, v);
        }
    }
    url.to_string()
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("WebTV_chats/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn get_helix(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    token: &str,
) -> HelixFetch {
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .get(url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match resp.json::<Value>().await {
                        Ok(v) => return HelixFetch::Ok(v),
                        Err(e) => last = format!("json: {e}"),
                    }
                } else {
                    last = format!("http {status}");
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        eprintln!("helix fetch failed ({last}): {url}");
                        return HelixFetch::Auth;
                    }
                }
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    eprintln!("helix fetch failed after {ATTEMPTS} attempts ({last}): {url}");
    HelixFetch::Fail
}

#[cfg(test)]
mod tests {
    use super::*;

    const BADGES_JSON: &str = r#"{
      "data": [
        {
          "set_id": "broadcaster",
          "versions": [
            {
              "id": "1",
              "image_url_1x": "https://static-cdn.jtvnw.net/badges/v1/broadcaster/1"
            }
          ]
        },
        {
          "set_id": "subscriber",
          "versions": [
            {
              "id": "12",
              "image_url_1x": "javascript:alert(1)"
            }
          ]
        }
      ]
    }"#;

    const CHEERS_JSON: &str = r#"{
      "data": [
        {
          "prefix": "Cheer",
          "tiers": [
            {
              "min_bits": 1,
              "images": {
                "dark": {
                  "static": {
                    "1": "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/static/1/1.gif"
                  }
                }
              }
            },
            {
              "min_bits": 100,
              "images": {
                "dark": {
                  "static": {
                    "1": "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/static/100/1.gif"
                  }
                }
              }
            }
          ]
        }
      ]
    }"#;

    #[test]
    fn parses_badge_sets_and_drops_bad_url() {
        let v: Value = serde_json::from_str(BADGES_JSON).unwrap();
        let map = parse_badge_sets(&v);
        assert_eq!(
            map.get("broadcaster/1").map(String::as_str),
            Some("https://static-cdn.jtvnw.net/badges/v1/broadcaster/1")
        );
        assert!(!map.contains_key("subscriber/12"));
    }

    #[test]
    fn channel_badge_overrides_global() {
        let mut cat = BadgeCatalog::default();
        cat.replace_global({
            let mut m = BadgeMap::new();
            m.insert(
                "subscriber/1".into(),
                "https://static-cdn.jtvnw.net/badges/v1/global/1".into(),
            );
            m
        });
        cat.replace_channel("xqc".into(), {
            let mut m = BadgeMap::new();
            m.insert(
                "subscriber/1".into(),
                "https://static-cdn.jtvnw.net/badges/v1/xqc/1".into(),
            );
            m
        });
        assert_eq!(
            cat.lookup("xqc", "subscriber", "1"),
            Some("https://static-cdn.jtvnw.net/badges/v1/xqc/1")
        );
        assert_eq!(
            cat.lookup("other", "subscriber", "1"),
            Some("https://static-cdn.jtvnw.net/badges/v1/global/1")
        );
    }

    #[test]
    fn parses_cheermotes_dark_static_1x() {
        let v: Value = serde_json::from_str(CHEERS_JSON).unwrap();
        let sets = parse_cheermote_sets(&v);
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].prefix, "Cheer");
        assert_eq!(sets[0].tiers[0].min_bits, 100);
        assert_eq!(sets[0].tiers[1].min_bits, 1);
    }

    #[test]
    fn allowlist_rejects_javascript_and_foreign_host() {
        assert!(allowed_badge_url("javascript:alert(1)").is_none());
        assert!(allowed_badge_url("https://evil.example/badge.png").is_none());
        assert!(allowed_badge_url("https://user:pass@static-cdn.jtvnw.net/x").is_none());
        assert!(allowed_badge_url("http://static-cdn.jtvnw.net/x").is_none());
        assert!(allowed_badge_url("https://static-cdn.jtvnw.net/badges/v1/x").is_some());
        assert!(allowed_badge_url(
            "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/static/1/1.gif"
        )
        .is_none());
        assert!(allowed_cheer_url("https://static-cdn.jtvnw.net/badges/v1/x").is_none());
        assert!(allowed_cheer_url(
            "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/static/1/1.gif"
        )
        .is_some());
    }

    #[test]
    fn resolve_fills_matching_badge_url() {
        let mut cat = BadgeCatalog::default();
        cat.replace_global({
            let mut m = BadgeMap::new();
            m.insert(
                "moderator/1".into(),
                "https://static-cdn.jtvnw.net/badges/v1/mod/1".into(),
            );
            m
        });
        let mut badges = vec![Badge {
            set: "moderator".into(),
            version: "1".into(),
            url: None,
        }];
        resolve_badge_urls(&mut badges, &cat, "xqc");
        assert_eq!(
            badges[0].url.as_deref(),
            Some("https://static-cdn.jtvnw.net/badges/v1/mod/1")
        );
    }
}
