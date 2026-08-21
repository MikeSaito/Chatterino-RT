import { Application, Assets } from "pixi.js";

let app: Application | null = null;

export async function createChatApp(canvas: HTMLCanvasElement, host: HTMLElement): Promise<Application> {
  if (app) {
    return app;
  }
  // Blob Worker Pixi для ImageBitmap режется CSP (fallback на script-src без blob:).
  // isImageBitmapSupported тогда reject, loadTextures бросает, эмодзи не грузятся.
  Assets.setPreferences({ preferWorkers: false });
  const created = new Application();
  await created.init({
    canvas,
    background: 0x191919,
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    resizeTo: host,
  });
  app = created;
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
  if (!app) {
    return;
  }
  app.destroy(true, { children: true, texture: true });
  app = null;
}
