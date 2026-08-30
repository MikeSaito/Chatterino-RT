// SPDX-FileCopyrightText: 2018 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of Helix badge, cheermote, and chat emote catalog loading
// from Chatterino TwitchBadges.cpp, TwitchChannel.cpp, and api/Helix.cpp.
// Not a copy of C++/Qt source.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use url::Url;

use super::cheers::{CheerCatalog, CheerSet, CheerTier};
use super::emotes::{Catalog, EmoteDef};
use super::hub::Hub;
use super::parse::{safe_twitch_emote_id, twitch_emote_url};
use super::types::Badge;

const ATTEMPTS: u32 = 3;
const HELIX: &str = "https://api.twitch.tv/helix";
const BADGE_HOSTS: &[&str] = &["static-cdn.jtvnw.net"];
const CHEER_HOSTS: &[&str] = &["d3aqoihi2n8ty8.cloudfront.net"];
const RETRY_WAIT: Duration = Duration::from_secs(2);

static LAST_HELIX_FAIL_LOG_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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

    pub fn drop_channel(&mut self, channel: &str) {
        self.channel.remove(channel);
    }

    pub fn clear_channels(&mut self) {
        self.channel.clear();
    }

    pub fn global_is_empty(&self) -> bool {
        self.global.is_empty()
    }

    pub fn lookup(&self, channel: &str, set: &str, version: &str) -> Option<&str> {
        self.lookup_exact(channel, set, version)
            .or_else(|| {
                if version != "1" {
                    self.lookup_exact(channel, set, "1")
                } else {
                    None
                }
            })
            .or_else(|| {
                if version != "0" {
                    self.lookup_exact(channel, set, "0")
                } else {
                    None
                }
            })
    }

    fn lookup_exact(&self, channel: &str, set: &str, version: &str) -> Option<&str> {
        let key = badge_key(set, version);
        self.channel
            .get(channel)
            .and_then(|m| m.get(&key))
            .or_else(|| self.global.get(&key))
            .map(String::as_str)
    }

    pub fn has_channel(&self, channel: &str) -> bool {
        self.channel.contains_key(channel)
    }
}

pub fn resolve_badge_urls(badges: &mut [Badge], catalog: &BadgeCatalog, channel: &str) {
    for badge in badges {
        if let Some(url) = catalog.lookup(channel, &badge.set, &badge.version) {
            badge.url = Some(url.to_string());
        }
    }
}

pub async fn load_global_badges(
    catalog: &Arc<Mutex<BadgeCatalog>>,
    token: Option<&str>,
    client_id: &str,
) {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        if let Ok(mut cat) = catalog.lock() {
            super::badge_fallback::seed_global(&mut cat);
        }
        return;
    };
    let client = http_client();
    let url = format!("{HELIX}/chat/badges/global");
    let v = match get_helix(&client, &url, &client_id, &token).await {
        HelixFetch::Ok(v) => v,
        HelixFetch::Auth => {
            if let Ok(mut cat) = catalog.lock() {
                super::badge_fallback::seed_global(&mut cat);
            }
            return;
        }
        HelixFetch::Fail => {
            tokio::time::sleep(RETRY_WAIT).await;
            match get_helix(&client, &url, &client_id, &token).await {
                HelixFetch::Ok(v) => v,
                HelixFetch::Auth | HelixFetch::Fail => {
                    if let Ok(mut cat) = catalog.lock() {
                        super::badge_fallback::seed_global(&mut cat);
                    }
                    return;
                }
            }
        }
    };
    let map = parse_badge_sets(&v);
    if let Ok(mut cat) = catalog.lock() {
        if map.is_empty() {
            super::badge_fallback::seed_global(&mut cat);
        } else {
            cat.replace_global(map);
        }
    }
}

pub async fn load_global_emotes(
    catalog: &Arc<Mutex<Catalog>>,
    token: Option<&str>,
    client_id: &str,
) {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return;
    };
    let client = http_client();
    let url = format!("{HELIX}/chat/emotes/global");
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
    let map = parse_chat_emotes(&v);
    if let Ok(mut cat) = catalog.lock() {
        for (code, def) in map {
            cat.insert_global_vacant(code, def);
        }
    }
}

pub async fn load_channel(
    badges: &Arc<Mutex<BadgeCatalog>>,
    cheers: &Arc<Mutex<CheerCatalog>>,
    emotes: &Arc<Mutex<Catalog>>,
    hub: &Arc<Mutex<Hub>>,
    login: &str,
    room_id: &str,
    token: Option<&str>,
    client_id: &str,
    load_gen: u64,
) {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return;
    };
    if !still_active(hub, login) {
        return;
    }
    let client = http_client();
    let badge_url = helix_query("/chat/badges", &[("broadcaster_id", room_id)]);
    let cheer_url = helix_query("/bits/cheermotes", &[("broadcaster_id", room_id)]);
    let emote_url = helix_query("/chat/emotes", &[("broadcaster_id", room_id)]);
    let (badge_json, cheer_json, emote_json) = tokio::join!(
        get_helix(&client, &badge_url, &client_id, &token),
        get_helix(&client, &cheer_url, &client_id, &token),
        get_helix(&client, &emote_url, &client_id, &token),
    );
    let badge_json = recover_helix(
        &client, &badge_url, &client_id, &token, hub, login, badge_json,
    )
    .await;
    let cheer_json = recover_helix(
        &client, &cheer_url, &client_id, &token, hub, login, cheer_json,
    )
    .await;
    let emote_json = recover_helix(
        &client, &emote_url, &client_id, &token, hub, login, emote_json,
    )
    .await;
    if !load_gen_active(hub, emotes, login, load_gen) {
        return;
    }
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
    if let Some(v) = emote_json {
        let map = parse_chat_emotes(&v);
        commit_if_active(hub, login, emotes, |cat| {
            if cat.load_gen() != load_gen {
                return;
            }
            cat.merge_channel_vacant(login, map);
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

pub(crate) fn commit_if_active<T>(
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

pub fn helix_creds(token: Option<&str>, client_id: &str) -> Option<(String, String)> {
    if client_id.is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return None;
    }
    let client_id = client_id.to_string();
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

pub fn parse_streams_live(value: &Value) -> bool {
    value
        .get("data")
        .and_then(Value::as_array)
        .is_some_and(|data| !data.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamStatus {
    pub live: bool,
    pub viewer_count: Option<u32>,
    pub game_name: Option<String>,
    pub stream_title: Option<String>,
    pub started_at: Option<String>,
    pub stream_id: Option<String>,
    pub language: Option<String>,
    pub tags: Vec<String>,
    pub is_mature: bool,
}

impl StreamStatus {
    /// Offline placeholder when Helix `/streams` omits the login.
    pub fn offline() -> Self {
        Self {
            live: false,
            viewer_count: None,
            game_name: None,
            stream_title: None,
            started_at: None,
            stream_id: None,
            language: None,
            tags: Vec::new(),
            is_mature: false,
        }
    }
}

pub fn parse_stream_status(value: &Value) -> StreamStatus {
    let Some(item) = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
    else {
        return StreamStatus::offline();
    };
    parse_stream_item(item)
}

fn parse_stream_item(item: &Value) -> StreamStatus {
    let tags = item
        .get("tags")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    StreamStatus {
        live: true,
        viewer_count: item
            .get("viewer_count")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
        game_name: item
            .get("game_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        stream_title: item
            .get("title")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        started_at: item
            .get("started_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        stream_id: item
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        language: item
            .get("language")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        tags,
        is_mature: item
            .get("is_mature")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Parse Helix `/streams` response into login → status (live only entries).
pub fn parse_streams_by_login(value: &Value) -> std::collections::HashMap<String, StreamStatus> {
    let mut out = std::collections::HashMap::new();
    let Some(arr) = value.get("data").and_then(Value::as_array) else {
        return out;
    };
    for item in arr {
        let Some(login) = item
            .get("user_login")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
        else {
            continue;
        };
        out.insert(login, parse_stream_item(item));
    }
    out
}

pub async fn fetch_channel_stream(
    login: &str,
    token: Option<&str>,
    client_id: &str,
) -> Option<StreamStatus> {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return None;
    };
    let url = helix_query("/streams", &[("user_login", login)]);
    let client = http_client();
    match get_helix(&client, &url, &client_id, &token).await {
        HelixFetch::Ok(v) => Some(parse_stream_status(&v)),
        HelixFetch::Auth | HelixFetch::Fail => None,
    }
}

const STREAMS_BATCH: usize = 100;

/// Batch Helix `/streams?user_login=` (chunks of 100). Missing logins are absent from the map (offline).
pub async fn fetch_streams_by_logins(
    logins: &[String],
    token: Option<&str>,
    client_id: &str,
) -> Option<std::collections::HashMap<String, StreamStatus>> {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return None;
    };
    if logins.is_empty() {
        return Some(std::collections::HashMap::new());
    }
    let client = http_client();
    let mut out = std::collections::HashMap::new();
    for chunk in logins.chunks(STREAMS_BATCH) {
        let mut url = Url::parse(&format!("{HELIX}/streams")).ok()?;
        {
            let mut q = url.query_pairs_mut();
            for login in chunk {
                let trimmed = login.trim();
                if trimmed.is_empty() {
                    continue;
                }
                q.append_pair("user_login", trimmed);
            }
        }
        match get_helix(&client, &url.to_string(), &client_id, &token).await {
            HelixFetch::Ok(v) => {
                out.extend(parse_streams_by_login(&v));
            }
            HelixFetch::Auth | HelixFetch::Fail => return None,
        }
    }
    Some(out)
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub id: String,
    pub login: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follower_count: Option<u64>,
}

pub fn allowed_profile_image_url(raw: &str) -> Option<String> {
    allowed_https_host(raw, BADGE_HOSTS)
}

fn parse_user_id(item: &Value) -> Option<String> {
    item.get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

fn parse_user_from_item(item: &Value) -> Option<UserProfile> {
    let id = parse_user_id(item)?;
    let login = item
        .get("login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_ascii_lowercase();
    let display_name = item
        .get("display_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(login.as_str())
        .to_string();
    let profile_image_url = item
        .get("profile_image_url")
        .and_then(Value::as_str)
        .and_then(allowed_profile_image_url);
    let created_at = item
        .get("created_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(UserProfile {
        id,
        login,
        display_name,
        profile_image_url,
        created_at,
        follower_count: None,
    })
}

pub fn parse_user_profile(value: &Value) -> Option<UserProfile> {
    value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
        .and_then(parse_user_from_item)
}

pub fn parse_channel_followers_total(value: &Value) -> Option<u64> {
    value.get("total").and_then(|t| {
        t.as_u64()
            .or_else(|| t.as_i64().and_then(|n| u64::try_from(n).ok()))
    })
}

pub async fn fetch_channel_followers(
    broadcaster_id: &str,
    token: &str,
    client_id: &str,
) -> Option<u64> {
    if broadcaster_id.is_empty() || !broadcaster_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let url = helix_query(
        "/channels/followers",
        &[("broadcaster_id", broadcaster_id), ("first", "1")],
    );
    let client = http_client();
    match get_helix(&client, &url, client_id, token).await {
        HelixFetch::Ok(v) => parse_channel_followers_total(&v),
        HelixFetch::Auth | HelixFetch::Fail => None,
    }
}

pub async fn fetch_user_profile(
    login: &str,
    token: Option<&str>,
    client_id: &str,
) -> Option<UserProfile> {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return None;
    };
    let url = helix_query("/users", &[("login", login)]);
    let client = http_client();
    match get_helix(&client, &url, &client_id, &token).await {
        HelixFetch::Ok(v) => parse_user_profile(&v),
        HelixFetch::Auth | HelixFetch::Fail => None,
    }
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

pub fn parse_chat_emotes(value: &Value) -> HashMap<String, EmoteDef> {
    let mut map = HashMap::new();
    let Some(arr) = value.get("data").and_then(Value::as_array) else {
        return map;
    };
    for item in arr {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        if !safe_twitch_emote_id(id) || name.is_empty() || name.len() > 100 {
            continue;
        }
        if name
            .chars()
            .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
        {
            continue;
        }
        map.insert(
            name.to_string(),
            EmoteDef {
                id: id.to_string(),
                provider: "twitch".into(),
                url: twitch_emote_url(id),
                zero_width: false,
                display_width: None,
                display_height: None,
            },
        );
    }
    map
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
        let color = item
            .get("color")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| {
                s.len() == 7
                    && s.starts_with('#')
                    && s.as_bytes()[1..].iter().all(|b| b.is_ascii_hexdigit())
            })
            .map(str::to_string);
        sets.push(CheerSet {
            prefix: prefix.to_string(),
            tiers,
            color,
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

fn load_gen_active(
    hub: &Arc<Mutex<Hub>>,
    emotes: &Arc<Mutex<Catalog>>,
    login: &str,
    load_gen: u64,
) -> bool {
    let Ok(h) = hub.lock() else {
        return false;
    };
    if h.active.as_deref() != Some(login) {
        return false;
    }
    let Ok(cat) = emotes.lock() else {
        return false;
    };
    cat.load_gen() == load_gen
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
    super::http_client::build(Duration::from_secs(12))
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
                        Err(e) => last = super::http_client::format_reqwest_error(&e),
                    }
                } else {
                    last = format!("http {status}");
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        super::fetch::log_http_fail_throttled(
                            &LAST_HELIX_FAIL_LOG_MS,
                            "helix",
                            &last,
                            url,
                        );
                        return HelixFetch::Auth;
                    }
                }
            }
            Err(e) => last = super::http_client::format_reqwest_error(&e),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    super::fetch::log_http_fail_throttled(
        &LAST_HELIX_FAIL_LOG_MS,
        "helix",
        &format!("after {ATTEMPTS} attempts: {last}"),
        url,
    );
    HelixFetch::Fail
}

/// Result of POST /chat/messages (Chatterino HelixSentMessage parity).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelixSendOutcome {
    Sent,
    Dropped(String),
    Failed(String),
}

pub fn parse_send_chat_response(value: &Value) -> HelixSendOutcome {
    let Some(item) = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
    else {
        return HelixSendOutcome::Failed("Your message was not sent.".into());
    };
    let is_sent = item
        .get("is_sent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_sent {
        return HelixSendOutcome::Sent;
    }
    if let Some(reason) = item.get("drop_reason").and_then(Value::as_object) {
        let msg = reason
            .get("message")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Your message was not sent.");
        return HelixSendOutcome::Dropped(msg.to_string());
    }
    HelixSendOutcome::Failed("Your message was not sent.".into())
}

pub fn map_send_chat_http_error(status: u16, body: &Value) -> String {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("(empty message)")
        .to_string();
    match status {
        400 => format!("Failed to send message: {message}"),
        401 if message
            .to_ascii_lowercase()
            .starts_with("user access token requires") =>
        {
            "Missing required scope. Re-login with your account and try again.".into()
        }
        401 => message,
        403 => "You are not allowed to send messages in this channel.".into(),
        422 => "Your message was too long.".into(),
        _ => format!("Unknown error: {message}"),
    }
}

pub async fn send_chat_message(
    broadcaster_id: &str,
    sender_id: &str,
    message: &str,
    reply_parent_message_id: Option<&str>,
    token: &str,
    client_id: &str,
) -> HelixSendOutcome {
    let mut body = serde_json::json!({
        "broadcaster_id": broadcaster_id,
        "sender_id": sender_id,
        "message": message,
    });
    if let Some(id) = reply_parent_message_id {
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "reply_parent_message_id".into(),
                Value::String(id.to_string()),
            );
        }
    }
    let url = format!("{HELIX}/chat/messages");
    let client = http_client();
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .post(&url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>().await {
                    Ok(v) if status.is_success() => return parse_send_chat_response(&v),
                    Ok(v) => {
                        return HelixSendOutcome::Failed(map_send_chat_http_error(
                            status.as_u16(),
                            &v,
                        ))
                    }
                    Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
                }
            }
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    HelixSendOutcome::Failed(format!("Failed to send message: {last}"))
}

pub fn parse_shared_chat_session(value: &Value) -> Vec<String> {
    let Some(item) = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
    else {
        return Vec::new();
    };
    let Some(arr) = item.get("participants").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for p in arr {
        let Some(id) = p
            .get("broadcaster_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        else {
            continue;
        };
        out.push(id.to_string());
    }
    out
}

pub fn parse_user_item(item: &Value) -> Option<(String, UserProfile)> {
    let profile = parse_user_from_item(item)?;
    Some((profile.id.clone(), profile))
}

pub fn parse_users_by_id(value: &Value) -> HashMap<String, UserProfile> {
    let mut out = HashMap::new();
    let Some(arr) = value.get("data").and_then(Value::as_array) else {
        return out;
    };
    for item in arr {
        if let Some((id, profile)) = parse_user_item(item) {
            out.insert(id, profile);
        }
    }
    out
}

/// Avatar badge URL (18px display) from Twitch profile picture URL.
pub fn shared_chat_profile_badge_url(profile_url: &str) -> Option<String> {
    let allowed = allowed_profile_image_url(profile_url)?;
    if let Some(idx) = allowed.find("300x300") {
        let mut resized = allowed;
        resized.replace_range(idx..idx + 7, "28x28");
        return allowed_profile_image_url(&resized);
    }
    allowed_profile_image_url(&allowed)
}

pub async fn fetch_shared_chat_session(
    broadcaster_id: &str,
    token: Option<&str>,
    client_id: &str,
) -> Option<Vec<String>> {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return None;
    };
    let url = helix_query(
        "/shared_chat/session",
        &[("broadcaster_id", broadcaster_id)],
    );
    let client = http_client();
    match get_helix(&client, &url, &client_id, &token).await {
        HelixFetch::Ok(v) => Some(parse_shared_chat_session(&v)),
        HelixFetch::Auth | HelixFetch::Fail => None,
    }
}

pub async fn fetch_users_by_ids(
    ids: &[String],
    token: Option<&str>,
    client_id: &str,
) -> HashMap<String, UserProfile> {
    if ids.is_empty() {
        return HashMap::new();
    }
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return HashMap::new();
    };
    let client = http_client();
    let mut out = HashMap::new();
    for chunk in ids.chunks(100) {
        let url = users_by_id_url(chunk);
        match get_helix(&client, &url, &client_id, &token).await {
            HelixFetch::Ok(v) => out.extend(parse_users_by_id(&v)),
            HelixFetch::Auth | HelixFetch::Fail => break,
        }
    }
    out
}

pub async fn load_channel_badges_for_login(
    badges: &Arc<Mutex<BadgeCatalog>>,
    login: &str,
    room_id: &str,
    token: Option<&str>,
    client_id: &str,
) {
    let Some((client_id, token)) = helix_creds(token, client_id) else {
        return;
    };
    if login.is_empty() || room_id.is_empty() {
        return;
    }
    if badges.lock().ok().is_some_and(|cat| cat.has_channel(login)) {
        return;
    }
    let url = helix_query("/chat/badges", &[("broadcaster_id", room_id)]);
    let client = http_client();
    if let HelixFetch::Ok(v) = get_helix(&client, &url, &client_id, &token).await {
        let map = parse_badge_sets(&v);
        if let Ok(mut cat) = badges.lock() {
            cat.replace_channel(login.to_string(), map);
        }
    }
}

fn users_by_id_url(ids: &[String]) -> String {
    let mut url = Url::parse(&format!("{HELIX}/users")).expect("helix users");
    {
        let mut q = url.query_pairs_mut();
        for id in ids {
            q.append_pair("id", id);
        }
    }
    url.to_string()
}

/// Result of Helix start/cancel raid (POST/DELETE /raids).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelixRaidOutcome {
    Ok,
    Failed(String),
}

/// Result of Helix warn chat user (POST /moderation/warnings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelixWarnOutcome {
    Ok,
    Failed(String),
}

pub async fn fetch_user_profile_by_id(
    user_id: &str,
    token: Option<&str>,
    client_id: &str,
) -> Option<UserProfile> {
    if !user_id.chars().all(|c| c.is_ascii_digit()) || user_id.is_empty() {
        return None;
    }
    let mut map = fetch_users_by_ids(&[user_id.to_string()], token, client_id).await;
    map.remove(user_id).or_else(|| map.into_values().next())
}

fn helix_body_message(body: &Value) -> String {
    body.get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("(empty message)")
        .to_string()
}

pub fn map_start_raid_http_error(status: u16, body: &Value) -> String {
    let message = helix_body_message(body);
    let lower = message.to_ascii_lowercase();
    let detail = match status {
        400 if lower.contains("cannot raid yourself") || lower.contains("to yourself") => {
            "A channel cannot raid itself.".into()
        }
        400 => format!("Failed to start a raid - {message}"),
        401 if lower.starts_with("missing scope")
            || lower.starts_with("user access token requires") =>
        {
            "Missing required scope. Re-login with your account and try again.".into()
        }
        401 if lower.contains("must match the user id") => {
            "You must be the broadcaster to start a raid.".into()
        }
        401 | 403 => "You must be the broadcaster to start a raid.".into(),
        429 => "You are being ratelimited by Twitch. Try again in a few seconds.".into(),
        _ => format!("Failed to start a raid - {message}"),
    };
    detail
}

pub fn map_cancel_raid_http_error(status: u16, body: &Value) -> String {
    let message = helix_body_message(body);
    let lower = message.to_ascii_lowercase();
    match status {
        404 | 400 if lower.contains("no pending") || lower.contains("not currently raiding") => {
            "You don't have an active raid.".into()
        }
        401 if lower.starts_with("missing scope")
            || lower.starts_with("user access token requires") =>
        {
            "Missing required scope. Re-login with your account and try again.".into()
        }
        401 if lower.contains("must match the user id") => {
            "You must be the broadcaster to cancel the raid.".into()
        }
        401 | 403 => "You must be the broadcaster to cancel the raid.".into(),
        429 => "You are being ratelimited by Twitch. Try again in a few seconds.".into(),
        _ => format!("Failed to cancel the raid - {message}"),
    }
}

pub fn map_warn_user_http_error(status: u16, body: &Value, display_name: &str) -> String {
    let message = helix_body_message(body);
    let lower = message.to_ascii_lowercase();
    match status {
        400 if lower.contains("may not be warned") => {
            format!("Failed to warn user - You cannot warn {display_name}.")
        }
        400 => format!("Failed to warn user - {message}"),
        401 if lower.starts_with("missing scope")
            || lower.starts_with("user access token requires") =>
        {
            "Failed to warn user - Missing required scope. Re-login with your account and try again."
                .into()
        }
        401 => format!("Failed to warn user - {message}"),
        403 => {
            "Failed to warn user - You don't have permission to perform that action.".into()
        }
        409 => {
            "Failed to warn user - There was a conflicting warn operation on this user. Please try again."
                .into()
        }
        429 => {
            "Failed to warn user - You are being ratelimited by Twitch. Try again in a few seconds."
                .into()
        }
        _ => format!("Failed to warn user - {message}"),
    }
}

/// https://dev.twitch.tv/docs/api/reference#warn-chat-user
pub async fn warn_user(
    broadcaster_id: &str,
    moderator_id: &str,
    user_id: &str,
    reason: &str,
    token: &str,
    client_id: &str,
    display_name: &str,
) -> HelixWarnOutcome {
    let url = helix_query(
        "/moderation/warnings",
        &[
            ("broadcaster_id", broadcaster_id),
            ("moderator_id", moderator_id),
        ],
    );
    let body = serde_json::json!({
        "data": {
            "user_id": user_id,
            "reason": reason,
        }
    });
    let client = http_client();
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .post(&url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return HelixWarnOutcome::Ok;
                }
                let code = status.as_u16();
                match resp.json::<Value>().await {
                    Ok(v) => {
                        return HelixWarnOutcome::Failed(map_warn_user_http_error(
                            code,
                            &v,
                            display_name,
                        ));
                    }
                    Err(e) => {
                        last = format!(
                            "http {code}; {}",
                            super::http_client::format_reqwest_error_brief(&e)
                        );
                        if (400..500).contains(&code) {
                            return HelixWarnOutcome::Failed(format!(
                                "Failed to warn user - {last}"
                            ));
                        }
                    }
                }
            }
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    HelixWarnOutcome::Failed(format!("Failed to warn user - {last}"))
}

/// https://dev.twitch.tv/docs/api/reference#start-a-raid
pub async fn start_raid(
    from_broadcaster_id: &str,
    to_broadcaster_id: &str,
    token: &str,
    client_id: &str,
) -> HelixRaidOutcome {
    let url = helix_query(
        "/raids",
        &[
            ("from_broadcaster_id", from_broadcaster_id),
            ("to_broadcaster_id", to_broadcaster_id),
        ],
    );
    let client = http_client();
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .post(&url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return HelixRaidOutcome::Ok;
                }
                let code = status.as_u16();
                match resp.json::<Value>().await {
                    Ok(v) => {
                        return HelixRaidOutcome::Failed(map_start_raid_http_error(code, &v));
                    }
                    Err(e) => {
                        last = format!(
                            "http {code}; {}",
                            super::http_client::format_reqwest_error_brief(&e)
                        );
                        if (400..500).contains(&code) {
                            return HelixRaidOutcome::Failed(format!(
                                "Failed to start a raid - {last}"
                            ));
                        }
                    }
                }
            }
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    HelixRaidOutcome::Failed(format!("Failed to start a raid - {last}"))
}

/// https://dev.twitch.tv/docs/api/reference#cancel-a-raid
pub async fn cancel_raid(broadcaster_id: &str, token: &str, client_id: &str) -> HelixRaidOutcome {
    let url = helix_query("/raids", &[("broadcaster_id", broadcaster_id)]);
    let client = http_client();
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .delete(&url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() || status.as_u16() == 204 {
                    return HelixRaidOutcome::Ok;
                }
                let code = status.as_u16();
                match resp.json::<Value>().await {
                    Ok(v) => {
                        return HelixRaidOutcome::Failed(map_cancel_raid_http_error(code, &v));
                    }
                    Err(e) => {
                        last = format!(
                            "http {code}; {}",
                            super::http_client::format_reqwest_error_brief(&e)
                        );
                        if (400..500).contains(&code) {
                            return HelixRaidOutcome::Failed(format!(
                                "Failed to cancel the raid - {last}"
                            ));
                        }
                    }
                }
            }
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    HelixRaidOutcome::Failed(format!("Failed to cancel the raid - {last}"))
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

    const EMOTES_JSON: &str = r#"{
      "data": [
        {
          "id": "25",
          "name": "Kappa"
        },
        {
          "id": "../x",
          "name": "Evil"
        },
        {
          "id": "emotesv2_abc",
          "name": "CoolStoryBob"
        }
      ]
    }"#;

    const CHEERS_JSON: &str = r##"{
      "data": [
        {
          "prefix": "Cheer",
          "color": "#9ACD32",
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
    }"##;

    #[test]
    fn parses_chat_emotes_and_drops_bad_id() {
        let v: Value = serde_json::from_str(EMOTES_JSON).unwrap();
        let map = parse_chat_emotes(&v);
        assert_eq!(
            map.get("Kappa").map(|d| d.provider.as_str()),
            Some("twitch")
        );
        assert_eq!(
            map.get("Kappa").map(|d| d.url.as_str()),
            Some("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0")
        );
        assert!(map.get("Evil").is_none());
        assert!(map.contains_key("CoolStoryBob"));
    }

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
        assert_eq!(sets[0].color.as_deref(), Some("#9ACD32"));
        assert_eq!(sets[0].tiers[0].min_bits, 100);
        assert_eq!(sets[0].tiers[1].min_bits, 1);
    }

    #[test]
    fn cheermote_color_rejects_invalid_hex() {
        let v: serde_json::Value = serde_json::json!({
            "data": [{
                "prefix": "Cheer",
                "color": "<script>",
                "tiers": [{
                    "min_bits": 1,
                    "images": { "dark": { "static": { "1": "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/static/1/1.gif" } } }
                }]
            }]
        });
        let sets = parse_cheermote_sets(&v);
        assert_eq!(sets.len(), 1);
        assert!(sets[0].color.is_none());
    }

    #[test]
    fn parse_streams_by_login_maps_entries() {
        let v = serde_json::json!({
            "data": [
                { "id": "1", "user_login": "XQC", "title": "a", "viewer_count": 10 },
                { "id": "2", "user_login": "lirik", "title": "b" }
            ]
        });
        let map = parse_streams_by_login(&v);
        assert_eq!(map.len(), 2);
        assert!(map["xqc"].live);
        assert_eq!(map["xqc"].stream_title.as_deref(), Some("a"));
        assert!(map["lirik"].live);
    }

    #[test]
    fn parse_streams_live_empty_and_present() {
        let offline: serde_json::Value = serde_json::json!({ "data": [] });
        assert!(!parse_streams_live(&offline));
        let online: serde_json::Value =
            serde_json::json!({ "data": [{ "id": "1", "user_login": "xqc" }] });
        assert!(parse_streams_live(&online));
    }

    #[test]
    fn parse_stream_status_offline_and_live() {
        let offline = serde_json::json!({ "data": [] });
        let parsed = parse_stream_status(&offline);
        assert!(!parsed.live);
        assert!(parsed.viewer_count.is_none());

        let online = serde_json::json!({
            "data": [{
                "viewer_count": 12345,
                "game_name": "Just Chatting",
                "title": "hello world",
                "started_at": "2020-01-01T12:00:00Z"
            }]
        });
        let parsed = parse_stream_status(&online);
        assert!(parsed.live);
        assert_eq!(parsed.viewer_count, Some(12345));
        assert_eq!(parsed.game_name.as_deref(), Some("Just Chatting"));
        assert_eq!(parsed.stream_title.as_deref(), Some("hello world"));
        assert_eq!(parsed.started_at.as_deref(), Some("2020-01-01T12:00:00Z"));
        assert!(parsed.language.is_none());
        assert!(parsed.tags.is_empty());
        assert!(!parsed.is_mature);

        let rich = serde_json::json!({
            "data": [{
                "viewer_count": 1,
                "title": "t",
                "language": "en",
                "tags": ["English", "FPS"],
                "is_mature": true
            }]
        });
        let rich_parsed = parse_stream_status(&rich);
        assert_eq!(rich_parsed.language.as_deref(), Some("en"));
        assert_eq!(rich_parsed.tags, vec!["English", "FPS"]);
        assert!(rich_parsed.is_mature);
    }

    #[test]
    fn parse_shared_chat_session_participants() {
        let v = serde_json::json!({
            "data": [{
                "id": "sess1",
                "participants": [
                    { "broadcaster_id": "11148817" },
                    { "broadcaster_id": "1025594235" }
                ]
            }]
        });
        let ids = parse_shared_chat_session(&v);
        assert_eq!(ids, vec!["11148817", "1025594235"]);
    }

    #[test]
    fn shared_chat_profile_badge_url_resizes_300() {
        let url = "https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-300x300.png";
        let out = shared_chat_profile_badge_url(url).expect("url");
        assert!(out.contains("28x28"));
    }

    #[test]
    fn parse_user_profile_and_reject_bad_avatar() {
        let ok = serde_json::json!({
            "data": [{
                "id": "44322889",
                "login": "XQC",
                "display_name": "xQc",
                "created_at": "2011-11-11T00:00:00Z",
                "profile_image_url": "https://static-cdn.jtvnw.net/jtv_user_pictures/x.png"
            }]
        });
        let parsed = parse_user_profile(&ok).expect("profile");
        assert_eq!(parsed.id, "44322889");
        assert_eq!(parsed.login, "xqc");
        assert_eq!(parsed.display_name, "xQc");
        assert_eq!(parsed.created_at.as_deref(), Some("2011-11-11T00:00:00Z"));
        assert_eq!(
            parsed.profile_image_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/jtv_user_pictures/x.png")
        );
        assert!(parsed.follower_count.is_none());

        let bad_img = serde_json::json!({
            "data": [{
                "id": "44322889",
                "login": "xqc",
                "display_name": "xQc",
                "profile_image_url": "javascript:alert(1)"
            }]
        });
        let parsed = parse_user_profile(&bad_img).expect("profile without img");
        assert!(parsed.profile_image_url.is_none());

        assert!(allowed_profile_image_url("https://evil.example/a.png").is_none());
        assert!(parse_user_profile(&serde_json::json!({ "data": [] })).is_none());
    }

    #[test]
    fn parse_channel_followers_total_reads_total() {
        let ok = serde_json::json!({ "total": 12345, "data": [] });
        assert_eq!(parse_channel_followers_total(&ok), Some(12345));
        assert_eq!(
            parse_channel_followers_total(&serde_json::json!({ "data": [] })),
            None
        );
    }

    #[test]
    fn parse_user_profile_rejects_missing_or_bad_id() {
        let missing_id = serde_json::json!({
            "data": [{ "login": "xqc", "display_name": "xQc" }]
        });
        assert!(parse_user_profile(&missing_id).is_none());

        let bad_id = serde_json::json!({
            "data": [{ "id": "abc", "login": "xqc", "display_name": "xQc" }]
        });
        assert!(parse_user_profile(&bad_id).is_none());
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
            source: "twitch".into(),
            tooltip: None,
        }];
        resolve_badge_urls(&mut badges, &cat, "xqc");
        assert_eq!(
            badges[0].url.as_deref(),
            Some("https://static-cdn.jtvnw.net/badges/v1/mod/1")
        );
    }

    #[test]
    fn lookup_falls_back_to_version_one() {
        let mut cat = BadgeCatalog::default();
        cat.replace_global({
            let mut m = BadgeMap::new();
            m.insert(
                "subscriber/1".into(),
                "https://static-cdn.jtvnw.net/badges/v1/sub/1".into(),
            );
            m
        });
        assert_eq!(
            cat.lookup("ch", "subscriber", "12"),
            Some("https://static-cdn.jtvnw.net/badges/v1/sub/1")
        );
    }

    #[test]
    fn parse_send_chat_response_sent_and_dropped() {
        let sent = serde_json::json!({
            "data": [{ "message_id": "1", "is_sent": true }]
        });
        assert_eq!(parse_send_chat_response(&sent), HelixSendOutcome::Sent);

        let dropped = serde_json::json!({
            "data": [{
                "message_id": "1",
                "is_sent": false,
                "drop_reason": { "code": "msg_ratelimit", "message": "Slow down!" }
            }]
        });
        assert_eq!(
            parse_send_chat_response(&dropped),
            HelixSendOutcome::Dropped("Slow down!".into())
        );
    }

    #[test]
    fn map_send_chat_http_error_statuses() {
        let scope = serde_json::json!({
            "message": "User access token requires scope user:write:chat"
        });
        assert_eq!(
            map_send_chat_http_error(401, &scope),
            "Missing required scope. Re-login with your account and try again."
        );
        assert_eq!(
            map_send_chat_http_error(403, &serde_json::json!({})),
            "You are not allowed to send messages in this channel."
        );
        assert_eq!(
            map_send_chat_http_error(422, &serde_json::json!({})),
            "Your message was too long."
        );
    }

    #[test]
    fn map_raid_http_errors() {
        assert_eq!(
            map_start_raid_http_error(
                400,
                &serde_json::json!({ "message": "The broadcaster cannot raid yourself." })
            ),
            "A channel cannot raid itself."
        );
        assert_eq!(
            map_start_raid_http_error(
                401,
                &serde_json::json!({ "message": "Missing scope: channel:manage:raids" })
            ),
            "Missing required scope. Re-login with your account and try again."
        );
        assert_eq!(
            map_cancel_raid_http_error(
                404,
                &serde_json::json!({ "message": "The channel is not currently raiding anyone." })
            ),
            "You don't have an active raid."
        );
    }

    #[test]
    fn map_warn_user_http_errors() {
        assert_eq!(
            map_warn_user_http_error(
                400,
                &serde_json::json!({
                    "message": "The user specified in the user_id field may not be warned."
                }),
                "Viewer"
            ),
            "Failed to warn user - You cannot warn Viewer."
        );
        assert_eq!(
            map_warn_user_http_error(
                401,
                &serde_json::json!({ "message": "Missing scope: moderator:manage:warnings" }),
                "Viewer"
            ),
            "Failed to warn user - Missing required scope. Re-login with your account and try again."
        );
        assert_eq!(
            map_warn_user_http_error(409, &serde_json::json!({ "message": "conflict" }), "Viewer"),
            "Failed to warn user - There was a conflicting warn operation on this user. Please try again."
        );
        assert_eq!(
            map_warn_user_http_error(429, &serde_json::json!({}), "Viewer"),
            "Failed to warn user - You are being ratelimited by Twitch. Try again in a few seconds."
        );
    }
}
