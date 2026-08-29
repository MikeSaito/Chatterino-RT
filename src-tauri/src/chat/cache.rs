//! Disk cache directory (Chatterino Paths::cacheDirectory; reimplementation, not a port).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::commands::ApiError;
use super::state::Shared;

pub const CACHE_PATH_KNOB: &str = "cache.path";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub path: String,
    pub is_custom: bool,
}

pub fn custom_path_from_knobs(knobs: &BTreeMap<String, Value>) -> String {
    knobs
        .get(CACHE_PATH_KNOB)
        .and_then(|v| match v {
            Value::String(s) => Some(s.as_str()),
            _ => None,
        })
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn default_cache_dir(app: &AppHandle) -> Result<PathBuf, ApiError> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| ApiError::internal(&e.to_string()))?;
    fs::create_dir_all(&dir).map_err(|e| ApiError::internal(&e.to_string()))?;
    Ok(dir)
}

/// Empty custom → default. Non-empty must be absolute without `..`.
pub fn resolve_cache_dir(default_dir: &Path, custom: &str) -> Result<PathBuf, ApiError> {
    let trimmed = custom.trim();
    if trimmed.is_empty() {
        return Ok(default_dir.to_path_buf());
    }
    validate_absolute_dir_path(trimmed)?;
    Ok(PathBuf::from(trimmed))
}

pub fn validate_absolute_dir_path(path: &str) -> Result<(), ApiError> {
    if path.trim().is_empty() {
        return Err(ApiError::coded("error.path.invalid", "invalid path"));
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(ApiError::coded("error.path.absolute", "absolute path required"));
    }
    for c in p.components() {
        if matches!(c, Component::ParentDir) {
            return Err(ApiError::coded("error.path.invalid", "invalid path"));
        }
    }
    Ok(())
}

fn canon_existing_or_create(path: &Path) -> Result<PathBuf, ApiError> {
    fs::create_dir_all(path).map_err(|e| ApiError::internal(&e.to_string()))?;
    fs::canonicalize(path).map_err(|e| ApiError::internal(&e.to_string()))
}

/// Wipe only if resolved equals default cache or the configured custom path.
pub fn clear_allowed(resolved: &Path, default_dir: &Path, custom: &str) -> Result<bool, ApiError> {
    let resolved_c = canon_existing_or_create(resolved)?;
    let default_c = canon_existing_or_create(default_dir)?;
    if resolved_c == default_c {
        return Ok(true);
    }
    let trimmed = custom.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    validate_absolute_dir_path(trimmed)?;
    let custom_c = canon_existing_or_create(Path::new(trimmed))?;
    Ok(resolved_c == custom_c)
}

pub fn clear_cache_dir(resolved: &Path, default_dir: &Path, custom: &str) -> Result<(), ApiError> {
    if !clear_allowed(resolved, default_dir, custom)? {
        return Err(ApiError::coded("error.cache.clear_forbidden", "clearing this directory is not allowed"));
    }
    let resolved_c = canon_existing_or_create(resolved)?;
    fs::remove_dir_all(&resolved_c).map_err(|e| ApiError::internal(&e.to_string()))?;
    fs::create_dir_all(&resolved_c).map_err(|e| ApiError::internal(&e.to_string()))?;
    Ok(())
}

pub fn info(app: &AppHandle, shared: &Shared) -> Result<CacheInfo, ApiError> {
    let default_dir = default_cache_dir(app)?;
    let knobs = {
        let guard = shared
            .settings
            .lock()
            .map_err(|_| ApiError::internal("settings lock"))?;
        guard.data.knobs.clone()
    };
    let custom = custom_path_from_knobs(&knobs);
    let resolved = resolve_cache_dir(&default_dir, &custom)?;
    fs::create_dir_all(&resolved).map_err(|e| ApiError::internal(&e.to_string()))?;
    Ok(CacheInfo {
        path: resolved.to_string_lossy().into_owned(),
        is_custom: !custom.is_empty(),
    })
}

pub fn pick_directory() -> Result<String, ApiError> {
    let dir = rfd::FileDialog::new()
        .set_title("Select cache directory")
        .pick_folder()
        .ok_or_else(|| ApiError::coded("error.path.dir_not_chosen", "directory not chosen"))?;
    let path = dir
        .to_str()
        .ok_or_else(|| ApiError::coded("error.path.invalid", "invalid path"))?
        .to_string();
    validate_absolute_dir_path(&path)?;
    Ok(path)
}

pub fn clear(app: &AppHandle, shared: &Shared) -> Result<(), ApiError> {
    let default_dir = default_cache_dir(app)?;
    let knobs = {
        let guard = shared
            .settings
            .lock()
            .map_err(|_| ApiError::internal("settings lock"))?;
        guard.data.knobs.clone()
    };
    let custom = custom_path_from_knobs(&knobs);
    let resolved = resolve_cache_dir(&default_dir, &custom)?;
    // Never wipe the settings / app config directory even if misconfigured as custom.
    if let Ok(config_dir) = app.path().app_config_dir() {
        if let (Ok(resolved_c), Ok(config_c)) = (
            canon_existing_or_create(&resolved),
            canon_existing_or_create(&config_dir),
        ) {
            if resolved_c == config_c {
                return Err(ApiError::coded("error.cache.clear_settings_forbidden", "clearing the settings directory is not allowed"));
            }
        }
    }
    clear_cache_dir(&resolved, &default_dir, &custom)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("chrt-cache-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_empty_uses_default() {
        let def = PathBuf::from("/tmp/app-cache");
        let got = resolve_cache_dir(&def, "").unwrap();
        assert_eq!(got, def);
        let got2 = resolve_cache_dir(&def, "  ").unwrap();
        assert_eq!(got2, def);
    }

    #[test]
    fn resolve_custom_absolute() {
        let def = PathBuf::from("/tmp/app-cache");
        #[cfg(windows)]
        let custom = r"D:\Cache\Emotes";
        #[cfg(not(windows))]
        let custom = "/var/cache/chrt";
        let got = resolve_cache_dir(&def, custom).unwrap();
        assert_eq!(got, PathBuf::from(custom));
    }

    #[test]
    fn reject_relative_and_parent() {
        let def = PathBuf::from("/tmp/app-cache");
        assert!(resolve_cache_dir(&def, "relative").is_err());
        #[cfg(windows)]
        {
            assert!(resolve_cache_dir(&def, r"D:\Cache\..\Evil").is_err());
        }
        #[cfg(not(windows))]
        {
            assert!(resolve_cache_dir(&def, "/tmp/../etc").is_err());
        }
    }

    #[test]
    fn clear_allowed_default_and_custom() {
        let default_dir = tmp_dir("default");
        let custom_dir = tmp_dir("custom");
        let custom = custom_dir.to_string_lossy().into_owned();

        assert!(clear_allowed(&default_dir, &default_dir, "").unwrap());
        assert!(clear_allowed(&custom_dir, &default_dir, &custom).unwrap());

        let other = tmp_dir("other");
        assert!(!clear_allowed(&other, &default_dir, &custom).unwrap());
        assert!(!clear_allowed(&other, &default_dir, "").unwrap());

        let _ = fs::remove_dir_all(&default_dir);
        let _ = fs::remove_dir_all(&custom_dir);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn clear_wipes_and_recreates() {
        let default_dir = tmp_dir("wipe-default");
        let marker = default_dir.join("file.bin");
        fs::write(&marker, b"x").unwrap();
        assert!(marker.exists());
        clear_cache_dir(&default_dir, &default_dir, "").unwrap();
        assert!(default_dir.is_dir());
        assert!(!marker.exists());
        let _ = fs::remove_dir_all(&default_dir);
    }
}
