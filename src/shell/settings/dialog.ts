import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MessageRing } from "../../chat/ring";
import type { AuthInfo, Filters } from "../../chat/types";
import { CHAT_AUTH_EVENT } from "../../constants";
import {
  bindingFromEvent,
  bindingsMatch,
  defaultHotkeyTableRows,
  formatBinding,
  normalizeHotkeyRows,
  stepZoom,
} from "../hotkeys";
import { subscribeSystemTheme } from "../theme";
import { presetToEngine } from "../webSearch";
import { setStreamerModeOnChange } from "../streamerMode";
import {
  SETTINGS_PAGES,
  ZOOM_LEVELS,
  defaultKnobs,
  visibleSectionKnobs,
  type KnobDef,
  type PageDef,
  type SectionDef,
  type TableDef,
} from "./catalog";
import { mountEditableTable } from "./editableTable";
import {
  exportImageUploaderSettings,
  importImageUploaderSettings,
  validateImportJson,
} from "../imageUploaderSharex";
import { iconEl, setButtonIcon } from "../icons";
import { t } from "../../i18n";
import { applyLocale, localeFromSettings } from "../../i18n";
import { settingsNavIcon } from "./navIcons";
import {
  applySettingsDisplay,
  emptySettings,
  filtersFromSettings,
  mergeLoadedSettings,
  tablePathGet,
  type AppSettings as AppliedSettings,
} from "./settingsApply";
import { migrateStaleFalseDefaults } from "./sendButtonMigrate";
import {
  emitSettingsClosed,
  emitSettingsPreview,
  emitSettingsSaved,
} from "./settingsBridge";
import { setSettingsWindowOpen } from "./settingsWindowState";

export type AppSettings = AppliedSettings;

type KnobControl = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;

function isSwitchControl(el: KnobControl): el is HTMLButtonElement {
  return el instanceof HTMLButtonElement && el.getAttribute("role") === "switch";
}

function switchChecked(el: HTMLButtonElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

function setSwitchChecked(el: HTMLButtonElement, on: boolean): void {
  el.setAttribute("aria-checked", on ? "true" : "false");
}

type TableApi = {
  getRows: () => Record<string, string | boolean>[];
  setRows: (rows: Record<string, string | boolean>[]) => void;
  setRowFilter: (
    fn: ((row: Record<string, string | boolean>, index: number) => boolean) | null,
  ) => void;
};

function formatError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "error";
}

function hasDuplicateCommandTriggers(
  rows: ReadonlyArray<Record<string, string | boolean>>,
): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const trigger = String(row.trigger ?? "").trim();
    if (!trigger) {
      continue;
    }
    if (seen.has(trigger)) {
      return true;
    }
    seen.add(trigger);
  }
  return false;
}

function nearestZoom(scale: number): number {
  let best = ZOOM_LEVELS[0] ? Number(ZOOM_LEVELS[0].value) : 1;
  let bestDist = Math.abs(scale - best);
  for (const item of ZOOM_LEVELS) {
    const v = Number(item.value);
    const dist = Math.abs(scale - v);
    if (dist < bestDist) {
      best = v;
      bestDist = dist;
    }
  }
  return best;
}

function focusables(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return [...nodes].filter((el) => !el.hidden && el.getClientRects().length > 0);
}

export function mountSettingsPanel(opts: {
  root: HTMLElement;
  ring?: MessageRing;
  onDisplay?: (data: AppSettings) => void;
}): {
  reload: () => Promise<void>;
  bumpZoom: (dir: 1 | -1 | 0) => Promise<void>;
} {
  const { root, ring, onDisplay } = opts;
  const detached = true;
  let lastSettings: AppSettings | null = null;
  if (ring) {
    setStreamerModeOnChange(() => {
      if (lastSettings) {
        applySettingsDisplay(ring, lastSettings, onDisplay);
      }
    });
    subscribeSystemTheme(() => {
      if (!lastSettings) {
        return;
      }
      if (String(lastSettings.knobs["appearance.theme"] ?? "") !== "System") {
        return;
      }
      applySettingsDisplay(ring, lastSettings, onDisplay);
    });
  }
  const applyDraft = (data: AppSettings): void => {
    lastSettings = data;
    applyLocale(localeFromSettings(data.knobs as Record<string, unknown>), root);
    const clearBtn = root.querySelector<HTMLButtonElement>("#settings-search-clear");
    if (clearBtn) {
      setButtonIcon(clearBtn, "close", {
        size: 14,
        label: t("settings.search.clear.aria"),
      });
    }
    root
      .querySelector("#settings-tabs")
      ?.setAttribute("aria-label", t("settings.tabs.aria"));
    if (ring) {
      applySettingsDisplay(ring, data, onDisplay);
    } else {
      void emitSettingsPreview(data);
    }
  };
  const search = root.querySelector<HTMLInputElement>("#settings-search");
  const searchClear = root.querySelector<HTMLButtonElement>("#settings-search-clear");
  const searchCount = root.querySelector<HTMLElement>("#settings-search-count");
  const searchIconHost = root.querySelector<HTMLElement>("#settings-search-icon");
  const tabsHost = root.querySelector<HTMLElement>("#settings-tabs");
  const pagesHost = root.querySelector<HTMLElement>("#settings-pages");
  const okBtn = root.querySelector<HTMLButtonElement>("#settings-ok");
  const cancelBtn = root.querySelector<HTMLButtonElement>("#settings-cancel");
  const statusEl = root.querySelector<HTMLElement>("#settings-status");
  if (!search || !tabsHost || !pagesHost || !okBtn || !cancelBtn || !statusEl) {
    return {
      reload: async () => undefined,
      bumpZoom: async () => undefined,
    };
  }
  tabsHost.setAttribute("role", "tablist");
  if (!tabsHost.getAttribute("aria-label")) {
    tabsHost.setAttribute("aria-label", t("settings.tabs.aria"));
  }
  if (searchIconHost) {
    searchIconHost.replaceChildren(iconEl("search", 14));
  }
  if (searchClear) {
    setButtonIcon(searchClear, "close", {
      size: 14,
      label: t("settings.search.clear.aria"),
    });
  }

  const knobInputs = new Map<string, KnobControl>();
  const tableApis = new Map<string, TableApi>();
  let baseline: AppSettings = emptySettings();
  let baselineFilters: Filters = {
    enableSelfHighlight: true,
    ignoreLogins: [],
    ignorePhrases: [],
    highlightPhrases: [],
    highlightLogins: [],
  };
  let activePage = "general";
  let saving = false;
  let loadReady = false;
  let blockedUsersRefreshSeq = 0;
  let resetHotkeyFilter: (() => void) | null = null;

  const refreshBlockedUsersList = async (): Promise<void> => {
    const list = document.querySelector<HTMLUListElement>(
      "#settings-blocked-users-list",
    );
    if (!list) {
      return;
    }
    const seq = ++blockedUsersRefreshSeq;
    try {
      const logins = await invoke<string[]>("chat_blocked_users");
      if (seq !== blockedUsersRefreshSeq) {
        return;
      }
      list.replaceChildren();
      if (!Array.isArray(logins) || logins.length === 0) {
        const empty = document.createElement("li");
        empty.className = "settings-blocked-users-empty";
        empty.textContent = "No blocked users.";
        list.append(empty);
        return;
      }
      for (const login of logins) {
        const li = document.createElement("li");
        li.className = "settings-blocked-users-row";
        li.textContent = login;
        list.append(li);
      }
    } catch {
      if (seq !== blockedUsersRefreshSeq) {
        return;
      }
      list.replaceChildren();
      const err = document.createElement("li");
      err.className = "settings-blocked-users-empty";
      err.textContent = "Could not load blocked users.";
      list.append(err);
    }
  };

  const refreshCacheResolved = (): void => {
    const el = document.querySelector<HTMLElement>("#settings-cache-resolved");
    if (!el) {
      return;
    }
    void invoke<{ path: string; isCustom: boolean }>("cache_info")
      .then((info) => {
        el.textContent = info.path;
      })
      .catch(() => {
        el.textContent = "(unavailable)";
      });
  };

  const handleSettingsAction = async (path: string): Promise<void> => {
    if (path === "__action.highlightSoundChange") {
      try {
        const picked = await invoke<string>("highlight_sound_pick");
        const input = knobInputs.get("highlighting.pathHighlightSound");
        if (input instanceof HTMLInputElement) {
          input.value = picked;
        }
        statusEl.textContent = "";
        schedulePreview();
      } catch (e) {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not pick sound file.";
        statusEl.textContent = msg;
      }
      return;
    }
    if (path === "__action.highlightSoundClear") {
      const input = knobInputs.get("highlighting.pathHighlightSound");
      if (input instanceof HTMLInputElement) {
        input.value = "";
      }
      statusEl.textContent = "";
      schedulePreview();
      return;
    }
    if (path === "__action.selectLogDirectory") {
      try {
        const picked = await invoke<string>("logging_pick_directory");
        const input = knobInputs.get("logging.logPath");
        if (input instanceof HTMLInputElement) {
          input.value = picked;
        }
        statusEl.textContent = "";
        schedulePreview();
      } catch (e) {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not select log directory.";
        statusEl.textContent = msg;
      }
      return;
    }
    if (path === "__action.resetLogDirectory") {
      const input = knobInputs.get("logging.logPath");
      if (input instanceof HTMLInputElement) {
        input.value = "";
      }
      statusEl.textContent = "";
      schedulePreview();
      return;
    }
    if (path === "__action.selectNotificationSound") {
      try {
        const picked = await invoke<string>("highlight_sound_pick");
        const input = knobInputs.get("notifications.notificationPathSound");
        if (input instanceof HTMLInputElement) {
          input.value = picked;
        }
        const custom = knobInputs.get("notifications.notificationCustomSound");
        if (custom && isSwitchControl(custom)) {
          setSwitchChecked(custom, true);
        }
        statusEl.textContent = "";
        schedulePreview();
      } catch (e) {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not pick sound file.";
        statusEl.textContent = msg;
      }
      return;
    }
    if (path === "__action.openAppData") {
      try {
        await invoke("open_settings_directory");
        statusEl.textContent = "";
      } catch (e) {
        statusEl.textContent =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not open settings directory.";
      }
      return;
    }
    if (path === "__action.chooseCachePath") {
      if (saving || !loadReady) {
        statusEl.textContent = "Settings are busy; try again.";
        return;
      }
      saving = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      let picked = "";
      try {
        picked = await invoke<string>("cache_pick_directory");
      } catch (e) {
        saving = false;
        okBtn.disabled = !loadReady;
        cancelBtn.disabled = false;
        statusEl.textContent =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not select cache directory.";
        return;
      }
      if (!loadReady) {
        saving = false;
        okBtn.disabled = true;
        cancelBtn.disabled = false;
        return;
      }
      const prev =
        knobInputs.get("cache.path") instanceof HTMLInputElement
          ? (knobInputs.get("cache.path") as HTMLInputElement).value
          : String(baseline.knobs["cache.path"] ?? "");
      try {
        const persistDraft: AppSettings = {
          ...baseline,
          knobs: { ...baseline.knobs, "cache.path": picked },
        };
        const saved = await invoke<AppSettings>("settings_set", {
          settings: persistDraft,
        });
        baseline = {
          ...emptySettings(),
          ...saved,
          knobs: { ...defaultKnobs(), ...(saved.knobs ?? {}) },
          enableSelfHighlight: baselineFilters.enableSelfHighlight,
        };
        const input = knobInputs.get("cache.path");
        if (input instanceof HTMLInputElement) {
          input.value = picked;
        }
        statusEl.textContent = "";
        refreshCacheResolved();
        schedulePreview();
      } catch (e) {
        const input = knobInputs.get("cache.path");
        if (input instanceof HTMLInputElement) {
          input.value = prev;
        }
        statusEl.textContent =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not save cache path.";
      } finally {
        saving = false;
        okBtn.disabled = !loadReady;
        cancelBtn.disabled = false;
      }
      return;
    }
    if (path === "__action.resetCachePath") {
      if (saving || !loadReady) {
        statusEl.textContent = "Settings are busy; try again.";
        return;
      }
      saving = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      const prev =
        knobInputs.get("cache.path") instanceof HTMLInputElement
          ? (knobInputs.get("cache.path") as HTMLInputElement).value
          : String(baseline.knobs["cache.path"] ?? "");
      try {
        const persistDraft: AppSettings = {
          ...baseline,
          knobs: { ...baseline.knobs, "cache.path": "" },
        };
        const saved = await invoke<AppSettings>("settings_set", {
          settings: persistDraft,
        });
        baseline = {
          ...emptySettings(),
          ...saved,
          knobs: { ...defaultKnobs(), ...(saved.knobs ?? {}) },
          enableSelfHighlight: baselineFilters.enableSelfHighlight,
        };
        const input = knobInputs.get("cache.path");
        if (input instanceof HTMLInputElement) {
          input.value = "";
        }
        statusEl.textContent = "";
        refreshCacheResolved();
        schedulePreview();
      } catch (e) {
        const input = knobInputs.get("cache.path");
        if (input instanceof HTMLInputElement) {
          input.value = prev;
        }
        statusEl.textContent =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not reset cache path.";
      } finally {
        saving = false;
        okBtn.disabled = !loadReady;
        cancelBtn.disabled = false;
      }
      return;
    }
    if (path === "__action.clearCache") {
      if (saving || !loadReady) {
        statusEl.textContent = "Settings are busy; try again.";
        return;
      }
      if (
        !window.confirm(
          "Are you sure that you want to clear your cache? Emotes may take longer to load next time Chatterino RT is started.",
        )
      ) {
        return;
      }
      if (saving) {
        statusEl.textContent = "Settings are busy; try again.";
        return;
      }
      saving = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await invoke("cache_clear");
        statusEl.textContent = "Cache cleared.";
        refreshCacheResolved();
      } catch (e) {
        statusEl.textContent =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not clear cache.";
      } finally {
        saving = false;
        okBtn.disabled = !loadReady;
        cancelBtn.disabled = false;
      }
      return;
    }
    if (path === "__action.resetHotkeys") {
      const api = tableApis.get("hotkeys");
      if (api) {
        api.setRows(defaultHotkeyTableRows());
      }
      statusEl.textContent = "";
      schedulePreview();
      return;
    }
    if (path === "__action.exportImageUploader") {
      const read = (key: string): string => {
        const input = knobInputs.get(key);
        if (!(input instanceof HTMLInputElement)) {
          return "";
        }
        return input.value;
      };
      const payload = exportImageUploaderSettings({
        url: read("external.imageUploaderUrl"),
        formField: read("external.imageUploaderFormField"),
        link: read("external.imageUploaderLink"),
        deletionLink: read("external.imageUploaderDeletionLink"),
        headers: read("external.imageUploaderHeaders"),
      });
      const text = JSON.stringify(payload, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        statusEl.textContent =
          "Image uploader settings have been copied to clipboard as JSON.";
      } catch {
        window.prompt("Copy image uploader settings JSON:", text);
        statusEl.textContent =
          "Clipboard unavailable; JSON shown in the prompt for manual copy.";
      }
      return;
    }
    if (path === "__action.importImageUploader") {
      let clipboardText = "";
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch {
        const pasted = window.prompt(
          "Clipboard unavailable. Paste image uploader settings JSON:",
          "",
        );
        if (pasted === null) {
          return;
        }
        clipboardText = pasted;
      }
      const validated = validateImportJson(clipboardText);
      if (!validated.ok) {
        statusEl.textContent = `Error validating image uploader import: ${validated.error}.`;
        return;
      }
      const imported = importImageUploaderSettings(validated.value);
      if (!imported) {
        statusEl.textContent =
          "No valid image uploader settings found in the JSON.";
        return;
      }
      if (
        !window.confirm(
          "This will overwrite your current image uploader settings. Continue?",
        )
      ) {
        return;
      }
      if (saving || !loadReady) {
        statusEl.textContent = "Settings are busy; try import again.";
        return;
      }
      saving = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      const patch: Record<string, string | boolean> = {
        "external.imageUploaderEnabled": true,
        "external.imageUploaderUrl": imported.url,
        "external.imageUploaderFormField": imported.formField,
        "external.imageUploaderLink": imported.link,
      };
      if (imported.deletionLink !== null) {
        patch["external.imageUploaderDeletionLink"] = imported.deletionLink;
      }
      if (imported.headers !== null) {
        patch["external.imageUploaderHeaders"] = imported.headers;
      }
      const persistDraft: AppSettings = {
        ...baseline,
        knobs: { ...baseline.knobs, ...patch },
      };
      try {
        const saved = await invoke<AppSettings>("settings_set", {
          settings: persistDraft,
        });
        baseline = {
          ...emptySettings(),
          ...saved,
          knobs: { ...defaultKnobs(), ...(saved.knobs ?? {}) },
          enableSelfHighlight: baselineFilters.enableSelfHighlight,
        };
        const writeText = (key: string, value: string): void => {
          const input = knobInputs.get(key);
          if (input instanceof HTMLInputElement) {
            input.value = value;
          }
        };
        writeText("external.imageUploaderUrl", imported.url);
        writeText("external.imageUploaderFormField", imported.formField);
        writeText("external.imageUploaderLink", imported.link);
        if (imported.deletionLink !== null) {
          writeText(
            "external.imageUploaderDeletionLink",
            imported.deletionLink,
          );
        }
        if (imported.headers !== null) {
          writeText("external.imageUploaderHeaders", imported.headers);
        }
        const enabled = knobInputs.get("external.imageUploaderEnabled");
        if (enabled && isSwitchControl(enabled)) {
          setSwitchChecked(enabled, true);
        }
        statusEl.textContent =
          "Image uploader settings have been imported successfully!";
        schedulePreview();
      } catch (e) {
        statusEl.textContent =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Could not save imported image uploader settings.";
      } finally {
        saving = false;
        okBtn.disabled = !loadReady;
        cancelBtn.disabled = false;
      }
      return;
    }
    statusEl.textContent = "This action is not available in Chatterino RT yet.";
  };

  const renderKnob = (knob: KnobDef, block: HTMLElement): void => {
    if (knob.id === "cache-path-display") {
      const wrap = document.createElement("div");
      wrap.className = "settings-cache-path";
      wrap.dataset.search = "cache path directory";
      const caption = document.createElement("p");
      caption.className = "settings-label-note";
      caption.textContent = "Cache saved at";
      const resolved = document.createElement("code");
      resolved.className = "settings-about-path";
      resolved.id = "settings-cache-resolved";
      resolved.textContent = "…";
      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.id = "settings-knob-cache-path";
      hidden.dataset.path = "cache.path";
      knobInputs.set("cache.path", hidden);
      wrap.append(caption, resolved, hidden);
      block.append(wrap);
      return;
    }
    if (knob.type === "blocked-list") {
      const wrap = document.createElement("div");
      wrap.className = "settings-blocked-users";
      wrap.dataset.search = `${knob.label} ${knob.search ?? ""}`;
      const caption = document.createElement("p");
      caption.className = "settings-label-note";
      caption.textContent = knob.label;
      const list = document.createElement("ul");
      list.className = "settings-blocked-users-list";
      list.id = "settings-blocked-users-list";
      list.setAttribute("aria-label", "Twitch blocked users");
      wrap.append(caption, list);
      block.append(wrap);
      return;
    }
    if (knob.type === "label") {
      const p = document.createElement("p");
      p.className = "settings-label-note";
      if (knob.label.includes("\n")) {
        p.classList.add("settings-label-note--pre");
      }
      p.textContent = knob.label;
      p.dataset.search = `${knob.label} ${knob.search ?? ""}`;
      block.append(p);
      return;
    }
    if (knob.type === "button") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-action-btn";
      btn.textContent = knob.label;
      btn.dataset.search = `${knob.label} ${knob.search ?? ""}`;
      btn.dataset.path = knob.path;
      btn.addEventListener("click", () => {
        void handleSettingsAction(knob.path);
      });
      block.append(btn);
      return;
    }
    if (knob.type === "checkbox") {
      const row = document.createElement("div");
      row.className = "settings-switch";
      row.dataset.search = `${knob.label} ${knob.search ?? ""}`;
      const labelId = `settings-knob-label-${knob.id}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "switch";
      btn.id = `settings-knob-${knob.id}`;
      btn.dataset.path = knob.path;
      btn.setAttribute("role", "switch");
      btn.setAttribute("aria-checked", "false");
      btn.setAttribute("aria-labelledby", labelId);
      if (knob.inverse) {
        btn.dataset.inverse = "1";
      }
      const knobEl = document.createElement("span");
      knobEl.className = "switch-knob";
      knobEl.setAttribute("aria-hidden", "true");
      btn.append(knobEl);
      const text = document.createElement("span");
      text.className = "settings-switch-label";
      text.id = labelId;
      text.textContent = knob.label;
      row.append(btn, text);
      text.addEventListener("click", () => {
        if (btn.disabled) {
          return;
        }
        btn.click();
      });
      block.append(row);
      knobInputs.set(knob.path, btn);
      btn.addEventListener("click", () => {
        setSwitchChecked(btn, !switchChecked(btn));
        schedulePreview();
      });
      return;
    }
    const row = document.createElement("div");
    row.className = "settings-row";
    row.dataset.search = `${knob.label} ${knob.search ?? ""}`;
    const lab = document.createElement("label");
    lab.htmlFor = `settings-knob-${knob.id}`;
    lab.textContent = knob.label;
    let input: HTMLInputElement | HTMLSelectElement;
    if (knob.type === "select") {
      const select = document.createElement("select");
      select.id = `settings-knob-${knob.id}`;
      for (const option of knob.options ?? []) {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        select.append(opt);
      }
      input = select;
    } else {
      const el = document.createElement("input");
      el.id = `settings-knob-${knob.id}`;
      if (knob.type === "number") {
        el.type = "number";
        if (knob.min != null) {
          el.min = String(knob.min);
        }
        if (knob.max != null) {
          el.max = String(knob.max);
        }
        if (knob.step != null) {
          el.step = String(knob.step);
        }
      } else if (knob.type === "color") {
        el.type = "color";
      } else {
        el.type = "text";
      }
      if (knob.path === "logging.logPath") {
        el.readOnly = true;
      }
      input = el;
    }
    input.dataset.path = knob.path;
    row.append(lab, input);
    block.append(row);
    knobInputs.set(knob.path, input);
    if (
      knob.path === "behaviour.searchEnginePreset" &&
      input instanceof HTMLSelectElement
    ) {
      input.addEventListener("change", () => {
        const engine = presetToEngine(input.value);
        if (!engine) {
          schedulePreview();
          return;
        }
        const urlInput = knobInputs.get("behaviour.searchEngineUrl");
        const nameInput = knobInputs.get("behaviour.searchEngineName");
        if (urlInput) {
          urlInput.value = engine.url;
        }
        if (nameInput) {
          nameInput.value = engine.name;
        }
        schedulePreview();
      });
    } else {
      input.addEventListener("change", () => {
        schedulePreview();
      });
    }
    input.addEventListener("input", () => {
      schedulePreview();
    });
  };

  const mountTable = (host: HTMLElement, def: TableDef): void => {
    const api = mountEditableTable(
      host,
      {
        columns: def.columns,
        blankRow: { ...def.blankRow },
        rows: [],
      },
      () => {
        statusEl.textContent = "";
        schedulePreview();
      },
    );
    tableApis.set(def.path, api);
  };

  const buildPages = (): void => {
    tabsHost.replaceChildren();
    pagesHost.replaceChildren();
    knobInputs.clear();
    tableApis.clear();
    resetHotkeyFilter = null;

    const groups = [
      ["general"],
      ["accounts", "nicknames"],
      ["commands", "highlights", "ignores", "filters"],
      ["hotkeys", "moderation", "notifications", "external"],
      ["about"],
    ];
    for (let gi = 0; gi < groups.length; gi += 1) {
      if (gi > 0) {
        const gap = document.createElement("div");
        gap.className = "settings-tab-gap";
        gap.setAttribute("aria-hidden", "true");
        tabsHost.append(gap);
      }
      if (gi === groups.length - 1) {
        const spacer = document.createElement("div");
        spacer.className = "settings-tab-spacer";
        spacer.setAttribute("aria-hidden", "true");
        tabsHost.append(spacer);
      }
      for (const id of groups[gi]) {
        const page = SETTINGS_PAGES.find((p) => p.id === id);
        if (!page) {
          continue;
        }
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "settings-tab";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", "false");
        tab.dataset.page = page.id;
        tab.dataset.search = `${page.navLabel} ${page.search}`;
        const icon = iconEl(settingsNavIcon(page.id), 16);
        icon.classList.add("settings-tab-icon");
        const label = document.createElement("span");
        label.className = "settings-tab-label";
        label.textContent = page.navLabel;
        tab.append(icon, label);
        tab.addEventListener("click", () => {
          showPage(page.id);
        });
        tabsHost.append(tab);
        pagesHost.append(buildPage(page));
      }
    }
  };

  const appendSettingsSections = (
    host: HTMLElement,
    blocks: SectionDef[] | undefined,
  ): void => {
    for (const block of blocks ?? []) {
      const knobs = visibleSectionKnobs(block);
      if (knobs.length === 0) {
        continue;
      }
      const wrap = document.createElement("div");
      wrap.className = "settings-block";
      wrap.dataset.search = block.title;
      const h = document.createElement("h4");
      h.className = "settings-section";
      h.textContent = block.title;
      wrap.append(h);
      for (const knob of knobs) {
        renderKnob(knob, wrap);
      }
      host.append(wrap);
    }
  };

  const buildPage = (page: PageDef): HTMLElement => {
    const section = document.createElement("section");
    section.className = "settings-page";
    section.dataset.page = page.id;
    section.dataset.search = `${page.title} ${page.search}`;
    const title = document.createElement("h3");
    title.className = "settings-page-title";
    title.textContent = page.title;
    section.append(title);

    if (page.kind === "about") {
      const name = document.createElement("p");
      name.className = "settings-about-name";
      name.textContent = "Chatterino RT";

      const versionBlock = document.createElement("div");
      versionBlock.className = "settings-about-block";
      versionBlock.dataset.search = "version settings directory";
      const versionTitle = document.createElement("h4");
      versionTitle.className = "settings-section";
      versionTitle.textContent = "Version";
      const versionLine = document.createElement("p");
      versionLine.className = "settings-about-meta";
      versionLine.textContent = "Loading…";
      const dirRow = document.createElement("div");
      dirRow.className = "settings-about-dir";
      const dirLabel = document.createElement("p");
      dirLabel.className = "settings-about-meta";
      dirLabel.textContent = "Settings directory:";
      const dirPath = document.createElement("code");
      dirPath.className = "settings-about-path";
      dirPath.textContent = "…";
      const openDirBtn = document.createElement("button");
      openDirBtn.type = "button";
      openDirBtn.className = "settings-action-btn";
      openDirBtn.textContent = "Open settings directory";
      openDirBtn.addEventListener("click", () => {
        void invoke("open_settings_directory")
          .then(() => {
            statusEl.textContent = "";
          })
          .catch((e: unknown) => {
            statusEl.textContent =
              e && typeof e === "object" && "message" in e
                ? String((e as { message: unknown }).message)
                : "Could not open settings directory.";
          });
      });
      dirRow.append(dirLabel, dirPath, openDirBtn);
      versionBlock.append(versionTitle, versionLine, dirRow);

      const chatterinoBlock = document.createElement("div");
      chatterinoBlock.className = "settings-about-block";
      chatterinoBlock.dataset.search = "wiki features discord chatterino";
      const chatterinoTitle = document.createElement("h4");
      chatterinoTitle.className = "settings-section";
      chatterinoTitle.textContent = "About Chatterino…";
      const chatterinoLinks = document.createElement("ul");
      chatterinoLinks.className = "settings-about-links";
      const aboutLinks: Array<{ label: string; url: string }> = [
        { label: "Chatterino Wiki", url: "https://wiki.chatterino.com" },
        {
          label: "Features",
          url: "https://chatterino.com/#features",
        },
        {
          label: "Discord",
          url: "https://discord.gg/7Y5AYhAK4z",
        },
      ];
      for (const item of aboutLinks) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-about-link";
        btn.textContent = item.label;
        btn.addEventListener("click", () => {
          void invoke("open_chat_link", { url: item.url })
            .then(() => {
              statusEl.textContent = "";
            })
            .catch((e: unknown) => {
              statusEl.textContent =
                e && typeof e === "object" && "message" in e
                  ? String((e as { message: unknown }).message)
                  : "Could not open link.";
            });
        });
        li.append(btn);
        chatterinoLinks.append(li);
      }
      chatterinoBlock.append(chatterinoTitle, chatterinoLinks);

      const mit = document.createElement("p");
      mit.className = "settings-about-meta";
      mit.dataset.search = "mit license chatterino";
      mit.textContent =
        "Chat behaviour reimplements Chatterino 2 logic under the MIT License. This is not a Qt/C++ port and does not ship stock Chatterino assets.";

      const ossBlock = document.createElement("div");
      ossBlock.className = "settings-about-block";
      ossBlock.dataset.search = "open source license tauri pixi";
      const ossTitle = document.createElement("h4");
      ossTitle.className = "settings-section";
      ossTitle.textContent = "Open source software used…";
      const ossLinks = document.createElement("ul");
      ossLinks.className = "settings-about-links";
      const ossItems: Array<{ label: string; url: string }> = [
        { label: "Tauri", url: "https://tauri.app/" },
        { label: "PixiJS", url: "https://pixijs.com/" },
        { label: "@msgpack/msgpack", url: "https://github.com/msgpack/msgpack-javascript" },
        { label: "Tokio", url: "https://tokio.rs/" },
        { label: "Reqwest", url: "https://github.com/seanmonstar/reqwest" },
        { label: "Serde", url: "https://serde.rs/" },
      ];
      for (const item of ossItems) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-about-link";
        btn.textContent = item.label;
        btn.addEventListener("click", () => {
          void invoke("open_chat_link", { url: item.url })
            .then(() => {
              statusEl.textContent = "";
            })
            .catch((e: unknown) => {
              statusEl.textContent =
                e && typeof e === "object" && "message" in e
                  ? String((e as { message: unknown }).message)
                  : "Could not open link.";
            });
        });
        li.append(btn);
        ossLinks.append(li);
      }
      ossBlock.append(ossTitle, ossLinks);

      section.append(name, versionBlock, chatterinoBlock, mit, ossBlock);

      void invoke<{ version: string; settingsDirectory: string }>("about_info")
        .then((info) => {
          versionLine.textContent = `Chatterino RT ${info.version}`;
          dirPath.textContent = info.settingsDirectory;
        })
        .catch(() => {
          versionLine.textContent = "Chatterino RT (version unavailable)";
          dirPath.textContent = "(unavailable)";
        });

      return section;
    }

    if (page.kind === "accounts") {
      const note = document.createElement("p");
      note.className = "settings-empty";
      note.textContent =
        "Select an account to use for chat. Add uses the same Chatterino login flow as the sidebar.";
      const list = document.createElement("ul");
      list.className = "settings-accounts-list";
      list.id = "settings-accounts-list";
      const actions = document.createElement("div");
      actions.className = "settings-accounts-actions";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.textContent = "Add";
      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.textContent = "Select";
      selectBtn.disabled = true;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.disabled = true;
      const status = document.createElement("p");
      status.className = "settings-accounts-status";
      status.hidden = true;
      actions.append(addBtn, selectBtn, removeBtn);
      section.append(note, list, actions, status);

      let selectedLogin: string | null = null;

      const setStatus = (text: string): void => {
        if (!text) {
          status.hidden = true;
          status.textContent = "";
          return;
        }
        status.hidden = false;
        status.textContent = text;
      };

      const syncActionButtons = (fromEnv: boolean): void => {
        if (fromEnv) {
          addBtn.disabled = true;
          selectBtn.disabled = true;
          removeBtn.disabled = true;
          return;
        }
        addBtn.disabled = false;
        selectBtn.disabled = !selectedLogin;
        removeBtn.disabled = !selectedLogin;
      };

      const paintAccounts = (info: AuthInfo): void => {
        list.replaceChildren();
        if (info.fromEnv) {
          note.textContent =
            "Account is fixed by TWITCH_LOGIN / TWITCH_OAUTH_TOKEN. Multi-account controls are disabled.";
          selectedLogin = null;
          syncActionButtons(true);
          return;
        }
        note.textContent =
          "Highlight a row, then Select to switch or Remove. Add uses the Chatterino login flow.";
        const accounts = Array.isArray(info.accounts) ? info.accounts : [];
        if (accounts.length === 0) {
          const empty = document.createElement("li");
          empty.className = "settings-accounts-empty";
          empty.textContent = "No saved accounts.";
          list.append(empty);
          selectedLogin = null;
          syncActionButtons(false);
          return;
        }
        if (
          selectedLogin &&
          !accounts.some((a) => a.login.toLowerCase() === selectedLogin)
        ) {
          selectedLogin = null;
        }
        for (const row of accounts) {
          const login = row.login.toLowerCase();
          const li = document.createElement("li");
          li.className = "settings-accounts-row";
          if (info.login?.toLowerCase() === login) {
            li.classList.add("is-current");
          }
          if (selectedLogin === login) {
            li.classList.add("is-selected");
          }
          const label = document.createElement("span");
          label.className = "settings-accounts-login";
          label.textContent = row.login;
          const meta = document.createElement("span");
          meta.className = "settings-accounts-meta";
          const bits: string[] = [];
          if (info.login?.toLowerCase() === login) {
            bits.push("current");
          }
          if (row.userId) {
            bits.push(`id ${row.userId}`);
          }
          meta.textContent = bits.join(" · ");
          li.append(label, meta);
          li.addEventListener("click", () => {
            selectedLogin = login;
            for (const el of list.querySelectorAll(".settings-accounts-row")) {
              el.classList.toggle("is-selected", el === li);
            }
            syncActionButtons(false);
          });
          li.addEventListener("dblclick", () => {
            selectedLogin = login;
            syncActionButtons(false);
            setStatus("");
            void invoke("auth_select", { login }).catch((err) => {
              setStatus(formatError(err));
            });
          });
          list.append(li);
        }
        syncActionButtons(false);
      };

      const refresh = async (): Promise<void> => {
        try {
          paintAccounts(await invoke<AuthInfo>("auth_status"));
        } catch (err) {
          setStatus(formatError(err));
        }
      };

      addBtn.addEventListener("click", () => {
        setStatus("");
        void (async () => {
          try {
            const started = await invoke<{ mode: string }>("auth_start");
            if (started.mode === "paste") {
              const blob = window.prompt(
                "Paste the Chatterino login line (oauth_token=…;username=…;…)",
              );
              if (!blob) {
                return;
              }
              await invoke("auth_import", { blob });
              setStatus("");
              await refresh();
            } else {
              setStatus("Complete device login in the browser.");
            }
          } catch (err) {
            setStatus(formatError(err));
          }
        })();
      });

      selectBtn.addEventListener("click", () => {
        if (!selectedLogin) {
          return;
        }
        const login = selectedLogin;
        setStatus("");
        void invoke("auth_select", { login }).catch((err) => {
          setStatus(formatError(err));
        });
      });

      removeBtn.addEventListener("click", () => {
        if (!selectedLogin) {
          return;
        }
        const login = selectedLogin;
        setStatus("");
        void invoke("auth_remove", { login })
          .then(() => {
            selectedLogin = null;
            return refresh();
          })
          .catch((err) => setStatus(formatError(err)));
      });

      void refresh();
      void listen<AuthInfo>(CHAT_AUTH_EVENT, (ev) => {
        paintAccounts(ev.payload);
      });

      return section;
    }

    if (page.kind === "table" && page.table) {
      const host = document.createElement("div");
      host.dataset.search = page.search;
      if (page.id === "commands") {
        const importWrap = document.createElement("div");
        importWrap.className = "settings-commands-import";
        const importBtn = document.createElement("button");
        importBtn.type = "button";
        importBtn.textContent = "Import commands from Chatterino 1";
        importBtn.hidden = true;
        const dupHint = document.createElement("p");
        dupHint.className = "settings-commands-dup-hint";
        dupHint.hidden = true;
        dupHint.textContent =
          "Multiple commands with the same trigger found. Only one of the commands will work.";
        importBtn.addEventListener("click", () => {
          void (async () => {
            try {
              const imported = await invoke<
                Array<{
                  trigger: string;
                  command: string;
                  showInMessageMenu: boolean;
                }>
              >("read_chatterino1_commands");
              const api = tableApis.get("commands");
              if (!api) {
                return;
              }
              const rows = api.getRows();
              const byTrigger = new Map<string, number>();
              rows.forEach((row, index) => {
                const trigger = String(row.trigger ?? "").trim();
                if (trigger) {
                  byTrigger.set(trigger, index);
                }
              });
              let replaced = false;
              for (const row of imported) {
                const trigger = String(row.trigger ?? "").trim();
                if (!trigger) {
                  continue;
                }
                const entry: Record<string, string | boolean> = {
                  trigger,
                  command: String(row.command ?? ""),
                  showInMessageMenu: Boolean(row.showInMessageMenu),
                };
                const idx = byTrigger.get(trigger);
                if (idx !== undefined) {
                  const prevMenu = rows[idx]?.showInMessageMenu;
                  entry.showInMessageMenu =
                    typeof prevMenu === "boolean" ? prevMenu : false;
                  rows[idx] = entry;
                  replaced = true;
                } else {
                  byTrigger.set(trigger, rows.length);
                  rows.push(entry);
                }
              }
              api.setRows(rows);
              dupHint.hidden = !hasDuplicateCommandTriggers(rows);
              statusEl.textContent = replaced
                ? `Imported ${imported.length} command(s); duplicate triggers replaced.`
                : `Imported ${imported.length} command(s).`;
              schedulePreview();
            } catch (err) {
              statusEl.textContent = formatError(err);
            }
          })();
        });
        importWrap.append(importBtn, dupHint);
        section.append(importWrap);
        void invoke<boolean>("chatterino1_commands_available")
          .then((ok) => {
            importBtn.hidden = !ok;
          })
          .catch(() => {
            importBtn.hidden = true;
          });
      }
      mountTable(host, page.table);
      section.append(host);
      appendSettingsSections(section, page.sections);
      return section;
    }

    if (page.kind === "hotkeys" && page.table) {
      const filterBar = document.createElement("div");
      filterBar.className = "settings-hotkey-search";
      const label = document.createElement("label");
      label.textContent = "Search keybind:";
      const input = document.createElement("input");
      input.type = "text";
      input.readOnly = true;
      input.placeholder = "Press a key combination…";
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.textContent = "Clear";
      filterBar.append(label, input, clearBtn);
      section.append(filterBar);

      const host = document.createElement("div");
      mountTable(host, page.table);
      const hotkeysApi = tableApis.get("hotkeys");
      if (hotkeysApi) {
        resetHotkeyFilter = () => {
          input.value = "";
          hotkeysApi.setRowFilter(null);
        };
        input.addEventListener("keydown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const captured = bindingFromEvent(ev);
          if (!captured) {
            return;
          }
          input.value = formatBinding(captured);
          hotkeysApi.setRowFilter((row) =>
            bindingsMatch(String(row.keybinding ?? ""), captured),
          );
        });
        clearBtn.addEventListener("click", () => {
          resetHotkeyFilter?.();
        });
      }
      section.append(host);
      appendSettingsSections(section, page.sections);
      return section;
    }

    if (page.kind === "nested-tabs" && page.tabs) {
      const tabBar = document.createElement("div");
      tabBar.className = "settings-inner-tabs";
      const panels = document.createElement("div");
      panels.className = "settings-inner-panels";
      page.tabs.forEach((tab, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = index === 0 ? "settings-inner-tab is-active" : "settings-inner-tab";
        btn.textContent = tab.label;
        const panel = document.createElement("div");
        panel.className = index === 0 ? "settings-inner-panel is-active" : "settings-inner-panel";
        panel.hidden = index !== 0;
        if (tab.table) {
          const host = document.createElement("div");
          mountTable(host, tab.table);
          panel.append(host);
        }
        appendSettingsSections(panel, tab.sections);
        btn.addEventListener("click", () => {
          tabBar.querySelectorAll(".settings-inner-tab").forEach((el) => {
            el.classList.remove("is-active");
          });
          panels.querySelectorAll(".settings-inner-panel").forEach((el) => {
            el.classList.remove("is-active");
            (el as HTMLElement).hidden = true;
          });
          btn.classList.add("is-active");
          panel.classList.add("is-active");
          panel.hidden = false;
          if (page.id === "ignores" && tab.id === "users") {
            void refreshBlockedUsersList();
          }
        });
        tabBar.append(btn);
        panels.append(panel);
      });
      section.append(tabBar, panels);
      appendSettingsSections(section, page.sections);
      return section;
    }

    appendSettingsSections(section, page.sections);
    return section;
  };

  const showPage = (id: string): void => {
    activePage = id;
    tabsHost.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
      const on = tab.dataset.page === id;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    pagesHost.querySelectorAll<HTMLElement>(".settings-page").forEach((page) => {
      page.classList.toggle("is-active", page.dataset.page === id);
    });
  };

  const readDraft = (): AppSettings => {
    const draft = emptySettings();
    draft.knobs = { ...baseline.knobs };
    for (const [path, input] of knobInputs) {
      if (path === "__wired.fontScale" && input instanceof HTMLSelectElement) {
        draft.fontScale = nearestZoom(Number(input.value));
        continue;
      }
      if (path === "__wired.timestampFormat" && input instanceof HTMLSelectElement) {
        draft.timestampFormat = input.value;
        draft.showTimestamps = input.value !== "Disable";
        continue;
      }
      if (path === "__wired.hideModerated" && isSwitchControl(input)) {
        draft.hideModerated = switchChecked(input);
        continue;
      }
      if (path === "__wired.enableSelfHighlight" && isSwitchControl(input)) {
        draft.enableSelfHighlight = switchChecked(input);
        continue;
      }
      if (path.startsWith("__")) {
        continue;
      }
      if (isSwitchControl(input)) {
        const checked = switchChecked(input);
        draft.knobs[path] = input.dataset.inverse === "1" ? !checked : checked;
      } else if (input instanceof HTMLInputElement && input.type === "number") {
        draft.knobs[path] = Number(input.value);
      } else if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        draft.knobs[path] = input.value;
      }
    }
    for (const [path, api] of tableApis) {
      let rows = api.getRows();
      if (path === "hotkeys") {
        rows = normalizeHotkeyRows(rows).map((r) => ({
          action: r.action,
          keybinding: r.keybinding,
          name: r.name,
        }));
      }
      (draft as unknown as Record<string, unknown>)[path] = rows;
    }
    return draft;
  };

  const paintDraft = (data: AppSettings): void => {
    for (const [path, input] of knobInputs) {
      if (path === "__wired.fontScale" && input instanceof HTMLSelectElement) {
        input.value = String(nearestZoom(data.fontScale));
        continue;
      }
      if (path === "__wired.timestampFormat" && input instanceof HTMLSelectElement) {
        input.value = data.timestampFormat || (data.showTimestamps ? "hh:mm" : "Disable");
        continue;
      }
      if (path === "__wired.hideModerated" && isSwitchControl(input)) {
        setSwitchChecked(input, data.hideModerated);
        continue;
      }
      if (path === "__wired.enableSelfHighlight" && isSwitchControl(input)) {
        setSwitchChecked(input, data.enableSelfHighlight);
        continue;
      }
      if (path.startsWith("__")) {
        continue;
      }
      const raw = data.knobs[path];
      if (isSwitchControl(input)) {
        const stored = typeof raw === "boolean" ? raw : Boolean(raw);
        setSwitchChecked(
          input,
          input.dataset.inverse === "1" ? !stored : stored,
        );
      } else if (input instanceof HTMLInputElement && input.type === "number") {
        input.value = String(typeof raw === "number" ? raw : Number(raw) || 0);
      } else if (input instanceof HTMLInputElement && input.type === "hidden") {
        input.value = raw != null ? String(raw) : "";
      } else if (
        (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) &&
        raw != null
      ) {
        input.value = String(raw);
      }
    }
    for (const [path, api] of tableApis) {
      api.setRows(tablePathGet(data, path));
    }
    applyDraft(data);
    refreshCacheResolved();
  };

  let previewTimer = 0;
  const schedulePreview = (): void => {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      applyDraft(readDraft());
    }, 50);
  };

  const applySearch = (query: string): void => {
    const q = query.trim().toLowerCase();
    const wrap = search.closest("#settings-search-wrap");
    wrap?.classList.toggle("has-query", q.length > 0);
    if (searchClear) {
      searchClear.hidden = q.length === 0;
    }
    tabsHost.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
      const hay = (tab.dataset.search ?? tab.textContent ?? "").toLowerCase();
      tab.hidden = q.length > 0 && !hay.includes(q);
      tab.classList.toggle("is-search-hit", q.length > 0 && hay.includes(q));
    });
    let hits = 0;
    pagesHost.querySelectorAll<HTMLElement>(".settings-page").forEach((page) => {
      const pageHay = (page.dataset.search ?? "").toLowerCase();
      let pageMatch = q.length === 0 || pageHay.includes(q);
      page.querySelectorAll<HTMLElement>("[data-search]").forEach((el) => {
        if (el.classList.contains("settings-page")) {
          return;
        }
        const hay = (el.dataset.search ?? el.textContent ?? "").toLowerCase();
        const textMatch = q.length === 0 || hay.includes(q);
        const match = textMatch || pageHay.includes(q);
        el.hidden = !match;
        if (match) {
          pageMatch = true;
          if (
            q.length > 0 &&
            textMatch &&
            !el.classList.contains("settings-block") &&
            el.dataset.search
          ) {
            hits += 1;
          }
        }
      });
      if (q.length > 0) {
        const tab = tabsHost.querySelector<HTMLButtonElement>(
          `.settings-tab[data-page="${page.dataset.page}"]`,
        );
        if (tab && pageMatch) {
          tab.hidden = false;
          tab.classList.add("is-search-hit");
        }
      }
    });
    if (searchCount) {
      if (q.length === 0) {
        searchCount.hidden = true;
        searchCount.textContent = "";
      } else {
        searchCount.hidden = false;
        searchCount.textContent = `${hits}`;
        searchCount.title = `${hits} results`;
      }
    }
  };

  const closePanel = (restore: boolean): void => {
    window.clearTimeout(previewTimer);
    resetHotkeyFilter?.();
    if (restore) {
      paintDraft(baseline);
    }
    search.value = "";
    applySearch("");
    statusEl.textContent = "";
    if (detached) {
      setSettingsWindowOpen(false);
      void (async () => {
        await emitSettingsClosed({ restore });
        await getCurrentWindow().hide();
      })();
    }
  };

  const refreshIncognitoKnobs = async (): Promise<void> => {
    let ok = false;
    try {
      ok = (await invoke<boolean>("supports_incognito_links")) === true;
    } catch {
      ok = false;
    }
    for (const path of [
      "misc.openLinksIncognito",
      "behaviour.searchIncognito",
    ] as const) {
      const input = knobInputs.get(path);
      if (!input) {
        continue;
      }
      if (isSwitchControl(input)) {
        input.disabled = !ok;
        if (!ok) {
          input.title =
            "Private browsing is not available for the default browser.";
        } else {
          input.removeAttribute("title");
        }
        continue;
      }
      if (!(input instanceof HTMLInputElement)) {
        continue;
      }
      input.disabled = !ok;
      if (!ok) {
        input.title =
          "Private browsing is not available for the default browser.";
      } else {
        input.removeAttribute("title");
      }
    }
  };

  const loadPanel = async (): Promise<void> => {
    if (detached) {
      setSettingsWindowOpen(true);
    }
    statusEl.textContent = "";
    loadReady = false;
    okBtn.disabled = true;
    try {
      const loaded = await invoke<AppSettings>("settings_get");
      const filters = await invoke<Filters>("filters_get");
      baselineFilters = filters;
      baseline = mergeLoadedSettings(loaded, filters);
      loadReady = true;
      okBtn.disabled = false;
    } catch (err) {
      statusEl.textContent = formatError(err);
      baseline = emptySettings();
      loadReady = false;
      okBtn.disabled = true;
    }
    paintDraft(baseline);
    void refreshIncognitoKnobs();
    showPage(activePage);
    search.focus();
  };

  const saveModal = async (): Promise<void> => {
    if (saving || !loadReady) {
      return;
    }
    saving = true;
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = "";
    const draft = readDraft();
    draft.knobs = migrateStaleFalseDefaults(draft.knobs).knobs;
    try {
      const live = await invoke<AppSettings>("settings_get");
      const split = live.knobs["appearance.playerChatSplit"];
      if (typeof split === "number" && Number.isFinite(split)) {
        draft.knobs["appearance.playerChatSplit"] = split;
      }
    } catch {
      /* keep draft */
    }
    const filtersDraft = filtersFromSettings(draft);
    let saved: AppSettings | undefined;
    try {
      saved = await invoke<AppSettings>("settings_set", { settings: draft });
      const filters = await invoke<Filters>("filters_set", { filters: filtersDraft });
      baseline = {
        ...emptySettings(),
        ...saved,
        knobs: { ...defaultKnobs(), ...(saved.knobs ?? {}) },
        enableSelfHighlight: filters.enableSelfHighlight,
      };
      baselineFilters = filters;
      paintDraft(baseline);
      await emitSettingsSaved(baseline);
      closePanel(false);
    } catch (err) {
      if (saved) {
        try {
          const rolled = await invoke<AppSettings>("settings_set", {
            settings: baseline,
          });
          baseline = {
            ...emptySettings(),
            ...rolled,
            knobs: { ...defaultKnobs(), ...(rolled.knobs ?? {}) },
            enableSelfHighlight: baselineFilters.enableSelfHighlight,
          };
          paintDraft(baseline);
          void emitSettingsPreview(baseline);
        } catch (rollErr) {
          statusEl.textContent = `${formatError(err)}; rollback: ${formatError(rollErr)}`;
          return;
        }
      }
      statusEl.textContent = formatError(err);
    } finally {
      saving = false;
      okBtn.disabled = !loadReady;
      cancelBtn.disabled = false;
    }
  };

  buildPages();
  showPage("general");

  cancelBtn.addEventListener("click", () => {
    closePanel(true);
  });
  okBtn.addEventListener("click", () => {
    void saveModal();
  });
  search.addEventListener("input", () => {
    applySearch(search.value);
  });
  searchClear?.addEventListener("click", () => {
    search.value = "";
    applySearch("");
    search.focus();
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "f" && ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePanel(true);
      return;
    }
    if (ev.key === "Tab") {
      const items = focusables(root);
      if (items.length === 0) {
        ev.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (ev.shiftKey) {
        if (!active || active === first || !root.contains(active)) {
          ev.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !root.contains(active)) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  if (detached) {
    void getCurrentWindow().onCloseRequested((ev) => {
      ev.preventDefault();
      closePanel(true);
    });
  } else if (ring) {
    void (async () => {
      try {
        const display = await invoke<AppSettings>("settings_get");
        const merged = {
          ...emptySettings(),
          ...display,
          knobs: { ...defaultKnobs(), ...(display.knobs ?? {}) },
          hotkeys: normalizeHotkeyRows(display.hotkeys ?? []).map((r) => ({
            action: r.action,
            keybinding: r.keybinding,
            name: r.name,
          })),
        };
        applyDraft(merged);
      } catch {
        applyDraft(emptySettings());
      }
    })();
  }

  return {
    reload: loadPanel,
    bumpZoom: (() => {
      let chain: Promise<void> = Promise.resolve();
      return (dir: 1 | -1 | 0): Promise<void> => {
        chain = chain
          .catch(() => undefined)
          .then(async () => {
            const base = lastSettings ?? emptySettings();
            const next: AppSettings = {
              ...base,
              fontScale: stepZoom(base.fontScale, dir),
              knobs: { ...defaultKnobs(), ...base.knobs },
              hotkeys: normalizeHotkeyRows(base.hotkeys ?? []).map((r) => ({
                action: r.action,
                keybinding: r.keybinding,
                name: r.name,
              })),
            };
            try {
              const saved = await invoke<AppSettings>("settings_set", {
                settings: next,
              });
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
              paintDraft(merged);
              applyDraft(merged);
            } catch {
              applyDraft(next);
            }
          });
        return chain;
      };
    })(),
  };
}
