use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

const FREEZE_APP_ORIGIN: &str = r#"
var host = String(location.hostname || "");
if (
  host !== "localhost" &&
  host !== "127.0.0.1" &&
  host !== "tauri.localhost" &&
  location.protocol !== "tauri:"
) {
  return;
}
Object.freeze(Object.prototype);
"#;

pub fn freeze_app_prototype<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("freeze-app-prototype")
        .js_init_script(FREEZE_APP_ORIGIN)
        .build()
}

pub fn allow_embed_storage<R: Runtime>(app: &impl Manager<R>) {
    #[cfg(windows)]
    {
        let Some(window) = app.get_webview_window("main") else {
            eprintln!("окно main не найдено, storage embed не настроен");
            return;
        };
        let window_for_js = window.clone();
        if let Err(err) = window.with_webview(move |platform| {
            if let Err(e) = disable_tracking_prevention(platform) {
                eprintln!("webview tracking prevention: {e}");
                let _ = window_for_js.eval(
                    "console.error('WebView2: storage для Twitch embed не включён')",
                );
            }
        }) {
            eprintln!("webview handle: {err}");
            let _ = window.eval("console.error('WebView2: storage для Twitch embed не включён')");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[cfg(windows)]
fn disable_tracking_prevention(platform: tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile3, ICoreWebView2_13, COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
    };
    use windows_core::Interface;

    unsafe {
        let core = platform
            .controller()
            .CoreWebView2()
            .map_err(|e| e.to_string())?;
        let core13 = core.cast::<ICoreWebView2_13>().map_err(|e| e.to_string())?;
        let profile = core13.Profile().map_err(|e| e.to_string())?;
        let profile3 = profile
            .cast::<ICoreWebView2Profile3>()
            .map_err(|e| e.to_string())?;
        profile3
            .SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
