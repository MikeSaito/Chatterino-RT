import "./styles.css";
import "./settings-window.css";
import { listen } from "@tauri-apps/api/event";
import { mountSettingsPanel } from "./shell/settings/dialog";
import { SETTINGS_OPENED_EVENT } from "./shell/settings/settingsBridge";
import { subscribeSystemTheme } from "./shell/theme";
import type { AppSettings } from "./shell/settings/settingsApply";
import { applySettingsAppearance } from "./shell/settings/settingsAppearance";

const root = document.querySelector<HTMLElement>("#settings-root");
if (!root) {
  throw new Error("#settings-root missing");
}

let draft: AppSettings | undefined;
applySettingsAppearance(root);
const panel = mountSettingsPanel({
  root,
  onDraftChange(data) {
    draft = data;
    applySettingsAppearance(root, data);
  },
});
const unsubscribeTheme = subscribeSystemTheme(() => applySettingsAppearance(root, draft));

void panel.reload();

let unlistenOpened: (() => void) | null = null;
void listen(SETTINGS_OPENED_EVENT, () => {
  void panel.reload();
}).then((unlisten) => {
  unlistenOpened = unlisten;
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeTheme();
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
