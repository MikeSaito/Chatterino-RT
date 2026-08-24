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
const DEVICE_SCOPES: &str = "chat:read chat:write user:read:blocked_users";
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
    pub disk: Option<StoredCreds>,
    pub cached_user_id: Option<String>,
    pub pending_user_code: Option<String>,
    pub pending_paste: bool,
    pub poll_gen: u64,
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    pub can_send: bool,
    pub from_env: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    pub pending_paste: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
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
}

impl AuthFail {
    fn config(message: impl Into<String>) -> Self {
        Self {
            code: "config".into(),
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input".into(),
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal".into(),
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
struct DiskFile {
    login: String,
    token: String,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    user_id: Option<String>,
}

#[derive(Serialize)]
struct DiskFileOut<'a> {
    login: &'a str,
    token: &'a str,
    client_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<&'a str>,
}

#[derive(Deserialize)]
struct DeviceJson {
    device_code: String,
    expires_in: u64,
    interval: Option<u64>,
    user_code: String,
    verification_uri: String,
}

pub fn init(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(AUTH_FILE);
    let disk = load_file(&path);
    {
        let mut inner = shared.auth.lock().map_err(|e| e.to_string())?;
        inner.path = path;
        inner.disk = disk.clone();
        inner.cached_user_id = disk.and_then(|c| c.user_id);
    }
    emit(app, shared);
    let app_chk = app.clone();
    let shared_chk = shared.clone();
    tauri::async_runtime::spawn(async move {
        verify_disk(app_chk, shared_chk).await;
    });
    Ok(())
}

pub fn emit(app: &AppHandle, shared: &Shared) {
    let _ = app.emit("chat:auth", snapshot(shared));
}

pub fn snapshot(shared: &Shared) -> AuthInfo {
    let (pending, pending_paste, disk, last_message) = match shared.auth.lock() {
        Ok(inner) => (
            inner.pending_user_code.clone(),
            inner.pending_paste,
            inner.disk.clone(),
            inner.last_message.clone(),
        ),
        Err(_) => (None, false, None, None),
    };
    let env_pair = env_login_token();
    let from_env = env_pair.is_some();
    let login = env_pair
        .as_ref()
        .map(|(l, _)| l.clone())
        .or_else(|| disk.as_ref().map(|c| c.login.clone()));
    let has_token = env_pair.is_some() || disk.is_some();
    let active = shared.hub.lock().ok();
    let can_send = has_token
        && login.is_some()
        && active
            .as_ref()
            .is_some_and(|h| h.active.is_some() && h.joined_active());
    AuthInfo {
        can_send,
        login,
        from_env,
        user_code: pending,
        pending_paste,
        message: last_message,
    }
}

pub fn resolved_login_token(shared: &Shared) -> Option<(String, String)> {
    if let Some(pair) = env_login_token() {
        return Some(pair);
    }
    shared
        .auth
        .lock()
        .ok()?
        .disk
        .as_ref()
        .map(|c| (c.login.clone(), c.token.clone()))
}

pub fn oauth_token(shared: &Shared) -> Option<String> {
    resolved_login_token(shared).map(|(_, token)| token)
}

fn valid_twitch_user_id(raw: &str) -> bool {
    !raw.is_empty() && raw.chars().all(|c| c.is_ascii_digit())
}

pub fn resolved_twitch_user_id(shared: &Shared) -> Option<String> {
    let inner = shared.auth.lock().ok()?;
    if let Some(id) = inner.cached_user_id.as_deref().filter(|s| valid_twitch_user_id(s)) {
        return Some(id.to_string());
    }
    inner
        .disk
        .as_ref()
        .and_then(|c| c.user_id.as_deref())
        .filter(|s| valid_twitch_user_id(s))
        .map(str::to_string)
}

pub fn set_cached_twitch_user_id(shared: &Shared, user_id: String) {
    if !valid_twitch_user_id(&user_id) {
        return;
    }
    if let Ok(mut inner) = shared.auth.lock() {
        inner.cached_user_id = Some(user_id.clone());
        if let Some(disk) = inner.disk.as_mut() {
            disk.user_id = Some(user_id);
        }
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
    let validated = validate_token(&http_client(), &token).await.ok()?;
    if let Some(uid) = validated.user_id {
        set_cached_twitch_user_id(shared, uid.clone());
        return Some(uid);
    }
    None
}

pub fn resolved_client_id(shared: &Shared) -> String {
    if let Some(id) = env_secret("TWITCH_CLIENT_ID") {
        return id;
    }
    if let Some(id) = shared
        .auth
        .lock()
        .ok()
        .and_then(|inner| inner.disk.as_ref().map(|c| c.client_id.clone()))
        .filter(|id| !id.is_empty() && id != "YOUR_API_KEY_HERE")
    {
        return id;
    }
    CHATTERINO_CLIENT_ID.to_string()
}

fn oauth_client_id() -> String {
    env_secret("TWITCH_CLIENT_ID").unwrap_or_else(|| CHATTERINO_CLIENT_ID.to_string())
}

pub fn allowed_oauth_url(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "некорректный URL входа".to_string())?;
    if parsed.scheme() != "https" {
        return Err("URL входа только https".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL входа с userinfo запрещён".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if host == "chatterino.com" || host == "www.chatterino.com" {
        if parsed.path() != "/client_login" {
            return Err("URL входа Chatterino только /client_login".into());
        }
        return Ok(CHATTERINO_LOGIN.to_string());
    }
    if !OAUTH_HOSTS.iter().any(|h| *h == host) {
        return Err("хост URL входа не из списка Twitch".into());
    }
    Ok(parsed.as_str().to_string())
}

pub async fn start_login(app: AppHandle, shared: Shared) -> Result<DeviceStart, AuthFail> {
    if oauth_client_id() == CHATTERINO_CLIENT_ID {
        start_chatterino_page(app, shared).await
    } else {
        start_device(app, shared).await
    }
}

async fn start_chatterino_page(app: AppHandle, shared: Shared) -> Result<DeviceStart, AuthFail> {
    let uri = allowed_oauth_url(CHATTERINO_LOGIN).map_err(AuthFail::invalid)?;
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
            inner.last_message = Some(format!("откройте вручную {CHATTERINO_LOGIN}"));
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
        return Err(AuthFail::config(
            "вход задан через TWITCH_LOGIN и TWITCH_OAUTH_TOKEN",
        ));
    }
    let parsed = parse_chatterino_blob(&blob)?;
    let expected = oauth_client_id();
    if parsed.client_id != expected {
        return Err(AuthFail::invalid(
            "client_id в коде не совпадает с Chatterino",
        ));
    }
    let gen = shared
        .auth
        .lock()
        .map_err(|_| AuthFail::internal("lock"))?
        .poll_gen;
    let login = validate_login(&http_client(), &parsed.token)
        .await
        .map_err(AuthFail::internal)?;
    if !still_current(&shared, gen) {
        return Err(AuthFail::internal("вход отменён"));
    }
    if !persist_and_relogin(
        &app,
        &shared,
        gen,
        login,
        parsed.token,
        parsed.client_id,
        Some(parsed.user_id),
    )
    .await
    {
        return Err(AuthFail::internal("не удалось сохранить вход"));
    }
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
        return Err(AuthFail::invalid("вставьте код со страницы входа Chatterino"));
    }
    if raw.len() > MAX_LOGIN_BLOB {
        return Err(AuthFail::invalid("код входа слишком длинный"));
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
        return Err(AuthFail::invalid("в коде нет oauth_token"));
    }
    if !valid_login(&login) {
        return Err(AuthFail::invalid("в коде нет корректного username"));
    }
    if user_id.is_empty() || !user_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AuthFail::invalid("в коде нет корректного user_id"));
    }
    if client_id.is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return Err(AuthFail::invalid("в коде нет client_id"));
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
        return Err(AuthFail::config(
            "для Chatterino используется страница входа, не device code",
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
    let uri = allowed_oauth_url(&device.verification_uri).map_err(AuthFail::invalid)?;
    {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        if inner.poll_gen != gen {
            return Err(AuthFail::internal("вход отменён"));
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
    let (path, gen) = {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
        inner.pending_paste = false;
        inner.disk = None;
        inner.cached_user_id = None;
        inner.last_message = None;
        (inner.path.clone(), inner.poll_gen)
    };
    if let Err(e) = remove_auth_file(&path) {
        if let Ok(mut inner) = shared.auth.lock() {
            if inner.poll_gen == gen {
                inner.disk = load_file(&path);
            }
        }
        return Err(e);
    }
    request_relogin(&shared).await;
    super::provider_activity::clear_identity_cache(&shared);
    super::twitch_blocks::clear_blocks(&shared);
    super::shared_chat::clear(&shared);
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
    let (path, gen) = {
        let Ok(mut inner) = shared.auth.lock() else {
            return;
        };
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
        inner.pending_paste = false;
        inner.disk = None;
        inner.cached_user_id = None;
        inner.last_message = Some(message.to_string());
        (inner.path.clone(), inner.poll_gen)
    };
    if let Err(e) = remove_auth_file(&path) {
        if let Ok(mut inner) = shared.auth.lock() {
            if inner.poll_gen == gen {
                inner.disk = load_file(&path);
                inner.last_message = Some(e.message);
            }
        }
        emit(&app, &shared);
        return;
    }
    request_relogin(&shared).await;
    super::provider_activity::clear_identity_cache(&shared);
    super::twitch_blocks::clear_blocks(&shared);
    super::shared_chat::clear(&shared);
    emit(&app, &shared);
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
            finish_pending(&app, &shared, job.gen, Some("код входа истёк"));
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
                finish_pending(&app, &shared, job.gen, Some("вход отклонён"));
                return;
            }
            TokenPoll::Expired => {
                finish_pending(&app, &shared, job.gen, Some("код входа истёк"));
                return;
            }
            TokenPoll::Fail(msg) => {
                finish_pending(&app, &shared, job.gen, Some(&msg));
                return;
            }
            TokenPoll::Ok(token) => {
                match validate_token(&client, &token).await {
                    Ok(validated) => {
                        if persist_and_relogin(
                            &app,
                            &shared,
                            job.gen,
                            validated.login,
                            token,
                            oauth_client_id(),
                            validated.user_id,
                        )
                        .await {
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
    let path = {
        let inner = match shared.auth.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if inner.poll_gen != gen {
            return false;
        }
        inner.path.clone()
    };
    if let Err(e) = save_file(&path, &login, &token, &client_id, user_id.as_deref()) {
        finish_pending(app, shared, gen, Some(&e));
        return false;
    }
    {
        let mut inner = match shared.auth.lock() {
            Ok(g) => g,
            Err(_) => {
                let _ = remove_auth_file(&path);
                return false;
            }
        };
        if inner.poll_gen != gen {
            drop(inner);
            let _ = remove_auth_file(&path);
            return false;
        }
        inner.disk = Some(StoredCreds {
            login: login.clone(),
            token,
            client_id,
            user_id: user_id.filter(|id| valid_twitch_user_id(id)),
        });
        inner.cached_user_id = inner.disk.as_ref().and_then(|c| c.user_id.clone());
        inner.pending_user_code = None;
        inner.pending_paste = false;
        inner.last_message = None;
    }
    request_relogin(shared).await;
    super::twitch_blocks::clear_blocks(shared);
    super::shared_chat::clear(shared);
    super::twitch_blocks::spawn_load_if_enabled(shared);
    emit(app, shared);
    true
}

async fn verify_disk(app: AppHandle, shared: Shared) {
    if env_login_token().is_some() {
        return;
    }
    let (token, gen) = match shared.auth.lock() {
        Ok(inner) => match inner.disk.as_ref() {
            Some(c) => (c.token.clone(), inner.poll_gen),
            None => return,
        },
        Err(_) => return,
    };
    if validate_login(&http_client(), &token).await.is_err() {
        let still = shared.auth.lock().ok().is_some_and(|inner| {
            inner.poll_gen == gen && inner.disk.as_ref().is_some_and(|c| c.token == token)
        });
        if still {
            reject_session(app, shared, "сохранённый вход недействителен").await;
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
    let tx = shared
        .irc_tx
        .lock()
        .ok()
        .and_then(|g| g.clone());
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
    let mut last = String::from("нет ответа");
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
                        return serde_json::from_value::<DeviceJson>(v).map_err(|_| {
                            AuthFail::internal("некорректный ответ device code")
                        });
                    }
                    Ok(v) => {
                        last = v
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("ошибка device code")
                            .to_string();
                    }
                    Err(e) => last = e.to_string(),
                }
            }
            Err(e) => last = e.to_string(),
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
                return TokenPoll::Fail("токен пустой".into());
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

async fn validate_login(client: &reqwest::Client, token: &str) -> Result<String, String> {
    validate_token(client, token).await.map(|v| v.login)
}

struct ValidatedToken {
    login: String,
    user_id: Option<String>,
}

async fn validate_token(client: &reqwest::Client, token: &str) -> Result<ValidatedToken, String> {
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("нет ответа");
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
                            return Err("validate: некорректный login".into());
                        }
                        let user_id = v
                            .get("user_id")
                            .and_then(serde_json::Value::as_str)
                            .filter(|s| valid_twitch_user_id(s))
                            .map(str::to_string);
                        return Ok(ValidatedToken { login, user_id });
                    }
                    Ok(v) => {
                        last = v
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("ошибка validate")
                            .to_string();
                    }
                    Err(e) => last = e.to_string(),
                }
            }
            Err(e) => last = e.to_string(),
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
        && login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn load_file(path: &Path) -> Option<StoredCreds> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: DiskFile = serde_json::from_str(&raw).ok()?;
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
        user_id: parsed
            .user_id
            .filter(|id| valid_twitch_user_id(id)),
    })
}

fn remove_auth_file(path: &Path) -> Result<(), AuthFail> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AuthFail::internal(format!("не удалось удалить сессию: {e}"))),
    }
}

fn save_file(
    path: &Path,
    login: &str,
    token: &str,
    client_id: &str,
    user_id: Option<&str>,
) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("каталог конфигурации не задан".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&DiskFileOut {
        login,
        token,
        client_id,
        user_id: user_id.filter(|id| valid_twitch_user_id(id)),
    })
    .map_err(|e| e.to_string())?;
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
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Chatterino-RT/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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
        assert!(parse_chatterino_blob("oauth_token=abc;username=bad name;user_id=1;client_id=x")
            .is_err());
        assert!(parse_chatterino_blob("").is_err());
        assert!(parse_chatterino_blob("javascript:alert(1)").is_err());
    }
}
