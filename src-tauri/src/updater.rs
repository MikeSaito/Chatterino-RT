//! In-app updates via tauri-plugin-updater (HTTPS + minisign only).
//!
//! Trust anchor (pubkey) comes from `tauri.conf.json` baked into the binary.
//! Endpoints may be overridden at runtime via HTTPS env URLs only.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const ENV_ENDPOINT: &str = "CHATTERINO_RT_UPDATER_ENDPOINT";
const ENV_ENDPOINT_BETA: &str = "CHATTERINO_RT_UPDATER_ENDPOINT_BETA";

const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// Serializes check/install across main + settings WebViews.
pub struct UpdaterGate(pub AtomicBool);

impl Default for UpdaterGate {
    fn default() -> Self {
        Self(AtomicBool::new(false))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatus {
    pub ready: bool,
    pub current_version: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckResult {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterConfFile {
    pubkey: Option<String>,
    endpoints: Option<Vec<String>>,
    #[serde(default)]
    dangerous_insecure_transport_protocol: Option<bool>,
}

fn is_placeholder(value: &str) -> bool {
    let t = value.trim();
    t.is_empty() || t.contains("YOUR_")
}

fn env_https_endpoint(name: &str) -> Option<Result<Url, String>> {
    let s = std::env::var(name).ok()?.trim().to_string();
    if is_placeholder(&s) {
        return None;
    }
    Some(parse_https_endpoint(&s))
}

fn parse_https_endpoint(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("error.updater.endpoint: {e}"))?;
    if url.scheme() != "https" {
        return Err("error.updater.insecure_endpoint".into());
    }
    Ok(url)
}

fn conf_from_tauri_json(app: &AppHandle) -> UpdaterConfFile {
    let empty = UpdaterConfFile {
        pubkey: None,
        endpoints: None,
        dangerous_insecure_transport_protocol: Some(false),
    };
    let Some(raw) = app.config().plugins.0.get("updater") else {
        return empty;
    };
    serde_json::from_value::<UpdaterConfFile>(raw.clone()).unwrap_or(empty)
}

fn resolve_pubkey(app: &AppHandle) -> Option<String> {
    let pk = conf_from_tauri_json(app).pubkey.unwrap_or_default();
    if is_placeholder(&pk) {
        None
    } else {
        Some(pk)
    }
}

fn resolve_endpoints(app: &AppHandle, beta: bool) -> Result<Vec<Url>, String> {
    let conf = conf_from_tauri_json(app);
    if conf.dangerous_insecure_transport_protocol.unwrap_or(false) {
        return Err("error.updater.insecure_endpoint".into());
    }

    if beta {
        return match env_https_endpoint(ENV_ENDPOINT_BETA) {
            Some(Ok(url)) => Ok(vec![url]),
            Some(Err(e)) => Err(e),
            None => Err("error.updater.beta_not_configured".into()),
        };
    }

    if let Some(res) = env_https_endpoint(ENV_ENDPOINT) {
        return Ok(vec![res?]);
    }

    let mut out = Vec::new();
    for ep in conf.endpoints.unwrap_or_default() {
        if is_placeholder(&ep) {
            continue;
        }
        out.push(parse_https_endpoint(&ep)?);
    }
    if out.is_empty() {
        return Err("error.updater.not_configured".into());
    }
    Ok(out)
}

pub fn is_ready(app: &AppHandle, beta: bool) -> bool {
    resolve_pubkey(app).is_some() && resolve_endpoints(app, beta).is_ok()
}

pub fn status(app: &AppHandle, beta: bool) -> UpdaterStatus {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    if resolve_pubkey(app).is_none() {
        return UpdaterStatus {
            ready: false,
            current_version,
            reason: "error.updater.pubkey_missing".into(),
        };
    }
    match resolve_endpoints(app, beta) {
        Ok(_) => UpdaterStatus {
            ready: true,
            current_version,
            reason: String::new(),
        },
        Err(reason) => UpdaterStatus {
            ready: false,
            current_version,
            reason,
        },
    }
}

/// Register updater plugin; pubkey always from tauri.conf (baked trust anchor).
pub fn plugin_builder() -> tauri_plugin_updater::Builder {
    tauri_plugin_updater::Builder::new()
}

fn clear_pending(pending: &PendingUpdate) {
    if let Ok(mut guard) = pending.0.lock() {
        *guard = None;
    }
}

fn build_checker(app: &AppHandle, beta: bool) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoints = resolve_endpoints(app, beta)?;
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    if let Some(pk) = resolve_pubkey(app) {
        builder = builder.pubkey(pk);
    }
    builder = builder
        .endpoints(endpoints)
        .map_err(|e| format!("error.updater.endpoint: {e}"))?;
    builder
        .build()
        .map_err(|e| format!("error.updater.build: {e}"))
}

struct GateGuard<'a>(&'a UpdaterGate);

impl Drop for GateGuard<'_> {
    fn drop(&mut self) {
        self.0 .0.store(false, Ordering::SeqCst);
    }
}

fn acquire_gate(gate: &UpdaterGate) -> Result<GateGuard<'_>, String> {
    if gate
        .0
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("error.updater.busy".into());
    }
    Ok(GateGuard(gate))
}

#[tauri::command]
pub fn updater_status(app: AppHandle, beta: bool) -> UpdaterStatus {
    status(&app, beta)
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    gate: State<'_, UpdaterGate>,
    beta: bool,
) -> Result<Option<UpdaterCheckResult>, String> {
    let _busy = acquire_gate(&gate)?;
    if !is_ready(&app, beta) {
        clear_pending(&pending);
        return Err(status(&app, beta).reason);
    }
    let updater = build_checker(&app, beta)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("error.updater.check: {e}"))?;
    let Some(update) = update else {
        clear_pending(&pending);
        return Ok(None);
    };
    let result = UpdaterCheckResult {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
        date: update.date.as_ref().map(|d| d.to_string()),
    };
    let mut guard = pending
        .0
        .lock()
        .map_err(|_| "error.updater.pending_lock".to_string())?;
    *guard = Some(update);
    Ok(Some(result))
}

#[tauri::command]
pub fn updater_clear_pending(pending: State<'_, PendingUpdate>) {
    clear_pending(&pending);
}

#[tauri::command]
pub async fn updater_install(
    pending: State<'_, PendingUpdate>,
    gate: State<'_, UpdaterGate>,
    expected_version: String,
) -> Result<(), String> {
    let _busy = acquire_gate(&gate)?;
    let expected = expected_version.trim();
    if expected.is_empty() || is_placeholder(expected) {
        return Err("error.updater.no_pending".into());
    }
    let update = {
        let mut guard = pending
            .0
            .lock()
            .map_err(|_| "error.updater.pending_lock".to_string())?;
        let Some(u) = guard.as_ref() else {
            return Err("error.updater.no_pending".into());
        };
        if u.version != expected {
            *guard = None;
            return Err("error.updater.version_mismatch".into());
        }
        guard.take().expect("pending checked")
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("error.updater.install: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_detection() {
        assert!(is_placeholder("YOUR_TAURI_UPDATER_PUBKEY_HERE"));
        assert!(is_placeholder(""));
        assert!(is_placeholder("  "));
        assert!(!is_placeholder("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu"));
    }

    #[test]
    fn rejects_http_endpoint() {
        let err = parse_https_endpoint("http://example.com/latest.json").unwrap_err();
        assert_eq!(err, "error.updater.insecure_endpoint");
    }

    #[test]
    fn accepts_https_endpoint() {
        assert!(parse_https_endpoint("https://example.com/{{target}}/latest.json").is_ok());
    }

    #[test]
    fn placeholder_url_detected() {
        assert!(is_placeholder(
            "https://github.com/YOUR_GITHUB_ORG/YOUR_GITHUB_REPO/releases/latest/download/latest.json"
        ));
    }
}
