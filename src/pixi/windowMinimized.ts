import { TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";

type NativeWindow = {
  isMinimized(): Promise<boolean>;
  listen(event: TauriEvent, handler: () => void): Promise<UnlistenFn>;
};

export function watchWindowMinimized(window: NativeWindow, onChange: (minimized: boolean) => void): () => void {
  const listeners: UnlistenFn[] = [];
  let disposed = false;
  let listening = false;
  let reading = false;
  let dirty = false;
  let minimized = false;

  const unlisten = (listener: UnlistenFn): void => {
    void Promise.resolve().then(listener).catch(() => {});
  };
  const dispose = (): void => {
    disposed = true;
    for (const listener of listeners.splice(0)) unlisten(listener);
  };

  async function read(): Promise<void> {
    reading = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        const next = await window.isMinimized().catch(() => false);
        // A newer event can arrive while the native query is in flight.
        if (!disposed && !dirty && next !== minimized) {
          minimized = next;
          onChange(next);
        }
      }
    } finally {
      reading = false;
    }
  }

  const refresh = (): void => {
    if (!listening || disposed) return;
    dirty = true;
    if (!reading) void read();
  };
  const events = [TauriEvent.WINDOW_RESIZED, TauriEvent.WINDOW_FOCUS, TauriEvent.WINDOW_BLUR];
  void Promise.all(events.map(async (event) => {
    const listener = await window.listen(event, refresh);
    if (disposed) unlisten(listener);
    else listeners.push(listener);
  })).then(() => {
    listening = true;
    refresh();
  }, dispose);

  return dispose;
}
