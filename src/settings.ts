import "./styles.css";
import "./settings-window.css";
import { listen } from "@tauri-apps/api/event";
import { mountSettingsPanel } from "./shell/settings/dialog";
import { SETTINGS_OPENED_EVENT } from "./shell/settings/settingsBridge";
import { applyResolvedTheme, resolveThemePreset, subscribeSystemTheme } from "./shell/theme";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./shell/settings/settingsApply";
import { applyLocale, localeFromSettings } from "./i18n";

const root = document.querySelector<HTMLElement>("#settings-root");
if (!root) {
  throw new Error("#settings-root missing");
}

async function applySettingsWindowTheme(): Promise<void> {
  try {
    const settings = await invoke<AppSettings>("settings_get");
    applyLocale(localeFromSettings(settings.knobs as Record<string, unknown>));
    const preset = resolveThemePreset({
      theme: String(settings.knobs["appearance.theme"] ?? "Dark"),
      darkSystem: String(settings.knobs["appearance.darkSystemTheme"] ?? "Dark"),
      lightSystem: String(settings.knobs["appearance.lightSystemTheme"] ?? "Light"),
    });
    applyResolvedTheme(preset);
  } catch {
    applyLocale("en");
    applyResolvedTheme("Dark");
  }
}

void applySettingsWindowTheme();
subscribeSystemTheme(() => {
  void applySettingsWindowTheme();
});

const panel = mountSettingsPanel({ root });

void panel.reload();

let unlistenOpened: (() => void) | null = null;
void listen(SETTINGS_OPENED_EVENT, () => {
  void panel.reload();
  void applySettingsWindowTheme();
}).then((unlisten) => {
  unlistenOpened = unlisten;
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unlistenOpened?.();
    unlistenOpened = null;
  });
}
window.addEventListener("keydown", (ev) => {
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) {
    return;
  }
  if (ev.key === "=" || ev.key === "+") {
    ev.preventDefault();
    void panel.bumpZoom(1);
  } else if (ev.key === "-" || ev.key === "_") {
    ev.preventDefault();
    void panel.bumpZoom(-1);
  } else if (ev.key === "0") {
    ev.preventDefault();
    void panel.bumpZoom(0);
  }
});
