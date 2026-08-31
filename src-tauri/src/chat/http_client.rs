//! Shared reqwest clients for outbound HTTPS.

use std::error::Error;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

const USER_AGENT: &str = concat!("Chatterino-RT/", env!("CARGO_PKG_VERSION"));

/// Default API client (JSON Helix / emote lists / OAuth).
///
/// Binds to IPv4 so broken IPv6 or local DNS (e.g. `2a09::`) does not stall
/// `error sending request` while IPv4 to the same host works.
pub fn build(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        .build()
        .expect("reqwest HTTPS client")
}

/// Same as [`build`], but never follows redirects (CDN / IVR probes).
///
/// Must not fall back to [`reqwest::Client::new`]: that follows redirects by default.
pub fn build_no_redirect(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        .build()
        .expect("reqwest no-redirect HTTPS client")
}

/// Short class for UI / IPC (no OS dump, no URL).
pub fn format_reqwest_error_brief(err: &reqwest::Error) -> String {
    classify_reqwest_error(err).to_string()
}

/// Full class + `source` chain for throttled stderr (URLs stripped).
///
/// Top-level reqwest `Display` is often only `error sending request for url (...)`;
/// the actionable cause lives in `Error::source`.
pub fn format_reqwest_error(err: &reqwest::Error) -> String {
    let kind = classify_reqwest_error(err);
    let mut chain = Vec::new();
    push_unique(&mut chain, sanitize_error_text(&err.to_string()));
    let mut cur = err.source();
    let mut depth = 0;
    while let Some(e) = cur {
        push_unique(&mut chain, sanitize_error_text(&e.to_string()));
        cur = e.source();
        depth += 1;
        if depth >= 8 {
            break;
        }
    }
    format!("{kind}: {}", chain.join(" <- "))
}

fn classify_reqwest_error(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        return "timeout";
    }
    if err.is_connect() {
        return "connect";
    }
    if err.is_body() {
        return "body";
    }
    if err.is_decode() {
        return "decode";
    }

    let mut blob = err.to_string();
    let mut cur = err.source();
    let mut depth = 0;
    while let Some(e) = cur {
        blob.push(' ');
        blob.push_str(&e.to_string());
        cur = e.source();
        depth += 1;
        if depth >= 8 {
            break;
        }
    }
    let lower = blob.to_ascii_lowercase();
    if lower.contains("certificate")
        || lower.contains("schannel")
        || lower.contains("ssl")
        || lower.contains("tls")
    {
        return "tls";
    }
    if lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("name or service not known")
        || lower.contains("no such host")
    {
        return "dns";
    }
    if lower.contains("proxy") {
        return "proxy";
    }
    "transport"
}

fn push_unique(chain: &mut Vec<String>, msg: String) {
    if msg.is_empty() {
        return;
    }
    if chain.last().map(|prev| prev == &msg).unwrap_or(false) {
        return;
    }
    chain.push(msg);
}

fn sanitize_error_text(raw: &str) -> String {
    // Drop ` for url (...)` / leading `for url (...)` fragments from reqwest Display.
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while !rest.is_empty() {
        let lower = rest.to_ascii_lowercase();
        if let Some(rel) = lower.find(" for url (") {
            out.push_str(&rest[..rel]);
            rest = &rest[rel + " for url (".len()..];
            if let Some(end) = rest.find(')') {
                rest = &rest[end + 1..];
                continue;
            }
            break;
        }
        if lower.starts_with("for url (") {
            rest = &rest["for url (".len()..];
            if let Some(end) = rest.find(')') {
                rest = &rest[end + 1..];
                continue;
            }
            break;
        }
        out.push_str(rest);
        break;
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_for_url() {
        let s = sanitize_error_text(
            "error sending request for url (https://7tv.io/v3/emote-sets/global?x=1)",
        );
        assert_eq!(s, "error sending request");
        assert!(!s.contains("7tv.io"));
        assert!(!s.contains("http"));
    }

    #[test]
    fn sanitize_keeps_plain_message() {
        assert_eq!(
            sanitize_error_text("operation timed out"),
            "operation timed out"
        );
    }
}
