use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use url::Url;

/// Vite `devUrl` port from `tauri.conf.json` (`http://localhost:1420`).
const DEV_FRONTEND_PORT: u16 = 1420;

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

/// Origins allowed for top-level WebView document navigations (main + settings).
///
/// Twitch player stays in an iframe: WebView2 `NavigationStarting` (wry) is top-level
/// only, so denying `https://player.twitch.tv` here does not break the embed on Windows.
/// On WKWebView / WebKitGTK, wry may invoke this for iframe navigations too — see
/// [`twitch_embed_nav_exception`].
pub fn is_allowed_shell_navigation(url: &Url) -> bool {
    if is_about_blank(url) {
        return true;
    }

    match url.scheme() {
        "tauri" | "asset" => true,
        "http" | "https" => is_allowed_http_shell_host(url) || twitch_embed_nav_exception(url),
        _ => false,
    }
}

fn nav_log_origin(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), host),
        None => format!("{}://{}", url.scheme(), host),
    }
}

fn is_about_blank(url: &Url) -> bool {
    if url.scheme() != "about" {
        return false;
    }
    let raw = url.as_str();
    raw == "about:blank"
        || raw.starts_with("about:blank?")
        || raw.starts_with("about:blank#")
        || url.path() == "blank"
}

fn is_allowed_http_shell_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };

    // Windows/Android custom protocols with useHttpsScheme: https://tauri.localhost
    // (default port only — *.localhost resolves to loopback, so :PORT would open local services).
    if host.eq_ignore_ascii_case("tauri.localhost")
        || host.eq_ignore_ascii_case("asset.localhost")
    {
        return url.scheme() == "https" && url.port().is_none();
    }

    if !tauri::is_dev() {
        return false;
    }

    let loopback = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1";
    loopback && url.port_or_known_default() == Some(DEV_FRONTEND_PORT)
}

/// WKWebView / WebKitGTK: wry `navigation_handler` can run for iframe loads.
/// Without this exception, denying non-app https would block `player.twitch.tv` embed.
/// Residual: on those backends, top-level navigation to Twitch embed hosts is still allowed.
fn twitch_embed_nav_exception(url: &Url) -> bool {
    if cfg!(windows) {
        return false;
    }
    if url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str().map(|h| h.to_ascii_lowercase()).as_deref(),
        Some("player.twitch.tv") | Some("embed.twitch.tv")
    )
}

pub fn freeze_app_prototype<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("freeze-app-prototype")
        .js_init_script(FREEZE_APP_ORIGIN)
        .on_navigation(|_webview, url| {
            let allow = is_allowed_shell_navigation(url);
            if !allow {
                eprintln!("shell nav blocked: {}", nav_log_origin(url));
            }
            allow
        })
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
                let _ = window_for_js
                    .eval("console.error('WebView2: storage для Twitch embed не включён')");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Url {
        Url::parse(raw).expect(raw)
    }

    #[test]
    fn allows_about_blank_and_app_protocols() {
        assert!(is_allowed_shell_navigation(&parse("about:blank")));
        assert!(is_allowed_shell_navigation(&parse("tauri://localhost/index.html")));
        assert!(is_allowed_shell_navigation(&parse("asset://localhost/x.png")));
        assert!(is_allowed_shell_navigation(&parse(
            "https://tauri.localhost/"
        )));
        assert!(is_allowed_shell_navigation(&parse(
            "https://tauri.localhost/settings.html"
        )));
        assert!(is_allowed_shell_navigation(&parse(
            "https://asset.localhost/asset.png"
        )));
    }

    #[test]
    fn denies_arbitrary_http_https() {
        assert!(!is_allowed_shell_navigation(&parse("https://evil.example/phish")));
        assert!(!is_allowed_shell_navigation(&parse("http://evil.example/")));
        assert!(!is_allowed_shell_navigation(&parse("file:///etc/passwd")));
        assert!(!is_allowed_shell_navigation(&parse("javascript:alert(1)")));
        assert!(!is_allowed_shell_navigation(&parse("data:text/html,x")));
    }

    #[test]
    fn denies_custom_protocol_http_and_nondefault_port() {
        assert!(!is_allowed_shell_navigation(&parse(
            "http://tauri.localhost/"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "http://asset.localhost/"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "https://tauri.localhost:8443/"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "https://asset.localhost:8443/x"
        )));
    }

    #[test]
    fn denies_host_spoof_lookalikes() {
        assert!(!is_allowed_shell_navigation(&parse(
            "https://tauri.localhost.evil.com/"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "https://evil-tauri.localhost/"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "https://tauri.localhost./"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "https://www.twitch.tv/"
        )));
    }

    #[test]
    fn windows_denies_twitch_top_level() {
        if !cfg!(windows) {
            return;
        }
        assert!(!is_allowed_shell_navigation(&parse(
            "https://player.twitch.tv/?channel=x"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "https://embed.twitch.tv/?channel=x"
        )));
    }

    #[test]
    fn non_windows_allows_twitch_embed_hosts_for_iframe_compat() {
        if cfg!(windows) {
            return;
        }
        assert!(is_allowed_shell_navigation(&parse(
            "https://player.twitch.tv/?channel=x"
        )));
        assert!(is_allowed_shell_navigation(&parse(
            "https://embed.twitch.tv/?channel=x"
        )));
        assert!(!is_allowed_shell_navigation(&parse(
            "https://www.twitch.tv/x"
        )));
    }

    #[test]
    fn dev_loopback_port_gated_by_is_dev() {
        let local = parse("http://localhost:1420/");
        let local_wrong_port = parse("http://localhost:5173/");
        let loopback = parse("http://127.0.0.1:1420/settings.html");
        let v6 = parse("http://[::1]:1420/");
        if tauri::is_dev() {
            assert!(is_allowed_shell_navigation(&local));
            assert!(is_allowed_shell_navigation(&loopback));
            assert!(!is_allowed_shell_navigation(&local_wrong_port));
            assert!(!is_allowed_shell_navigation(&v6));
        } else {
            assert!(!is_allowed_shell_navigation(&local));
            assert!(!is_allowed_shell_navigation(&loopback));
        }
    }

    #[test]
    fn nav_log_omits_path_and_query() {
        let url = parse("https://evil.example/phish?token=secret");
        assert_eq!(nav_log_origin(&url), "https://evil.example");
    }
}
