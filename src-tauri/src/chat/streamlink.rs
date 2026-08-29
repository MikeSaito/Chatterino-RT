//! Launch Streamlink for a Twitch channel (Chatterino StreamLink.cpp parity; reimplementation).

use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use super::state::Shared;

const MAX_OPTS: usize = 64;
const MAX_OPTS_CHARS: usize = 2_048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityArgs {
    pub quality: String,
    pub exclude: Option<String>,
}

/// Map settings preferredQuality → streamlink quality (+ optional excludes).
/// Choose → best (QualityPopup deferred).
pub fn quality_args(preferred: &str) -> QualityArgs {
    match preferred.trim() {
        "High" => QualityArgs {
            quality: "high,best".into(),
            exclude: Some(">720p30".into()),
        },
        "Medium" => QualityArgs {
            quality: "medium,best".into(),
            exclude: Some(">540p30".into()),
        },
        "Low" => QualityArgs {
            quality: "low,best".into(),
            exclude: Some(">360p30".into()),
        },
        "AudioOnly" => QualityArgs {
            quality: "audio,audio_only".into(),
            exclude: None,
        },
        // Source, Choose, unknown
        _ => QualityArgs {
            quality: "best".into(),
            exclude: None,
        },
    }
}

pub fn streamlink_binary_name() -> &'static str {
    if cfg!(windows) {
        "streamlink.exe"
    } else {
        "streamlink"
    }
}

/// Resolve executable path from knobs. Custom path = directory containing the binary.
pub fn resolve_binary(use_custom: bool, custom_dir: &str) -> Result<PathBuf, String> {
    let name = streamlink_binary_name();
    if !use_custom {
        return Ok(PathBuf::from(name));
    }
    let dir = custom_dir.trim();
    if dir.is_empty() {
        return Err(
            "Streamlink custom path is empty. Set the directory that contains the streamlink binary."
                .into(),
        );
    }
    let base = PathBuf::from(dir);
    if !base.is_absolute() {
        return Err("Streamlink custom path must be an absolute directory.".into());
    }
    if has_parent_component(&base) {
        return Err("Streamlink custom path must not contain '..'.".into());
    }
    let exe = base.join(name);
    if !exe.is_file() {
        return Err(format!(
            "Unable to find Streamlink executable at {}. Point custom path to the directory that contains {}.",
            exe.display(),
            name
        ));
    }
    Ok(exe)
}

fn has_parent_component(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

/// Split additional options (Qt `QProcess::splitCommand`-like: whitespace + double quotes).
pub fn split_opts(raw: &str) -> Result<Vec<String>, String> {
    if raw.chars().count() > MAX_OPTS_CHARS {
        return Err("Streamlink options string is too long.".into());
    }
    if raw.chars().any(|c| matches!(c, '\0' | '\r' | '\n')) {
        return Err("Streamlink options contain forbidden characters.".into());
    }
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in raw.chars() {
        match c {
            '"' => {
                in_quote = !in_quote;
            }
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    parts.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if in_quote {
        return Err("Streamlink options have an unclosed quote.".into());
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    if parts.len() > MAX_OPTS {
        return Err("Too many Streamlink options.".into());
    }
    Ok(parts)
}

pub fn channel_url(login: &str) -> String {
    format!("https://twitch.tv/{login}")
}

pub fn normalize_login(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_start_matches('#').to_lowercase();
    if s.is_empty() || s.len() > 25 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("channel name: 1-25 chars [a-z0-9_]".into());
    }
    Ok(s)
}

pub fn build_argv(
    binary: &Path,
    url: &str,
    quality: &QualityArgs,
    extra_opts: &[String],
) -> (PathBuf, Vec<String>) {
    let mut args = Vec::new();
    if let Some(ex) = &quality.exclude {
        args.push("--stream-sorting-excludes".into());
        args.push(ex.clone());
    }
    args.push(url.to_string());
    args.push(quality.quality.clone());
    args.extend(extra_opts.iter().cloned());
    (binary.to_path_buf(), args)
}

fn knob_bool(knobs: &std::collections::BTreeMap<String, Value>, key: &str, default: bool) -> bool {
    knobs.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn knob_str(knobs: &std::collections::BTreeMap<String, Value>, key: &str) -> String {
    knobs
        .get(key)
        .and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Spawn Streamlink detached for `channel` using current settings knobs.
pub fn open_for_channel(shared: &Shared, channel: &str) -> Result<(), String> {
    let login = normalize_login(channel)?;
    let (use_custom, custom_dir, preferred, opts_raw) = {
        let guard = shared
            .settings
            .lock()
            .map_err(|_| "settings lock".to_string())?;
        let knobs = &guard.data.knobs;
        (
            knob_bool(knobs, "external.streamlinkUseCustomPath", false),
            knob_str(knobs, "external.streamlinkPath"),
            knob_str(knobs, "external.preferredQuality"),
            knob_str(knobs, "external.streamlinkOpts"),
        )
    };
    let binary = resolve_binary(use_custom, &custom_dir)?;
    let quality = quality_args(&preferred);
    let opts = split_opts(&opts_raw)?;
    let url = channel_url(&login);
    let (program, args) = build_argv(&binary, &url, &quality, &opts);
    spawn_detached(&program, &args)
}

fn spawn_detached(program: &Path, args: &[String]) -> Result<(), String> {
    if program.is_absolute() && !program.is_file() {
        return Err(format!(
            "Unable to find Streamlink executable at {}.",
            program.display()
        ));
    }
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW);
        // Detached: do not join a wait thread for long-lived Streamlink.
        cmd.spawn().map(|_| ()).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Unable to find Streamlink executable. Enable a custom path if Streamlink is installed outside PATH."
                    .into()
            } else {
                e.to_string()
            }
        })
    }
    #[cfg(not(windows))]
    {
        match cmd.spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                Ok(())
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Err(
                        "Unable to find Streamlink executable. Enable a custom path if Streamlink is installed outside PATH."
                            .into(),
                    )
                } else {
                    Err(e.to_string())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_source_and_choose_are_best() {
        assert_eq!(quality_args("Source").quality, "best");
        assert_eq!(quality_args("Choose").quality, "best");
        assert_eq!(quality_args("").quality, "best");
    }

    #[test]
    fn quality_tiers() {
        let h = quality_args("High");
        assert_eq!(h.quality, "high,best");
        assert_eq!(h.exclude.as_deref(), Some(">720p30"));
        let a = quality_args("AudioOnly");
        assert_eq!(a.quality, "audio,audio_only");
        assert!(a.exclude.is_none());
    }

    #[test]
    fn resolve_path_rejects_relative_and_parent() {
        assert!(resolve_binary(true, "").is_err());
        assert!(resolve_binary(true, "streamlink").is_err());
        assert!(resolve_binary(true, r"C:\tools\..\evil").is_err());
        assert!(resolve_binary(false, "").is_ok());
    }

    #[test]
    fn split_opts_ok_and_reject() {
        assert_eq!(
            split_opts("  --twitch-disable-ads  -n ").unwrap(),
            vec!["--twitch-disable-ads", "-n"]
        );
        assert_eq!(
            split_opts(r#"--player "C:\Program Files\VLC\vlc.exe""#).unwrap(),
            vec!["--player", r"C:\Program Files\VLC\vlc.exe"]
        );
        assert!(split_opts("a\nb").is_err());
        assert!(split_opts(r#"--player "open"#).is_err());
    }

    #[test]
    fn build_argv_order() {
        let q = quality_args("High");
        let (prog, args) = build_argv(
            Path::new("streamlink"),
            "https://twitch.tv/xqc",
            &q,
            &["--foo".into()],
        );
        assert_eq!(prog, PathBuf::from("streamlink"));
        assert_eq!(
            args,
            vec![
                "--stream-sorting-excludes",
                ">720p30",
                "https://twitch.tv/xqc",
                "high,best",
                "--foo",
            ]
        );
    }

    #[test]
    fn channel_url_and_login() {
        assert_eq!(channel_url("xqc"), "https://twitch.tv/xqc");
        assert_eq!(normalize_login("#Bob").unwrap(), "bob");
        assert!(normalize_login("").is_err());
        assert!(normalize_login("bad name").is_err());
    }
}
