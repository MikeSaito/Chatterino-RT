use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::commands::ApiError;
use super::state::Shared;

const SESSION_FILE: &str = "session.json";
const MAX_RECENTS: usize = 30;
const MAX_OPEN: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub last_channel: Option<String>,
    #[serde(default)]
    pub recents: Vec<String>,
    #[serde(default)]
    pub open: Vec<String>,
}

#[derive(Default)]
pub struct SessionInner {
    pub path: PathBuf,
    pub data: Session,
}

pub fn init(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(SESSION_FILE);
    let data = load_file(&path);
    let mut inner = shared.session.lock().map_err(|e| e.to_string())?;
    inner.path = path;
    inner.data = data;
    Ok(())
}

pub fn snapshot(shared: &Shared) -> Result<Session, ApiError> {
    shared
        .session
        .lock()
        .map(|inner| inner.data.clone())
        .map_err(|_| ApiError::internal("lock"))
}

pub fn remember(shared: &Shared, normalized: String) -> Result<Session, ApiError> {
    if !valid_login(&normalized) {
        return Err(ApiError::invalid("имя канала: 1-25 символов [a-z0-9_]"));
    }
    let (path, data) = {
        let mut inner = shared.session.lock().map_err(|_| ApiError::internal("lock"))?;
        let list = &mut inner.data.recents;
        if let Some(pos) = list.iter().position(|c| c == &normalized) {
            list.remove(pos);
        }
        list.insert(0, normalized.clone());
        list.truncate(MAX_RECENTS);
        let open = &mut inner.data.open;
        if let Some(pos) = open.iter().position(|c| c == &normalized) {
            open.remove(pos);
        }
        open.insert(0, normalized.clone());
        open.truncate(MAX_OPEN);
        inner.data.last_channel = Some(normalized);
        (inner.path.clone(), inner.data.clone())
    };
    save_file(&path, &data).map_err(|e| ApiError::internal(&e))?;
    Ok(data)
}

pub fn forget_open(shared: &Shared, normalized: &str) -> Result<Session, ApiError> {
    let (path, data) = {
        let mut inner = shared.session.lock().map_err(|_| ApiError::internal("lock"))?;
        inner.data.open.retain(|c| c != normalized);
        if inner.data.last_channel.as_deref() == Some(normalized) {
            inner.data.last_channel = inner.data.open.first().cloned();
        }
        (inner.path.clone(), inner.data.clone())
    };
    save_file(&path, &data).map_err(|e| ApiError::internal(&e))?;
    Ok(data)
}

pub fn clear_last(shared: &Shared) -> Result<Session, ApiError> {
    let (path, data) = {
        let mut inner = shared.session.lock().map_err(|_| ApiError::internal("lock"))?;
        inner.data.last_channel = None;
        inner.data.open.clear();
        (inner.path.clone(), inner.data.clone())
    };
    save_file(&path, &data).map_err(|e| ApiError::internal(&e))?;
    Ok(data)
}

pub fn emit_rooms(app: &AppHandle, shared: &Shared, dropped: Option<String>) {
    let (active, open) = match shared.hub.lock() {
        Ok(hub) => (hub.active.clone(), hub.channels()),
        Err(_) => (None, Vec::new()),
    };
    let _ = app.emit(
        "chat:rooms",
        super::types::ChatRooms {
            active,
            open,
            dropped,
        },
    );
}

fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 25
        && login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn load_file(path: &Path) -> Session {
    let Ok(raw) = fs::read_to_string(path) else {
        return Session::default();
    };
    let Ok(mut session) = serde_json::from_str::<Session>(&raw) else {
        return Session::default();
    };
    session.recents = session
        .recents
        .into_iter()
        .filter(|c| valid_login(c))
        .collect();
    session.recents.truncate(MAX_RECENTS);
    session.open = session
        .open
        .into_iter()
        .filter(|c| valid_login(c))
        .collect();
    session.open.truncate(MAX_OPEN);
    if let Some(last) = session.last_channel.take() {
        session.last_channel = valid_login(&last).then_some(last);
    }
    if session.last_channel.is_none() {
        session.last_channel = session.open.first().cloned();
    }
    session
}

fn save_file(path: &Path, data: &Session) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("session path empty".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::state::Shared;

    #[test]
    fn remember_orders_and_caps() {
        let shared = Shared::new();
        {
            let mut inner = shared.session.lock().unwrap();
            inner.path = std::env::temp_dir().join(format!(
                "webtv-session-test-{}.json",
                std::process::id()
            ));
        }
        for i in 0..35 {
            remember(&shared, format!("u{i}")).unwrap();
        }
        let snap = snapshot(&shared).unwrap();
        assert_eq!(snap.recents.len(), MAX_RECENTS);
        assert_eq!(snap.recents[0], "u34");
        assert_eq!(snap.last_channel.as_deref(), Some("u34"));
        assert!(snap.open.len() <= MAX_OPEN);
        assert!(snap.open.contains(&"u34".to_string()));
        forget_open(&shared, "u34").unwrap();
        let snap2 = snapshot(&shared).unwrap();
        assert!(!snap2.open.contains(&"u34".to_string()));
        let _ = fs::remove_file(&shared.session.lock().unwrap().path);
    }
}
