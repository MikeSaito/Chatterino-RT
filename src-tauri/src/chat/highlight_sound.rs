//! Read/pick highlight sound files for WebView playback.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;

use super::commands::ApiError;
use super::state::Shared;

const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFile {
    pub mime: String,
    pub data: String,
}

pub fn path_from_settings(shared: &Shared) -> Result<String, ApiError> {
    let path = shared
        .settings
        .lock()
        .map_err(|_| ApiError::internal("lock"))?
        .data
        .knobs
        .get("highlighting.pathHighlightSound")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if path.is_empty() {
        return Err(ApiError::coded(
            "error.sound.path_unset",
            "sound path is not set",
        ));
    }
    Ok(path)
}

pub fn allowed_paths_from_settings(data: &super::settings::AppSettings) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Some(p) = data
        .knobs
        .get("highlighting.pathHighlightSound")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        set.insert(p.to_string());
    }
    if let Some(p) = data
        .knobs
        .get("notifications.notificationPathSound")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && !s.starts_with("qrc:"))
    {
        set.insert(p.to_string());
    }
    for row in &data.highlight_messages {
        let p = row.custom_sound.trim();
        if !p.is_empty() {
            set.insert(p.to_string());
        }
    }
    for row in &data.highlight_users {
        let p = row.custom_sound.trim();
        if !p.is_empty() {
            set.insert(p.to_string());
        }
    }
    for row in &data.highlight_badges {
        let p = row.custom_sound.trim();
        if !p.is_empty() {
            set.insert(p.to_string());
        }
    }
    set
}

pub fn rebuild_allowed_paths(shared: &Shared, data: &super::settings::AppSettings) {
    let set = allowed_paths_from_settings(data);
    if let Ok(mut slot) = shared.allowed_highlight_sounds.lock() {
        *slot = set;
    }
}

pub fn validate_sound_path(raw: &str) -> Result<(), ApiError> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(ApiError::coded(
            "error.path.absolute_file",
            "absolute file path required",
        ));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(ApiError::coded("error.path.invalid", "invalid path"));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "wav" | "ogg" | "mp3" => Ok(()),
        _ => Err(ApiError::coded(
            "error.sound.format",
            "format: wav, ogg, or mp3",
        )),
    }
}

fn path_allowed(shared: &Shared, path: &str, settings_path: Option<&str>) -> bool {
    if settings_path == Some(path) {
        return true;
    }
    if shared
        .pending_highlight_sound
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .as_deref()
        == Some(path)
    {
        return true;
    }
    shared
        .allowed_highlight_sounds
        .lock()
        .ok()
        .is_some_and(|set| set.contains(path))
}

pub fn read_configured(
    shared: &Shared,
    override_path: Option<String>,
) -> Result<SoundFile, ApiError> {
    let settings_path = shared.settings.lock().ok().and_then(|inner| {
        inner
            .data
            .knobs
            .get("highlighting.pathHighlightSound")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });
    let path = match override_path {
        Some(p) => {
            let p = p.trim().to_string();
            if p.is_empty() {
                return Err(ApiError::coded(
                    "error.sound.path_unset",
                    "sound path is not set",
                ));
            }
            let allowed = path_allowed(&shared, &p, settings_path.as_deref());
            if !allowed {
                return Err(ApiError::coded(
                    "error.sound.path_denied",
                    "sound path is not allowed",
                ));
            }
            p
        }
        None => settings_path
            .ok_or_else(|| ApiError::coded("error.sound.path_unset", "sound path is not set"))?,
    };
    read_path(&path)
}

pub fn pick_path(shared: &Shared) -> Result<String, ApiError> {
    let file = rfd::FileDialog::new()
        .add_filter("Audio", &["wav", "ogg", "mp3"])
        .set_title("Highlight sound")
        .pick_file()
        .ok_or_else(|| ApiError::coded("error.sound.file_not_chosen", "file not chosen"))?;
    let path = file
        .to_str()
        .ok_or_else(|| ApiError::coded("error.path.invalid", "invalid path"))?
        .to_string();
    let _ = read_path(&path)?;
    if let Ok(mut slot) = shared.pending_highlight_sound.lock() {
        *slot = Some(path.clone());
    }
    Ok(path)
}

pub fn read_path(raw: &str) -> Result<SoundFile, ApiError> {
    validate_sound_path(raw)?;
    let path = Path::new(raw);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        _ => {
            return Err(ApiError::coded(
                "error.sound.format",
                "format: wav, ogg, or mp3",
            ))
        }
    };
    let meta = fs::metadata(path)
        .map_err(|_| ApiError::coded("error.sound.file_missing", "file not found"))?;
    if !meta.is_file() {
        return Err(ApiError::coded("error.sound.not_a_file", "not a file"));
    }
    if meta.len() == 0 || meta.len() > MAX_BYTES {
        return Err(ApiError::coded(
            "error.sound.size",
            "file size: 1 byte – 2 MiB",
        ));
    }
    let bytes = fs::read(path).map_err(|e| ApiError::internal(&e.to_string()))?;
    Ok(SoundFile {
        mime: mime.into(),
        data: B64.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_relative_and_parent() {
        assert!(read_path("ping.wav").is_err());
        assert!(read_path(r"C:\foo\..\bar.wav").is_err());
    }

    #[test]
    fn reads_small_wav() {
        let dir = std::env::temp_dir().join(format!("hl-sound-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("t.wav");
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(b"RIFF....WAVEfmt ").unwrap();
        }
        let out = read_path(path.to_str().unwrap()).unwrap();
        assert_eq!(out.mime, "audio/wav");
        assert!(!out.data.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn table_custom_sound_allowed_after_rebuild() {
        use super::super::settings::{AppSettings, HighlightMessageRow};

        let dir = std::env::temp_dir().join(format!("hl-table-allow-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("row.wav");
        fs::write(&path, b"RIFF....WAVEfmt ").unwrap();
        let p = path.to_str().unwrap().to_string();

        let shared = Shared::new();
        let data = AppSettings {
            highlight_messages: vec![HighlightMessageRow {
                pattern: "pog".into(),
                show_in_mentions: false,
                flash_taskbar: false,
                regex: false,
                case_sensitive: false,
                play_sound: true,
                custom_sound: p.clone(),
                color: String::new(),
            }],
            ..AppSettings::default()
        };
        rebuild_allowed_paths(&shared, &data);
        assert!(read_configured(&shared, Some(p)).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn override_requires_pending_or_settings() {
        let shared = Shared::new();
        assert!(read_configured(&shared, Some(r"C:\nowhere\x.wav".into())).is_err());
        *shared.pending_highlight_sound.lock().unwrap() = Some(r"C:\tmp\a.wav".into());
        // Still fails: file missing, but path is allowed past gate — create temp
        let dir = std::env::temp_dir().join(format!("hl-sound-allow-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("ok.wav");
        fs::write(&path, b"RIFF....WAVEfmt ").unwrap();
        let p = path.to_str().unwrap().to_string();
        *shared.pending_highlight_sound.lock().unwrap() = Some(p.clone());
        assert!(read_configured(&shared, Some(p)).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}
