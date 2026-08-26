import { emit } from "@tauri-apps/api/event";
import type { AppSettings } from "./settingsApply";

export const SETTINGS_PREVIEW_EVENT = "settings-preview";
export const SETTINGS_SAVED_EVENT = "settings-saved";
export const SETTINGS_CLOSED_EVENT = "settings-closed";
export const SETTINGS_OPENED_EVENT = "settings-opened";

export type SettingsClosedPayload = {
  restore: boolean;
};

export async function emitSettingsPreview(data: AppSettings): Promise<void> {
  await emit(SETTINGS_PREVIEW_EVENT, data);
}

export async function emitSettingsSaved(data: AppSettings): Promise<void> {
  await emit(SETTINGS_SAVED_EVENT, data);
}

export async function emitSettingsClosed(
  payload: SettingsClosedPayload,
): Promise<void> {
  await emit(SETTINGS_CLOSED_EVENT, payload);
}
