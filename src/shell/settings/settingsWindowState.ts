import { invoke } from "@tauri-apps/api/core";

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
}
