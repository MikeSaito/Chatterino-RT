import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import type { UiLayout } from "./uiLayout";

/** Extended: player + sidebar. Matches tauri.conf.json main window. */
export const EXTENDED_MIN_SIZE = { width: 960, height: 420 } as const;

/** Classic: chat-only strip (Chatterino-like). */
export const CLASSIC_MIN_SIZE = { width: 320, height: 240 } as const;

export function minSizeForLayout(mode: UiLayout): {
  width: number;
  height: number;
} {
  return mode === "Classic" ? CLASSIC_MIN_SIZE : EXTENDED_MIN_SIZE;
}

let desired: UiLayout = "Extended";
let applied: UiLayout | null = null;
let chain: Promise<void> = Promise.resolve();

/** Подстроить min size окна под UI layout. */
export function applyWindowMinForLayout(mode: UiLayout): void {
  desired = mode;
  if (!isTauri()) {
    applied = mode;
    return;
  }
  chain = chain
    .then(async () => {
      while (applied !== desired) {
        const next = desired;
        const min = minSizeForLayout(next);
        const win = getCurrentWindow();
        await win.setMinSize(new LogicalSize(min.width, min.height));
        if (desired !== next) {
          applied = null;
          continue;
        }
        if (next === "Extended") {
          const physical = await win.innerSize();
          if (desired !== next) {
            applied = null;
            continue;
          }
          const scale = await win.scaleFactor();
          if (desired !== next) {
            applied = null;
            continue;
          }
          const w = physical.width / scale;
          const h = physical.height / scale;
          if (w < min.width || h < min.height) {
            await win.setSize(
              new LogicalSize(Math.max(w, min.width), Math.max(h, min.height)),
            );
            if (desired !== next) {
              applied = null;
              continue;
            }
          }
        }
        applied = next;
      }
    })
    .catch((err: unknown) => {
      console.error("setMinSize failed", err);
    });
}
