//! Twitch chat GIF: IRC tag parsing helpers, Giphy search proxy, outbound text.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::fetch::{allowed_twitch_gif_url, gif_url_matches_id};

const GIPHY_SEARCH: &str = "https://api.giphy.com/v1/gifs/search";
const SEARCH_LIMIT: u32 = 24;
const ATTEMPTS: u32 = 2;
const GIF_SEARCH_MIN_GAP: Duration = Duration::from_millis(400);

static GIF_SEARCH_GATE: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifSearchHit {
    pub id: String,
    pub title: String,
    pub url: String,
    pub preview_url: String,
}

/// Bracket placeholder Twitch expects for Giphy-sourced GIF messages.
pub fn format_outgoing_gif_text(label: &str) -> String {
    let clean = sanitize_gif_label(label);
    if clean.is_empty() {
        return "[GIF by Giphy]".to_string();
    }
    format!("[{clean} GIF by Giphy]")
}

pub fn sanitize_gif_label(label: &str) -> String {
    label
        .trim()
        .replace('[', "(")
        .replace(']', ")")
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn safe_gif_id(id: &str) -> bool {
    let t = id.trim();
    !t.is_empty()
        && t.len() <= 64
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn escape_irc_tag_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\:"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            ' ' => out.push_str("\\s"),
            other => out.push(other),
        }
    }
    out
}

/// Outbound PRIVMSG with optional reply and GIF IRC tags.
pub fn build_outbound_privmsg_line(
    channel: &str,
    text: &str,
    reply_to: Option<&str>,
    gif_id: Option<&str>,
    gif_url: Option<&str>,
) -> String {
    let mut tags: Vec<String> = Vec::new();
    if let Some(id) = reply_to.filter(|s| !s.is_empty()) {
        tags.push(format!("reply-parent-msg-id={}", escape_irc_tag_value(id)));
    }
    if let (Some(id), Some(url)) = (gif_id.filter(|s| !s.is_empty()), gif_url) {
        let end_cp = text.chars().count().saturating_sub(1);
        tags.push(format!(
            "gifs=0-{end_cp}|{}|{}",
            escape_irc_tag_value(id),
            escape_irc_tag_value(url)
        ));
    }
    let body = format!("PRIVMSG #{channel} :{text}");
    if tags.is_empty() {
        body
    } else {
        format!("@{} {body}", tags.join(";"))
    }
}

fn giphy_api_key() -> Option<String> {
    let s = std::env::var("GIPHY_API_KEY").ok()?.trim().to_string();
    if s.is_empty() || s == "YOUR_API_KEY_HERE" {
        return None;
    }
    Some(s)
}

pub async fn search_gifs(query: &str) -> Result<Vec<GifSearchHit>, String> {
    {
        let mut gate = GIF_SEARCH_GATE
            .lock()
            .map_err(|_| "gif search busy".to_string())?;
        let now = Instant::now();
        if let Some(last) = *gate {
            if now.duration_since(last) < GIF_SEARCH_MIN_GAP {
                return Err("GIF search rate limit".into());
            }
        }
        *gate = Some(now);
    }
    let key = giphy_api_key().ok_or_else(|| "Giphy API key not configured".to_string())?;
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    if q.len() > 50 {
        return Err("search query too long".into());
    }
    let client = super::http_client::build(Duration::from_secs(12));
    let limit = SEARCH_LIMIT.to_string();
    let mut url = url::Url::parse(GIPHY_SEARCH).map_err(|e| e.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("api_key", &key);
        pairs.append_pair("q", q);
        pairs.append_pair("limit", &limit);
        pairs.append_pair("rating", "pg-13");
    }
    let search_url = url.to_string();
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client.get(&search_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let body = resp
                    .json::<Value>()
                    .await
                    .map_err(|e| super::http_client::format_reqwest_error_brief(&e))?;
                return Ok(parse_giphy_search(&body));
            }
            Ok(resp) => {
                last = format!("http {}", resp.status());
            }
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(format!("Giphy search failed: {last}"))
}

fn parse_giphy_search(body: &Value) -> Vec<GifSearchHit> {
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in data {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !safe_gif_id(id) {
            continue;
        }
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();
        let images = item.get("images").and_then(Value::as_object);
        let url = pick_giphy_image_url(images, &["original", "downsized_medium", "downsized"]);
        let preview_url = pick_giphy_image_url(
            images,
            &["fixed_height_small", "downsized", "preview_gif"],
        );
        let Some(url) = url.and_then(|u| allowed_twitch_gif_url(&u)) else {
            continue;
        };
        if !gif_url_matches_id(&url, id) {
            continue;
        }
        let preview_url = preview_url
            .and_then(|u| allowed_twitch_gif_url(&u))
            .unwrap_or_else(|| url.clone());
        out.push(GifSearchHit {
            id: id.to_string(),
            title,
            url,
            preview_url,
        });
    }
    out
}

fn pick_giphy_image_url(images: Option<&serde_json::Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let images = images?;
    for key in keys {
        if let Some(url) = images
            .get(*key)
            .and_then(|v| v.get("url"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(url.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_outgoing_gif_text_sanitizes_brackets() {
        assert_eq!(
            format_outgoing_gif_text("[wow]"),
            "[(wow) GIF by Giphy]"
        );
        assert_eq!(format_outgoing_gif_text(""), "[GIF by Giphy]");
    }

    #[test]
    fn build_outbound_privmsg_includes_gifs_tag() {
        let text = "[Y A Y Yes GIF by Djemilah Birnie]";
        let line = build_outbound_privmsg_line(
            "twitch",
            text,
            None,
            Some("joSNxeswxuc74Juo8X"),
            Some("https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif"),
        );
        assert!(line.starts_with("@gifs=0-33|"));
        assert!(line.contains("PRIVMSG #twitch :"));
    }

    #[test]
    fn escape_irc_tag_value_roundtrip_with_semicolons() {
        let raw = "a;b&c=d";
        let escaped = escape_irc_tag_value(raw);
        assert!(escaped.contains("\\:"));
        assert!(!escaped.contains("\\;"));
    }
}
