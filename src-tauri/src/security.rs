use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

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
