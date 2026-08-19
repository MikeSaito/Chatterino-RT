import { Application } from "pixi.js";

let app: Application | null = null;

export async function createChatApp(canvas: HTMLCanvasElement, host: HTMLElement): Promise<Application> {
  if (app) {
    return app;
  }
  const created = new Application();
  await created.init({
    canvas,
    background: 0x0e0e10,
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    resizeTo: host,
  });
  app = created;
  return created;
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
