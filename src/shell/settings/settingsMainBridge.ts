import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MessageRing } from "../../chat/ring";
import {
  applySettingsDisplay,
  emptySettings,
  mergeLoadedSettings,
  type AppSettings,
} from "./settingsApply";
import {
  SETTINGS_CLOSED_EVENT,
  SETTINGS_PREVIEW_EVENT,
  SETTINGS_SAVED_EVENT,
  type SettingsClosedPayload,
} from "./settingsBridge";
import { requestOpenSettingsWindow, setSettingsWindowOpen } from "./settingsWindowState";
import { defaultKnobs } from "./catalog";
import { normalizeHotkeyRows, stepZoom } from "../hotkeys";
import type { Filters } from "../../chat/types";

export type { AppSettings } from "./settingsApply";

export function bindSettingsBridge(opts: {
  ring: MessageRing;
  openBtn: HTMLButtonElement;
  onDisplay?: (data: AppSettings) => void;
  onOpen?: () => void;
}): {
  bumpZoom: (dir: 1 | -1 | 0) => Promise<void>;
} {
  const { ring, openBtn, onDisplay } = opts;
  let applied: AppSettings = emptySettings();
  let baseline: AppSettings = emptySettings();

  const apply = (data: AppSettings): void => {
    applied = data;
    applySettingsDisplay(ring, data, onDisplay);
  };

  void (async () => {
    try {
      const loaded = await invoke<AppSettings>("settings_get");
      const filters = await invoke<Filters>("filters_get");
      const merged = mergeLoadedSettings(loaded, filters);
      baseline = merged;
      apply(merged);
    } catch {
      apply(emptySettings());
    }
  })();

  void listen<AppSettings>(SETTINGS_PREVIEW_EVENT, (ev) => {
    apply(ev.payload);
  });
  void listen<AppSettings>(SETTINGS_SAVED_EVENT, (ev) => {
    baseline = ev.payload;
    apply(ev.payload);
  });
  void listen<SettingsClosedPayload>(SETTINGS_CLOSED_EVENT, (ev) => {
    setSettingsWindowOpen(false);
    if (ev.payload.restore) {
      apply(baseline);
    }
  });

  openBtn.addEventListener("click", () => {
    opts.onOpen?.();
    baseline = applied;
    void requestOpenSettingsWindow();
  });

  let chain: Promise<void> = Promise.resolve();
  const bumpZoom = (dir: 1 | -1 | 0): Promise<void> => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        const next: AppSettings = {
          ...applied,
          fontScale: stepZoom(applied.fontScale, dir),
          knobs: { ...defaultKnobs(), ...applied.knobs },
          hotkeys: normalizeHotkeyRows(applied.hotkeys ?? []).map((r) => ({
            action: r.action,
            keybinding: r.keybinding,
            name: r.name,
          })),
        };
        try {
          const saved = await invoke<AppSettings>("settings_set", { settings: next });
          const merged: AppSettings = {
            ...emptySettings(),
            ...saved,
            knobs: { ...defaultKnobs(), ...(saved.knobs ?? {}) },
            hotkeys: normalizeHotkeyRows(saved.hotkeys ?? []).map((r) => ({
              action: r.action,
              keybinding: r.keybinding,
              name: r.name,
            })),
          };
          baseline = merged;
          apply(merged);
        } catch {
          apply(next);
        }
      });
    return chain;
  };

  return { bumpZoom };
}
