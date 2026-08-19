import { listen } from "@tauri-apps/api/event";
import { createChatApp, destroyChatApp } from "./pixi/app";
import { MessageRing } from "./chat/ring";
import { bindChatIpc } from "./chat/ipc";
import { TextureLru } from "./chat/textures";
import { mountPlayer, unmountPlayer } from "./player/embed";
import { CHAT_STATUS_EVENT } from "./constants";
import type { ChatStatus } from "./chat/types";

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
  const joinBtn = form?.querySelector<HTMLButtonElement>("button[type=submit]");
  const player = document.querySelector<HTMLElement>("#player-slot");
  const status = document.querySelector<HTMLElement>("#status");
  if (!canvas || !pane || !form || !input || !joinBtn || !player || !status) {
    return;
  }

  const app = await createChatApp(canvas, pane);
  const ring = new MessageRing(app, new TextureLru());
  await ring.init();
  const ipc = bindChatIpc(ring);
  let mountedChannel = "";
  let holdStatus = false;

  await listen<ChatStatus>(CHAT_STATUS_EVENT, (ev) => {
    if (holdStatus) {
      return;
    }
    status.textContent = formatStatus(ev.payload);
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) {
      return;
    }
    joinBtn.disabled = true;
    holdStatus = false;
    void (async () => {
      try {
        const joined = await ipc.join(name);
        if (joined !== mountedChannel) {
          unmountPlayer(player);
          mountPlayer(player, joined);
          mountedChannel = joined;
        }
      } catch (err) {
        holdStatus = true;
        status.textContent = formatError(err);
      } finally {
        joinBtn.disabled = false;
      }
    })();
  });
}

function formatStatus(s: ChatStatus): string {
  switch (s.state) {
    case "connected":
      return s.channel ? `#${s.channel}` : "";
    case "reconnecting":
      return "переподключение…";
    case "error":
      return s.message || "ошибка";
    case "connecting":
      return s.channel ? `подключение #${s.channel}…` : "подключение…";
    default:
      return "подключение…";
  }
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
