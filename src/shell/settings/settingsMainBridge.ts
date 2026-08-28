import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MessageRing } from "../../chat/ring";
import {
  applySettingsDisplay,
  emptySettings,
  mergeLoadedSettingsWithMeta,
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
import { migrateStaleFalseDefaults } from "./sendButtonMigrate";

export type { AppSettings } from "./settingsApply";

function rematchSettings(saved: AppSettings): AppSettings {
  return {
    ...emptySettings(),
    ...saved,
    knobs: migrateStaleFalseDefaults({
      ...defaultKnobs(),
      ...(saved.knobs ?? {}),
    }).knobs,
    hotkeys: normalizeHotkeyRows(saved.hotkeys ?? []).map((r) => ({
      action: r.action,
      keybinding: r.keybinding,
      name: r.name,
    })),
  };
}

export function bindSettingsBridge(opts: {
  ring: MessageRing;
  /** null = open уже привязан до Pixi (chrome wiring). */
  openBtn: HTMLButtonElement | null;
  onDisplay?: (data: AppSettings) => void;
  onOpen?: () => void;
}): {
  bumpZoom: (dir: 1 | -1 | 0) => Promise<void>;
  patchKnobs: (patch: Record<string, boolean | string | number>) => Promise<void>;
  prepareOpen: () => void;
} {
  const { ring, openBtn, onDisplay } = opts;
  let applied: AppSettings = emptySettings();
  let baseline: AppSettings = emptySettings();

  const apply = (data: AppSettings): void => {
    applied = data;
    applySettingsDisplay(ring, data, onDisplay);
  };

  let chain: Promise<void> = Promise.resolve();
  const persist = (next: AppSettings): Promise<void> => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        try {
          const saved = await invoke<AppSettings>("settings_set", {
            settings: next,
          });
          const merged = rematchSettings(saved);
          baseline = merged;
          apply(merged);
        } catch {
          apply(next);
        }
      });
    return chain;
  };

  void (async () => {
    try {
      const loaded = await invoke<AppSettings>("settings_get");
      const filters = await invoke<Filters>("filters_get");
      const { settings: merged, knobsMigrated } =
        mergeLoadedSettingsWithMeta(loaded, filters);
      baseline = merged;
      apply(merged);
      if (knobsMigrated) {
        await persist(merged);
      }
    } catch {
      apply(emptySettings());
    }
  })();

  void listen<AppSettings>(SETTINGS_PREVIEW_EVENT, (ev) => {
    apply(rematchSettings(ev.payload));
  });
  void listen<AppSettings>(SETTINGS_SAVED_EVENT, (ev) => {
    const next = rematchSettings(ev.payload);
    baseline = next;
    apply(next);
  });
  void listen<SettingsClosedPayload>(SETTINGS_CLOSED_EVENT, (ev) => {
    setSettingsWindowOpen(false);
    if (ev.payload.restore) {
      apply(baseline);
    }
  });

  openBtn?.addEventListener("click", () => {
    opts.onOpen?.();
    baseline = applied;
    void requestOpenSettingsWindow();
  });

  const prepareOpen = (): void => {
    opts.onOpen?.();
    baseline = applied;
  };

  let zoomPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let zoomPersistResolve: (() => void) | null = null;

  const bumpZoom = (dir: 1 | -1 | 0): Promise<void> => {
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
    applied = next;
    applySettingsDisplay(ring, next, onDisplay);
    if (zoomPersistTimer !== null) {
      clearTimeout(zoomPersistTimer);
      zoomPersistTimer = null;
    }
    return new Promise((resolve) => {
      zoomPersistResolve?.();
      zoomPersistResolve = resolve;
      zoomPersistTimer = setTimeout(() => {
        zoomPersistTimer = null;
        const done = zoomPersistResolve;
        zoomPersistResolve = null;
        const toSave: AppSettings = {
          ...baseline,
          fontScale: applied.fontScale,
          knobs: { ...defaultKnobs(), ...baseline.knobs },
          hotkeys: normalizeHotkeyRows(baseline.hotkeys ?? []).map((r) => ({
            action: r.action,
            keybinding: r.keybinding,
            name: r.name,
          })),
        };
        void persist(toSave).finally(() => {
          done?.();
        });
      }, 400);
    });
  };

  /** Patch knobs onto last-saved baseline (not live preview) without wiping preview. */
  const patchKnobs = (
    patch: Record<string, boolean | string | number>,
  ): Promise<void> => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        const next: AppSettings = {
          ...baseline,
          knobs: migrateStaleFalseDefaults({
            ...defaultKnobs(),
            ...baseline.knobs,
            ...patch,
          }).knobs,
          hotkeys: normalizeHotkeyRows(baseline.hotkeys ?? []).map((r) => ({
            action: r.action,
            keybinding: r.keybinding,
            name: r.name,
          })),
        };
        try {
          const saved = await invoke<AppSettings>("settings_set", {
            settings: next,
          });
          baseline = rematchSettings(saved);
          applied = {
            ...applied,
            knobs: { ...applied.knobs, ...patch },
          };
          onDisplay?.(applied);
        } catch {
          applied = {
            ...applied,
            knobs: { ...applied.knobs, ...patch },
          };
          onDisplay?.(applied);
        }
      });
    return chain;
  };

  return { bumpZoom, patchKnobs, prepareOpen };
}
