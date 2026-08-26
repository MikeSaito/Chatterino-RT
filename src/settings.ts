import "./styles.css";
import "./settings-window.css";
import { listen } from "@tauri-apps/api/event";
import { mountSettingsPanel } from "./shell/settings/dialog";
import { SETTINGS_OPENED_EVENT } from "./shell/settings/settingsBridge";

const root = document.querySelector<HTMLElement>("#settings-root");
if (!root) {
  throw new Error("#settings-root missing");
}

const panel = mountSettingsPanel({ root });

void panel.reload();

let unlistenOpened: (() => void) | null = null;
void listen(SETTINGS_OPENED_EVENT, () => {
  void panel.reload();
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
