import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createChatApp, destroyChatApp } from "./pixi/app";
import { MessageRing } from "./chat/ring";
import { bindChatIpc } from "./chat/ipc";
import { TextureLru } from "./chat/textures";
import { mountPlayer, unmountPlayer } from "./player/embed";
import { bindScrollChrome } from "./chat/scrollUi";
import { bindChannelList } from "./shell/channels";
import { CHAT_AUTH_EVENT, CHAT_STATUS_EVENT } from "./constants";
import type { AuthInfo, ChatStatus, Filters } from "./chat/types";

window.addEventListener("DOMContentLoaded", () => {
  void boot();
});

window.addEventListener("beforeunload", () => {
  destroyChatApp();
});

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#chat-canvas");
  const pane = document.querySelector<HTMLElement>("#chat-pane");
  const canvasHost = document.querySelector<HTMLElement>("#chat-canvas-host");
  const scrollTrack = document.querySelector<HTMLElement>("#chat-scroll");
  const scrollThumb = document.querySelector<HTMLElement>("#chat-scroll-thumb");
  const jumpBottom = document.querySelector<HTMLButtonElement>("#chat-jump-bottom");
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
  const authPaste = document.querySelector<HTMLTextAreaElement>("#auth-paste");
  const authImport = document.querySelector<HTMLButtonElement>("#auth-import");
  const filtersForm = document.querySelector<HTMLFormElement>("#filters-form");
  const filtersSelf = document.querySelector<HTMLInputElement>("#filters-self");
  const filtersIgnoreLogins = document.querySelector<HTMLTextAreaElement>("#filters-ignore-logins");
  const filtersIgnorePhrases = document.querySelector<HTMLTextAreaElement>("#filters-ignore-phrases");
  const filtersHighlightPhrases = document.querySelector<HTMLTextAreaElement>("#filters-highlight-phrases");
  const filtersHighlightLogins = document.querySelector<HTMLTextAreaElement>("#filters-highlight-logins");
  const filtersStatus = document.querySelector<HTMLElement>("#filters-status");
  const filtersSave = filtersForm?.querySelector<HTMLButtonElement>("button[type=submit]");
  if (
    !canvas ||
    !pane ||
    !canvasHost ||
    !scrollTrack ||
    !scrollThumb ||
    !jumpBottom ||
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
    !authDevice ||
    !authPaste ||
    !authImport ||
    !filtersForm ||
    !filtersSelf ||
    !filtersIgnoreLogins ||
    !filtersIgnorePhrases ||
    !filtersHighlightPhrases ||
    !filtersHighlightLogins ||
    !filtersStatus ||
    !filtersSave
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
  const pasteEl = authPaste;
  const importBtn = authImport;
  const filterForm = filtersForm;
  const selfBox = filtersSelf;
  const ignoreLoginsEl = filtersIgnoreLogins;
  const ignorePhrasesEl = filtersIgnorePhrases;
  const highlightPhrasesEl = filtersHighlightPhrases;
  const highlightLoginsEl = filtersHighlightLogins;
  const filterStatusEl = filtersStatus;
  const filterSaveBtn = filtersSave;

  const app = await createChatApp(canvas, canvasHost);
  const ring = new MessageRing(app, new TextureLru());
  await ring.init();
  bindScrollChrome({
    ring,
    host: canvasHost,
    track: scrollTrack,
    thumb: scrollThumb,
    jump: jumpBottom,
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "End" || !ev.ctrlKey || ev.altKey || ev.metaKey) {
      return;
    }
    if (isEditableTarget(ev.target)) {
      return;
    }
    ev.preventDefault();
    ring.goToBottom();
  });
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

  importBtn.addEventListener("click", () => {
    void importLogin();
  });

  filterForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void saveFilters();
  });

  try {
    applyAuth(await invoke<AuthInfo>("auth_status"));
  } catch (err) {
    statusEl.textContent = formatError(err);
  }

  try {
    applyFilters(await invoke<Filters>("filters_get"));
  } catch (err) {
    filterStatusEl.textContent = formatError(err);
  }

  function applyAuth(info: AuthInfo): void {
    lastAuth = info;
    const signed = Boolean(info.login);
    const pending = Boolean(info.userCode) || Boolean(info.pendingPaste);
    loginEl.textContent = info.login ? info.login : "";
    signinBtn.hidden = signed || pending;
    signinBtn.disabled = pending;
    logoutBtn.hidden = !((signed && !info.fromEnv) || pending);
    logoutBtn.textContent = signed ? "Выйти" : "Отмена";
    pasteEl.hidden = !info.pendingPaste;
    importBtn.hidden = !info.pendingPaste;
    if (info.userCode) {
      deviceEl.hidden = false;
      deviceEl.textContent = `код: ${info.userCode}`;
    } else if (info.pendingPaste) {
      deviceEl.hidden = false;
      deviceEl.textContent =
        info.message ||
        "Войдите на chatterino.com/client_login, скопируйте строку и вставьте сюда";
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
      const started = await invoke<{
        mode: string;
        userCode?: string;
      }>("auth_start");
      if (started.mode === "paste") {
        pasteEl.hidden = false;
        importBtn.hidden = false;
        deviceEl.hidden = false;
        deviceEl.textContent =
          "Войдите на chatterino.com/client_login, скопируйте строку и вставьте сюда";
      } else if (started.userCode) {
        deviceEl.hidden = false;
        deviceEl.textContent = `код: ${started.userCode}`;
      }
    } catch (err) {
      deviceEl.hidden = false;
      deviceEl.textContent = formatError(err);
    } finally {
      signinBtn.disabled = false;
    }
  }

  async function importLogin(): Promise<void> {
    const blob = pasteEl.value;
    importBtn.disabled = true;
    try {
      await invoke("auth_import", { blob });
      pasteEl.value = "";
      try {
        await navigator.clipboard.writeText("");
      } catch {
        /* clipboard may be denied */
      }
    } catch (err) {
      deviceEl.hidden = false;
      deviceEl.textContent = formatError(err);
    } finally {
      importBtn.disabled = false;
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

  function applyFilters(data: Filters): void {
    selfBox.checked = data.enableSelfHighlight;
    ignoreLoginsEl.value = data.ignoreLogins.join("\n");
    ignorePhrasesEl.value = data.ignorePhrases.join("\n");
    highlightPhrasesEl.value = data.highlightPhrases.join("\n");
    highlightLoginsEl.value = data.highlightLogins.join("\n");
  }

  async function saveFilters(): Promise<void> {
    filterSaveBtn.disabled = true;
    try {
      const saved = await invoke<Filters>("filters_set", {
        filters: {
          enableSelfHighlight: selfBox.checked,
          ignoreLogins: splitLines(ignoreLoginsEl.value),
          ignorePhrases: splitLines(ignorePhrasesEl.value),
          highlightPhrases: splitLines(highlightPhrasesEl.value),
          highlightLogins: splitLines(highlightLoginsEl.value),
        },
      });
      applyFilters(saved);
      filterStatusEl.textContent = "сохранено";
    } catch (err) {
      filterStatusEl.textContent = formatError(err);
    } finally {
      filterSaveBtn.disabled = false;
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

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
