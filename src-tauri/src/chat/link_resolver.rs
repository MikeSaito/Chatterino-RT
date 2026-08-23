//! Chatterino link resolver client (MIT reimpl of LinkResolver.cpp).
//! Fetches rich link tooltips from the stock resolver service.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

use super::commands::ApiError;
use super::spans::allowed_chat_url;

const CACHE_LIMIT: usize = 200;
const TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LinkInfoResponse {
    pub tooltip: String,
    pub thumbnail_url: Option<String>,
    /// Unshortened destination from resolver `link` (validated); None if absent/invalid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_url: Option<String>,
}

struct LinkResolverState {
    cache: HashMap<String, LinkInfoResponse>,
    order: Vec<String>,
    inflight: HashMap<String, Vec<tokio::sync::oneshot::Sender<Result<LinkInfoResponse, ApiError>>>>,
}

impl LinkResolverState {
    fn new() -> Self {
        Self {
            cache: HashMap::new(),
            order: Vec::new(),
            inflight: HashMap::new(),
        }
    }

    fn get_cached(&mut self, url: &str) -> Option<LinkInfoResponse> {
        if let Some(hit) = self.cache.get(url) {
            if let Some(pos) = self.order.iter().position(|k| k == url) {
                self.order.remove(pos);
            }
            self.order.push(url.to_string());
            return Some(hit.clone());
        }
        None
    }

    fn store(&mut self, url: String, value: LinkInfoResponse) {
        if !self.cache.contains_key(&url) {
            self.order.push(url.clone());
        }
        self.cache.insert(url, value);
        while self.order.len() > CACHE_LIMIT {
            if let Some(old) = self.order.first().cloned() {
                self.order.remove(0);
                self.cache.remove(&old);
            } else {
                break;
            }
        }
    }
}

fn state() -> &'static Mutex<LinkResolverState> {
    static STATE: OnceLock<Mutex<LinkResolverState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(LinkResolverState::new()))
}

fn resolver_base_url() -> String {
    std::env::var("CHATTERINO2_LINK_RESOLVER_URL").unwrap_or_else(|_| {
        "https://braize.pajlada.com/chatterino/link_resolver/".to_string()
    })
}

/// Qt QUrl::toPercentEncoding(url, {}, "/:")
fn encode_link_path_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(byte & 0x0f) as usize]));
            }
        }
    }
    out
}

fn build_resolver_url(original: &str) -> String {
    let base = resolver_base_url();
    let encoded = encode_link_path_segment(original);
    if base.contains("%1") {
        base.replace("%1", &encoded)
    } else {
        format!("{base}{encoded}")
    }
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn parse_resolver_json(body: &Value) -> LinkInfoResponse {
    let status = body.get("status").and_then(Value::as_i64).unwrap_or(0);
    if status == 200 {
        let tooltip = body
            .get("tooltip")
            .and_then(Value::as_str)
            .map(percent_decode)
            .unwrap_or_default();
        let thumbnail_url = body
            .get("thumbnail")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .and_then(|raw| allowed_chat_url(raw).ok());
        let resolved_url = body
            .get("link")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .and_then(|raw| allowed_chat_url(raw).ok());
        return LinkInfoResponse {
            tooltip,
            thumbnail_url,
            resolved_url,
        };
    }
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .map(percent_decode)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "No link info found".to_string());
    LinkInfoResponse {
        tooltip: message,
        thumbnail_url: None,
        resolved_url: None,
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .user_agent("Chatterino-RT/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn fetch_link_info(url: &str) -> Result<LinkInfoResponse, ApiError> {
    let allowed = allowed_chat_url(url).map_err(ApiError::invalid)?;
    let request_url = build_resolver_url(&allowed);
    let client = http_client();
    let resp = client
        .get(&request_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| ApiError::internal(&format!("link resolver: {e}")))?;
    let body = resp
        .json::<Value>()
        .await
        .map_err(|e| ApiError::internal(&format!("link resolver json: {e}")))?;
    Ok(parse_resolver_json(&body))
}

#[tauri::command]
pub async fn resolve_link_info(url: String) -> Result<LinkInfoResponse, ApiError> {
    let normalized = allowed_chat_url(&url).map_err(ApiError::invalid)?;
    let mut guard = state().lock().await;
    if let Some(hit) = guard.get_cached(&normalized) {
        return Ok(hit);
    }
    if let Some(waiters) = guard.inflight.get_mut(&normalized) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        waiters.push(tx);
        drop(guard);
        return rx
            .await
            .unwrap_or_else(|_| Err(ApiError::internal("link resolver wait failed")));
    }
    guard
        .inflight
        .insert(normalized.clone(), Vec::new());
    drop(guard);

    let result = fetch_link_info(&normalized).await;
    let mut guard = state().lock().await;
    if let Ok(ref value) = result {
        guard.store(normalized.clone(), value.clone());
    }
    if let Some(waiters) = guard.inflight.remove(&normalized) {
        for tx in waiters {
            let msg = match &result {
                Ok(v) => Ok(v.clone()),
                Err(e) => Err(ApiError {
                    code: e.code.clone(),
                    message: e.message.clone(),
                }),
            };
            let _ = tx.send(msg);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encode_link_path_segment_keeps_slash_and_colon() {
        assert_eq!(
            encode_link_path_segment("https://example.com/a:b"),
            "https://example.com/a:b"
        );
        assert_eq!(encode_link_path_segment("a b"), "a%20b");
    }

    #[test]
    fn parse_resolver_json_success() {
        let body = json!({
            "status": 200,
            "tooltip": "Hello%20world",
            "thumbnail": "https://example.com/thumb.png",
            "link": "https://example.com/full"
        });
        let parsed = parse_resolver_json(&body);
        assert_eq!(parsed.tooltip, "Hello world");
        assert_eq!(
            parsed.thumbnail_url.as_deref(),
            Some("https://example.com/thumb.png")
        );
        assert_eq!(
            parsed.resolved_url.as_deref(),
            Some("https://example.com/full")
        );
    }

    #[test]
    fn parse_resolver_json_rejects_bad_thumbnail() {
        let body = json!({
            "status": 200,
            "tooltip": "x",
            "thumbnail": "javascript:alert(1)"
        });
        let parsed = parse_resolver_json(&body);
        assert!(parsed.thumbnail_url.is_none());
        assert!(parsed.resolved_url.is_none());
    }

    #[test]
    fn parse_resolver_json_rejects_bad_resolved_link() {
        let body = json!({
            "status": 200,
            "tooltip": "x",
            "link": "javascript:alert(1)"
        });
        let parsed = parse_resolver_json(&body);
        assert!(parsed.resolved_url.is_none());
    }

    #[test]
    fn parse_resolver_json_error_status() {
        let body = json!({ "status": 404, "message": "Not%20found" });
        let parsed = parse_resolver_json(&body);
        assert_eq!(parsed.tooltip, "Not found");
        assert!(parsed.thumbnail_url.is_none());
        assert!(parsed.resolved_url.is_none());
    }

    #[test]
    fn allowed_url_rejects_javascript_for_resolver() {
        assert!(allowed_chat_url("javascript:alert(1)").is_err());
    }
}
