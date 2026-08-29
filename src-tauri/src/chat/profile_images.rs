//! Disk map login → Helix profile_image_url (CDN). Bytes stay on CDN for WebView img-src.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::auth;
use super::helix::{self, allowed_profile_image_url};
use super::state::Shared;

const FILE: &str = "profile-images.json";

#[derive(Default, Clone, Serialize, Deserialize)]
struct Store {
    /// login (lowercase) → allowed https CDN url
    urls: HashMap<String, String>,
}

struct Cache {
    path: PathBuf,
    store: Store,
}

static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();

#[derive(Clone, Serialize)]
pub struct ProfileImageEvent {
    pub login: String,
    pub url: String,
}

fn cache_slot() -> &'static Mutex<Option<Cache>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

fn ensure_loaded(app: &AppHandle) -> Result<(), ()> {
    let mut guard = cache_slot().lock().map_err(|_| ())?;
    if guard.is_some() {
        return Ok(());
    }
    let dir = app.path().app_config_dir().map_err(|_| ())?;
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(FILE);
    let store = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    *guard = Some(Cache { path, store });
    Ok(())
}

fn persist(cache: &Cache) {
    if let Ok(raw) = serde_json::to_string_pretty(&cache.store) {
        let tmp = cache.path.with_extension("json.tmp");
        if fs::write(&tmp, &raw).is_ok() {
            let _ = fs::rename(&tmp, &cache.path);
        }
    }
}

pub fn get(app: &AppHandle, login: &str) -> Option<String> {
    let key = login.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    let _ = ensure_loaded(app);
    let guard = cache_slot().lock().ok()?;
    let cache = guard.as_ref()?;
    cache
        .store
        .urls
        .get(&key)
        .cloned()
        .and_then(|u| allowed_profile_image_url(&u))
}

pub fn put(app: &AppHandle, login: &str, url: &str) -> bool {
    let Some(allowed) = allowed_profile_image_url(url) else {
        return false;
    };
    let key = login.trim().to_ascii_lowercase();
    if key.is_empty() {
        return false;
    }
    if ensure_loaded(app).is_err() {
        return false;
    }
    let Ok(mut guard) = cache_slot().lock() else {
        return false;
    };
    let Some(cache) = guard.as_mut() else {
        return false;
    };
    if cache.store.urls.get(&key) == Some(&allowed) {
        return false;
    }
    cache.store.urls.insert(key, allowed);
    persist(cache);
    true
}

fn emit_updated(app: &AppHandle, shared: &Shared, login: &str, url: &str) {
    let _ = app.emit(
        "chat:profile_image",
        ProfileImageEvent {
            login: login.to_string(),
            url: url.to_string(),
        },
    );
    if auth::resolved_login_token(shared).map(|(l, _)| l) == Some(login.to_string()) {
        let _ = app.emit("chat:auth", auth::snapshot(app, shared));
    }
}

/// Refresh CDN url for an auth-account login (uses that account's token).
pub fn spawn_refresh(app: AppHandle, shared: Shared, login: String) {
    tauri::async_runtime::spawn(async move {
        let login = login.trim().to_ascii_lowercase();
        if login.is_empty() {
            return;
        }
        let Some((tok_login, token)) = auth::resolved_login_token(&shared) else {
            return;
        };
        let (token, client_id) = if tok_login == login {
            (token, auth::resolved_client_id(&shared))
        } else {
            let Ok(inner) = shared.auth.lock() else {
                return;
            };
            let Some(creds) = inner.accounts.iter().find(|c| c.login == login) else {
                return;
            };
            (creds.token.clone(), creds.client_id.clone())
        };
        let Some(profile) = helix::fetch_user_profile(&login, Some(&token), &client_id).await
        else {
            return;
        };
        let Some(url) = profile.profile_image_url.as_deref() else {
            return;
        };
        if put(&app, &login, url) {
            emit_updated(&app, &shared, &login, url);
        }
    });
}

/// Refresh CDN url for any login via the current session OAuth token.
pub fn spawn_refresh_login(app: AppHandle, shared: Shared, login: String) {
    tauri::async_runtime::spawn(async move {
        let login = login.trim().to_ascii_lowercase();
        if login.is_empty() {
            return;
        }
        let Some(token) = auth::oauth_token(&shared) else {
            return;
        };
        let client_id = auth::resolved_client_id(&shared);
        let Some(profile) = helix::fetch_user_profile(&login, Some(&token), &client_id).await
        else {
            return;
        };
        let Some(url) = profile.profile_image_url.as_deref() else {
            return;
        };
        if put(&app, &login, url) {
            emit_updated(&app, &shared, &login, url);
        }
    });
}

pub fn spawn_refresh_current(app: AppHandle, shared: Shared) {
    let login = auth::resolved_login_token(&shared).map(|(l, _)| l);
    if let Some(login) = login {
        spawn_refresh(app, shared, login);
    }
}
