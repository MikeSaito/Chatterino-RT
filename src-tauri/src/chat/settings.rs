// Display settings for Chatterino RT. Logic inspired by Chatterino settings
// (MIT); no C++/Qt copied.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::commands::ApiError;
use super::state::Shared;

const SETTINGS_FILE: &str = "settings.json";
const MIN_SCALE: f64 = 0.5;
const MAX_SCALE: f64 = 4.0;
const DEFAULT_SCALE: f64 = 1.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySettings {
    #[serde(default = "default_scale")]
    pub font_scale: f64,
    #[serde(default = "default_true")]
    pub show_timestamps: bool,
    #[serde(default)]
    pub hide_moderated: bool,
}

fn default_scale() -> f64 {
    DEFAULT_SCALE
}

fn default_true() -> bool {
    true
}

impl Default for DisplaySettings {
    fn default() -> Self {
        Self {
            font_scale: DEFAULT_SCALE,
            show_timestamps: true,
            hide_moderated: false,
        }
    }
}

#[derive(Default)]
pub struct SettingsInner {
    pub path: PathBuf,
    pub data: DisplaySettings,
}

pub fn init(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(SETTINGS_FILE);
    let data = load_file(&path);
    let mut inner = shared.settings.lock().map_err(|e| e.to_string())?;
    inner.path = path;
    inner.data = data;
    Ok(())
}

pub fn snapshot(shared: &Shared) -> Result<DisplaySettings, ApiError> {
    shared
        .settings
        .lock()
        .map(|inner| inner.data.clone())
        .map_err(|_| ApiError::internal("lock"))
}

pub fn replace(shared: &Shared, incoming: DisplaySettings) -> Result<DisplaySettings, ApiError> {
    let clean = sanitize(incoming)?;
    let mut inner = shared.settings.lock().map_err(|_| ApiError::internal("lock"))?;
    if inner.path.as_os_str().is_empty() {
        return Err(ApiError::internal("каталог конфигурации не инициализирован"));
    }
    save_file(&inner.path, &clean).map_err(|e| ApiError::internal(&e))?;
    inner.data = clean.clone();
    Ok(clean)
}

pub fn sanitize(raw: DisplaySettings) -> Result<DisplaySettings, ApiError> {
    if !raw.font_scale.is_finite() {
        return Err(ApiError::invalid("масштаб шрифта: число"));
    }
    if raw.font_scale < MIN_SCALE || raw.font_scale > MAX_SCALE {
        return Err(ApiError::invalid(format!(
            "масштаб шрифта: {MIN_SCALE}–{MAX_SCALE}"
        )));
    }
    // Snap to hundredths to avoid float junk on disk.
    let scale = (raw.font_scale * 100.0).round() / 100.0;
    Ok(DisplaySettings {
        font_scale: scale.clamp(MIN_SCALE, MAX_SCALE),
        show_timestamps: raw.show_timestamps,
        hide_moderated: raw.hide_moderated,
    })
}

fn load_file(path: &Path) -> DisplaySettings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return DisplaySettings::default();
        }
        Err(e) => {
            eprintln!(
                "не удалось прочитать settings.json ({e}), используются значения по умолчанию"
            );
            return DisplaySettings::default();
        }
    };
    let parsed = match serde_json::from_str::<DisplaySettings>(&raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("settings.json повреждён ({e}), используются значения по умолчанию");
            return DisplaySettings::default();
        }
    };
    match sanitize(parsed) {
        Ok(clean) => clean,
        Err(e) => {
            eprintln!(
                "settings.json отклонён ({}), используются значения по умолчанию",
                e.message
            );
            DisplaySettings::default()
        }
    }
}

fn save_file(path: &Path, data: &DisplaySettings) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("settings path empty".into());
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
    fn sanitize_rejects_out_of_range() {
        assert!(sanitize(DisplaySettings {
            font_scale: 0.4,
            show_timestamps: true,
            hide_moderated: false,
        })
        .is_err());
        assert!(sanitize(DisplaySettings {
            font_scale: 4.5,
            show_timestamps: true,
            hide_moderated: false,
        })
        .is_err());
        assert!(sanitize(DisplaySettings {
            font_scale: f64::NAN,
            show_timestamps: true,
            hide_moderated: false,
        })
        .is_err());
    }

    #[test]
    fn replace_roundtrip() {
        let shared = Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner.path = std::env::temp_dir().join(format!(
                "webtv-settings-test-{}.json",
                std::process::id()
            ));
        }
        let saved = replace(
            &shared,
            DisplaySettings {
                font_scale: 1.25,
                show_timestamps: false,
                hide_moderated: true,
            },
        )
        .unwrap();
        assert_eq!(saved.font_scale, 1.25);
        assert!(!saved.show_timestamps);
        assert!(saved.hide_moderated);
        let snap = snapshot(&shared).unwrap();
        assert_eq!(snap, saved);
        let _ = fs::remove_file(&shared.settings.lock().unwrap().path);
    }
}
