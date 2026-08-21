import { invoke } from "@tauri-apps/api/core";

export type StreamerModeSetting =
  | "Disabled"
  | "Enabled"
  | "DetectStreamingSoftware";

export type StreamerModeState = {
  active: boolean;
  muteMentions: boolean;
  hideModActions: boolean;
};

const POLL_MS = 10_000;

let mode: StreamerModeSetting = "DetectStreamingSoftware";
let muteMentions = true;
let hideModActions = true;
let detected = false;
let active = false;
let pollTimer: number | null = null;
let detectGen = 0;
let detectInflight = false;
let onChange: ((state: StreamerModeState) => void) | undefined;
let badgeEl: HTMLElement | null = null;

export function bindStreamerModeBadge(el: HTMLElement | null): void {
  badgeEl = el;
  paintBadge();
}

export function setStreamerModeOnChange(
  cb: ((state: StreamerModeState) => void) | undefined,
): void {
  onChange = cb;
}

export function configureStreamerMode(opts: {
  mode: string;
  muteMentions: boolean;
  hideModActions: boolean;
}): void {
  const nextMode = parseMode(opts.mode);
  if (mode === "DetectStreamingSoftware" && nextMode !== "DetectStreamingSoftware") {
    detected = false;
    detectGen += 1;
  }
  if (mode !== "DetectStreamingSoftware" && nextMode === "DetectStreamingSoftware") {
    // Как stock: после Disabled/Enabled → Automatic остаёмся off до первого check.
    detected = false;
  }
  mode = nextMode;
  muteMentions = opts.muteMentions;
  hideModActions = opts.hideModActions;
  syncPolling();
  setActive(computeActive(), false);
}

export function isStreamerModeActive(): boolean {
  return active;
}

export function streamerModeState(): StreamerModeState {
  return { active, muteMentions, hideModActions };
}

function parseMode(raw: string): StreamerModeSetting {
  if (raw === "Disabled" || raw === "Enabled" || raw === "DetectStreamingSoftware") {
    return raw;
  }
  return "DetectStreamingSoftware";
}

function computeActive(): boolean {
  if (mode === "Enabled") {
    return true;
  }
  if (mode === "DetectStreamingSoftware") {
    return detected;
  }
  return false;
}

function setActive(next: boolean, notify: boolean): void {
  const changed = next !== active;
  active = next;
  paintBadge();
  if (changed && notify) {
    onChange?.(streamerModeState());
  }
}

function syncPolling(): void {
  if (mode === "DetectStreamingSoftware") {
    if (pollTimer === null) {
      void refreshDetect();
      pollTimer = window.setInterval(() => {
        void refreshDetect();
      }, POLL_MS);
    }
  } else if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshDetect(): Promise<void> {
  if (mode !== "DetectStreamingSoftware" || detectInflight) {
    return;
  }
  const token = ++detectGen;
  detectInflight = true;
  let hit = false;
  try {
    hit = (await invoke<boolean>("streamer_mode_detect")) === true;
  } catch {
    hit = false;
  } finally {
    detectInflight = false;
  }
  if (token !== detectGen || mode !== "DetectStreamingSoftware") {
    return;
  }
  detected = hit;
  setActive(computeActive(), true);
}

function paintBadge(): void {
  if (!badgeEl) {
    return;
  }
  badgeEl.hidden = !active;
}
