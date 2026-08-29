//! Open URLs in the default browser's private/incognito mode.
//! Behavior mirrors Chatterino `IncognitoBrowser` (MIT); reimplementation, not a port of Qt/C++.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Private-mode CLI flag for a browser executable basename (no extension).
pub fn private_switch(exe: &Path) -> Option<&'static str> {
    let stem = exe
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match stem.as_str() {
        "librewolf" | "waterfox" | "icecat" => Some("-private-window"),
        "chrome" | "google-chrome-stable" | "chromium" | "brave" | "vivaldi" => Some("-incognito"),
        "opera" => Some("-newprivatetab"),
        "msedge" => Some("-inprivate"),
        _ if stem.starts_with("firefox") => Some("-private-window"),
        _ => None,
    }
}

pub fn supports_incognito() -> bool {
    default_browser_exe()
        .map(|exe| private_switch(&exe).is_some())
        .unwrap_or(false)
}

/// Spawn the default browser in private mode. `url` must already be validated.
pub fn open_incognito(url: &str) -> Result<(), String> {
    let exe = default_browser_exe().ok_or_else(|| "нет браузера по умолчанию".to_string())?;
    // Absolute paths must exist; relative Exec= names resolve via PATH (Linux).
    if exe.is_absolute() && !exe.is_file() {
        return Err("браузер по умолчанию не найден".into());
    }
    let switch =
        private_switch(&exe).ok_or_else(|| "private mode не поддерживается".to_string())?;
    let mut cmd = Command::new(&exe);
    cmd.arg(switch)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // Reap so short-lived launchers do not leave zombies (Unix).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn default_browser_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        default_browser_windows()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        default_browser_linux()
    }
    #[cfg(target_os = "macos")]
    {
        None
    }
}

#[cfg(windows)]
fn default_browser_windows() -> Option<PathBuf> {
    assoc_executable(true, "http")
        .or_else(|| assoc_executable(false, ".html"))
        .or_else(|| assoc_executable(false, ".htm"))
}

#[cfg(windows)]
fn assoc_executable(is_protocol: bool, query: &str) -> Option<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        AssocQueryStringW, ASSOCF_IS_PROTOCOL, ASSOCF_NOTRUNCATE, ASSOCSTR_EXECUTABLE,
    };

    let mut flags = ASSOCF_NOTRUNCATE;
    if is_protocol {
        flags |= ASSOCF_IS_PROTOCOL;
    }
    let query_wide: Vec<u16> = query.encode_utf16().chain(std::iter::once(0)).collect();
    let query_pcw = PCWSTR(query_wide.as_ptr());

    let mut size: u32 = 0;
    // First call: required buffer size (chars including NUL).
    let first = unsafe {
        AssocQueryStringW(
            flags,
            ASSOCSTR_EXECUTABLE,
            query_pcw,
            PCWSTR::null(),
            None,
            &mut size,
        )
    };
    if first.is_err() || size <= 1 {
        return None;
    }
    let mut buf = vec![0u16; size as usize];
    let second = unsafe {
        AssocQueryStringW(
            flags,
            ASSOCSTR_EXECUTABLE,
            query_pcw,
            PCWSTR::null(),
            Some(windows::core::PWSTR(buf.as_mut_ptr())),
            &mut size,
        )
    };
    if second.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    if len == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..len]);
    let pb = PathBuf::from(path.trim());
    if pb.as_os_str().is_empty() {
        None
    } else {
        Some(pb)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_browser_linux() -> Option<PathBuf> {
    let desktop_id = Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })?;
    let desktop_path = find_desktop_file(&desktop_id)?;
    let exec = read_desktop_exec(&desktop_path)?;
    parse_desktop_exec_program(&exec).map(PathBuf::from)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn find_desktop_file(id: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(data_home).join("applications"));
    } else if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/applications"));
    }
    if let Ok(data_dirs) = std::env::var("XDG_DATA_DIRS") {
        for d in data_dirs.split(':').filter(|s| !s.is_empty()) {
            dirs.push(PathBuf::from(d).join("applications"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/share/applications"));
        dirs.push(PathBuf::from("/usr/share/applications"));
    }
    for dir in dirs {
        let candidate = dir.join(id);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_desktop_exec(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut in_desktop = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_desktop = t.eq_ignore_ascii_case("[Desktop Entry]");
            continue;
        }
        if !in_desktop {
            continue;
        }
        if let Some(rest) = t.strip_prefix("Exec=") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// First program token of a desktop Exec= line (stock parseDesktopExecProgram).
#[cfg(all(unix, not(target_os = "macos")))]
fn parse_desktop_exec_program(exec: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = exec.chars().peekable();
    let mut in_quote = false;
    while let Some(c) = chars.next() {
        match c {
            '"' => in_quote = !in_quote,
            '\\' if in_quote => {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            }
            c if c.is_whitespace() && !in_quote => break,
            '%' if !in_quote => {
                // Skip field code (%u, %U, …)
                let _ = chars.next();
            }
            _ => out.push(c),
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn private_switch_known_browsers() {
        assert_eq!(
            private_switch(Path::new(
                "C:/Program Files/Google/Chrome/Application/chrome.exe"
            )),
            Some("-incognito")
        );
        assert_eq!(
            private_switch(Path::new("/usr/bin/msedge")),
            Some("-inprivate")
        );
        assert_eq!(
            private_switch(Path::new("firefox.exe")),
            Some("-private-window")
        );
        assert_eq!(
            private_switch(Path::new("firefox-esr")),
            Some("-private-window")
        );
        assert_eq!(private_switch(Path::new("opera")), Some("-newprivatetab"));
        assert_eq!(private_switch(Path::new("unknown-browser")), None);
    }
}
