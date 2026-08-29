//! Shared reqwest clients for outbound HTTPS.

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

const USER_AGENT: &str = "Chatterino-RT/0.1";

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
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Same as [`build`], but never follows redirects (CDN / IVR probes).
pub fn build_no_redirect(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}
