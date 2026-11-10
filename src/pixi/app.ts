// Polyfill shader/UBO sync without new Function — required under prod CSP (no unsafe-eval).
import "pixi.js/unsafe-eval";
import { Application, Assets } from "pixi.js";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { watchWindowMinimized } from "./windowMinimized";

let app: Application | null = null;
/** Pixi ResizePlugin only listens to window.resize; splitter/grid changes need RO. */
let hostResizeRo: ResizeObserver | null = null;
let stopMinimizeWatch: (() => void) | undefined;

export async function createChatApp(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  onMinimized: (minimized: boolean) => void,
): Promise<Application> {
  if (app) {
    return app;
  }
  // Blob Worker Pixi для ImageBitmap режется CSP (fallback на script-src без blob:).
  // isImageBitmapSupported тогда reject, loadTextures бросает, эмодзи не грузятся.
  Assets.setPreferences({ preferWorkers: false });
  const created = new Application();
  let minimized = false;
  const nativeWindow = isTauri() ? getCurrentWindow() : undefined;
  if (nativeWindow) {
    // ResizePlugin also renders directly while the application ticker is stopped.
    const render = created.render.bind(created);
    created.render = () => {
      if (!minimized) render();
    };
  }
  await created.init({
    canvas,
    background: 0x191919,
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    resizeTo: host,
  });
  hostResizeRo?.disconnect();
  hostResizeRo = new ResizeObserver(() => {
    created.queueResize();
  });
  hostResizeRo.observe(host);
  created.queueResize();
  app = created;
  if (nativeWindow) {
    let resumeTicker = false;
    stopMinimizeWatch = watchWindowMinimized(nativeWindow, (next) => {
      minimized = next;
      if (minimized) {
        resumeTicker = created.ticker.started;
        created.stop();
      }
      onMinimized(minimized);
      if (!minimized && resumeTicker) created.start();
    });
  }
  return created;
}

export function setChatAppBackground(color: number): void {
  if (!app) {
    return;
  }
  app.renderer.background.color = color;
}

export function chatApp(): Application {
  if (!app) {
    throw new Error("PIXI.Application ещё не создан");
  }
  return app;
}

export function destroyChatApp(): void {
  stopMinimizeWatch?.();
  stopMinimizeWatch = undefined;
  hostResizeRo?.disconnect();
  hostResizeRo = null;
  if (!app) {
    return;
  }
  app.destroy(true, { children: true, texture: true });
  app = null;
}
