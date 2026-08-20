import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createChatApp, destroyChatApp } from "./pixi/app";
import { MessageRing } from "./chat/ring";
import { bindChatIpc } from "./chat/ipc";
import { TextureLru } from "./chat/textures";
import { mountPlayer, unmountPlayer } from "./player/embed";
import { bindChannelList } from "./shell/channels";
import { CHAT_AUTH_EVENT, CHAT_STATUS_EVENT } from "./constants";
import type { AuthInfo, ChatStatus } from "./chat/types";

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
  const list = document.querySelector<HTMLUListElement>("#channel-list");
  const title = document.querySelector<HTMLElement>("#channel-title");
  const player = document.querySelector<HTMLElement>("#player-slot");
  const status = document.querySelector<HTMLElement>("#status");
  const composer = document.querySelector<HTMLFormElement>("#composer");
  const composerInput = document.querySelector<HTMLTextAreaElement>("#composer-input");
  const composerSend = document.querySelector<HTMLButtonElement>("#composer-send");
  const authLogin = document.querySelector<HTMLElement>("#auth-login");
  const authSignin = document.querySelector<HTMLButtonElement>("#auth-signin");
  const authLogout = document.querySelector<HTMLButtonElement>("#auth-logout");
  const authDevice = document.querySelector<HTMLElement>("#auth-device");
  if (
    !canvas ||
    !pane ||
    !form ||
    !input ||
    !joinBtn ||
    !list ||
    !title ||
    !player ||
    !status ||
    !composer ||
    !composerInput ||
    !composerSend ||
    !authLogin ||
    !authSignin ||
    !authLogout ||
    !authDevice
  ) {
    return;
  }

  const joinControl = joinBtn;
  const titleEl = title;
  const channelInput = input;
  const playerSlot = player;
  const statusEl = status;
  const messageInput = composerInput;
  const sendBtn = composerSend;
  const loginEl = authLogin;
  const signinBtn = authSignin;
  const logoutBtn = authLogout;
  const deviceEl = authDevice;

  const app = await createChatApp(canvas, pane);
  const ring = new MessageRing(app, new TextureLru());
  await ring.init();
  const ipc = bindChatIpc(ring);
  let mountedChannel = "";
  let holdStatus = false;
  let joining = false;
  let queuedJoin: string | null = null;
  let sending = false;
  let lastAuth: AuthInfo = { canSend: false, fromEnv: false };

  const channels = bindChannelList(list, (login) => {
    void joinChannel(login);
  });

  await listen<ChatStatus>(CHAT_STATUS_EVENT, (ev) => {
    if (holdStatus) {
      return;
    }
    statusEl.textContent = formatStatus(ev.payload);
  });

  await listen<AuthInfo>(CHAT_AUTH_EVENT, (ev) => {
    applyAuth(ev.payload);
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void joinChannel(channelInput.value.trim());
  });

  composer.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void sendMessage();
  });

  messageInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void sendMessage();
    }
  });

  signinBtn.addEventListener("click", () => {
    void startLogin();
  });

  logoutBtn.addEventListener("click", () => {
    void logout();
  });

  try {
    applyAuth(await invoke<AuthInfo>("auth_status"));
  } catch (err) {
    statusEl.textContent = formatError(err);
  }

  function applyAuth(info: AuthInfo): void {
    lastAuth = info;
    const signed = Boolean(info.login);
    const pending = Boolean(info.userCode);
    loginEl.textContent = info.login ? info.login : "";
    signinBtn.hidden = signed || pending;
    signinBtn.disabled = pending;
    logoutBtn.hidden = !((signed && !info.fromEnv) || pending);
    logoutBtn.textContent = signed ? "Выйти" : "Отмена";
    if (info.userCode) {
      deviceEl.hidden = false;
      deviceEl.textContent = `код: ${info.userCode}`;
    } else if (info.message && !signed) {
      deviceEl.hidden = false;
      deviceEl.textContent = info.message;
    } else {
      deviceEl.hidden = true;
      deviceEl.textContent = "";
    }
    syncComposer();
  }

  function syncComposer(): void {
    const on = lastAuth.canSend && !sending;
    sendBtn.disabled = !on;
    messageInput.disabled = !lastAuth.canSend;
    sendBtn.title = lastAuth.canSend
      ? ""
      : "Нужен вход Twitch и активный канал";
  }

  async function startLogin(): Promise<void> {
    signinBtn.disabled = true;
    try {
      const started = await invoke<{ userCode: string }>("auth_start");
      deviceEl.hidden = false;
      deviceEl.textContent = `код: ${started.userCode}`;
    } catch (err) {
      deviceEl.hidden = false;
      deviceEl.textContent = formatError(err);
    } finally {
      signinBtn.disabled = false;
    }
  }

  async function logout(): Promise<void> {
    logoutBtn.disabled = true;
    try {
      await invoke("auth_logout");
    } catch (err) {
      statusEl.textContent = formatError(err);
    } finally {
      logoutBtn.disabled = false;
    }
  }

  async function sendMessage(): Promise<void> {
    if (!lastAuth.canSend || sending) {
      return;
    }
    const text = messageInput.value;
    sending = true;
    syncComposer();
    try {
      await invoke("chat_send", { text });
      messageInput.value = "";
    } catch (err) {
      statusEl.textContent = formatError(err);
    } finally {
      sending = false;
      syncComposer();
    }
  }

  async function joinChannel(raw: string): Promise<void> {
    const name = raw.trim();
    if (!name) {
      holdStatus = true;
      statusEl.textContent = "имя канала: 1-25 символов [a-z0-9_]";
      return;
    }
    if (joining) {
      queuedJoin = name;
      return;
    }
    joining = true;
    joinControl.disabled = true;
    holdStatus = false;
    try {
      const joined = await ipc.join(name);
      channels.remember(joined);
      titleEl.textContent = `#${joined}`;
      channelInput.value = joined;
      if (joined !== mountedChannel) {
        unmountPlayer(playerSlot);
        mountPlayer(playerSlot, joined);
        mountedChannel = joined;
      }
    } catch (err) {
      holdStatus = true;
      statusEl.textContent = formatError(err);
    } finally {
      joining = false;
      joinControl.disabled = false;
      const next = queuedJoin;
      queuedJoin = null;
      if (next) {
        void joinChannel(next);
      }
    }
  }
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
