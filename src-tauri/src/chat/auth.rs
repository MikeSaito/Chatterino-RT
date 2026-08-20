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
const DEVICE_SCOPES: &str = "chat:read chat:write";
const GRANT_DEVICE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_HOSTS: &[&str] = &["id.twitch.tv", "www.twitch.tv"];
const AUTH_FILE: &str = "twitch-auth.json";
const HTTP_ATTEMPTS: u32 = 3;

#[derive(Clone)]
pub struct StoredCreds {
    pub login: String,
    pub token: String,
}

#[derive(Default)]
pub struct AuthInner {
    pub path: PathBuf,
    pub disk: Option<StoredCreds>,
    pub pending_user_code: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
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
}

#[derive(Serialize)]
struct DiskFileOut<'a> {
    login: &'a str,
    token: &'a str,
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
        inner.disk = disk;
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
    let (pending, disk, last_message) = match shared.auth.lock() {
        Ok(inner) => (
            inner.pending_user_code.clone(),
            inner.disk.clone(),
            inner.last_message.clone(),
        ),
        Err(_) => (None, None, None),
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
            .is_some_and(|h| h.active.is_some() && h.joined);
    AuthInfo {
        can_send,
        login,
        from_env,
        user_code: pending,
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

pub fn allowed_oauth_url(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "некорректный URL входа".to_string())?;
    if parsed.scheme() != "https" {
        return Err("URL входа только https".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL входа с userinfo запрещён".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if !OAUTH_HOSTS.iter().any(|h| *h == host) {
        return Err("хост URL входа не из списка Twitch".into());
    }
    Ok(parsed.as_str().to_string())
}

pub async fn start_device(app: AppHandle, shared: Shared) -> Result<DeviceStart, AuthFail> {
    let client_id = env_secret("TWITCH_CLIENT_ID").ok_or_else(|| {
        AuthFail::config("Задайте TWITCH_CLIENT_ID в окружении (не YOUR_API_KEY_HERE)")
    })?;
    let gen = {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
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
        user_code: device.user_code,
        verification_uri: uri,
        expires_in,
    })
}

pub async fn logout(app: AppHandle, shared: Shared) -> Result<(), AuthFail> {
    let (path, gen) = {
        let mut inner = shared.auth.lock().map_err(|_| AuthFail::internal("lock"))?;
        inner.poll_gen = inner.poll_gen.wrapping_add(1);
        inner.pending_user_code = None;
        inner.disk = None;
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
        inner.disk = None;
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
                match validate_login(&client, &token).await {
                    Ok(login) => {
                        if persist_and_relogin(&app, &shared, job.gen, login, token).await {
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
    if let Err(e) = save_file(&path, &login, &token) {
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
        });
        inner.pending_user_code = None;
        inner.last_message = None;
    }
    request_relogin(shared).await;
    emit(app, shared);
    true
}

async fn verify_disk(app: AppHandle, shared: Shared) {
    if env_login_token().is_some() {
        return;
    }
    let token = match shared.auth.lock().ok().and_then(|inner| {
        inner.disk.as_ref().map(|c| c.token.clone())
    }) {
        Some(t) => t,
        None => return,
    };
    if validate_login(&http_client(), &token).await.is_err() {
        reject_session(app, shared, "сохранённый вход недействителен").await;
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
                        return Ok(login);
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
    Some(StoredCreds { login, token })
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

fn save_file(path: &Path, login: &str, token: &str) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("каталог конфигурации не задан".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&DiskFileOut { login, token }).map_err(|e| e.to_string())?;
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
        .user_agent("WebTV_chats/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_url_allowlist() {
        assert!(allowed_oauth_url("https://www.twitch.tv/activate").is_ok());
        assert!(allowed_oauth_url("https://id.twitch.tv/oauth2/device").is_ok());
        assert!(allowed_oauth_url("http://www.twitch.tv/activate").is_err());
        assert!(allowed_oauth_url("https://evil.example/activate").is_err());
        assert!(allowed_oauth_url("https://user:pass@www.twitch.tv/activate").is_err());
        assert!(allowed_oauth_url("https://www.twitch.tv.evil.com/activate").is_err());
        assert!(allowed_oauth_url("javascript:alert(1)").is_err());
        assert!(allowed_oauth_url("https://www.twitch.tv.attacker.com/").is_err());
    }
}
