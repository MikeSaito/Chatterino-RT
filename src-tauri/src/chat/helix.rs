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

    pub fn lookup(&self, channel: &str, set: &str, version: &str) -> Option<&str> {
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
    let badge_json = recover_helix(&client, &badge_url, &client_id, &token, hub, login, badge_json).await;
    let cheer_json = recover_helix(&client, &cheer_url, &client_id, &token, hub, login, cheer_json).await;
    let emote_json = recover_helix(&client, &emote_url, &client_id, &token, hub, login, emote_json).await;
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
}

pub fn parse_stream_status(value: &Value) -> StreamStatus {
    let Some(item) = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
    else {
        return StreamStatus {
            live: false,
            viewer_count: None,
            game_name: None,
            stream_title: None,
            started_at: None,
        };
    };
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
    }
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

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub login: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image_url: Option<String>,
}

pub fn allowed_profile_image_url(raw: &str) -> Option<String> {
    allowed_https_host(raw, BADGE_HOSTS)
}

pub fn parse_user_profile(value: &Value) -> Option<UserProfile> {
    let item = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())?;
    let login = item
        .get("login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_lowercase();
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
    Some(UserProfile {
        login,
        display_name,
        profile_image_url,
    })
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
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Chatterino-RT/0.1")
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
    let is_sent = item.get("is_sent").and_then(Value::as_bool).unwrap_or(false);
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
            obj.insert("reply_parent_message_id".into(), Value::String(id.to_string()));
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
                    Ok(v) => return HelixSendOutcome::Failed(map_send_chat_http_error(
                        status.as_u16(),
                        &v,
                    )),
                    Err(e) => last = format!("json: {e}"),
                }
            }
            Err(e) => last = e.to_string(),
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
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))?
        .to_string();
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
    Some((
        id,
        UserProfile {
            login,
            display_name,
            profile_image_url,
        },
    ))
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
    if badges
        .lock()
        .ok()
        .is_some_and(|cat| cat.has_channel(login))
    {
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
        assert_eq!(map.get("Kappa").map(|d| d.provider.as_str()), Some("twitch"));
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
                "login": "XQC",
                "display_name": "xQc",
                "profile_image_url": "https://static-cdn.jtvnw.net/jtv_user_pictures/x.png"
            }]
        });
        let parsed = parse_user_profile(&ok).expect("profile");
        assert_eq!(parsed.login, "xqc");
        assert_eq!(parsed.display_name, "xQc");
        assert_eq!(
            parsed.profile_image_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/jtv_user_pictures/x.png")
        );

        let bad_img = serde_json::json!({
            "data": [{
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
}
