import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./settingsApply";

export const SETTINGS_PREVIEW_EVENT = "settings-preview";
export const SETTINGS_SAVED_EVENT = "settings-saved";
export const SETTINGS_CLOSED_EVENT = "settings-closed";
export const SETTINGS_OPENED_EVENT = "settings-opened";

export type SettingsClosedPayload = {
  restore: boolean;
};

/** Settings WebView must not use frontend emit; Rust commands emit fixed event names. */
export async function emitSettingsPreview(data: AppSettings): Promise<void> {
  await invoke("settings_ui_preview", { settings: data });
}

export async function emitSettingsSaved(data: AppSettings): Promise<void> {
  await invoke("settings_ui_saved", { settings: data });
}

export async function emitSettingsClosed(
  payload: SettingsClosedPayload,
): Promise<void> {
  await invoke("settings_ui_closed", { restore: payload.restore });
}
