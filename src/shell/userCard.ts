import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent } from "../chat/types";
import {
  moderationSlashCommand,
  type TimeoutButton,
} from "./timeoutButtons";

export type UserCardOpen = {
  login: string;
  nick: string;
  clientX: number;
  clientY: number;
};

type UserProfile = {
  login: string;
  displayName: string;
  profileImageUrl?: string | null;
};

/**
 * SPA UserInfoPopup: плавающая карточка у курсора (DraggablePopup), без fullscreen dim.
 */
export function bindUserCard(opts: {
  modal: HTMLElement;
  settingsModal: HTMLElement;
  searchModal: HTMLElement;
  activeChannel: () => string;
  autoClose: () => boolean;
  getHideAvatars: () => boolean;
  /** misc.openLinksIncognito when private open is supported. */
  getOpenPrivate?: () => boolean;
  /** misc.scrollbackUsercardLimit (hot on each open). */
  getUsercardLimit: () => number;
  getTimeoutButtons: () => TimeoutButton[];
  getSelfLogin: () => string | null;
}): { open: (info: UserCardOpen) => void; close: () => void; syncAvatars: () => void; syncMod: () => void } {
  const {
    modal,
    settingsModal,
    searchModal,
    activeChannel,
    autoClose,
    getHideAvatars,
    getOpenPrivate,
    getUsercardLimit,
    getTimeoutButtons,
    getSelfLogin,
  } = opts;
  const dialog = modal.querySelector<HTMLElement>("#usercard-dialog");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#usercard-close");
  const pinBtn = modal.querySelector<HTMLButtonElement>("#usercard-pin");
  const avatarEl = modal.querySelector<HTMLImageElement>("#usercard-avatar");
  const nameEl = modal.querySelector<HTMLElement>("#usercard-name");
  const loginEl = modal.querySelector<HTMLElement>("#usercard-login");
  const recent = modal.querySelector<HTMLElement>("#usercard-recent");
  const openTwitch = modal.querySelector<HTMLButtonElement>("#usercard-open-twitch");
  const modRow = modal.querySelector<HTMLElement>("#usercard-mod-row");
  const timeoutsEl = modal.querySelector<HTMLElement>("#usercard-timeouts");
  const banBtn = modal.querySelector<HTMLButtonElement>("#usercard-ban");
  const unbanBtn = modal.querySelector<HTMLButtonElement>("#usercard-unban");
  const statusEl = modal.querySelector<HTMLElement>("#usercard-status");
  const head = modal.querySelector<HTMLElement>(".popup-head");
  if (!dialog || !closeBtn || !nameEl || !loginEl || !recent || !openTwitch || !head) {
    return {
      open: () => undefined,
      close: () => undefined,
      syncAvatars: () => undefined,
      syncMod: () => undefined,
    };
  }

  let currentLogin = "";
  let pinned = false;
  let modBusy = false;
  let drag: { ox: number; oy: number; sx: number; sy: number } | null = null;

  const clearAvatar = (): void => {
    if (!avatarEl) {
      return;
    }
    avatarEl.hidden = true;
    avatarEl.removeAttribute("src");
    avatarEl.alt = "";
  };

  if (avatarEl) {
    avatarEl.addEventListener("error", () => {
      clearAvatar();
    });
  }

  const setStatus = (text: string): void => {
    if (!statusEl) {
      return;
    }
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
  };

  const setModBusy = (busy: boolean): void => {
    modBusy = busy;
    if (banBtn) {
      banBtn.disabled = busy;
    }
    if (unbanBtn) {
      unbanBtn.disabled = busy;
    }
    if (timeoutsEl) {
      for (const btn of timeoutsEl.querySelectorAll("button")) {
        btn.disabled = busy;
      }
    }
  };

  const syncModRow = (): void => {
    if (!modRow || !timeoutsEl) {
      return;
    }
    const self = getSelfLogin()?.trim().toLowerCase() ?? "";
    const hideSelf = Boolean(self) && self === currentLogin;
    if (!currentLogin || hideSelf) {
      modRow.hidden = true;
      timeoutsEl.replaceChildren();
      return;
    }
    modRow.hidden = false;
    timeoutsEl.replaceChildren();
    for (const btnDef of getTimeoutButtons()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = btnDef.label;
      btn.title = `Timeout ${btnDef.seconds}s`;
      btn.dataset.seconds = String(btnDef.seconds);
      btn.addEventListener("click", () => {
        void sendMod("timeout", btnDef.seconds);
      });
      timeoutsEl.append(btn);
    }
  };

  const sendMod = async (
    kind: "timeout" | "ban" | "unban",
    seconds?: number,
  ): Promise<void> => {
    if (!currentLogin || modBusy || modal.hidden) {
      return;
    }
    const loginAtSend = currentLogin;
    const text = moderationSlashCommand(kind, loginAtSend, seconds);
    if (!text) {
      setStatus("Invalid user.");
      return;
    }
    setStatus("");
    setModBusy(true);
    try {
      await invoke("chat_send", { text, replyToId: null });
    } catch (e) {
      if (modal.hidden || currentLogin !== loginAtSend) {
        return;
      }
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : "Could not send moderation command.";
      setStatus(msg);
    } finally {
      if (!modal.hidden && currentLogin === loginAtSend) {
        setModBusy(false);
      } else {
        modBusy = false;
      }
    }
  };

  const syncAvatars = (): void => {
    if (modal.hidden || !currentLogin) {
      return;
    }
    if (getHideAvatars()) {
      clearAvatar();
      return;
    }
    void loadAvatar(currentLogin);
  };

  const close = (): void => {
    modal.hidden = true;
    currentLogin = "";
    pinned = false;
    modBusy = false;
    if (pinBtn) {
      pinBtn.classList.remove("is-pinned");
      pinBtn.title = "Pin";
    }
    clearAvatar();
    recent.replaceChildren();
    setStatus("");
    if (banBtn) {
      banBtn.disabled = false;
    }
    if (unbanBtn) {
      unbanBtn.disabled = false;
    }
    if (modRow) {
      modRow.hidden = true;
    }
    if (timeoutsEl) {
      timeoutsEl.replaceChildren();
    }
  };

  const placeNear = (clientX: number, clientY: number): void => {
    modal.hidden = false;
    const pad = 8;
    const w = dialog.offsetWidth || 360;
    const h = dialog.offsetHeight || 420;
    let left = clientX - w / 3;
    let top = clientY - h / 5;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
  };

  const loadAvatar = async (login: string): Promise<void> => {
    if (!avatarEl || getHideAvatars()) {
      clearAvatar();
      return;
    }
    try {
      const profile = await invoke<UserProfile>("chat_user_profile", { login });
      if (login !== currentLogin) {
        return;
      }
      if (getHideAvatars()) {
        clearAvatar();
        return;
      }
      const url = profile.profileImageUrl?.trim() ?? "";
      if (!url) {
        clearAvatar();
        return;
      }
      avatarEl.alt = profile.displayName || login;
      avatarEl.src = url;
      avatarEl.hidden = false;
    } catch {
      if (login !== currentLogin) {
        return;
      }
      clearAvatar();
    }
  };

  const open = (info: UserCardOpen): void => {
    if (!settingsModal.hidden || !searchModal.hidden) {
      return;
    }
    currentLogin = info.login.toLowerCase();
    nameEl.textContent = info.nick || info.login;
    loginEl.textContent = info.login ? `@${info.login}` : "";
    clearAvatar();
    recent.replaceChildren();
    setStatus("");
    const loading = document.createElement("p");
    loading.className = "usercard-empty";
    loading.textContent = "Loading recent messages…";
    recent.append(loading);
    syncModRow();
    placeNear(info.clientX, info.clientY);
    void loadRecent(currentLogin);
    void loadAvatar(currentLogin);
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
          (ev) => ev.kind === "privmsg" && ev.login.toLowerCase() === login,
        )
        .slice(-getUsercardLimit());
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

  if (pinBtn) {
    pinBtn.addEventListener("click", () => {
      pinned = !pinned;
      pinBtn.classList.toggle("is-pinned", pinned);
      pinBtn.title = pinned ? "Unpin" : "Pin";
    });
  }

  head.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) {
      return;
    }
    const t = ev.target as HTMLElement;
    if (t.closest("button")) {
      return;
    }
    drag = {
      ox: ev.clientX,
      oy: ev.clientY,
      sx: dialog.offsetLeft,
      sy: dialog.offsetTop,
    };
    head.setPointerCapture(ev.pointerId);
  });

  head.addEventListener("pointermove", (ev) => {
    if (!drag) {
      return;
    }
    const left = drag.sx + (ev.clientX - drag.ox);
    const top = drag.sy + (ev.clientY - drag.oy);
    const pad = 4;
    dialog.style.left = `${Math.max(pad, Math.min(left, window.innerWidth - dialog.offsetWidth - pad))}px`;
    dialog.style.top = `${Math.max(pad, Math.min(top, window.innerHeight - dialog.offsetHeight - pad))}px`;
  });

  head.addEventListener("pointerup", () => {
    drag = null;
  });
  head.addEventListener("pointercancel", () => {
    drag = null;
  });

  openTwitch.addEventListener("click", () => {
    if (!currentLogin) {
      return;
    }
    void invoke("open_chat_link", {
      url: `https://www.twitch.tv/${currentLogin}`,
      private: getOpenPrivate?.() === true,
    }).catch(() => undefined);
  });

  if (banBtn) {
    banBtn.addEventListener("click", () => {
      void sendMod("ban");
    });
  }
  if (unbanBtn) {
    unbanBtn.addEventListener("click", () => {
      void sendMod("unban");
    });
  }

  document.addEventListener("pointerdown", (ev) => {
    if (modal.hidden || pinned || !autoClose()) {
      return;
    }
    const t = ev.target as Node;
    if (dialog.contains(t)) {
      return;
    }
    close();
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden && !pinned) {
      ev.preventDefault();
      close();
    }
  });

  return { open, close, syncAvatars, syncMod: syncModRow };
}
