//! Open a Twitch channel in a custom URI-scheme player (Chatterino CustomPlayer.cpp; reimplementation).

use serde_json::Value;

use super::state::Shared;

const MAX_SCHEME_CHARS: usize = 64;

const DENIED_SCHEMES: &[&str] = &[
    "file",
    "http",
    "https",
    "javascript",
    "data",
    "vbscript",
    "about",
    "blob",
    "shell",
    "ms-msdt",
    "search-ms",
    "ms-settings",
];

/// Validate scheme prefix from settings: `ALPHA [ALPHA/DIGIT/+/-.]* ://` only.
pub fn validate_scheme(raw: &str) -> Result<String, String> {
    let scheme = raw.trim();
    if scheme.is_empty() {
        return Err("Custom stream player URI scheme is empty.".into());
    }
    if scheme.chars().count() > MAX_SCHEME_CHARS {
        return Err("Custom stream player URI scheme is too long.".into());
    }
    if scheme.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return Err("Custom stream player URI scheme contains forbidden characters.".into());
    }
    let Some(sep) = scheme.find("://") else {
        return Err("Custom stream player URI scheme must contain '://'.".into());
    };
    if sep == 0 {
        return Err("Custom stream player URI scheme name is empty.".into());
    }
    if scheme[sep + 3..].contains("://") {
        return Err("Custom stream player URI scheme must not contain another '://'.".into());
    }
    // After :// only allow empty or a short fixed suffix without `/` `?` `#` (stock uses bare `scheme://`).
    let after = &scheme[sep + 3..];
    if after.chars().any(|c| matches!(c, '/' | '?' | '#' | '@')) {
        return Err("Custom stream player URI scheme must end at '://' (no path/query).".into());
    }
    let name = &scheme[..sep];
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err("Custom stream player URI scheme name is empty.".into());
    };
    if !first.is_ascii_alphabetic() {
        return Err("Custom stream player URI scheme name must start with a letter.".into());
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
        return Err("Custom stream player URI scheme name has invalid characters.".into());
    }
    let name_lower = name.to_ascii_lowercase();
    if DENIED_SCHEMES.contains(&name_lower.as_str())
        || name_lower.starts_with("ms-")
        || name_lower.starts_with("web+")
    {
        return Err("This URI scheme is not allowed for the custom stream player.".into());
    }
    // Normalize to scheme:// (drop accidental trailing junk after :// if we allowed empty only)
    if !after.is_empty() {
        return Err("Custom stream player URI scheme must end with '://'.".into());
    }
    Ok(format!("{name_lower}://"))
}

pub fn normalize_login(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_start_matches('#').to_lowercase();
    if s.is_empty() || s.len() > 25 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("channel name: 1-25 chars [a-z0-9_]".into());
    }
    Ok(s)
}

/// Qt `QUrl::toPercentEncoding` unreserved set: A-Z a-z 0-9 - . _ ~
pub fn percent_encode_qt(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(char::from(*b));
            }
            _ => {
                out.push('%');
                out.push(char::from(hex_digit(b >> 4)));
                out.push(char::from(hex_digit(b & 0x0f)));
            }
        }
    }
    out
}

fn hex_digit(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        10..=15 => b'A' + (n - 10),
        _ => b'0',
    }
}

/// `scheme + percentEncode("https://www.twitch.tv/" + channel)`.
pub fn build_custom_player_url(scheme: &str, channel: &str) -> Result<String, String> {
    let scheme = validate_scheme(scheme)?;
    let login = normalize_login(channel)?;
    let twitch = format!("https://www.twitch.tv/{login}");
    Ok(format!("{scheme}{}", percent_encode_qt(&twitch)))
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

pub fn open_for_channel(shared: &Shared, channel: &str) -> Result<(), String> {
    let scheme = {
        let guard = shared
            .settings
            .lock()
            .map_err(|_| "settings lock".to_string())?;
        knob_str(&guard.data.knobs, "external.customURIScheme")
    };
    let url = build_custom_player_url(&scheme, channel)?;
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_twitch_url() {
        assert_eq!(
            percent_encode_qt("https://www.twitch.tv/xqc"),
            "https%3A%2F%2Fwww.twitch.tv%2Fxqc"
        );
    }

    #[test]
    fn build_url_ok() {
        assert_eq!(
            build_custom_player_url("potplayer://", "xqc").unwrap(),
            "potplayer://https%3A%2F%2Fwww.twitch.tv%2Fxqc"
        );
        assert_eq!(
            build_custom_player_url("vlc://", "#Bob").unwrap(),
            "vlc://https%3A%2F%2Fwww.twitch.tv%2Fbob"
        );
    }

    #[test]
    fn reject_empty_and_bad_scheme() {
        assert!(build_custom_player_url("", "xqc").is_err());
        assert!(build_custom_player_url("potplayer", "xqc").is_err());
        assert!(build_custom_player_url("bad scheme://", "xqc").is_err());
        assert!(build_custom_player_url("x:\\evil", "xqc").is_err());
        assert!(build_custom_player_url("://", "xqc").is_err());
        assert!(build_custom_player_url("https://", "xqc").is_err());
        assert!(build_custom_player_url("file://", "xqc").is_err());
        assert!(build_custom_player_url("javascript://", "xqc").is_err());
        assert!(build_custom_player_url("https://evil.com/", "xqc").is_err());
        assert!(build_custom_player_url("a://b://c", "xqc").is_err());
    }

    #[test]
    fn normalize_scheme_case() {
        assert_eq!(
            build_custom_player_url("PotPlayer://", "xqc").unwrap(),
            "potplayer://https%3A%2F%2Fwww.twitch.tv%2Fxqc"
        );
    }

    #[test]
    fn reject_bad_channel() {
        assert!(build_custom_player_url("potplayer://", "").is_err());
        assert!(build_custom_player_url("potplayer://", "bad name").is_err());
    }
}
