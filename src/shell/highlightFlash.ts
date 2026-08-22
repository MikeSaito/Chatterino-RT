import { invoke } from "@tauri-apps/api/core";

const FLASH_GAP_MS = 100;

let lastFlash = 0;
let longAlerts = false;
let muted = false;
let focusListenerInstalled = false;

export function configureHighlightFlash(opts: {
  longAlerts: boolean;
  muted?: boolean;
}): void {
  longAlerts = opts.longAlerts === true;
  muted = opts.muted === true;
  if (!focusListenerInstalled) {
    focusListenerInstalled = true;
    window.addEventListener("focus", () => {
      if (longAlerts) {
        void invoke("highlight_cancel_attention");
      }
    });
  }
}

export function notifyHighlightFlash(
  events: ReadonlyArray<{ highlightFlash?: boolean } | object>,
): void {
  const hits = events.filter(
    (ev): ev is { highlightFlash: true } =>
      "highlightFlash" in ev && ev.highlightFlash === true,
  );
  if (hits.length === 0) {
    return;
  }
  void flashBatch(hits.length);
}

async function flashBatch(count: number): Promise<void> {
  if (muted) {
    return;
  }
  for (let i = 0; i < count; i += 1) {
    const now = Date.now();
    const wait = FLASH_GAP_MS - (now - lastFlash);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastFlash = Date.now();
    try {
      await invoke("highlight_request_attention", { longAlerts });
    } catch {
      // Platform may reject attention requests; non-fatal.
    }
  }
}
