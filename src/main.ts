import { createChatApp, destroyChatApp } from "./pixi/app";
import { MessageRing } from "./chat/ring";
import { bindChatIpc } from "./chat/ipc";
import { TextureLru } from "./chat/textures";
import { mountPlayer, unmountPlayer } from "./player/embed";

window.addEventListener("DOMContentLoaded", () => {
  void boot();
});

window.addEventListener("beforeunload", () => {
  destroyChatApp();
});

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#chat-canvas");
  const pane = document.querySelector<HTMLElement>("#chat-pane");
  const form = document.querySelector<HTMLFormElement>("#join-form");
  const input = document.querySelector<HTMLInputElement>("#channel-input");
  const player = document.querySelector<HTMLElement>("#player-slot");
  const status = document.querySelector<HTMLElement>("#status");
  if (!canvas || !pane || !form || !input || !player || !status) {
    return;
  }

  const app = await createChatApp(canvas, pane);
  const ring = new MessageRing(app, new TextureLru());
  await ring.init();
  const ipc = bindChatIpc(ring);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) {
      return;
    }
    void (async () => {
      status.textContent = "подключение…";
      unmountPlayer(player);
      ring.reset();
      try {
        const joined = await ipc.join(name);
        mountPlayer(player, joined);
        status.textContent = `#${joined}`;
      } catch (err) {
        status.textContent = formatError(err);
      }
    })();
  });
}

function formatError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object") {
    const rec = err as { message?: unknown; code?: unknown };
    if (typeof rec.message === "string") {
      return rec.message;
    }
  }
  return String(err);
}
