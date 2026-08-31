//! Chat message file logging (MIT reimpl Chatterino Logging / LoggingChannel).

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, TimeZone, Timelike};
use serde_json::Value;

use super::commands::ApiError;
use super::settings::{AppSettings, ChannelRow};
use super::state::Shared;
use super::types::ChatEvent;

const PLATFORM: &str = "Twitch";
const MAX_LINE_CHARS: usize = 4096;
const WHISPERS_KEY: &str = "/whispers";

#[derive(Debug, Clone)]
pub struct LoggingConfig {
    pub enabled: bool,
    pub base_path: PathBuf,
    pub timestamp_format: String,
    pub try_use_twitch_timestamps: bool,
    pub only_log_listed: bool,
    pub separately_store_stream_logs: bool,
    pub listed_channels: HashSet<String>,
    pub strip_reply_mention: bool,
    pub hide_reply_context: bool,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_path: PathBuf::new(),
            timestamp_format: "hh:mm:ss".into(),
            try_use_twitch_timestamps: false,
            only_log_listed: false,
            separately_store_stream_logs: false,
            listed_channels: HashSet::new(),
            strip_reply_mention: true,
            hide_reply_context: false,
        }
    }
}

impl LoggingConfig {
    pub fn from_settings(data: &AppSettings, default_base: &Path) -> Self {
        let knobs = &data.knobs;
        let custom = knob_str(knobs, "logging.logPath");
        let base_path = if custom.is_empty() {
            default_base.to_path_buf()
        } else {
            PathBuf::from(custom)
        };
        Self {
            enabled: knob_bool(knobs, "logging.enableLogging", false),
            base_path,
            timestamp_format: {
                let fmt = knob_str(knobs, "logging.logTimestampFormat");
                if fmt.is_empty() {
                    "hh:mm:ss".into()
                } else {
                    fmt
                }
            },
            try_use_twitch_timestamps: knob_bool(knobs, "logging.tryUseTwitchTimestamps", false),
            only_log_listed: knob_bool(knobs, "logging.onlyLogListedChannels", false),
            separately_store_stream_logs: knob_bool(
                knobs,
                "logging.separatelyStoreStreamLogs",
                false,
            ),
            listed_channels: listed_from_rows(&data.log_channels),
            strip_reply_mention: knob_bool(knobs, "appearance.stripReplyMention", true),
            hide_reply_context: knob_bool(knobs, "appearance.hideReplyContext", false),
        }
    }

    fn should_log_key(&self, log_key: &str) -> bool {
        if !self.enabled {
            return false;
        }
        if !self.only_log_listed {
            return true;
        }
        let needle = log_key.trim().trim_start_matches('#').to_ascii_lowercase();
        self.listed_channels.contains(&needle)
    }
}

fn listed_from_rows(rows: &[ChannelRow]) -> HashSet<String> {
    rows.iter()
        .map(|r| {
            r.channel
                .trim()
                .trim_start_matches('#')
                .to_ascii_lowercase()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn knob_bool(knobs: &std::collections::BTreeMap<String, Value>, key: &str, default: bool) -> bool {
    knobs.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn knob_str(knobs: &std::collections::BTreeMap<String, Value>, key: &str) -> String {
    knobs
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Sanitize channel / stream id for filesystem paths.
pub fn sanitize_fs_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => out.push('_'),
            c if c.is_control() => out.push('_'),
            c => out.push(c),
        }
    }
    let trimmed = out.trim().trim_matches('.');
    if trimmed.is_empty() {
        return "_".into();
    }
    let upper = trimmed.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or(&upper);
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

pub fn validate_log_path(raw: &str) -> Result<(), ApiError> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(());
    }
    if s.len() > MAX_CELL || s.contains('\0') {
        return Err(ApiError::coded("error.log.path", "log path"));
    }
    let p = Path::new(s);
    if !p.is_absolute() {
        return Err(ApiError::coded(
            "error.log.path_absolute",
            "log path must be absolute",
        ));
    }
    for c in p.components() {
        if matches!(c, std::path::Component::ParentDir) {
            return Err(ApiError::coded(
                "error.log.path_invalid",
                "invalid log path",
            ));
        }
    }
    Ok(())
}

const MAX_CELL: usize = 2000;

fn sub_directory(log_key: &str) -> PathBuf {
    let platform = format!(
        "{}{}",
        PLATFORM
            .chars()
            .next()
            .map(|c| c.to_ascii_uppercase())
            .unwrap_or('T'),
        &PLATFORM[1..].to_ascii_lowercase()
    );
    if log_key.starts_with("/whispers") {
        PathBuf::from(platform).join("Whispers")
    } else if log_key.starts_with("/mentions") {
        PathBuf::from(platform).join("Mentions")
    } else if log_key.starts_with("/live") {
        PathBuf::from(platform).join("Live")
    } else if log_key.starts_with("/automod") {
        PathBuf::from(platform).join("AutoMod")
    } else {
        PathBuf::from(platform)
            .join("Channels")
            .join(sanitize_fs_name(log_key))
    }
}

fn generate_opening_string(now: DateTime<Local>) -> String {
    format!(
        "# Start logging at {} {}\n",
        now.format("%Y-%m-%d %H:%M:%S"),
        now.format("%Z")
    )
}

fn generate_closing_string(now: DateTime<Local>) -> String {
    format!(
        "# Stop logging at {} {}\n",
        now.format("%Y-%m-%d %H:%M:%S"),
        now.format("%Z")
    )
}

fn date_string(now: DateTime<Local>) -> String {
    now.format("%Y-%m-%d").to_string()
}

/// Map Chatterino/Qt timestamp formats to a display string.
pub fn format_qt_timestamp(dt: DateTime<Local>, fmt: &str) -> String {
    if fmt == "Disable" {
        return String::new();
    }
    let h12 = {
        let h = dt.hour12();
        if h.1 == 0 {
            12
        } else {
            h.1
        }
    };
    let ampm = if dt.hour12().0 { "PM" } else { "AM" };
    let ms = dt.timestamp_subsec_millis();
    match fmt {
        "h:mm" => format!("{h12}:{:02}", dt.minute()),
        "hh:mm" => format!("{:02}:{:02}", dt.hour(), dt.minute()),
        "h:mm a" => format!("{h12}:{:02} {ampm}", dt.minute()),
        "hh:mm a" => format!("{:02}:{:02} {ampm}", h12, dt.minute()),
        "h:mm:ss" => format!("{h12}:{:02}:{:02}", dt.minute(), dt.second()),
        "hh:mm:ss" => format!("{:02}:{:02}:{:02}", dt.hour(), dt.minute(), dt.second()),
        "h:mm:ss a" => format!("{h12}:{:02}:{:02} {ampm}", dt.minute(), dt.second()),
        "hh:mm:ss a" => format!("{:02}:{:02}:{:02} {ampm}", h12, dt.minute(), dt.second()),
        "h:mm:ss.zzz" => format!("{h12}:{:02}:{:02}.{:03}", dt.minute(), dt.second(), ms),
        "h:mm:ss.zzz a" => format!(
            "{h12}:{:02}:{:02}.{:03} {ampm}",
            dt.minute(),
            dt.second(),
            ms
        ),
        "hh:mm:ss.zzz" => format!(
            "{:02}:{:02}:{:02}.{:03}",
            dt.hour(),
            dt.minute(),
            dt.second(),
            ms
        ),
        "hh:mm:ss.zzz a" => format!(
            "{:02}:{:02}:{:02}.{:03} {ampm}",
            h12,
            dt.minute(),
            dt.second(),
            ms
        ),
        _ => format!("{:02}:{:02}:{:02}", dt.hour(), dt.minute(), dt.second()),
    }
}

fn message_timestamp(event: &ChatEvent, use_twitch: bool) -> DateTime<Local> {
    if use_twitch {
        let ms = event.timestamp_ms();
        if ms > 0 {
            if let Some(dt) = Local.timestamp_millis_opt(ms as i64).single() {
                return dt;
            }
        }
    }
    Local::now()
}

fn truncate_line(mut s: String) -> String {
    if s.chars().count() > MAX_LINE_CHARS {
        s = s.chars().take(MAX_LINE_CHARS).collect();
    }
    s
}

fn insert_reply_parent(message_text: &mut String, parent_login: &str) {
    if parent_login.is_empty() {
        return;
    }
    if let Some(idx) = message_text.find(':') {
        message_text.insert_str(idx + 1, &format!(" @{parent_login}"));
    }
}

fn message_body(event: &ChatEvent, cfg: &LoggingConfig) -> Option<String> {
    match event {
        ChatEvent::Privmsg {
            login,
            display_name,
            text,
            reply_to_login,
            reply_to_id,
            ..
        } => {
            let mut message_text =
                if display_name.is_empty() || display_name.eq_ignore_ascii_case(login) {
                    format!("{login}: {text}")
                } else {
                    format!("{display_name} {login}: {text}")
                };
            if reply_to_id.is_some() && cfg.strip_reply_mention && !cfg.hide_reply_context {
                if let Some(parent) = reply_to_login.as_deref().filter(|s| !s.is_empty()) {
                    insert_reply_parent(&mut message_text, parent);
                }
            }
            Some(message_text)
        }
        ChatEvent::Usernotice {
            system_text,
            login,
            privmsg,
            ..
        } => {
            if let Some(inner) = privmsg.as_ref() {
                if let ChatEvent::Privmsg {
                    login: pl,
                    display_name,
                    text,
                    ..
                } = inner.as_ref()
                {
                    let nick = if display_name.is_empty() {
                        pl.clone()
                    } else {
                        display_name.clone()
                    };
                    return Some(format!("{system_text} {nick}: {text}"));
                }
            }
            if let Some(l) = login.as_deref().filter(|s| !s.is_empty()) {
                Some(format!("{system_text} ({l})"))
            } else {
                Some(system_text.clone())
            }
        }
        ChatEvent::Notice { text, .. } => Some(text.clone()),
        ChatEvent::Clearchat {
            target_login,
            duration_sec,
            stack_count,
            source_login,
            moderator_login,
            ..
        } => Some(super::clearchat_text::clearchat_text_en(
            target_login.as_deref(),
            duration_sec.map(u64::from),
            *stack_count,
            source_login.as_deref(),
            moderator_login.as_deref(),
        )),
        ChatEvent::Clearmsg { .. } | ChatEvent::Roomstate { .. } | ChatEvent::Userstate { .. } => {
            None
        }
        ChatEvent::AutomodHeld {
            author_login,
            author_display_name,
            text,
            status,
            ..
        } => {
            let nick = if author_display_name.is_empty() {
                author_login.clone()
            } else {
                author_display_name.clone()
            };
            Some(format!("AutoMod ({status}) {nick}: {text}"))
        }
        ChatEvent::AutomodStatus {
            target_id, status, ..
        } => Some(format!("AutoMod status {status} ({target_id})")),
        ChatEvent::LowTrustHeader { detail, status, .. } => {
            Some(format!("Suspicious User: {detail} ({status})"))
        }
        ChatEvent::LowTrustMessage {
            login,
            display_name,
            text,
            status,
            ..
        } => {
            let nick = if display_name.is_empty() {
                login.clone()
            } else {
                display_name.clone()
            };
            Some(format!("LowTrust ({status}) {nick}: {text}"))
        }
    }
}

/// Format one log line (without trailing newline). Returns None for non-logged kinds.
pub fn format_log_line(event: &ChatEvent, cfg: &LoggingConfig) -> Option<String> {
    let body = message_body(event, cfg)?;
    let ts = message_timestamp(event, cfg.try_use_twitch_timestamps);
    let mut line = String::new();
    let stamp = format_qt_timestamp(ts, &cfg.timestamp_format);
    if !stamp.is_empty() {
        line.push('[');
        line.push_str(&stamp);
        line.push_str("] ");
    }
    line.push_str(&body);
    Some(truncate_line(line))
}

struct LoggingChannel {
    log_key: String,
    date_string: String,
    file: Option<BufWriter<File>>,
    stream_id: String,
    stream_file: Option<BufWriter<File>>,
}

impl LoggingChannel {
    fn new(log_key: String) -> Self {
        Self {
            log_key,
            date_string: String::new(),
            file: None,
            stream_id: String::new(),
            stream_file: None,
        }
    }

    fn open_log_file(&mut self, base: &Path, now: DateTime<Local>) {
        self.date_string = date_string(now);
        if let Some(mut f) = self.file.take() {
            let _ = f.flush();
        }
        let dir = base.join(sub_directory(&self.log_key));
        if fs::create_dir_all(&dir).is_err() {
            self.file = None;
            return;
        }
        let name = format!(
            "{}-{}.log",
            sanitize_fs_name(&self.log_key),
            self.date_string
        );
        let path = dir.join(name);
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                let mut writer = BufWriter::new(file);
                let _ = writer.write_all(generate_opening_string(now).as_bytes());
                let _ = writer.flush();
                self.file = Some(writer);
            }
            Err(_) => {
                self.file = None;
            }
        }
    }

    fn open_stream_log_file(&mut self, base: &Path, stream_id: &str, now: DateTime<Local>) {
        self.stream_id = stream_id.to_string();
        if let Some(mut f) = self.stream_file.take() {
            let _ = f.flush();
        }
        let dir = base.join(sub_directory(&self.log_key));
        if fs::create_dir_all(&dir).is_err() {
            self.stream_file = None;
            return;
        }
        let name = format!(
            "{}-{}.log",
            sanitize_fs_name(&self.log_key),
            sanitize_fs_name(stream_id)
        );
        let path = dir.join(name);
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                let mut writer = BufWriter::new(file);
                let _ = writer.write_all(generate_opening_string(now).as_bytes());
                let _ = writer.flush();
                self.stream_file = Some(writer);
            }
            Err(_) => {
                self.stream_file = None;
            }
        }
    }

    fn close_stream(&mut self) {
        if let Some(mut f) = self.stream_file.take() {
            let closing = generate_closing_string(Local::now());
            let _ = f.write_all(closing.as_bytes());
            let _ = f.flush();
        }
        self.stream_id.clear();
    }

    fn append_line(
        &mut self,
        base: &Path,
        cfg: &LoggingConfig,
        line: &str,
        stream_id: &str,
        message_ts: DateTime<Local>,
    ) {
        let msg_date = date_string(message_ts);
        if self.file.is_none() || self.date_string != msg_date {
            self.open_log_file(base, message_ts);
        }
        if let Some(file) = self.file.as_mut() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.write_all(b"\n");
            let _ = file.flush();
        }
        if cfg.separately_store_stream_logs && !stream_id.is_empty() {
            if self.stream_file.is_none() || self.stream_id != stream_id {
                self.open_stream_log_file(base, stream_id, message_ts);
            }
            if let Some(file) = self.stream_file.as_mut() {
                let _ = file.write_all(line.as_bytes());
                let _ = file.write_all(b"\n");
                let _ = file.flush();
            }
        }
    }
}

impl Drop for LoggingChannel {
    fn drop(&mut self) {
        let now = Local::now();
        let closing = generate_closing_string(now);
        if let Some(mut f) = self.file.take() {
            let _ = f.write_all(closing.as_bytes());
            let _ = f.flush();
        }
        if let Some(mut f) = self.stream_file.take() {
            let _ = f.write_all(closing.as_bytes());
            let _ = f.flush();
        }
    }
}

pub struct Logging {
    config: LoggingConfig,
    default_base: PathBuf,
    channels: HashMap<String, LoggingChannel>,
}

impl Default for Logging {
    fn default() -> Self {
        Self {
            config: LoggingConfig::default(),
            default_base: PathBuf::new(),
            channels: HashMap::new(),
        }
    }
}

impl Logging {
    pub fn set_default_base(&mut self, path: PathBuf) {
        self.default_base = path;
    }

    pub fn rebuild(&mut self, data: &AppSettings) {
        let next = LoggingConfig::from_settings(data, &self.default_base);
        let path_changed = next.base_path != self.config.base_path;
        let disabled = !next.enabled;
        self.config = next;
        if path_changed || disabled {
            self.channels.clear();
        }
    }

    pub fn close_channel(&mut self, log_key: &str) {
        self.channels.remove(log_key);
    }

    pub fn close_stream_file(&mut self, log_key: &str) {
        if let Some(ch) = self.channels.get_mut(log_key) {
            ch.close_stream();
        }
    }

    pub fn add_message(&mut self, log_key: &str, event: &ChatEvent, stream_id: &str) {
        if !self.config.should_log_key(log_key) {
            return;
        }
        let Some(line) = format_log_line(event, &self.config) else {
            return;
        };
        let message_ts = message_timestamp(event, self.config.try_use_twitch_timestamps);
        let base = self.config.base_path.clone();
        let channel = self
            .channels
            .entry(log_key.to_string())
            .or_insert_with(|| LoggingChannel::new(log_key.to_string()));
        channel.append_line(&base, &self.config, &line, stream_id, message_ts);
    }
}

/// Log a live (non-history) event that was added to scrollback.
/// `stream_id` must be resolved by the caller (avoid locking Hub while ingest holds it).
pub fn try_log(shared: &Shared, log_key: &str, event: &ChatEvent, stream_id: &str) {
    let Ok(mut logging) = shared.logging.lock() else {
        return;
    };
    logging.add_message(log_key, event, stream_id);
}

pub fn close_channel(shared: &Shared, log_key: &str) {
    if let Ok(mut logging) = shared.logging.lock() {
        logging.close_channel(log_key);
    }
}

pub fn close_stream_file(shared: &Shared, log_key: &str) {
    if let Ok(mut logging) = shared.logging.lock() {
        logging.close_stream_file(log_key);
    }
}

pub fn rebuild(shared: &Shared, data: &AppSettings) {
    if let Ok(mut logging) = shared.logging.lock() {
        logging.rebuild(data);
    }
}

pub fn init_default_base(shared: &Shared, app_config_dir: &Path) {
    let logs = app_config_dir.join("Logs");
    if let Ok(mut logging) = shared.logging.lock() {
        logging.set_default_base(logs);
    }
}

pub fn resolve_stream_id(shared: &Shared, channel: &str) -> String {
    shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.stream_id(channel).map(str::to_string))
        .unwrap_or_default()
}

pub fn pick_directory(_shared: &Shared) -> Result<String, ApiError> {
    let dir = rfd::FileDialog::new()
        .set_title("Select log directory")
        .pick_folder()
        .ok_or_else(|| ApiError::coded("error.path.dir_not_chosen", "directory not chosen"))?;
    let path = dir
        .to_str()
        .ok_or_else(|| ApiError::coded("error.path.invalid", "invalid path"))?
        .to_string();
    if path.trim().is_empty() {
        return Err(ApiError::coded("error.path.invalid", "invalid path"));
    }
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(ApiError::coded(
            "error.path.absolute",
            "absolute path required",
        ));
    }
    for c in p.components() {
        if matches!(c, std::path::Component::ParentDir) {
            return Err(ApiError::coded("error.path.invalid", "invalid path"));
        }
    }
    Ok(path)
}

pub fn whispers_key() -> &'static str {
    WHISPERS_KEY
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::ChatEvent;

    fn cfg_with(fmt: &str) -> LoggingConfig {
        LoggingConfig {
            enabled: true,
            timestamp_format: fmt.into(),
            try_use_twitch_timestamps: true,
            ..LoggingConfig::default()
        }
    }

    fn privmsg(login: &str, display: &str, text: &str) -> ChatEvent {
        ChatEvent::Privmsg {
            id: "1".into(),
            timestamp_ms: 1_700_000_000_000,
            user_id: "9".into(),
            login: login.into(),
            display_name: display.into(),
            color: "#fff".into(),
            badges: vec![],
            text: text.into(),
            emote_spans: vec![],
            link_spans: vec![],
            mention_spans: vec![],
            bits: None,
            reply_to_id: None,
            reply_to_login: None,
            reply_to_display_name: None,
            reply_to_text: None,
            action: false,
            first_msg: false,
            custom_reward_id: None,
            system_msg_id: None,
            highlight_color: None,
            highlight_sound: false,
            highlight_sound_path: None,
            highlight_flash: false,
            whisper: false,
            disabled: false,
            source_room_id: None,
            source_badges: vec![],
            paint: None,
        }
    }

    #[test]
    fn format_privmsg_same_nick() {
        let cfg = cfg_with("Disable");
        let line = format_log_line(&privmsg("ann", "ann", "hi"), &cfg).unwrap();
        assert_eq!(line, "ann: hi");
    }

    #[test]
    fn format_privmsg_localized_nick() {
        let cfg = cfg_with("Disable");
        let line = format_log_line(&privmsg("ann", "Анна", "hi"), &cfg).unwrap();
        assert_eq!(line, "Анна ann: hi");
    }

    #[test]
    fn format_with_timestamp_prefix() {
        let cfg = cfg_with("hh:mm:ss");
        let line = format_log_line(&privmsg("ann", "ann", "hi"), &cfg).unwrap();
        assert!(line.starts_with('['), "{line}");
        assert!(line.contains("] ann: hi"), "{line}");
    }

    #[test]
    fn format_clearchat() {
        let cfg = cfg_with("Disable");
        let ev = ChatEvent::Clearchat {
            id: "c".into(),
            timestamp_ms: 1,
            target_login: Some("bob".into()),
            duration_sec: Some(60),
            stack_count: 1,
            source_login: None,
            moderator_login: None,
        };
        let line = format_log_line(&ev, &cfg).unwrap();
        assert_eq!(line, "bob timed out for 1m");
    }

    #[test]
    fn roomstate_not_logged() {
        let cfg = cfg_with("Disable");
        let ev = ChatEvent::Roomstate {
            id: "r".into(),
            timestamp_ms: 1,
            emote_only: Some(true),
            subs_only: None,
            slow_sec: None,
            followers_only: None,
        };
        assert!(format_log_line(&ev, &cfg).is_none());
    }

    #[test]
    fn sanitize_rejects_path_chars() {
        assert_eq!(sanitize_fs_name(r"a/b:c*"), "a_b_c_");
        assert_eq!(sanitize_fs_name("..."), "_");
    }

    #[test]
    fn sanitize_reserved_windows_names() {
        assert_eq!(sanitize_fs_name("CON"), "_CON");
        assert_eq!(sanitize_fs_name("com1.txt"), "_com1.txt");
    }

    #[test]
    fn validate_log_path_rules() {
        assert!(validate_log_path("").is_ok());
        assert!(validate_log_path("relative").is_err());
        assert!(validate_log_path(r"C:\Logs\..\evil").is_err());
        assert!(validate_log_path(r"C:\Logs\chat").is_ok());
    }

    #[test]
    fn only_listed_filter() {
        let mut cfg = LoggingConfig::default();
        cfg.enabled = true;
        cfg.only_log_listed = true;
        cfg.listed_channels.insert("xqc".into());
        assert!(cfg.should_log_key("xqc"));
        assert!(cfg.should_log_key("#XQC"));
        assert!(!cfg.should_log_key("lirik"));
        assert!(!cfg.should_log_key("/whispers"));
    }

    #[test]
    fn writes_daily_file() {
        let dir =
            std::env::temp_dir().join(format!("chatterino-rt-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut logging = Logging::default();
        logging.set_default_base(dir.clone());
        logging.config = LoggingConfig {
            enabled: true,
            base_path: dir.clone(),
            timestamp_format: "Disable".into(),
            ..LoggingConfig::default()
        };
        logging.add_message("xqc", &privmsg("ann", "ann", "hello"), "");
        let expected = dir
            .join("Twitch")
            .join("Channels")
            .join("xqc")
            .join(format!("xqc-{}.log", date_string(Local::now())));
        let body = fs::read_to_string(&expected).expect("log file");
        assert!(body.contains("# Start logging at "));
        assert!(body.contains("ann: hello"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reply_parent_insertion() {
        let mut cfg = cfg_with("Disable");
        cfg.strip_reply_mention = true;
        cfg.hide_reply_context = false;
        let mut ev = privmsg("ann", "ann", "hello");
        if let ChatEvent::Privmsg {
            reply_to_id,
            reply_to_login,
            ..
        } = &mut ev
        {
            *reply_to_id = Some("p".into());
            *reply_to_login = Some("bob".into());
        }
        let line = format_log_line(&ev, &cfg).unwrap();
        assert_eq!(line, "ann: @bob hello");
    }
}
