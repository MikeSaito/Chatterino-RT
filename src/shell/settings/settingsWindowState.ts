import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { SETTINGS_OPENED_EVENT } from "./settingsBridge";

let open = false;

export function setSettingsWindowOpen(next: boolean): void {
  open = next;
}

export function isSettingsWindowOpen(): boolean {
  return open;
}

export async function requestOpenSettingsWindow(): Promise<void> {
  await invoke("open_settings_window");
  setSettingsWindowOpen(true);
  await emit(SETTINGS_OPENED_EVENT, {});
}
