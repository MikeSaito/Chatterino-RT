//! Image paste upload (Chatterino ImageUploader; reimplementation, not a port).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::multipart::{Form, Part};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use super::spans::allowed_chat_url;
use super::state::Shared;

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_HEADERS_CHARS: usize = 4_096;
const MAX_HEADER_PAIRS: usize = 32;
const MAX_RESPONSE_BYTES: usize = 1_024 * 1024;
const MAX_LINK_REPLACE: usize = 32;
const MAX_LINK_CHARS: usize = 2_048;

static UPLOAD_BUSY: AtomicBool = AtomicBool::new(false);

pub struct UploadGuard;

impl UploadGuard {
    pub fn try_acquire() -> Result<Self, String> {
        if UPLOAD_BUSY
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("An image upload is already in progress.".into());
        }
        Ok(Self)
    }
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        UPLOAD_BUSY.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub link: String,
    pub deletion_link: String,
}

#[derive(Debug, Clone)]
pub struct UploadConfig {
    pub url: String,
    pub form_field: String,
    pub headers: Vec<(String, String)>,
    pub link_pattern: String,
    pub deletion_pattern: String,
}

fn knob_bool(knobs: &std::collections::BTreeMap<String, Value>, key: &str, default: bool) -> bool {
    knobs.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn knob_str(knobs: &std::collections::BTreeMap<String, Value>, key: &str) -> String {
    knobs
        .get(key)
        .and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Stock `parseHeaderList`: `Name: value;Other: v2`.
pub fn parse_header_list(raw: &str) -> Result<Vec<(String, String)>, String> {
    if raw.chars().count() > MAX_HEADERS_CHARS {
        return Err("Image uploader headers string is too long.".into());
    }
    if raw.chars().any(|c| matches!(c, '\0' | '\r' | '\n')) {
        return Err("Image uploader headers contain forbidden characters.".into());
    }
    let mut out = Vec::new();
    for pair in raw.split(';') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((name, value)) = pair.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        if name.chars().any(|c| c.is_control()) || value.chars().any(|c| c.is_control()) {
            return Err("Image uploader headers contain control characters.".into());
        }
        out.push((name.to_string(), value.to_string()));
        if out.len() > MAX_HEADER_PAIRS {
            return Err("Too many image uploader headers.".into());
        }
    }
    Ok(out)
}

/// Walk JSON with dotted path (`a.b.0`).
pub fn json_path_value(root: &Value, path: &str) -> String {
    let mut cur = root;
    for key in path.split('.') {
        if key.is_empty() {
            continue;
        }
        match cur {
            Value::Object(map) => {
                cur = match map.get(key) {
                    Some(v) => v,
                    None => return String::new(),
                };
            }
            Value::Array(arr) => {
                let Ok(idx) = key.parse::<usize>() else {
                    return String::new();
                };
                cur = match arr.get(idx) {
                    Some(v) => v,
                    None => return String::new(),
                };
            }
            _ => return String::new(),
        }
    }
    match cur {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null | Value::Object(_) | Value::Array(_) => String::new(),
    }
}

/// Stock `getLinkFromResponse`: replace `{path}` tokens in pattern.
pub fn link_from_response(body: &str, pattern: &str) -> String {
    let body = if body.len() > MAX_RESPONSE_BYTES {
        &body[..MAX_RESPONSE_BYTES]
    } else {
        body
    };
    let trimmed_pattern = pattern.trim();
    if trimmed_pattern.is_empty() {
        let t = body.trim();
        if t.len() > MAX_LINK_CHARS {
            return t[..MAX_LINK_CHARS].to_string();
        }
        return t.to_string();
    }
    let root: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut out = trimmed_pattern.to_string();
    for _ in 0..MAX_LINK_REPLACE {
        let Some(start) = out.find('{') else {
            break;
        };
        let Some(rel_end) = out[start + 1..].find('}') else {
            break;
        };
        let end = start + 1 + rel_end;
        let path = out[start + 1..end].to_string();
        let mut value = json_path_value(&root, &path);
        if value.contains('{') || value.contains('}') {
            value.clear();
        }
        out.replace_range(start..=end, &value);
        if out.len() > MAX_LINK_CHARS * 2 {
            out.truncate(MAX_LINK_CHARS);
            break;
        }
    }
    if out.len() > MAX_LINK_CHARS {
        out.truncate(MAX_LINK_CHARS);
    }
    out
}

pub fn validate_upload_url(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("Image uploader Request URL is empty.".into());
    }
    let url = Url::parse(s).map_err(|_| "Image uploader Request URL is invalid.".to_string())?;
    match url.scheme() {
        "https" => {
            if upload_host_is_non_public(&url) {
                return Err(
                    "Image uploader HTTPS must target a public host (not loopback/private IP)."
                        .into(),
                );
            }
        }
        "http" => {
            let host = url.host_str().unwrap_or("");
            if host != "127.0.0.1" && !host.eq_ignore_ascii_case("localhost") {
                return Err(
                    "Image uploader HTTP is only allowed for localhost / 127.0.0.1.".into(),
                );
            }
        }
        _ => {
            return Err("Image uploader Request URL must be https (or http localhost).".into());
        }
    }
    if url.username() != "" || url.password().is_some() {
        return Err("Image uploader Request URL must not contain userinfo.".into());
    }
    Ok(url)
}

fn upload_host_is_non_public(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ipv4_upload_blocked(ip),
        Some(url::Host::Ipv6(ip)) => ipv6_upload_blocked(ip),
        Some(url::Host::Domain(name)) => {
            let n = name.trim_end_matches('.').to_ascii_lowercase();
            n == "localhost" || n.ends_with(".localhost") || n.ends_with(".local")
        }
        None => true,
    }
}

fn ipv4_upload_blocked(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ipv4_is_cgnat(ip)
        || ip.octets()[0] == 0
}

/// RFC 6598 shared address space (CGNAT) 100.64.0.0/10.
fn ipv4_is_cgnat(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0xc0) == 64
}

fn ipv6_upload_blocked(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_unicast_link_local() {
        return true;
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return ipv4_upload_blocked(v4);
    }
    // Unique local fc00::/7
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn ip_addr_upload_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_upload_blocked(v4),
        IpAddr::V6(v6) => ipv6_upload_blocked(v6),
    }
}

/// After literal/host checks: resolve DNS and reject private/loopback/link-local/CGNAT.
pub async fn assert_upload_resolved_public(url: &Url) -> Result<(), String> {
    if url.scheme() == "http" {
        // HTTP already limited to localhost / 127.0.0.1 literals.
        return Ok(());
    }
    if upload_host_is_non_public(url) {
        return Err(
            "Image uploader HTTPS must target a public host (not loopback/private IP).".into(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Image uploader Request URL is invalid.".to_string())?;
    // Literal IPs already gated above; still resolve domains (and re-check literals).
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "Image uploader could not resolve Request URL host.".to_string())?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if ip_addr_upload_blocked(addr.ip()) {
            return Err(
                "Image uploader HTTPS must not resolve to a private, loopback, link-local, or CGNAT address."
                    .into(),
            );
        }
    }
    if !any {
        return Err("Image uploader could not resolve Request URL host.".into());
    }
    Ok(())
}

pub fn normalize_format(raw: &str) -> Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "png" => Ok("png"),
        "jpeg" | "jpg" => Ok("jpeg"),
        "gif" => Ok("gif"),
        _ => Err("unsupported image format (png, jpeg, gif)".into()),
    }
}

pub fn load_config(shared: &Shared) -> Result<UploadConfig, String> {
    let guard = shared
        .settings
        .lock()
        .map_err(|_| "settings lock".to_string())?;
    let knobs = &guard.data.knobs;
    if !knob_bool(knobs, "external.imageUploaderEnabled", false) {
        return Err("Image uploader is disabled.".into());
    }
    let url = knob_str(knobs, "external.imageUploaderUrl");
    validate_upload_url(&url)?;
    let form_field = knob_str(knobs, "external.imageUploaderFormField")
        .trim()
        .to_string();
    if form_field.is_empty() {
        return Err("Image uploader form field is empty.".into());
    }
    if form_field
        .chars()
        .any(|c| c.is_control() || c == '"' || c == '\n')
    {
        return Err("Image uploader form field is invalid.".into());
    }
    let headers = parse_header_list(&knob_str(knobs, "external.imageUploaderHeaders"))?;
    Ok(UploadConfig {
        url: url.trim().to_string(),
        form_field,
        headers,
        link_pattern: knob_str(knobs, "external.imageUploaderLink"),
        deletion_pattern: knob_str(knobs, "external.imageUploaderDeletionLink"),
    })
}

pub fn try_begin_upload() -> Result<UploadGuard, String> {
    UploadGuard::try_acquire()
}

fn http_client() -> reqwest::Client {
    super::http_client::build_no_redirect(Duration::from_secs(60))
}

pub async fn post_image(
    cfg: &UploadConfig,
    bytes: Vec<u8>,
    format: &str,
) -> Result<UploadResult, String> {
    if bytes.is_empty() {
        return Err("Image is empty.".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Image is too large (max {} MiB).",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let url = validate_upload_url(&cfg.url)?;
    assert_upload_resolved_public(&url).await?;
    let mime = format!("image/{format}");
    let filename = format!("control_v.{format}");
    let part = Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let form = Form::new().part(cfg.form_field.clone(), part);
    let mut req = http_client().post(url.as_str()).multipart(form);
    for (name, value) in &cfg.headers {
        req = req.header(name.as_str(), value.as_str());
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(format!(
            "An error happened while uploading your image: HTTP {status} (redirects are not followed)."
        ));
    }
    let raw = resp.bytes().await.map_err(|e| e.to_string())?;
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err("Upload response is too large.".into());
    }
    let body = String::from_utf8_lossy(&raw).into_owned();
    if !status.is_success() {
        let mut msg = format!("An error happened while uploading your image: HTTP {status}");
        if let Ok(obj) = serde_json::from_str::<Value>(&body) {
            if let Some(code) = obj.get("code") {
                let mut c = code.to_string();
                c.truncate(20);
                msg.push_str(&format!(" - code: {c}"));
            }
            if let Some(err) = obj.get("error").and_then(|v| v.as_str()) {
                let mut e = err.trim().to_string();
                e.truncate(300);
                if !e.is_empty() {
                    msg.push_str(&format!(" - error: {e}"));
                }
            }
        }
        return Err(msg);
    }
    let link_raw = normalize_upload_link(&link_from_response(&body, &cfg.link_pattern));
    let link = allowed_chat_url(link_raw.trim())
        .map_err(|_| "Upload succeeded but returned an invalid image link.".to_string())?;
    let deletion_link = if cfg.deletion_pattern.trim().is_empty() {
        String::new()
    } else {
        let raw = normalize_upload_link(&link_from_response(&body, &cfg.deletion_pattern));
        allowed_chat_url(raw.trim()).unwrap_or_default()
    };
    Ok(UploadResult {
        link,
        deletion_link,
    })
}

fn normalize_upload_link(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    if t.starts_with("//") {
        return format!("https:{t}");
    }
    if !t.contains("://")
        && t.contains('.')
        && !t.contains(' ')
        && !t.starts_with('/')
    {
        return format!("https://{t}");
    }
    t.to_string()
}

pub fn decode_bytes(base64: &str) -> Result<Vec<u8>, String> {
    let raw = base64.trim();
    if raw.is_empty() {
        return Err("Image payload is empty.".into());
    }
    // Reject oversized base64 before decode (~4/3 of max + margin).
    if raw.len() > (MAX_IMAGE_BYTES * 4 / 3) + 64 {
        return Err(format!(
            "Image is too large (max {} MiB).",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    B64.decode(raw)
        .map_err(|_| "Image payload is not valid base64.".to_string())
}

pub fn success_notice(link: &str, deletion: &str) -> String {
    if deletion.is_empty() {
        format!("Image uploaded: {link}")
    } else {
        format!("Image uploaded: {link} (delete: {deletion})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_schemeless_upload_link() {
        assert_eq!(
            normalize_upload_link("//cdn.example/a.png"),
            "https://cdn.example/a.png"
        );
        assert_eq!(
            normalize_upload_link("cdn.example/a.png"),
            "https://cdn.example/a.png"
        );
        assert_eq!(
            normalize_upload_link("https://cdn.example/a.png"),
            "https://cdn.example/a.png"
        );
    }

    #[test]
    fn headers_parse() {
        let h = parse_header_list("Authorization: secret; X-Foo: bar").unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0], ("Authorization".into(), "secret".into()));
        assert_eq!(h[1], ("X-Foo".into(), "bar".into()));
        assert!(parse_header_list("a\nb: c").is_err());
    }

    #[test]
    fn json_path_and_link() {
        let body =
            r#"{"data":{"link":"https://cdn.example/a.png","del":["https://del.example/1"]}}"#;
        assert_eq!(
            link_from_response(body, "{data.link}"),
            "https://cdn.example/a.png"
        );
        assert_eq!(
            link_from_response(body, "{data.del.0}"),
            "https://del.example/1"
        );
        assert_eq!(link_from_response("plain-url", ""), "plain-url");
        let root = json!({"a":{"b":[1,2]}});
        assert_eq!(json_path_value(&root, "a.b.1"), "2");
    }

    #[test]
    fn url_scheme() {
        assert!(validate_upload_url("https://i.imgur.com/upload").is_ok());
        assert!(validate_upload_url("http://127.0.0.1:8080/up").is_ok());
        assert!(validate_upload_url("http://example.com/up").is_err());
        assert!(validate_upload_url("https://127.0.0.1/up").is_err());
        assert!(validate_upload_url("https://10.0.0.1/up").is_err());
        assert!(validate_upload_url("https://100.64.1.1/up").is_err());
        assert!(validate_upload_url("https://[fe80::1]/up").is_err());
        assert!(validate_upload_url("ftp://x").is_err());
        assert!(validate_upload_url("https://user:pass@evil/").is_err());
        assert!(validate_upload_url("").is_err());
    }

    #[test]
    fn cgnat_and_link_local_blocked() {
        assert!(ipv4_is_cgnat(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(ipv4_is_cgnat(Ipv4Addr::new(100, 127, 255, 255)));
        assert!(!ipv4_is_cgnat(Ipv4Addr::new(100, 63, 255, 255)));
        assert!(ipv6_upload_blocked("fe80::1".parse().unwrap()));
        assert!(ipv6_upload_blocked("fc00::1".parse().unwrap()));
        assert!(!ipv6_upload_blocked("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn format_and_size_gate() {
        assert_eq!(normalize_format("PNG").unwrap(), "png");
        assert_eq!(normalize_format("jpg").unwrap(), "jpeg");
        assert!(normalize_format("webp").is_err());
        assert!(decode_bytes("").is_err());
    }
}
