import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent } from "../chat/types";

export type UserCardOpen = {
  login: string;
  nick: string;
};

/**
 * SPA UserInfoPopup: карточка пользователя без второго PIXI.
 */
export function bindUserCard(opts: {
  modal: HTMLElement;
  settingsModal: HTMLElement;
  searchModal: HTMLElement;
  activeChannel: () => string;
}): { open: (info: UserCardOpen) => void; close: () => void } {
  const { modal, settingsModal, searchModal, activeChannel } = opts;
  const dialog = modal.querySelector<HTMLElement>("#usercard-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#usercard-backdrop");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#usercard-close");
  const nameEl = modal.querySelector<HTMLElement>("#usercard-name");
  const loginEl = modal.querySelector<HTMLElement>("#usercard-login");
  const recent = modal.querySelector<HTMLElement>("#usercard-recent");
  const openTwitch = modal.querySelector<HTMLButtonElement>("#usercard-open-twitch");
  if (!dialog || !backdrop || !closeBtn || !nameEl || !loginEl || !recent || !openTwitch) {
    return { open: () => undefined, close: () => undefined };
  }

  let currentLogin = "";

  const close = (): void => {
    modal.hidden = true;
    currentLogin = "";
    recent.replaceChildren();
  };

  const open = (info: UserCardOpen): void => {
    if (!settingsModal.hidden || !searchModal.hidden) {
      return;
    }
    currentLogin = info.login.toLowerCase();
    nameEl.textContent = info.nick || info.login;
    loginEl.textContent = info.login ? `@${info.login}` : "";
    recent.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "usercard-empty";
    loading.textContent = "Loading recent messages…";
    recent.append(loading);
    modal.hidden = false;
    void loadRecent(currentLogin);
  };

  const loadRecent = async (login: string): Promise<void> => {
    const channel = activeChannel();
    if (!channel) {
      recent.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "usercard-empty";
      empty.textContent = "No active channel.";
      recent.append(empty);
      return;
    }
    try {
      const snap = await invoke<{ events: ChatEvent[] }>("chat_snapshot", { channel });
      if (login !== currentLogin) {
        return;
      }
      recent.replaceChildren();
      const events = Array.isArray(snap.events) ? snap.events : [];
      const hits = events
        .filter(
          (ev) =>
            ev.kind === "privmsg" &&
            ev.login.toLowerCase() === login,
        )
        .slice(-40);
      if (hits.length === 0) {
        const empty = document.createElement("p");
        empty.className = "usercard-empty";
        empty.textContent = "No recent messages in scrollback.";
        recent.append(empty);
        return;
      }
      for (const ev of hits) {
        if (ev.kind !== "privmsg") {
          continue;
        }
        const row = document.createElement("div");
        row.className = "usercard-msg";
        const time = document.createElement("span");
        time.className = "usercard-msg-time";
        const d = new Date(ev.timestampMs);
        time.textContent = Number.isNaN(d.getTime())
          ? "--:--"
          : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        const text = document.createElement("span");
        text.className = "usercard-msg-text";
        text.textContent = ev.text;
        row.append(time, text);
        recent.append(row);
      }
      recent.scrollTop = recent.scrollHeight;
    } catch {
      if (login !== currentLogin) {
        return;
      }
      recent.replaceChildren();
      const err = document.createElement("p");
      err.className = "usercard-empty";
      err.textContent = "Could not load messages.";
      recent.append(err);
    }
  };

  closeBtn.addEventListener("click", () => {
    close();
  });
  backdrop.addEventListener("click", () => {
    close();
  });
  openTwitch.addEventListener("click", () => {
    if (!currentLogin) {
      return;
    }
    void invoke("open_chat_link", {
      url: `https://www.twitch.tv/${currentLogin}`,
    }).catch(() => undefined);
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden) {
      ev.preventDefault();
      close();
    }
  });

  return { open, close };
}
