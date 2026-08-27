//! Local user notes / color overrides (Chatterino UserDataController; MIT reimpl).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;

use super::state::Shared;

const USER_DATA_FILE: &str = "user-data.json";
const MAX_NOTES_LEN: usize = 20_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
}

impl UserEntry {
    fn is_empty(&self) -> bool {
        self.color.as_ref().map_or(true, |c| c.trim().is_empty()) && self.notes.trim().is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct UserDataFile {
    #[serde(default)]
    users: BTreeMap<String, UserEntry>,
}

#[derive(Debug, Default)]
pub struct UserDataStore {
    path: PathBuf,
    users: BTreeMap<String, UserEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserNotesResult {
    pub notes: String,
}

fn validate_user_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid user id".into());
    }
    Ok(id.to_string())
}

fn load_file(path: &Path) -> UserDataFile {
    if !path.exists() {
        return UserDataFile::default();
    }
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| {
            eprintln!("user-data.json повреждён, используются пустые данные");
            UserDataFile::default()
        }),
        Err(_) => UserDataFile::default(),
    }
}

fn save_file(path: &Path, data: &UserDataFile) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("user-data path empty".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn init(shared: &Shared) -> Result<(), String> {
    let settings = shared.settings.lock().map_err(|e| e.to_string())?;
    if settings.path.as_os_str().is_empty() {
        return Err("settings path unset".into());
    }
    let dir = settings
        .path
        .parent()
        .ok_or_else(|| "settings directory missing".to_string())?;
    let path = dir.join(USER_DATA_FILE);
    let file = load_file(&path);
    drop(settings);
    let mut store = shared.user_data.lock().map_err(|e| e.to_string())?;
    store.path = path;
    store.users = file.users;
    Ok(())
}

pub fn get_notes(shared: &Shared, user_id: &str) -> Result<String, String> {
    let id = validate_user_id(user_id)?;
    let store = shared.user_data.lock().map_err(|_| "lock".to_string())?;
    Ok(store
        .users
        .get(&id)
        .map(|e| e.notes.clone())
        .unwrap_or_default())
}

pub fn set_notes(shared: &Shared, user_id: &str, notes: &str) -> Result<(), String> {
    let id = validate_user_id(user_id)?;
    if notes.len() > MAX_NOTES_LEN {
        return Err("notes too long".into());
    }
    let cleaned = if notes.chars().all(|c| c.is_whitespace()) {
        String::new()
    } else {
        notes.to_string()
    };

    let mut store = shared.user_data.lock().map_err(|_| "lock".to_string())?;
    if store.path.as_os_str().is_empty() {
        return Err("user-data path unset".into());
    }

    let mut next = store.users.clone();
    let entry = next.entry(id.clone()).or_insert_with(UserEntry::default);
    entry.notes = cleaned;
    if let Some(c) = entry.color.as_mut() {
        let trimmed = c.trim().to_string();
        if trimmed.is_empty() {
            entry.color = None;
        } else {
            *c = trimmed;
        }
    }
    let empty = entry.is_empty();
    if empty {
        next.remove(&id);
    }

    let file = UserDataFile { users: next.clone() };
    save_file(&store.path, &file)?;
    store.users = next;
    Ok(())
}

/// Test helper: build store from JSON value without disk.
#[cfg(test)]
fn store_from_json(v: Value) -> BTreeMap<String, UserEntry> {
    serde_json::from_value::<UserDataFile>(v)
        .unwrap_or_default()
        .users
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_shared(dir: &Path) -> Shared {
        let shared = Shared::new();
        {
            let mut settings = shared.settings.lock().unwrap();
            settings.path = dir.join("settings.json");
        }
        init(&shared).unwrap();
        shared
    }

    #[test]
    fn validate_user_id_digits() {
        assert!(validate_user_id("123").is_ok());
        assert!(validate_user_id("").is_err());
        assert!(validate_user_id("abc").is_err());
    }

    #[test]
    fn roundtrip_notes() {
        let dir = std::env::temp_dir().join(format!(
            "crt-user-data-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let shared = temp_shared(&dir);
        set_notes(&shared, "42", "hello note").unwrap();
        assert_eq!(get_notes(&shared, "42").unwrap(), "hello note");
        let raw = fs::read_to_string(dir.join(USER_DATA_FILE)).unwrap();
        assert!(raw.contains("hello note"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whitespace_clears_notes() {
        let dir = std::env::temp_dir().join(format!(
            "crt-user-data-ws-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let shared = temp_shared(&dir);
        set_notes(&shared, "7", "keep").unwrap();
        set_notes(&shared, "7", "   \n\t  ").unwrap();
        assert_eq!(get_notes(&shared, "7").unwrap(), "");
        let store = shared.user_data.lock().unwrap();
        assert!(!store.users.contains_key("7"));
        drop(store);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preserve_color_when_clearing_notes() {
        let mut users: BTreeMap<String, UserEntry> = BTreeMap::new();
        users.insert(
            "9".into(),
            UserEntry {
                color: Some("#ff0000".into()),
                notes: "x".into(),
            },
        );
        let mut entry = users.get("9").unwrap().clone();
        entry.notes.clear();
        assert!(!entry.is_empty());
        assert_eq!(entry.color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn length_cap() {
        let dir = std::env::temp_dir().join(format!(
            "crt-user-data-cap-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let shared = temp_shared(&dir);
        let long = "a".repeat(MAX_NOTES_LEN + 1);
        assert!(set_notes(&shared, "1", &long).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_stock_shape() {
        let users = store_from_json(serde_json::json!({
            "users": {
                "123": { "notes": "hi", "color": "#fff" }
            }
        }));
        assert_eq!(users.get("123").unwrap().notes, "hi");
        assert_eq!(users.get("123").unwrap().color.as_deref(), Some("#fff"));
    }
}
