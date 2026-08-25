//! Start Menu shortcut for Windows toast identity (Chatterino createShortcutForToasts).
//! Reimplementation of WinToast SHORTCUT_POLICY behaviour; not a port.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::state::Shared;

pub const KNOB: &str = "notifications.createShortcutForToasts";
pub const AUMID: &str = "com.mike.webtv-chats";
pub const SHORTCUT_FILE_NAME: &str = "Chatterino RT.lnk";

pub fn should_create_shortcut(knobs: &BTreeMap<String, Value>) -> bool {
    knobs
        .get(KNOB)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub fn start_menu_programs_lnk(appdata: &Path) -> PathBuf {
    appdata
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join(SHORTCUT_FILE_NAME)
}

pub fn apply_from_settings(shared: &Shared) {
    #[cfg(windows)]
    {
        // Stock always sets process AUMID; the knob only gates shortcut creation.
        if let Err(e) = set_process_aumid() {
            eprintln!("toast shortcut aumid: {e}");
        }
        let knobs = match shared.settings.lock() {
            Ok(guard) => guard.data.knobs.clone(),
            Err(_) => return,
        };
        if !should_create_shortcut(&knobs) {
            return;
        }
        if let Err(e) = ensure_toast_shortcut() {
            eprintln!("toast shortcut: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = shared;
    }
}

#[cfg(windows)]
fn set_process_aumid() -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)) }
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn ensure_toast_shortcut() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IShellLinkW, PropertiesSystem::IPropertyStore, ShellLink,
    };

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_canon = std::fs::canonicalize(&exe).unwrap_or_else(|_| exe.clone());

    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA unset".to_string())?;
    let lnk = start_menu_programs_lnk(&appdata);
    if let Some(parent) = lnk.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    if lnk.is_file() {
        if let Ok(existing) = read_shortcut_target(&lnk) {
            let existing_canon =
                std::fs::canonicalize(&existing).unwrap_or_else(|_| existing.clone());
            if path_same_file(&existing_canon, &exe_canon) {
                if read_shortcut_aumid(&lnk).ok().as_deref() == Some(AUMID) {
                    return Ok(());
                }
            }
        }
    }

    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| e.to_string())?;
        let exe_hs = HSTRING::from(exe.as_os_str());
        link.SetPath(&exe_hs).map_err(|e| e.to_string())?;
        if let Some(dir) = exe.parent() {
            let dir_hs = HSTRING::from(dir.as_os_str());
            let _ = link.SetWorkingDirectory(&dir_hs);
        }
        let _ = link.SetIconLocation(&exe_hs, 0);

        let store: IPropertyStore = link.cast().map_err(|e| e.to_string())?;
        let aumid_hs = HSTRING::from(AUMID);
        let mut value = PROPVARIANT::default();
        init_propvariant_from_string(PCWSTR::from_raw(aumid_hs.as_ptr()), &mut value)?;
        let set = store.SetValue(&PKEY_AppUserModel_ID, &value);
        let _ = PropVariantClear(&mut value);
        set.map_err(|e| e.to_string())?;
        store.Commit().map_err(|e| e.to_string())?;

        let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        let lnk_wide: Vec<u16> = OsStr::new(&lnk)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        persist
            .Save(PCWSTR(lnk_wide.as_ptr()), true)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(windows)]
fn init_propvariant_from_string(
    psz: windows::core::PCWSTR,
    out: &mut windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
) -> Result<(), String> {
    #[link(name = "propsys")]
    unsafe extern "system" {
        fn InitPropVariantFromString(
            psz: windows::core::PCWSTR,
            ppropvar: *mut windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
        ) -> windows_core::HRESULT;
    }
    let hr = unsafe { InitPropVariantFromString(psz, out) };
    hr.ok().map_err(|e| e.to_string())
}

#[cfg(windows)]
fn open_shell_link(lnk: &Path) -> Result<windows::Win32::UI::Shell::IShellLinkW, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| e.to_string())?;
        let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        let lnk_wide: Vec<u16> = OsStr::new(lnk)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        persist
            .Load(PCWSTR(lnk_wide.as_ptr()), windows::Win32::System::Com::STGM_READ)
            .map_err(|e| e.to_string())?;
        Ok(link)
    }
}

#[cfg(windows)]
fn read_shortcut_target(lnk: &Path) -> Result<PathBuf, String> {
    use windows::Win32::UI::Shell::SLGP_RAWPATH;

    let link = open_shell_link(lnk)?;
    unsafe {
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .map_err(|e| e.to_string())?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        if len == 0 {
            return Err("empty shortcut target".into());
        }
        if len >= buf.len() {
            return Err("shortcut target truncated".into());
        }
        Ok(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
    }
}

#[cfg(windows)]
fn read_shortcut_aumid(lnk: &Path) -> Result<String, String> {
    use windows::core::Interface;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToString, PROPVARIANT,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

    let link = open_shell_link(lnk)?;
    unsafe {
        let store: IPropertyStore = link.cast().map_err(|e| e.to_string())?;
        let mut value = store
            .GetValue(&PKEY_AppUserModel_ID)
            .map_err(|e| e.to_string())?;
        let mut buf = [0u16; 256];
        let converted = PropVariantToString(&value, &mut buf);
        let _ = PropVariantClear(&mut value);
        converted.map_err(|e| e.to_string())?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..len]))
    }
}

#[cfg(windows)]
fn path_same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy();
        let stripped = s.strip_prefix(r"\\?\").unwrap_or(s.as_ref());
        stripped.replace('/', "\\").to_ascii_lowercase()
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn should_create_defaults_true() {
        let empty = BTreeMap::new();
        assert!(should_create_shortcut(&empty));
        let mut on = BTreeMap::new();
        on.insert(KNOB.to_string(), json!(true));
        assert!(should_create_shortcut(&on));
        let mut off = BTreeMap::new();
        off.insert(KNOB.to_string(), json!(false));
        assert!(!should_create_shortcut(&off));
    }

    #[test]
    fn start_menu_path_shape() {
        let appdata = PathBuf::from(r"C:\Users\x\AppData\Roaming");
        let lnk = start_menu_programs_lnk(&appdata);
        assert!(lnk.ends_with(SHORTCUT_FILE_NAME));
        assert!(lnk.to_string_lossy().contains(r"Start Menu\Programs"));
    }

    #[cfg(windows)]
    #[test]
    fn path_same_file_ignores_case() {
        assert!(path_same_file(
            Path::new(r"C:\Apps\ChatterinoRT.exe"),
            Path::new(r"c:\apps\chatterinort.exe"),
        ));
    }
}
