//! Application settings for Chatterino RT.
//! Structure and defaults inspired by Chatterino Settings (MIT); no C++/Qt copied.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::commands::ApiError;
use super::state::Shared;

const SETTINGS_FILE: &str = "settings.json";
const MIN_SCALE: f64 = 0.5;
const MAX_SCALE: f64 = 4.0;
const DEFAULT_SCALE: f64 = 1.0;
const MAX_KNOBS: usize = 512;
const MAX_KNOB_KEY: usize = 120;
const MAX_TABLE_ROWS: usize = 500;
const MAX_CELL: usize = 2000;

const HOTKEY_ACTIONS: &[&str] = &[
    "showSearch",
    "openSettings",
    "openEmotesPopup",
    "scrollToBottom",
    "zoomIn",
    "zoomOut",
    "zoomReset",
];

fn default_scale() -> f64 {
    DEFAULT_SCALE
}

fn default_true() -> bool {
    true
}

fn default_timestamp_format() -> String {
    "hh:mm".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NicknameRow {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub nickname: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRow {
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub show_in_message_menu: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighlightMessageRow {
    #[serde(default)]
    pub pattern: String,
    #[serde(default = "default_true")]
    pub show_in_mentions: bool,
    #[serde(default)]
    pub flash_taskbar: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub play_sound: bool,
    #[serde(default)]
    pub custom_sound: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighlightUserRow {
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_true")]
    pub show_in_mentions: bool,
    #[serde(default)]
    pub flash_taskbar: bool,
    #[serde(default)]
    pub play_sound: bool,
    #[serde(default)]
    pub custom_sound: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighlightBadgeRow {
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub show_in_mentions: bool,
    #[serde(default)]
    pub flash_taskbar: bool,
    #[serde(default)]
    pub play_sound: bool,
    #[serde(default)]
    pub custom_sound: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighlightBlacklistRow {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub regex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreMessageRow {
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_true")]
    pub block: bool,
    #[serde(default)]
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterRow {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub filter: String,
    #[serde(default = "default_true")]
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyRow {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub keybinding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModActionRow {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRow {
    #[serde(default)]
    pub channel: String,
}

/// Full app settings (Chatterino Settings dialog parity).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_scale")]
    pub font_scale: f64,
    #[serde(default = "default_true")]
    pub show_timestamps: bool,
    #[serde(default)]
    pub hide_moderated: bool,
    #[serde(default = "default_timestamp_format")]
    pub timestamp_format: String,
    /// Free-form knobs keyed by path (appearance.*, behaviour.*, …).
    #[serde(default)]
    pub knobs: BTreeMap<String, Value>,
    #[serde(default)]
    pub nicknames: Vec<NicknameRow>,
    #[serde(default)]
    pub commands: Vec<CommandRow>,
    #[serde(default)]
    pub highlight_messages: Vec<HighlightMessageRow>,
    #[serde(default)]
    pub highlight_users: Vec<HighlightUserRow>,
    #[serde(default)]
    pub highlight_badges: Vec<HighlightBadgeRow>,
    #[serde(default)]
    pub highlight_blacklist: Vec<HighlightBlacklistRow>,
    #[serde(default)]
    pub ignore_messages: Vec<IgnoreMessageRow>,
    #[serde(default)]
    pub ignore_users: Vec<HighlightBlacklistRow>,
    #[serde(default)]
    pub filters: Vec<FilterRow>,
    #[serde(default)]
    pub hotkeys: Vec<HotkeyRow>,
    #[serde(default)]
    pub mod_actions: Vec<ModActionRow>,
    #[serde(default)]
    pub log_channels: Vec<ChannelRow>,
    #[serde(default)]
    pub notify_channels: Vec<ChannelRow>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_scale: DEFAULT_SCALE,
            show_timestamps: true,
            hide_moderated: false,
            timestamp_format: default_timestamp_format(),
            knobs: BTreeMap::new(),
            nicknames: Vec::new(),
            commands: Vec::new(),
            highlight_messages: Vec::new(),
            highlight_users: Vec::new(),
            highlight_badges: Vec::new(),
            highlight_blacklist: Vec::new(),
            ignore_messages: Vec::new(),
            ignore_users: Vec::new(),
            filters: Vec::new(),
            hotkeys: Vec::new(),
            mod_actions: Vec::new(),
            log_channels: Vec::new(),
            notify_channels: Vec::new(),
        }
    }
}

/// Legacy command alias; same as AppSettings.
pub type DisplaySettings = AppSettings;

/// Legacy three-field payload still accepted on load.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDisplay {
    #[serde(default = "default_scale")]
    font_scale: f64,
    #[serde(default = "default_true")]
    show_timestamps: bool,
    #[serde(default)]
    hide_moderated: bool,
}

#[derive(Default)]
pub struct SettingsInner {
    pub path: PathBuf,
    pub data: AppSettings,
}

pub fn init(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(SETTINGS_FILE);
    let data = load_file(&path);
    let mut inner = shared.settings.lock().map_err(|e| e.to_string())?;
    inner.path = path;
    inner.data = data;
    let ctx = super::filters::HighlightSoundCtx::from_settings(&inner.data);
    if let Ok(mut slot) = shared.highlight_sound.lock() {
        *slot = ctx;
    }
    let ignore_rules = super::filters::ignore_block_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.ignore_block_rules.lock() {
        *slot = ignore_rules;
    }
    let ignore_replaces = super::filters::ignore_replace_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.ignore_replace_rules.lock() {
        *slot = ignore_replaces;
    }
    let ignore_users = super::filters::ignore_user_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.ignore_user_rules.lock() {
        *slot = ignore_users;
    }
    let blacklist = super::filters::blacklist_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.highlight_blacklist.lock() {
        *slot = blacklist;
    }
    super::highlight_sound::rebuild_allowed_paths(shared, &inner.data);
    Ok(())
}

pub fn snapshot(shared: &Shared) -> Result<AppSettings, ApiError> {
    shared
        .settings
        .lock()
        .map(|inner| inner.data.clone())
        .map_err(|_| ApiError::internal("lock"))
}

pub fn replace(shared: &Shared, incoming: AppSettings) -> Result<AppSettings, ApiError> {
    let clean = sanitize(incoming)?;
    let mut inner = shared.settings.lock().map_err(|_| ApiError::internal("lock"))?;
    if inner.path.as_os_str().is_empty() {
        return Err(ApiError::internal("каталог конфигурации не инициализирован"));
    }
    let prev_flags = super::fetch::EmoteProviderFlags::from_knobs(&inner.data.knobs);
    let prev_stv_channel_need =
        super::eventapi::seventv_event_channel_needed_from_knobs(&inner.data.knobs);
    save_file(&inner.path, &clean).map_err(|e| ApiError::internal(&e))?;
    inner.data = clean.clone();
    let ctx = super::filters::HighlightSoundCtx::from_settings(&inner.data);
    if let Ok(mut slot) = shared.highlight_sound.lock() {
        *slot = ctx;
    }
    let ignore_rules = super::filters::ignore_block_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.ignore_block_rules.lock() {
        *slot = ignore_rules;
    }
    let ignore_replaces = super::filters::ignore_replace_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.ignore_replace_rules.lock() {
        *slot = ignore_replaces;
    }
    let ignore_users = super::filters::ignore_user_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.ignore_user_rules.lock() {
        *slot = ignore_users;
    }
    let blacklist = super::filters::blacklist_rules_from_settings(&inner.data);
    if let Ok(mut slot) = shared.highlight_blacklist.lock() {
        *slot = blacklist;
    }
    super::highlight_sound::rebuild_allowed_paths(shared, &clean);
    if let Ok(mut pending) = shared.pending_highlight_sound.lock() {
        if pending
            .as_deref()
            .is_some_and(|p| shared.allowed_highlight_sounds.lock().ok().is_some_and(|set| set.contains(p)))
        {
            *pending = None;
        }
    }
    drop(inner);
    let flags = super::fetch::EmoteProviderFlags::from_knobs(&clean.knobs);
    let bttv_live = super::bttv_live::bttv_live_enabled_from_knobs(&clean.knobs);
    shared.notify_bttv(super::state::BttvCmd::SetEnabled(bttv_live));
    shared.notify_event(super::state::EventCmd::SetEnabled(flags.seventv_event_api));
    let new_stv_channel_need =
        super::eventapi::seventv_event_channel_needed_from_knobs(&clean.knobs);
    if prev_stv_channel_need != new_stv_channel_need {
        super::eventapi::spawn_event_channel_resync(shared.clone());
    }
    if prev_flags.catalog_reload_key() != flags.catalog_reload_key() {
        spawn_emote_catalog_reload(shared);
    }
    Ok(clean)
}

fn spawn_emote_catalog_reload(shared: &Shared) {
    let shared = shared.clone();
    tauri::async_runtime::spawn(async move {
        let flags = super::fetch::EmoteProviderFlags::from_shared(&shared);
        let Ok(set_id) = super::fetch::load_globals(&shared.catalog, flags).await else {
            return;
        };
        if flags.seventv_global {
            if let Some(set_id) = set_id {
                shared.notify_event(super::state::EventCmd::SetGlobal { set_id });
            }
        } else {
            shared.notify_event(super::state::EventCmd::ClearGlobal);
        }
        let active = shared
            .hub
            .lock()
            .ok()
            .and_then(|h| h.active.clone());
        let Some(login) = active else {
            return;
        };
        let room_id = super::eventapi::resolve_twitch_room_id(&shared, &login);
        let Some(room_id) = room_id else {
            if let Ok(mut cat) = shared.catalog.lock() {
                if !flags.bttv_channel {
                    cat.purge_channel(&login, "bttv");
                }
                if !flags.ffz_channel {
                    cat.purge_channel(&login, "ffz");
                }
                if !flags.seventv_channel {
                    cat.purge_channel(&login, "7tv");
                }
            }
            if !super::eventapi::seventv_event_channel_needed(&shared) {
                shared.notify_event(super::state::EventCmd::ClearChannel);
            }
            return;
        };
        let token = super::auth::oauth_token(&shared);
        let client_id = super::auth::resolved_client_id(&shared);
        let stv = super::fetch::load_channel(
            &shared.catalog,
            &shared.badges,
            &shared.cheers,
            &shared.hub,
            &login,
            &room_id,
            token.as_deref(),
            &client_id,
            flags,
        )
        .await;
        let still = shared
            .hub
            .lock()
            .ok()
            .and_then(|h| h.active.clone())
            .is_some_and(|ch| ch == login);
        if !still {
            return;
        }
        if super::eventapi::seventv_event_channel_needed(&shared) {
            let flags = super::fetch::EmoteProviderFlags::from_shared(&shared);
            let (set_id, user_id) = if flags.seventv_channel {
                stv.unwrap_or_default()
            } else {
                (String::new(), String::new())
            };
            shared.notify_event(super::state::EventCmd::SetChannel {
                login,
                room_id,
                set_id,
                user_id,
            });
        } else {
            shared.notify_event(super::state::EventCmd::ClearChannel);
        }
    });
}

pub fn sanitize(mut raw: AppSettings) -> Result<AppSettings, ApiError> {
    if !raw.font_scale.is_finite() {
        return Err(ApiError::invalid("масштаб шрифта: число"));
    }
    if raw.font_scale < MIN_SCALE || raw.font_scale > MAX_SCALE {
        return Err(ApiError::invalid(format!(
            "масштаб шрифта: {MIN_SCALE}–{MAX_SCALE}"
        )));
    }
    raw.font_scale = ((raw.font_scale * 100.0).round() / 100.0).clamp(MIN_SCALE, MAX_SCALE);

    let fmt = raw.timestamp_format.trim();
    const ALLOWED_FMT: &[&str] = &[
        "Disable",
        "h:mm",
        "hh:mm",
        "h:mm a",
        "hh:mm a",
        "h:mm:ss",
        "hh:mm:ss",
        "h:mm:ss a",
        "hh:mm:ss a",
        "h:mm:ss.zzz",
        "h:mm:ss.zzz a",
        "hh:mm:ss.zzz",
        "hh:mm:ss.zzz a",
    ];
    let fmt_owned = fmt.to_string();
    if !ALLOWED_FMT.iter().any(|a| *a == fmt_owned.as_str()) {
        return Err(ApiError::invalid("формат времени сообщений"));
    }
    raw.show_timestamps = fmt_owned != "Disable";
    raw.timestamp_format = fmt_owned;

    if raw.knobs.len() > MAX_KNOBS {
        return Err(ApiError::invalid("слишком много настроек"));
    }
    let mut clean_knobs = BTreeMap::new();
    for (key, value) in raw.knobs {
        if key.is_empty() || key.len() > MAX_KNOB_KEY || key.contains('\0') {
            return Err(ApiError::invalid("ключ настройки"));
        }
        if !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '/')
        {
            return Err(ApiError::invalid(format!("ключ настройки: {key}")));
        }
        match &value {
            Value::Bool(_) | Value::Null => {}
            Value::Number(n) => {
                if !n.is_f64() && !n.is_i64() && !n.is_u64() {
                    return Err(ApiError::invalid("число настройки"));
                }
            }
            Value::String(s) => {
                if s.len() > MAX_CELL || s.contains('\0') {
                    return Err(ApiError::invalid("строка настройки"));
                }
            }
            _ => return Err(ApiError::invalid("тип настройки")),
        }
        clean_knobs.insert(key, value);
    }
    raw.knobs = clean_knobs;

    fn trim_cell(s: &mut String) -> Result<(), ApiError> {
        if s.len() > MAX_CELL || s.contains('\0') {
            return Err(ApiError::invalid("ячейка таблицы"));
        }
        *s = s.trim().to_string();
        Ok(())
    }

    fn validate_sound_cell(s: &str) -> Result<(), ApiError> {
        if s.is_empty() {
            return Ok(());
        }
        super::highlight_sound::validate_sound_path(s)
    }

    if raw.nicknames.len() > MAX_TABLE_ROWS
        || raw.commands.len() > MAX_TABLE_ROWS
        || raw.highlight_messages.len() > MAX_TABLE_ROWS
        || raw.highlight_users.len() > MAX_TABLE_ROWS
        || raw.highlight_badges.len() > MAX_TABLE_ROWS
        || raw.highlight_blacklist.len() > MAX_TABLE_ROWS
        || raw.ignore_messages.len() > MAX_TABLE_ROWS
        || raw.ignore_users.len() > MAX_TABLE_ROWS
        || raw.filters.len() > MAX_TABLE_ROWS
        || raw.hotkeys.len() > MAX_TABLE_ROWS
        || raw.mod_actions.len() > MAX_TABLE_ROWS
        || raw.log_channels.len() > MAX_TABLE_ROWS
        || raw.notify_channels.len() > MAX_TABLE_ROWS
    {
        return Err(ApiError::invalid("слишком много строк таблицы"));
    }

    for row in &mut raw.nicknames {
        trim_cell(&mut row.username)?;
        trim_cell(&mut row.nickname)?;
    }
    for row in &mut raw.commands {
        trim_cell(&mut row.trigger)?;
        trim_cell(&mut row.command)?;
    }
    for row in &mut raw.highlight_messages {
        trim_cell(&mut row.pattern)?;
        trim_cell(&mut row.custom_sound)?;
        validate_sound_cell(&row.custom_sound)?;
        trim_cell(&mut row.color)?;
    }
    for row in &mut raw.highlight_users {
        trim_cell(&mut row.username)?;
        trim_cell(&mut row.custom_sound)?;
        validate_sound_cell(&row.custom_sound)?;
        trim_cell(&mut row.color)?;
    }
    for row in &mut raw.highlight_badges {
        trim_cell(&mut row.name)?;
        trim_cell(&mut row.custom_sound)?;
        validate_sound_cell(&row.custom_sound)?;
        trim_cell(&mut row.color)?;
    }
    for row in &mut raw.highlight_blacklist {
        trim_cell(&mut row.username)?;
    }
    for row in &mut raw.ignore_messages {
        trim_cell(&mut row.pattern)?;
        trim_cell(&mut row.replacement)?;
    }
    for row in &mut raw.ignore_users {
        trim_cell(&mut row.username)?;
    }
    for row in &mut raw.filters {
        trim_cell(&mut row.name)?;
        trim_cell(&mut row.filter)?;
    }
    for row in &mut raw.hotkeys {
        trim_cell(&mut row.action)?;
        trim_cell(&mut row.name)?;
        trim_cell(&mut row.keybinding)?;
        if !HOTKEY_ACTIONS.contains(&row.action.as_str()) {
            return Err(ApiError::invalid("invalid hotkey action"));
        }
        if row.keybinding.is_empty() || row.keybinding.len() > 64 {
            return Err(ApiError::invalid("invalid hotkey keybinding"));
        }
    }
    for row in &mut raw.mod_actions {
        trim_cell(&mut row.action)?;
        trim_cell(&mut row.icon)?;
    }
    for row in &mut raw.log_channels {
        trim_cell(&mut row.channel)?;
    }
    for row in &mut raw.notify_channels {
        trim_cell(&mut row.channel)?;
    }

    if let Some(Value::String(path)) = raw.knobs.get("highlighting.pathHighlightSound") {
        validate_sound_cell(path)?;
    }

    Ok(raw)
}

fn load_file(path: &Path) -> AppSettings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return AppSettings::default();
        }
        Err(e) => {
            eprintln!(
                "не удалось прочитать settings.json ({e}), используются значения по умолчанию"
            );
            return AppSettings::default();
        }
    };

    // Legacy DisplaySettings-only files (no timestampFormat / knobs).
    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
        let is_legacy = value.get("timestampFormat").is_none()
            && value.get("knobs").is_none()
            && value.get("nicknames").is_none();
        if is_legacy {
            if let Ok(legacy) = serde_json::from_value::<LegacyDisplay>(value) {
                let mut migrated = AppSettings::default();
                migrated.font_scale = legacy.font_scale;
                migrated.show_timestamps = legacy.show_timestamps;
                migrated.hide_moderated = legacy.hide_moderated;
                migrated.timestamp_format = if legacy.show_timestamps {
                    "hh:mm".into()
                } else {
                    "Disable".into()
                };
                return match sanitize(migrated) {
                    Ok(clean) => clean,
                    Err(_) => AppSettings::default(),
                };
            }
        }
    }

    if let Ok(parsed) = serde_json::from_str::<AppSettings>(&raw) {
        return match sanitize(parsed) {
            Ok(clean) => clean,
            Err(e) => {
                eprintln!(
                    "settings.json отклонён ({}), используются значения по умолчанию",
                    e.message
                );
                AppSettings::default()
            }
        };
    }
    eprintln!("settings.json повреждён, используются значения по умолчанию");
    AppSettings::default()
}

fn save_file(path: &Path, data: &AppSettings) -> Result<(), String> {
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

    #[test]
    fn sanitize_rejects_out_of_range() {
        assert!(sanitize(AppSettings {
            font_scale: 0.4,
            ..AppSettings::default()
        })
        .is_err());
        assert!(sanitize(AppSettings {
            font_scale: 4.5,
            ..AppSettings::default()
        })
        .is_err());
        assert!(sanitize(AppSettings {
            font_scale: f64::NAN,
            ..AppSettings::default()
        })
        .is_err());
    }

    #[test]
    fn sanitize_sets_show_timestamps_from_format() {
        let off = sanitize(AppSettings {
            timestamp_format: "Disable".into(),
            show_timestamps: true,
            ..AppSettings::default()
        })
        .unwrap();
        assert!(!off.show_timestamps);
        let on = sanitize(AppSettings {
            timestamp_format: "hh:mm".into(),
            show_timestamps: false,
            ..AppSettings::default()
        })
        .unwrap();
        assert!(on.show_timestamps);
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
            AppSettings {
                font_scale: 1.25,
                show_timestamps: false,
                hide_moderated: true,
                timestamp_format: "Disable".into(),
                ..AppSettings::default()
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

    #[test]
    fn migrates_legacy_display_json() {
        let path = std::env::temp_dir().join(format!(
            "webtv-settings-legacy-{}.json",
            std::process::id()
        ));
        fs::write(
            &path,
            r#"{"fontScale":1.5,"showTimestamps":false,"hideModerated":true}"#,
        )
        .unwrap();
        let loaded = load_file(&path);
        assert_eq!(loaded.font_scale, 1.5);
        assert!(!loaded.show_timestamps);
        assert_eq!(loaded.timestamp_format, "Disable");
        assert!(loaded.hide_moderated);
        let _ = fs::remove_file(&path);
    }
}
