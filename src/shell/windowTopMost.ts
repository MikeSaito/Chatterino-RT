import { getCurrentWindow } from "@tauri-apps/api/window";

let desired = false;
let applied: boolean | null = null;
let chain: Promise<void> = Promise.resolve();

/** Stock windowTopMost → Qt::WindowStaysOnTopHint. */
export function applyWindowTopMost(on: boolean): void {
  const next = on === true;
  desired = next;
  if (applied === next) {
    return;
  }
  chain = chain
    .then(async () => {
      if (applied === desired) {
        return;
      }
      const value = desired;
      await getCurrentWindow().setAlwaysOnTop(value);
      applied = value;
    })
    .catch((err: unknown) => {
      console.error("setAlwaysOnTop failed", err);
    });
}
