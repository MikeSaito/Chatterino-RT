//! Детект стримерского софта для Automatic Streamer Mode (как Chatterino StreamerMode).

use super::state::Shared;

/// Имена процессов Win (эталон broadcastingBinaries в StreamerMode.cpp).
pub const BROADCASTING_BINARIES: &[&str] = &[
    "obs.exe",
    "obs64.exe",
    "PRISMLiveStudio.exe",
    "XSplit.Core.exe",
    "TwitchStudio.exe",
    "vMix64.exe",
];

pub fn broadcasting_software_active() -> bool {
    #[cfg(windows)]
    {
        windows_broadcasting_active()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Stock `IStreamerMode::isEnabled()` from `streamerMode.enabled` knob.
pub fn is_enabled(shared: &Shared) -> bool {
    let settings = match shared.settings.lock() {
        Ok(inner) => inner,
        Err(_) => return false,
    };
    let mode = settings
        .data
        .knobs
        .get("streamerMode.enabled")
        .and_then(|v| v.as_str())
        .unwrap_or("DetectStreamingSoftware");
    match mode {
        "Enabled" => true,
        "DetectStreamingSoftware" => broadcasting_software_active(),
        _ => false,
    }
}

pub fn should_suppress_inline_whispers(shared: &Shared) -> bool {
    let suppress = shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("streamerMode.suppressInlineWhispers")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);
    suppress && is_enabled(shared)
}

pub fn inline_whispers_enabled(shared: &Shared) -> bool {
    let on = shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("whispers.inlineWhispers")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true);
    on && !should_suppress_inline_whispers(shared)
}

pub fn is_broadcasting_process_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    BROADCASTING_BINARIES
        .iter()
        .any(|bin| lower == bin.to_ascii_lowercase())
}

#[cfg(windows)]
fn windows_broadcasting_active() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return false,
        };
        if snap.is_invalid() {
            return false;
        }
        struct SnapGuard(windows::Win32::Foundation::HANDLE);
        impl Drop for SnapGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let _guard = SnapGuard(snap);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_err() {
            return false;
        }
        loop {
            let name = wchar_to_string(&entry.szExeFile);
            if is_broadcasting_process_name(&name) {
                return true;
            }
            if Process32NextW(snap, &mut entry).is_err() {
                break;
            }
        }
        false
    }
}

#[cfg(windows)]
fn wchar_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::state::Shared;
    use serde_json::json;

    #[test]
    fn matches_obs_case_insensitive() {
        assert!(is_broadcasting_process_name("obs.exe"));
        assert!(is_broadcasting_process_name("OBS.EXE"));
        assert!(is_broadcasting_process_name("Obs64.Exe"));
        assert!(is_broadcasting_process_name("TwitchStudio.exe"));
    }

    #[test]
    fn rejects_unrelated() {
        assert!(!is_broadcasting_process_name("chrome.exe"));
        assert!(!is_broadcasting_process_name("obs"));
        assert!(!is_broadcasting_process_name(""));
    }

    #[test]
    fn enabled_mode_without_obs() {
        let shared = Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner
                .data
                .knobs
                .insert("streamerMode.enabled".into(), json!("Enabled"));
            inner.data.knobs.insert(
                "streamerMode.suppressInlineWhispers".into(),
                json!(true),
            );
        }
        assert!(is_enabled(&shared));
        assert!(should_suppress_inline_whispers(&shared));
        assert!(!inline_whispers_enabled(&shared));
    }

    #[test]
    fn disabled_mode_with_suppress_knob() {
        let shared = Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner
                .data
                .knobs
                .insert("streamerMode.enabled".into(), json!("Disabled"));
            inner.data.knobs.insert(
                "streamerMode.suppressInlineWhispers".into(),
                json!(true),
            );
        }
        assert!(!is_enabled(&shared));
        assert!(!should_suppress_inline_whispers(&shared));
        assert!(inline_whispers_enabled(&shared));
    }

    #[test]
    fn inline_whispers_off() {
        let shared = Shared::new();
        {
            let mut inner = shared.settings.lock().unwrap();
            inner
                .data
                .knobs
                .insert("whispers.inlineWhispers".into(), json!(false));
        }
        assert!(!inline_whispers_enabled(&shared));
    }
}
