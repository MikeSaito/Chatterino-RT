use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use super::state::{IrcCmd, Shared};

const DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
// Must match scopes Chatterino client_login can grant (same Client ID).
// Twitch uses `chat:edit` (not `chat:write`). Prefer `moderator:manage:*` where
// Chatterino login does not issue the corresponding `read` scope — Helix/EventSub
// accept manage for pins, warn, AutoMod, shared channel.moderate.
// Existing sessions need re-login after scopes are added.
const DEVICE_SCOPES: &str =
    "chat:read chat:edit user:read:blocked_users user:manage:blocked_users channel:read:polls channel:read:predictions channel:manage:raids channel:moderate moderator:manage:chat_messages moderator:manage:automod moderator:manage:warnings moderator:read:suspicious_users moderator:manage:suspicious_users moderator:manage:blocked_terms moderator:manage:chat_settings moderator:manage:unban_requests moderator:manage:banned_users moderator:read:moderators moderator:read:vips";
const GRANT_DEVICE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_HOSTS: &[&str] = &["id.twitch.tv", "www.twitch.tv"];
const CHATTERINO_LOGIN: &str = "https://chatterino.com/client_login";
const CHATTERINO_CLIENT_ID: &str = "g5zg0400k4vhrx2g6xi4hgveruamlv";
const AUTH_FILE: &str = "twitch-auth.json";
const HTTP_ATTEMPTS: u32 = 3;
const MAX_LOGIN_BLOB: usize = 4096;

#[derive(Clone)]
pub struct StoredCreds {
    pub login: String,
    pub token: String,
    pub client_id: String,
    pub user_id: Option<String>,
}

#[derive(Default)]
pub struct AuthInner {
    pub path: PathBuf,
    pub accounts: Vec<StoredCreds>,
    pub current_login: Option<String>,
    pub cached_user_id: Option<String>,
    pub pending_user_code: Option<String>,
    pub pending_paste: bool,
    pub poll_gen: u64,
    pub last_message: Option<String>,
    /// Token scopes missing vs DEVICE_SCOPES (pins/automod/warn/shared).
    pub scopes_incomplete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    pub accounts: Vec<AccountRow>,
    pub can_send: bool,
    pub from_env: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    pub pending_paste: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image_url: Option<String>,
    /// True when validate scopes are missing vs DEVICE_SCOPES — UI prompts re-login.
    pub scopes_incomplete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    pub verification_uri: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone)]
pub struct AuthFail {
    pub code: String,
    pub message: String,
    pub params: BTreeMap<String, String>,
}

impl AuthFail {
    pub fn coded(code: impl Into<String>, message_en: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message_en.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn coded_params(
        code: impl Into<String>,
        message_en: impl Into<String>,
        params: BTreeMap<String, String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message_en.into(),
            params,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal".into(),
            message: message.into(),
            params: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Default)]
struct AuthStore {
    accounts: Vec<StoredCreds>,
    current_login: Option<String>,
}

#[derive(Deserialize)]
struct DiskAccount {
    login: String,
    token: String,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    user_id: Option<String>,
}

#[derive(Deserialize)]
struct DiskMulti {
    #[serde(default)]
    current: String,
    #[serde(default)]
    accounts: Vec<DiskAccount>,
}

#[derive(Deserialize)]
struct DiskLegacy {
    login: String,
    token: String,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    user_id: Option<String>,
}

#[derive(Serialize)]
struct DiskAccountOut<'a> {
    login: &'a str,
    token: &'a str,
    client_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<&'a str>,
}

#[derive(Serialize)]
struct DiskMultiOut<'a> {
    current: &'a str,
    accounts: Vec<DiskAccountOut<'a>>,
}

#[derive(Deserialize)]
struct DeviceJson {
    device_code: String,
    expires_in: u64,
    interval: Option<u64>,
    user_code: String,
    verification_uri: String,
}

fn current_creds(inner: &AuthInner) -> Option<&StoredCreds> {
    let login = inner.current_login.as_deref()?;
    inner.accounts.iter().find(|c| c.login == login)
}

fn current_creds_mut(inner: &mut AuthInner) -> Option<&mut StoredCreds> {
    let login = inner.current_login.clone()?;
    inner.accounts.iter_mut().find(|c| c.login == login)
}

fn apply_store(inner: &mut AuthInner, store: AuthStore) {
    inner.accounts = store.accounts;
    inner.current_login = store
        .current_login
        .filter(|l| inner.accounts.iter().any(|a| &a.login == l))
        .or_else(|| inner.accounts.first().map(|a| a.login.clone()));
    inner.cached_user_id = current_creds(inner).and_then(|c| c.user_id.clone());
}

fn upsert_account(accounts: &mut Vec<StoredCreds>, creds: StoredCreds) {
    if let Some(slot) = accounts.iter_mut().find(|c| c.login == creds.login) {
        *slot = creds;
    } else {
        accounts.push(creds);
    }
}

pub fn init(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(AUTH_FILE);
    let store = load_file(&path);
    {
        let mut inner = shared.auth.lock().map_err(|e| e.to_string())?;
        inner.path = path;
        apply_store(&mut inner, store);
    }
    emit(app, shared);
    let app_chk = app.clone();
    let shared_chk = shared.clone();
    tauri::async_runtime::spawn(async move {
        verify_disk(app_chk.clone(), shared_chk.clone()).await;
        let _ = ensure_twitch_user_id(&shared_chk).await;
        super::profile_images::spawn_refresh_current(app_chk, shared_chk);
    });
    Ok(())
}

pub fn emit(app: &AppHandle, shared: &Shared) {
    let _ = app.emit("chat:auth", snapshot(app, shared));
}

pub fn snapshot(app: &AppHandle, shared: &Shared) -> AuthInfo {
    let (pending, pending_paste, account_logins, current_login, last_message, scopes_incomplete) =
        match shared.auth.lock() {
            Ok(inner) => (
                inner.pending_user_code.clone(),
                inner.pending_paste,
                inner
                    .accounts
                    .iter()
                    .map(|c| (c.login.clone(), c.user_id.clone()))
                    .collect::<Vec<_>>(),
                inner.current_login.clone(),
                inner.last_message.clone(),
                inner.scopes_incomplete,
            ),
            Err(_) => (None, false, Vec::new(), None, None, false),
        };
    let env_pair = env_login_token();
    let from_env = env_pair.is_some();
    let login = env_pair.as_ref().map(|(l, _)| l.clone()).or(current_login);
    let has_token = env_pair.is_some() || login.is_some();
    let active = shared.hub.lock().ok();
    let can_send = has_token
        && login.is_some()
        && active
            .as_ref()
            .is_some_and(|h| h.active.is_some() && h.joined_active());
    let accounts: Vec<AccountRow> = if from_env {
        Vec::new()
    } else {
        account_logins
            .into_iter()
            .map(|(login, user_id)| AccountRow {
                profile_image_url: super::profile_images::get(app, &login),
                login,
                user_id,
            })
            .collect()
    };
    let profile_image_url = login
        .as_ref()
        .and_then(|l| super::profile_images::get(app, l));
    AuthInfo {
        can_send,
        login,
        accounts,
        from_env,
        user_code: pending,
        pending_paste,
        message: last_message,
        profile_image_url,
        scopes_incomplete,
    }
}

pub fn resolved_login_token(shared: &Shared) -> Option<(String, String)> {
    if let Some(pair) = env_login_token() {
        return Some(pair);
    }
    let inner = shared.auth.lock().ok()?;
    let c = current_creds(&inner)?;
    Some((c.login.clone(), c.token.clone()))
}

pub fn oauth_token(shared: &Shared) -> Option<String> {
    resolved_login_token(shared).map(|(_, token)| token)
}

/// Client-Id paired with the active user token (preferred for GQL with that token).
pub fn oauth_graph_creds(shared: &Shared) -> Option<(String, String)> {
    if let Some((_, token)) = env_login_token() {
        let client_id = env_secret("TWITCH_CLIENT_ID")
            .filter(|id| !id.is_empty() && id != "YOUR_API_KEY_HERE")
            .unwrap_or_else(|| CHATTERINO_CLIENT_ID.to_string());
        return Some((client_id, token));
    }
    let inner = shared.auth.lock().ok()?;
    let creds = current_creds(&inner)?;
    let client_id = creds.client_id.trim();
    if client_id.is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return None;
    }
    let token = creds.token.trim();
    if token.is_empty() || token == "YOUR_API_KEY_HERE" {
        return None;
    }
    Some((client_id.to_string(), token.to_string()))
}

fn valid_twitch_user_id(raw: &str) -> bool {
    !raw.is_empty() && raw.chars().all(|c| c.is_ascii_digit())
}

pub fn resolved_twitch_user_id(shared: &Shared) -> Option<String> {
    let inner = shared.auth.lock().ok()?;
    if let Some(id) = inner
        .cached_user_id
        .as_deref()
        .filter(|s| valid_twitch_user_id(s))
    {
        return Some(id.to_string());
    }
    current_creds(&inner)
        .and_then(|c| c.user_id.as_deref())
        .filter(|s| valid_twitch_user_id(s))
        .map(str::to_string)
}

pub fn set_cached_twitch_user_id(shared: &Shared, user_id: String) {
    if !valid_twitch_user_id(&user_id) {
        return;
    }
    let Ok(mut inner) = shared.auth.lock() else {
        return;
    };
    let already = inner.cached_user_id.as_deref() == Some(user_id.as_str())
        && current_creds(&inner)
            .and_then(|c| c.user_id.as_deref())
            .is_some_and(|id| id == user_id);
    inner.cached_user_id = Some(user_id.clone());
    if let Some(disk) = current_creds_mut(&mut inner) {
        disk.user_id = Some(user_id);
    }
    if already || env_login_token().is_some() || inner.accounts.is_empty() {
        return;
    }
    if inner.path.as_os_str().is_empty() {
        return;
    }
    let store = AuthStore {
        accounts: inner.accounts.clone(),
        current_login: inner.current_login.clone(),
    };
    let path = inner.path.clone();
    // Persist while holding the auth lock so a concurrent login cannot be
    // overwritten by a stale accounts clone written after unlock.
    if let Err(e) = save_store(&path, &store) {
        inner.last_message = Some(format!("failed to save user id: {e}"));
    }
}

pub async fn ensure_twitch_user_id(shared: &Shared) -> Option<String> {
    if let Some(id) = resolved_twitch_user_id(shared) {
        return Some(id);
    }
    let _guard = shared.auth_user_id_fetch.lock().await;
    if let Some(id) = resolved_twitch_user_id(shared) {
        return Some(id);
    }
    let token = oauth_token(shared)?;
    let client_id = resolved_client_id(shared);
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return None;
    }
    let mut login_hint = resolved_login_token(shared).map(|(l, _)| l);
    if let Ok(validated) = validate_token(&http_client(), &token).await {
        apply_scope_check(shared, &validated.scopes);
        if let Some(uid) = validated.user_id {
            set_cached_twitch_user_id(shared, uid.clone());
            return Some(uid);
        }
        login_hint = Some(validated.login);
    }
    let login = login_hint?;
    let profile = super::helix::fetch_user_profile(&login, Some(&token), &client_id).await?;
    if !valid_twitch_user_id(&profile.id) {
        return None;
    }
    set_cached_twitch_user_id(shared, profile.id.clone());
    Some(profile.id)
}

pub fn resolved_client_id(shared: &Shared) -> String {
    if let Some(id) = env_secret("TWITCH_CLIENT_ID") {
        return id;
    }
    if let Some(id) = shared
        .auth
        .lock()
        .ok()
        .and_then(|inner| current_creds(&inner).map(|c| c.client_id.clone()))
        .filter(|id| !id.is_empty() && id != "YOUR_API_KEY_HERE")
    {
        return id;
    }
    CHATTERINO_CLIENT_ID.to_string()
}

fn oauth_client_id() -> String {
    env_secret("TWITCH_CLIENT_ID").unwrap_or_else(|| CHATTERINO_CLIENT_ID.to_string())
}

pub fn allowed_oauth_url(raw: &str) -> Result<String, AuthFail> {
    let parsed = Url::parse(raw.trim())
        .map_err(|_| AuthFail::coded("error.auth.url.invalid", "invalid login URL"))?;
    if parsed.scheme() != "https" {
        return Err(AuthFail::coded(
            "error.auth.url.https_only",
            "login URL must be https",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AuthFail::coded(
            "error.auth.url.userinfo",
            "login URL must not include userinfo",
        ));
    }
    let host = parsed.host_str().unwrap_or("");
    if host == "chatterino.com" || host == "www.chatterino.com" {
        if parsed.path() != "/client_login" {
            return Err(AuthFail::coded(
                "error.auth.url.chatterino_path",
                "Chatterino login URL path must be /client_login",
            ));
        }
        return Ok(CHATTERINO_LOGIN.to_string());
    }
    if !OAUTH_HOSTS.iter().any(|h| *h == host) {
        return Err(AuthFail::coded(
            "error.auth.url.host",
            "login URL host is not an allowed Twitch host",
        ));
    }
    Ok(parsed.as_str().to_string())
}

fn auth_env_locked() -> AuthFail {
    AuthFail::coded(
        "error.auth.config.env",
        "login is set via TWITCH_LOGIN and TWITCH_OAUTH_TOKEN",
    )
}

pub async fn start_login(app: AppHandle, shared: Shared) -> Result<DeviceStart, AuthFail> {
    if env_login_token().is_some() {
        return Err(auth_env_locked());
    }
    if oauth_client_id() == CHATTERINO_CLIENT_ID {
        start_chatterino_page(app, shared).await
    } else {
        start_device(app, shared).await
    }
}

async fn start_chatterino_page(app: AppHandle, shared: Shared) -> Result<DeviceStart, AuthFail> {
    let uri = allowed_oauth_url(CHATTERINO_LOGIN)?;
    {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
        inner.pending_paste = true;
        inner.last_message = None;
    }
    emit(&app, &shared);
    if tauri_plugin_opener::open_url(&uri, None::<&str>).is_err() {
        if let Ok(mut inner) = shared.auth.lock() {
            inner.last_message = Some(format!("open manually {CHATTERINO_LOGIN}"));
        }
        emit(&app, &shared);
    }
    Ok(DeviceStart {
        mode: "paste".into(),
        user_code: None,
        verification_uri: uri,
        expires_in: 0,
    })
}

pub async fn import_blob(app: AppHandle, shared: Shared, blob: String) -> Result<(), AuthFail> {
    if env_login_token().is_some() {
        return Err(auth_env_locked());
    }
    let parsed = parse_chatterino_blob(&blob)?;
    let expected = oauth_client_id();
    if parsed.client_id != expected {
        return Err(AuthFail::coded(
            "error.auth.blob.client_id",
            "client_id in login code does not match Chatterino",
        ));
    }
    let gen = shared
        .auth
        .lock()
        .map_err(|_| AuthFail::internal("lock"))?
        .poll_gen;
    let validated = validate_token(&http_client(), &parsed.token)
        .await
        .map_err(AuthFail::internal)?;
    if !still_current(&shared, gen) {
        return Err(AuthFail::coded("error.auth.cancelled", "login cancelled"));
    }
    apply_scope_check(&shared, &validated.scopes);
    let user_id = validated
        .user_id
        .filter(|id| valid_twitch_user_id(id))
        .or_else(|| valid_twitch_user_id(&parsed.user_id).then_some(parsed.user_id.clone()));
    if !persist_and_relogin(
        &app,
        &shared,
        gen,
        validated.login,
        parsed.token,
        parsed.client_id,
        user_id,
    )
    .await
    {
        return Err(AuthFail::coded(
            "error.auth.persist_failed",
            "failed to save login",
        ));
    }
    let _ = ensure_twitch_user_id(&shared).await;
    Ok(())
}

// SPDX-FileCopyrightText: 2017 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of clipboard login parsing from Chatterino LoginDialog.cpp.
// Not a copy of C++/Qt source.
fn parse_chatterino_blob(raw: &str) -> Result<ParsedLogin, AuthFail> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AuthFail::coded(
            "error.auth.blob.empty",
            "paste the code from the Chatterino login page",
        ));
    }
    if raw.len() > MAX_LOGIN_BLOB {
        return Err(AuthFail::coded(
            "error.auth.blob.too_long",
            "login code is too long",
        ));
    }
    let mut oauth_token = String::new();
    let mut username = String::new();
    let mut user_id = String::new();
    let mut client_id = String::new();
    for part in raw.split(';') {
        let mut kv = part.splitn(2, '=');
        let key = kv.next().unwrap_or("").trim();
        let value = kv.next().unwrap_or("").trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        match key {
            "oauth_token" => oauth_token = value.to_string(),
            "username" => username = value.to_string(),
            "user_id" => user_id = value.to_string(),
            "client_id" => client_id = value.to_string(),
            _ => {}
        }
    }
    let token = oauth_token.trim_start_matches("oauth:").to_string();
    let login = username.trim().to_lowercase();
    if token.is_empty() || token == "YOUR_API_KEY_HERE" {
        return Err(AuthFail::coded(
            "error.auth.blob.missing_token",
            "login code has no oauth_token",
        ));
    }
    if !valid_login(&login) {
        return Err(AuthFail::coded(
            "error.auth.blob.bad_username",
            "login code has no valid username",
        ));
    }
    if user_id.is_empty() || !user_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AuthFail::coded(
            "error.auth.blob.bad_user_id",
            "login code has no valid user_id",
        ));
    }
    if client_id.is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return Err(AuthFail::coded(
            "error.auth.blob.missing_client_id",
            "login code has no client_id",
        ));
    }
    Ok(ParsedLogin {
        token,
        client_id,
        user_id,
    })
}

struct ParsedLogin {
    token: String,
    client_id: String,
    user_id: String,
}

pub async fn start_device(app: AppHandle, shared: Shared) -> Result<DeviceStart, AuthFail> {
    let client_id = oauth_client_id();
    if client_id == CHATTERINO_CLIENT_ID {
        return Err(AuthFail::coded(
            "error.auth.device.use_page",
            "Chatterino uses the login page, not device code",
        ));
    }
    let gen = {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
        inner.pending_paste = false;
        inner.last_message = None;
        inner.poll_gen
    };
    emit(&app, &shared);

    let device = request_device(&client_id).await?;
    let uri = allowed_oauth_url(&device.verification_uri)?;
    {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        if inner.poll_gen != gen {
            return Err(AuthFail::coded("error.auth.cancelled", "login cancelled"));
        }
        inner.pending_user_code = Some(device.user_code.clone());
        inner.pending_paste = false;
        inner.last_message = None;
    }
    emit(&app, &shared);
    let _ = tauri_plugin_opener::open_url(&uri, None::<&str>);

    let interval = device.interval.unwrap_or(5).clamp(5, 30);
    let expires_in = device.expires_in.max(1);
    let poll = PollJob {
        gen,
        client_id,
        device_code: device.device_code.clone(),
        interval,
        deadline: Instant::now() + Duration::from_secs(expires_in),
    };
    let app_poll = app.clone();
    let shared_poll = shared.clone();
    tauri::async_runtime::spawn(async move {
        poll_token(app_poll, shared_poll, poll).await;
    });

    Ok(DeviceStart {
        mode: "device".into(),
        user_code: Some(device.user_code),
        verification_uri: uri,
        expires_in,
    })
}

pub async fn logout(app: AppHandle, shared: Shared) -> Result<(), AuthFail> {
    if env_login_token().is_some() {
        return Err(auth_env_locked());
    }
    let (cancel_only, current) = {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        let pending = inner.pending_paste || inner.pending_user_code.is_some();
        if pending {
            inner.poll_gen = inner.poll_gen.wrapping_add(1);
            inner.pending_user_code = None;
            inner.pending_paste = false;
            inner.last_message = None;
            (true, None)
        } else {
            (false, inner.current_login.clone())
        }
    };
    if cancel_only {
        emit(&app, &shared);
        return Ok(());
    }
    let Some(login) = current else {
        emit(&app, &shared);
        return Ok(());
    };
    remove_account(app, shared, login).await
}

pub async fn select_account(app: AppHandle, shared: Shared, login: String) -> Result<(), AuthFail> {
    if env_login_token().is_some() {
        return Err(auth_env_locked());
    }
    let login = login.trim().to_lowercase();
    if !valid_login(&login) {
        return Err(AuthFail::coded("error.auth.login.invalid", "invalid login"));
    }
    {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        if !inner.accounts.iter().any(|c| c.login == login) {
            return Err(AuthFail::coded(
                "error.auth.account.not_found",
                "account not found",
            ));
        }
        if inner.current_login.as_deref() == Some(login.as_str()) {
            return Ok(());
        }
        let prev = AuthStore {
            accounts: inner.accounts.clone(),
            current_login: inner.current_login.clone(),
        };
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
        inner.pending_paste = false;
        inner.last_message = None;
        inner.current_login = Some(login.clone());
        inner.cached_user_id = current_creds(&inner).and_then(|c| c.user_id.clone());
        let store = AuthStore {
            accounts: inner.accounts.clone(),
            current_login: inner.current_login.clone(),
        };
        let path = inner.path.clone();
        if let Err(e) = save_store(&path, &store) {
            apply_store(&mut inner, prev);
            return Err(AuthFail::internal(e));
        }
    }
    after_identity_change(&shared).await;
    emit(&app, &shared);
    super::profile_images::spawn_refresh(app.clone(), shared.clone(), login);
    Ok(())
}

pub async fn remove_account(app: AppHandle, shared: Shared, login: String) -> Result<(), AuthFail> {
    if env_login_token().is_some() {
        return Err(auth_env_locked());
    }
    let login = login.trim().to_lowercase();
    if !valid_login(&login) {
        return Err(AuthFail::coded("error.auth.login.invalid", "invalid login"));
    }
    let was_current = {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        let idx = inner
            .accounts
            .iter()
            .position(|c| c.login == login)
            .ok_or_else(|| AuthFail::coded("error.auth.account.not_found", "account not found"))?;
        let was_current = inner.current_login.as_deref() == Some(login.as_str());
        let prev = AuthStore {
            accounts: inner.accounts.clone(),
            current_login: inner.current_login.clone(),
        };
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
        inner.pending_paste = false;
        inner.last_message = None;
        inner.accounts.remove(idx);
        if was_current {
            inner.current_login = inner.accounts.first().map(|c| c.login.clone());
            inner.cached_user_id = current_creds(&inner).and_then(|c| c.user_id.clone());
        }
        let store = AuthStore {
            accounts: inner.accounts.clone(),
            current_login: inner.current_login.clone(),
        };
        let path = inner.path.clone();
        if let Err(e) = persist_store_or_remove(&path, &store) {
            apply_store(&mut inner, prev);
            return Err(e);
        }
        was_current
    };
    if was_current {
        after_identity_change(&shared).await;
    }
    emit(&app, &shared);
    Ok(())
}

pub async fn reject_session(app: AppHandle, shared: Shared, message: &str) {
    if env_login_token().is_some() {
        {
            if let Ok(mut inner) = shared.auth.lock() {
                inner.last_message = Some(message.to_string());
            }
        }
        emit(&app, &shared);
        return;
    }
    let current = shared
        .auth
        .lock()
        .ok()
        .and_then(|inner| inner.current_login.clone());
    let Some(login) = current else {
        if let Ok(mut inner) = shared.auth.lock() {
            inner.last_message = Some(message.to_string());
        }
        emit(&app, &shared);
        return;
    };
    if let Err(e) = remove_account(app.clone(), shared.clone(), login).await {
        if let Ok(mut inner) = shared.auth.lock() {
            inner.last_message = Some(e.message);
        }
        emit(&app, &shared);
        return;
    }
    if let Ok(mut inner) = shared.auth.lock() {
        inner.last_message = Some(message.to_string());
    }
    emit(&app, &shared);
}

async fn after_identity_change(shared: &Shared) {
    let _ = ensure_twitch_user_id(shared).await;
    request_relogin(shared).await;
    shared.notify_pins(super::pins::PinsCmd::Relogin);
    shared.notify_polls(super::polls::PollsCmd::Relogin);
    shared.notify_low_trust(super::low_trust::LowTrustCmd::Relogin);
    shared.notify_shared_bans(super::shared_bans::SharedBansCmd::Relogin);
    super::provider_activity::clear_identity_cache(shared);
    super::twitch_blocks::clear_blocks(shared);
    super::shared_chat::clear(shared);
    super::twitch_blocks::spawn_load_if_enabled(shared);
}

struct PollJob {
    gen: u64,
    client_id: String,
    device_code: String,
    interval: u64,
    deadline: Instant,
}

async fn poll_token(app: AppHandle, shared: Shared, mut job: PollJob) {
    let client = http_client();
    loop {
        if Instant::now() >= job.deadline {
            finish_pending(&app, &shared, job.gen, Some("login code expired"));
            return;
        }
        if !still_current(&shared, job.gen) {
            return;
        }
        match request_token(&client, &job.client_id, &job.device_code).await {
            TokenPoll::Pending => {}
            TokenPoll::SlowDown => {
                job.interval = (job.interval + 5).min(30);
            }
            TokenPoll::Denied => {
                finish_pending(&app, &shared, job.gen, Some("login denied"));
                return;
            }
            TokenPoll::Expired => {
                finish_pending(&app, &shared, job.gen, Some("login code expired"));
                return;
            }
            TokenPoll::Fail(msg) => {
                finish_pending(&app, &shared, job.gen, Some(&msg));
                return;
            }
            TokenPoll::Ok(token) => {
                match validate_token(&client, &token).await {
                    Ok(validated) => {
                        apply_scope_check(&shared, &validated.scopes);
                        if persist_and_relogin(
                            &app,
                            &shared,
                            job.gen,
                            validated.login,
                            token,
                            oauth_client_id(),
                            validated.user_id,
                        )
                        .await
                        {
                            return;
                        }
                    }
                    Err(msg) => {
                        finish_pending(&app, &shared, job.gen, Some(&msg));
                    }
                }
                return;
            }
        }
        let wait = Duration::from_secs(job.interval.max(5));
        tokio::time::sleep(wait).await;
    }
}

async fn persist_and_relogin(
    app: &AppHandle,
    shared: &Shared,
    gen: u64,
    login: String,
    token: String,
    client_id: String,
    user_id: Option<String>,
) -> bool {
    if env_login_token().is_some() {
        finish_pending(app, shared, gen, Some("login is set via env"));
        return false;
    }
    let save_err = {
        let mut inner = match shared.auth.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if inner.poll_gen != gen {
            return false;
        }
        let path = inner.path.clone();
        let mut accounts = inner.accounts.clone();
        upsert_account(
            &mut accounts,
            StoredCreds {
                login: login.clone(),
                token,
                client_id,
                user_id: user_id.filter(|id| valid_twitch_user_id(id)),
            },
        );
        let store = AuthStore {
            accounts,
            current_login: Some(login.clone()),
        };
        if let Err(e) = save_store(&path, &store) {
            inner.last_message = Some(e);
            inner.pending_user_code = None;
            inner.pending_paste = false;
            true
        } else {
            apply_store(&mut inner, store);
            inner.pending_user_code = None;
            inner.pending_paste = false;
            inner.last_message = None;
            false
        }
    };
    if save_err {
        emit(app, shared);
        return false;
    }
    after_identity_change(shared).await;
    emit(app, shared);
    super::profile_images::spawn_refresh(app.clone(), shared.clone(), login);
    true
}

async fn verify_disk(app: AppHandle, shared: Shared) {
    if env_login_token().is_some() {
        let _ = ensure_twitch_user_id(&shared).await;
        // ensure_twitch_user_id may set scopesIncomplete; push to UI.
        emit(&app, &shared);
        return;
    }
    let (token, gen, login) = match shared.auth.lock() {
        Ok(inner) => match current_creds(&inner) {
            Some(c) => (c.token.clone(), inner.poll_gen, c.login.clone()),
            None => return,
        },
        Err(_) => return,
    };
    match validate_token(&http_client(), &token).await {
        Ok(validated) => {
            apply_scope_check(&shared, &validated.scopes);
            if let Some(uid) = validated.user_id {
                set_cached_twitch_user_id(&shared, uid);
            } else {
                let _ = ensure_twitch_user_id(&shared).await;
            }
            emit(&app, &shared);
        }
        Err(_) => {
            let still = shared.auth.lock().ok().is_some_and(|inner| {
                inner.poll_gen == gen
                    && current_creds(&inner).is_some_and(|c| c.login == login && c.token == token)
            });
            if still {
                reject_session(app, shared, "saved login is invalid").await;
            }
        }
    }
}

fn finish_pending(app: &AppHandle, shared: &Shared, gen: u64, message: Option<&str>) {
    {
        let Ok(mut inner) = shared.auth.lock() else {
            return;
        };
        if inner.poll_gen != gen {
            return;
        }
        inner.pending_user_code = None;
        inner.pending_paste = false;
        inner.last_message = message.map(str::to_string);
    }
    emit(app, shared);
}

fn still_current(shared: &Shared, gen: u64) -> bool {
    shared
        .auth
        .lock()
        .ok()
        .is_some_and(|inner| inner.poll_gen == gen)
}

async fn request_relogin(shared: &Shared) {
    let tx = shared.irc_tx.lock().ok().and_then(|g| g.clone());
    if let Some(tx) = tx {
        let _ = tokio::time::timeout(Duration::from_secs(10), tx.send(IrcCmd::Relogin)).await;
    }
}

async fn request_device(client_id: &str) -> Result<DeviceJson, AuthFail> {
    let client = http_client();
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("scopes", DEVICE_SCOPES)
        .finish();
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..HTTP_ATTEMPTS {
        match client
            .post(DEVICE_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .body(body.clone())
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<serde_json::Value>().await {
                    Ok(v) if status.is_success() => {
                        return serde_json::from_value::<DeviceJson>(v)
                            .map_err(|_| AuthFail::internal("invalid device code response"));
                    }
                    Ok(v) => {
                        last = v
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("device code error")
                            .to_string();
                    }
                    Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
                }
            }
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
        }
        if attempt + 1 < HTTP_ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(AuthFail::internal(format!("device code: {last}")))
}

enum TokenPoll {
    Ok(String),
    Pending,
    SlowDown,
    Denied,
    Expired,
    Fail(String),
}

async fn request_token(client: &reqwest::Client, client_id: &str, device_code: &str) -> TokenPoll {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("device_code", device_code)
        .append_pair("grant_type", GRANT_DEVICE)
        .finish();
    match client
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .await
    {
        Err(_) => TokenPoll::Pending,
        Ok(resp) => {
            let status = resp.status();
            let Ok(v) = resp.json::<serde_json::Value>().await else {
                return TokenPoll::Pending;
            };
            if status.is_success() {
                if let Some(token) = v.get("access_token").and_then(serde_json::Value::as_str) {
                    if !token.is_empty() {
                        return TokenPoll::Ok(token.to_string());
                    }
                }
                return TokenPoll::Fail("empty token".into());
            }
            let kind = v
                .get("message")
                .and_then(serde_json::Value::as_str)
                .or_else(|| v.get("error").and_then(serde_json::Value::as_str))
                .unwrap_or("");
            match kind {
                "authorization_pending" => TokenPoll::Pending,
                "slow_down" => TokenPoll::SlowDown,
                "access_denied" => TokenPoll::Denied,
                "expired_token" => TokenPoll::Expired,
                other => {
                    if other.is_empty() {
                        TokenPoll::Pending
                    } else {
                        TokenPoll::Fail(other.to_string())
                    }
                }
            }
        }
    }
}

struct ValidatedToken {
    login: String,
    user_id: Option<String>,
    scopes: Vec<String>,
}

fn device_scope_list() -> Vec<&'static str> {
    DEVICE_SCOPES.split_whitespace().collect()
}

/// True when `need` is present, or a known equivalent Twitch/Chatterino grants.
fn scope_satisfied(have: &std::collections::HashSet<&str>, need: &str) -> bool {
    if have.contains(need) {
        return true;
    }
    // Legacy alias / manage-covers-read for banner completeness only.
    match need {
        "chat:write" => have.contains("chat:edit"),
        "chat:edit" => have.contains("chat:write"),
        "moderator:read:chat_messages" => have.contains("moderator:manage:chat_messages"),
        "moderator:read:blocked_terms" => have.contains("moderator:manage:blocked_terms"),
        "moderator:read:chat_settings" => have.contains("moderator:manage:chat_settings"),
        "moderator:read:unban_requests" => have.contains("moderator:manage:unban_requests"),
        "moderator:read:banned_users" => have.contains("moderator:manage:banned_users"),
        _ => false,
    }
}

/// Returns true when every DEVICE_SCOPES entry is present in the validate response.
fn scopes_cover_device(have: &[String]) -> bool {
    let have_set: std::collections::HashSet<&str> = have.iter().map(String::as_str).collect();
    device_scope_list()
        .iter()
        .all(|need| scope_satisfied(&have_set, need))
}

fn apply_scope_check(shared: &Shared, scopes: &[String]) {
    let incomplete = !scopes_cover_device(scopes);
    if let Ok(mut inner) = shared.auth.lock() {
        inner.scopes_incomplete = incomplete;
        // Do not stash English copy in last_message — UI uses t("auth.scopes.relogin").
        if !incomplete
            && inner
                .last_message
                .as_deref()
                .is_some_and(|m| m.contains("unlock pins, AutoMod"))
        {
            inner.last_message = None;
        }
    }
}

async fn validate_token(client: &reqwest::Client, token: &str) -> Result<ValidatedToken, String> {
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..HTTP_ATTEMPTS {
        match client
            .get(VALIDATE_URL)
            .header("Authorization", format!("OAuth {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<serde_json::Value>().await {
                    Ok(v) if status.is_success() => {
                        let login = v
                            .get("login")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_lowercase();
                        if !valid_login(&login) {
                            return Err("validate: invalid login".into());
                        }
                        let user_id = v
                            .get("user_id")
                            .and_then(serde_json::Value::as_str)
                            .filter(|s| valid_twitch_user_id(s))
                            .map(str::to_string);
                        let scopes = v
                            .get("scopes")
                            .and_then(serde_json::Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|x| x.as_str().map(str::to_string))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        return Ok(ValidatedToken {
                            login,
                            user_id,
                            scopes,
                        });
                    }
                    Ok(v) => {
                        last = v
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("validate error")
                            .to_string();
                    }
                    Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
                }
            }
            Err(e) => last = super::http_client::format_reqwest_error_brief(&e),
        }
        if attempt + 1 < HTTP_ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(format!("validate: {last}"))
}

pub(crate) fn env_secret(name: &str) -> Option<String> {
    let s = std::env::var(name).ok()?.trim().to_string();
    if s.is_empty() || s == "YOUR_API_KEY_HERE" {
        None
    } else {
        Some(s)
    }
}

fn env_login_token() -> Option<(String, String)> {
    let login = env_secret("TWITCH_LOGIN")?.to_lowercase();
    if login == "your_login_here" || !valid_login(&login) {
        return None;
    }
    let token = env_oauth_token()?;
    Some((login, token))
}

fn env_oauth_token() -> Option<String> {
    let raw = env_secret("TWITCH_OAUTH_TOKEN")?;
    let token = raw.trim_start_matches("oauth:").to_string();
    if token.is_empty() || token == "YOUR_API_KEY_HERE" {
        None
    } else {
        Some(token)
    }
}

fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 25
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn load_file(path: &Path) -> AuthStore {
    let Ok(raw) = fs::read_to_string(path) else {
        return AuthStore::default();
    };
    parse_auth_json(&raw).unwrap_or_default()
}

fn parse_auth_json(raw: &str) -> Option<AuthStore> {
    if let Ok(multi) = serde_json::from_str::<DiskMulti>(raw) {
        if !multi.accounts.is_empty() || !multi.current.is_empty() {
            let mut accounts = Vec::new();
            for row in multi.accounts {
                if let Some(c) = normalize_disk_account(row) {
                    upsert_account(&mut accounts, c);
                }
            }
            let current = multi.current.trim().to_lowercase();
            let current_login =
                if valid_login(&current) && accounts.iter().any(|a| a.login == current) {
                    Some(current)
                } else {
                    accounts.first().map(|a| a.login.clone())
                };
            return Some(AuthStore {
                accounts,
                current_login,
            });
        }
    }
    let legacy: DiskLegacy = serde_json::from_str(raw).ok()?;
    let creds = normalize_disk_account(DiskAccount {
        login: legacy.login,
        token: legacy.token,
        client_id: legacy.client_id,
        user_id: legacy.user_id,
    })?;
    let login = creds.login.clone();
    Some(AuthStore {
        accounts: vec![creds],
        current_login: Some(login),
    })
}

fn normalize_disk_account(parsed: DiskAccount) -> Option<StoredCreds> {
    let login = parsed.login.trim().to_lowercase();
    let token = parsed.token.trim().trim_start_matches("oauth:").to_string();
    if !valid_login(&login) || token.is_empty() || token == "YOUR_API_KEY_HERE" {
        return None;
    }
    Some(StoredCreds {
        login,
        token,
        client_id: if parsed.client_id.is_empty() || parsed.client_id == "YOUR_API_KEY_HERE" {
            CHATTERINO_CLIENT_ID.to_string()
        } else {
            parsed.client_id.trim().to_string()
        },
        user_id: parsed.user_id.filter(|id| valid_twitch_user_id(id)),
    })
}

fn remove_auth_file(path: &Path) -> Result<(), AuthFail> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AuthFail::internal(format!("failed to remove session: {e}"))),
    }
}

fn persist_store_or_remove(path: &Path, store: &AuthStore) -> Result<(), AuthFail> {
    if store.accounts.is_empty() {
        remove_auth_file(path)
    } else {
        save_store(path, store).map_err(AuthFail::internal)
    }
}

fn save_store(path: &Path, store: &AuthStore) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("config directory is not set".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let current = store.current_login.as_deref().unwrap_or("");
    let accounts: Vec<DiskAccountOut<'_>> = store
        .accounts
        .iter()
        .map(|c| DiskAccountOut {
            login: &c.login,
            token: &c.token,
            client_id: &c.client_id,
            user_id: c.user_id.as_deref().filter(|id| valid_twitch_user_id(id)),
        })
        .collect();
    let json =
        serde_json::to_string(&DiskMultiOut { current, accounts }).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn http_client() -> reqwest::Client {
    super::http_client::build(Duration::from_secs(12))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_url_allowlist() {
        assert!(allowed_oauth_url("https://chatterino.com/client_login").is_ok());
        assert!(allowed_oauth_url("https://www.chatterino.com/client_login").is_ok());
        assert!(allowed_oauth_url("https://chatterino.com/other").is_err());
        assert!(allowed_oauth_url("https://www.twitch.tv/activate").is_ok());
        assert!(allowed_oauth_url("https://id.twitch.tv/oauth2/device").is_ok());
        assert!(allowed_oauth_url("http://www.twitch.tv/activate").is_err());
        assert!(allowed_oauth_url("https://evil.example/activate").is_err());
        assert!(allowed_oauth_url("https://user:pass@www.twitch.tv/activate").is_err());
        assert!(allowed_oauth_url("https://www.twitch.tv.evil.com/activate").is_err());
        assert!(allowed_oauth_url("javascript:alert(1)").is_err());
        assert!(allowed_oauth_url("https://www.twitch.tv.attacker.com/").is_err());
    }

    #[test]
    fn parses_chatterino_login_blob() {
        let blob = format!(
            "oauth_token=abc123;username=TestUser;user_id=42;client_id={CHATTERINO_CLIENT_ID}"
        );
        let parsed = parse_chatterino_blob(&blob).unwrap();
        assert_eq!(parsed.token, "abc123");
        assert_eq!(parsed.client_id, CHATTERINO_CLIENT_ID);
        assert_eq!(parsed.user_id, "42");
        assert!(
            parse_chatterino_blob("oauth_token=abc;username=bad name;user_id=1;client_id=x")
                .is_err()
        );
        assert!(parse_chatterino_blob("").is_err());
        assert!(parse_chatterino_blob("javascript:alert(1)").is_err());
    }

    #[test]
    fn migrates_legacy_auth_json() {
        let raw = format!(
            r#"{{"login":"Alice","token":"tok","client_id":"{CHATTERINO_CLIENT_ID}","user_id":"9"}}"#
        );
        let store = parse_auth_json(&raw).unwrap();
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.accounts[0].login, "alice");
        assert_eq!(store.current_login.as_deref(), Some("alice"));
    }

    #[test]
    fn parses_multi_auth_json() {
        let raw = r#"{
            "current":"bob",
            "accounts":[
                {"login":"alice","token":"t1","client_id":"cid","user_id":"1"},
                {"login":"bob","token":"t2","client_id":"cid","user_id":"2"}
            ]
        }"#;
        let store = parse_auth_json(raw).unwrap();
        assert_eq!(store.accounts.len(), 2);
        assert_eq!(store.current_login.as_deref(), Some("bob"));
    }

    #[test]
    fn upsert_replaces_same_login() {
        let mut accounts = vec![StoredCreds {
            login: "alice".into(),
            token: "old".into(),
            client_id: "c".into(),
            user_id: Some("1".into()),
        }];
        upsert_account(
            &mut accounts,
            StoredCreds {
                login: "alice".into(),
                token: "new".into(),
                client_id: "c".into(),
                user_id: Some("1".into()),
            },
        );
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].token, "new");
    }

    #[test]
    fn auth_info_rows_have_no_token_field() {
        let json = serde_json::to_string(&AccountRow {
            login: "alice".into(),
            user_id: Some("1".into()),
            profile_image_url: None,
        })
        .unwrap();
        assert!(!json.contains("token"));
        assert!(json.contains("alice"));
    }

    #[test]
    fn scopes_cover_device_requires_all_device_scopes() {
        let full: Vec<String> = device_scope_list()
            .into_iter()
            .map(str::to_string)
            .collect();
        assert!(scopes_cover_device(&full));
        let mut missing = full.clone();
        missing.retain(|s| s != "moderator:manage:warnings");
        assert!(!scopes_cover_device(&missing));
        assert!(!scopes_cover_device(&[]));
    }

    #[test]
    fn scopes_cover_accepts_chat_edit_and_manage_equivalents() {
        let mut scopes: Vec<String> = device_scope_list()
            .into_iter()
            .map(str::to_string)
            .collect();
        // Replace chat:edit with legacy chat:write — still complete.
        scopes.retain(|s| s != "chat:edit");
        scopes.push("chat:write".into());
        assert!(scopes_cover_device(&scopes));
        assert!(scope_satisfied(
            &["moderator:manage:chat_messages"].into_iter().collect(),
            "moderator:read:chat_messages"
        ));
    }
}
