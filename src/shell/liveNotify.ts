import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { playLiveNotifySound } from "./highlightSound";

export type LiveNotifyPayload = {
  channel: string;
  title?: string | null;
  flash: boolean;
  playSound: boolean;
  soundPath?: string;
  toast: boolean;
  openUrl: string;
  openFromToast: string;
};

const FLASH_GAP_MS = 100;
let lastFlash = 0;
let unlisten: UnlistenFn | null = null;

async function flashTaskbar(): Promise<void> {
  const now = Date.now();
  if (now - lastFlash < FLASH_GAP_MS) {
    return;
  }
  lastFlash = now;
  try {
    await invoke("highlight_request_attention", { longAlerts: false });
  } catch {
    // Non-fatal.
  }
}

async function showToast(payload: LiveNotifyPayload): Promise<void> {
  if (typeof Notification === "undefined") {
    return;
  }
  try {
    let perm = Notification.permission;
    if (perm === "default") {
      perm = await Notification.requestPermission();
    }
    if (perm !== "granted") {
      return;
    }
    const title = payload.title?.trim()
      ? `${payload.channel} is live`
      : `${payload.channel} is live!`;
    const body = payload.title?.trim() || "Twitch stream started";
    const n = new Notification(title, { body, silent: true });
    n.onclick = () => {
      n.close();
      const action = (payload.openFromToast || "OpenInBrowser").trim();
      if (action === "DontOpen") {
        return;
      }
      if (action === "OpenInStreamlink") {
        const channel = (payload.channel || "").trim();
        if (!channel) {
          return;
        }
        void invoke("open_in_streamlink", { channel }).catch(() => undefined);
        return;
      }
      // OpenInBrowser / OpenInCustomPlayer (URI deferred) / unknown → browser.
      const url = payload.openUrl?.trim();
      if (!url) {
        return;
      }
      void invoke("open_chat_link", { url }).catch(() => undefined);
    };
  } catch {
    // Permission / platform failures are non-fatal.
  }
}

export async function handleLiveNotify(payload: LiveNotifyPayload): Promise<void> {
  if (!payload?.channel) {
    return;
  }
  if (payload.flash) {
    void flashTaskbar();
  }
  if (payload.playSound) {
    const path = payload.soundPath?.trim() || undefined;
    void playLiveNotifySound(path);
  }
  if (payload.toast) {
    void showToast(payload);
  }
}

export async function startLiveNotifyListener(): Promise<void> {
  if (unlisten) {
    return;
  }
  unlisten = await listen<LiveNotifyPayload>("chat:live_notify", (ev) => {
    void handleLiveNotify(ev.payload);
  });
}

export function stopLiveNotifyListener(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
