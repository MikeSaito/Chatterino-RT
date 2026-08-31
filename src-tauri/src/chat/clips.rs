//! Twitch clip metadata via Helix (chat link cards).
//! SPDX-FileCopyrightText: Contributors to Chatterino <https://chatterino.com>
//! SPDX-License-Identifier: MIT
//! Reimplementation; not a copy of C++/Qt source.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;
use url::Url;

use super::auth;
use super::commands::ApiError;
use super::helix::helix_creds;
use super::http_client;
use super::spans::allowed_chat_url;
use super::state::Shared;

const CACHE_LIMIT: usize = 128;
const HELIX: &str = "https://api.twitch.tv/helix";
const CLIP_THUMB_HOSTS: &[&str] = &["clips-media-assets2.twitch.tv", "static-cdn.jtvnw.net"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfoResponse {
    pub clip_id: String,
    pub url: String,
    pub title: String,
    pub host: String,
    pub thumbnail_url: Option<String>,
    pub duration_sec: f64,
    pub view_count: u64,
    pub creator_name: String,
    pub broadcaster_name: String,
    pub game_name: Option<String>,
    pub created_at: Option<String>,
}

struct ClipCache {
    by_id: HashMap<String, ClipInfoResponse>,
    order: Vec<String>,
    inflight:
        HashMap<String, Vec<tokio::sync::oneshot::Sender<Result<ClipInfoResponse, ApiError>>>>,
}

impl ClipCache {
    fn new() -> Self {
        Self {
            by_id: HashMap::new(),
            order: Vec::new(),
            inflight: HashMap::new(),
        }
    }

    fn get(&mut self, id: &str) -> Option<ClipInfoResponse> {
        if let Some(hit) = self.by_id.get(id) {
            if let Some(pos) = self.order.iter().position(|k| k == id) {
                self.order.remove(pos);
            }
            self.order.push(id.to_string());
            return Some(hit.clone());
        }
        None
    }

    fn store(&mut self, id: String, value: ClipInfoResponse) {
        if !self.by_id.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.by_id.insert(id, value);
        while self.order.len() > CACHE_LIMIT {
            if let Some(old) = self.order.first().cloned() {
                self.order.remove(0);
                self.by_id.remove(&old);
            } else {
                break;
            }
        }
    }
}

fn cache() -> &'static Mutex<ClipCache> {
    static CACHE: OnceLock<Mutex<ClipCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ClipCache::new()))
}

/// Extract Twitch clip slug from clips.twitch.tv or twitch.tv/.../clip/ URLs.
pub fn parse_clip_id(raw: &str) -> Option<String> {
    let normalized = allowed_chat_url(raw).ok()?;
    let parsed = Url::parse(&normalized).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    let slug = if host == "clips.twitch.tv" {
        segments.first().copied()
    } else if host == "twitch.tv" || host == "m.twitch.tv" {
        let mut it = segments.iter();
        while let Some(seg) = it.next() {
            if seg.eq_ignore_ascii_case("clip") {
                return it
                    .next()
                    .copied()
                    .map(str::to_string)
                    .filter(|s| valid_clip_slug(s));
            }
        }
        None
    } else {
        None
    }?;
    let slug = slug.to_string();
    if valid_clip_slug(&slug) {
        Some(slug)
    } else {
        None
    }
}

fn valid_clip_slug(slug: &str) -> bool {
    let len = slug.len();
    (3..=100).contains(&len)
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn allowed_clip_thumbnail_url(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?;
    if !CLIP_THUMB_HOSTS.iter().any(|h| *h == host) {
        return None;
    }
    let path = parsed.path();
    if path.contains("..") || path.is_empty() || path == "/" {
        return None;
    }
    let lower = path.to_ascii_lowercase();
    // Clip thumbs are image paths (often `*-preview-*.jpg`); reject bare/non-image trees.
    if !(lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.contains("-preview-"))
    {
        return None;
    }
    Some(parsed.as_str().to_string())
}

fn parse_clip_item(item: &Value, page_url: &str) -> Option<(ClipInfoResponse, Option<String>)> {
    let clip_id = item.get("id").and_then(Value::as_str)?.to_string();
    if !valid_clip_slug(&clip_id) {
        return None;
    }
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .chars()
        .take(200)
        .collect::<String>();
    let url = item
        .get("url")
        .and_then(Value::as_str)
        .and_then(|u| allowed_chat_url(u).ok())
        .unwrap_or_else(|| page_url.to_string());
    let thumbnail_url = item
        .get("thumbnail_url")
        .and_then(Value::as_str)
        .and_then(allowed_clip_thumbnail_url);
    let duration_sec = item
        .get("duration")
        .and_then(|v| v.as_f64().or_else(|| v.as_u64().map(|n| n as f64)))
        .unwrap_or(0.0)
        .max(0.0);
    let view_count = item
        .get("view_count")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
        })
        .unwrap_or(0);
    let creator_name = item
        .get("creator_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();
    let broadcaster_name = item
        .get("broadcaster_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(creator_name.as_str())
        .to_string();
    let created_at = item
        .get("created_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let game_id = item
        .get("game_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_string);
    Some((
        ClipInfoResponse {
            clip_id,
            url,
            title,
            host: "clip.twitch.tv".into(),
            thumbnail_url,
            duration_sec,
            view_count,
            creator_name,
            broadcaster_name,
            game_name: None,
            created_at,
        },
        game_id,
    ))
}

fn parse_game_name(value: &Value) -> Option<String> {
    value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect())
}

async fn helix_get(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    token: &str,
) -> Result<Value, ApiError> {
    let mut last = ApiError::internal("clip helix failed");
    for _ in 0..2 {
        let resp = client
            .get(url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                return r
                    .json::<Value>()
                    .await
                    .map_err(|e| ApiError::internal(&format!("clip helix json: {e}")));
            }
            Ok(r) if matches!(r.status().as_u16(), 401 | 403) => {
                return Err(ApiError::coded(
                    "error.helix.forbidden",
                    "Clip lookup requires Twitch login",
                ));
            }
            Ok(r) => {
                last = ApiError::internal(&format!("clip helix HTTP {}", r.status()));
            }
            Err(e) => {
                last = ApiError::internal(&format!("clip helix: {e}"));
            }
        }
    }
    Err(last)
}

async fn fetch_clip(
    clip_id: &str,
    token: &str,
    client_id: &str,
    page_url: &str,
) -> Result<ClipInfoResponse, ApiError> {
    let client = http_client::build(Duration::from_secs(20));
    let mut clips_url = Url::parse(&format!("{HELIX}/clips")).expect("helix clips");
    clips_url.query_pairs_mut().append_pair("id", clip_id);
    let body = helix_get(&client, &clips_url.to_string(), client_id, token).await?;
    let item = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .cloned()
        .ok_or_else(|| ApiError::invalid("clip not found"))?;
    let (mut info, game_id) =
        parse_clip_item(&item, page_url).ok_or_else(|| ApiError::invalid("clip parse"))?;
    if let Some(gid) = game_id {
        let mut games_url = Url::parse(&format!("{HELIX}/games")).expect("helix games");
        games_url.query_pairs_mut().append_pair("id", &gid);
        if let Ok(gv) = helix_get(&client, &games_url.to_string(), client_id, token).await {
            info.game_name = parse_game_name(&gv);
        }
    }
    Ok(info)
}

#[tauri::command]
pub async fn resolve_clip_info(
    state: tauri::State<'_, Shared>,
    url: String,
) -> Result<ClipInfoResponse, ApiError> {
    let normalized = allowed_chat_url(&url).map_err(ApiError::invalid)?;
    let clip_id =
        parse_clip_id(&normalized).ok_or_else(|| ApiError::invalid("not a twitch clip url"))?;
    {
        let mut guard = cache().lock().await;
        if let Some(hit) = guard.get(&clip_id) {
            return Ok(hit);
        }
        if let Some(waiters) = guard.inflight.get_mut(&clip_id) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            waiters.push(tx);
            drop(guard);
            return rx
                .await
                .unwrap_or_else(|_| Err(ApiError::internal("clip wait failed")));
        }
        guard.inflight.insert(clip_id.clone(), Vec::new());
    }
    let token = auth::resolved_login_token(&state).map(|(_, t)| t);
    let client_id = auth::resolved_client_id(&state);
    let (client_id, token) = match helix_creds(token.as_deref(), &client_id) {
        Some(v) => v,
        None => {
            let mut guard = cache().lock().await;
            if let Some(waiters) = guard.inflight.remove(&clip_id) {
                let err =
                    ApiError::coded("error.helix.forbidden", "Clip lookup requires Twitch login");
                for tx in waiters {
                    let _ = tx.send(Err(err.clone()));
                }
            }
            return Err(ApiError::coded(
                "error.helix.forbidden",
                "Clip lookup requires Twitch login",
            ));
        }
    };
    let result = fetch_clip(&clip_id, &token, &client_id, &normalized).await;
    let mut guard = cache().lock().await;
    if let Ok(ref value) = result {
        guard.store(clip_id.clone(), value.clone());
    }
    if let Some(waiters) = guard.inflight.remove(&clip_id) {
        for tx in waiters {
            let msg = match &result {
                Ok(v) => Ok(v.clone()),
                Err(e) => Err(e.clone()),
            };
            let _ = tx.send(msg);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clips_twitch_tv() {
        assert_eq!(
            parse_clip_id("https://clips.twitch.tv/AwesomeClip-abc_123").as_deref(),
            Some("AwesomeClip-abc_123")
        );
    }

    #[test]
    fn parses_channel_clip_path() {
        assert_eq!(
            parse_clip_id("https://www.twitch.tv/xqc/clip/CoolClip_01").as_deref(),
            Some("CoolClip_01")
        );
    }

    #[test]
    fn rejects_non_clip() {
        assert!(parse_clip_id("https://twitch.tv/xqc").is_none());
        assert!(parse_clip_id("https://example.com/clip/x").is_none());
    }

    #[test]
    fn allows_clip_cdn_thumb() {
        assert!(allowed_clip_thumbnail_url(
            "https://clips-media-assets2.twitch.tv/foo-preview-480x272.jpg"
        )
        .is_some());
        assert!(allowed_clip_thumbnail_url("https://evil.example/x.jpg").is_none());
    }
}
