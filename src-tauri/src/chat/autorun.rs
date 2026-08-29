//! Start with Windows (Chatterino behaviour.autorun / WindowsHelper; reimplementation).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const KNOB: &str = "behaviour.autorun";
pub const RUN_VALUE_NAME: &str = "Chatterino RT";

pub fn format_run_command(exe: &Path) -> String {
    let path = exe.to_string_lossy().replace('/', "\\");
    format!("\"{path}\" --autorun")
}

pub fn sync_knob_from_registry(knobs: &mut BTreeMap<String, Value>) {
    knobs.insert(KNOB.to_string(), Value::Bool(is_registered()));
}

pub fn apply_knob_to_registry(knobs: &BTreeMap<String, Value>) -> Result<(), String> {
    let want = knobs.get(KNOB).and_then(Value::as_bool).unwrap_or(false);
    set_registered(want)
}

pub fn is_registered() -> bool {
    #[cfg(windows)]
    {
        match read_run_value() {
            Ok(Some(v)) => !v.trim().is_empty(),
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn set_registered(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let abs = std::fs::canonicalize(&exe).unwrap_or(exe);
            let abs = strip_extended_prefix(abs);
            write_run_value(&format_run_command(&abs))
        } else {
            delete_run_value()
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(())
    }
}

fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(windows)]
fn is_file_not_found(err: &windows::core::Error) -> bool {
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    err.code() == ERROR_FILE_NOT_FOUND.to_hresult() || err.code().0 as u32 == ERROR_FILE_NOT_FOUND.0
}

#[cfg(windows)]
fn read_run_value() -> Result<Option<String>, String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
        RRF_RT_REG_SZ,
    };

    unsafe {
        let mut key = Default::default();
        let open = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Run"),
            None,
            KEY_READ,
            &mut key,
        );
        if let Err(e) = open.ok() {
            if is_file_not_found(&e) {
                return Ok(None);
            }
            return Err(e.to_string());
        }

        let mut data = vec![0u16; 1024];
        let mut data_bytes = (data.len() * 2) as u32;
        let mut ty = REG_SZ;
        let status = RegGetValueW(
            key,
            PCWSTR::null(),
            w!("Chatterino RT"),
            RRF_RT_REG_SZ,
            Some(&mut ty),
            Some(data.as_mut_ptr() as *mut _),
            Some(&mut data_bytes),
        );
        let _ = RegCloseKey(key);

        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        status.ok().map_err(|e| e.to_string())?;
        let chars = (data_bytes as usize / 2).saturating_sub(1);
        let slice = &data[..chars.min(data.len())];
        let len = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
        Ok(Some(String::from_utf16_lossy(&slice[..len])))
    }
}

#[cfg(windows)]
fn write_run_value(command: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ,
    };

    let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2) };

    unsafe {
        let mut key = Default::default();
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Run"),
            None,
            KEY_SET_VALUE,
            &mut key,
        )
        .ok()
        .map_err(|e| e.to_string())?;
        let name = HSTRING::from(RUN_VALUE_NAME);
        let result = RegSetValueExW(key, &name, None, REG_SZ, Some(bytes));
        let _ = RegCloseKey(key);
        result.ok().map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
fn delete_run_value() -> Result<(), String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };

    unsafe {
        let mut key = Default::default();
        let open = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Run"),
            None,
            KEY_SET_VALUE,
            &mut key,
        );
        if let Err(e) = open.ok() {
            if is_file_not_found(&e) {
                return Ok(());
            }
            return Err(e.to_string());
        }
        let name = HSTRING::from(RUN_VALUE_NAME);
        let status = RegDeleteValueW(key, &name);
        let _ = RegCloseKey(key);
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        status.ok().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_quotes_path_and_flag() {
        #[cfg(windows)]
        let cmd = format_run_command(Path::new(r"C:\Apps\Chatterino RT.exe"));
        #[cfg(not(windows))]
        let cmd = format_run_command(Path::new("/opt/chatterino-rt"));
        assert!(cmd.starts_with('"'));
        assert!(cmd.contains(" --autorun"));
        assert!(!cmd.contains('/'));
    }

    #[test]
    fn sync_knob_writes_bool() {
        let mut knobs = BTreeMap::new();
        sync_knob_from_registry(&mut knobs);
        assert!(matches!(knobs.get(KNOB), Some(Value::Bool(_))));
    }

    #[test]
    fn strip_extended_keeps_unc() {
        let p = strip_extended_prefix(PathBuf::from(r"\\?\UNC\server\share\app.exe"));
        assert_eq!(p, PathBuf::from(r"\\server\share\app.exe"));
        let local = strip_extended_prefix(PathBuf::from(r"\\?\C:\Apps\app.exe"));
        assert_eq!(local, PathBuf::from(r"C:\Apps\app.exe"));
    }

    #[test]
    fn disable_autorun_is_idempotent() {
        set_registered(false).expect("disable autorun");
        set_registered(false).expect("disable autorun again");
    }
}
