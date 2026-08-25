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
  id: string;
  login: string;
  displayName: string;
  profileImageUrl?: string | null;
  createdAt?: string | null;
  followerCount?: number | null;
};

function formatFollowerCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatCreatedDate(iso: string): string {
  const idx = iso.indexOf("T");
  return idx >= 0 ? iso.slice(0, idx) : iso;
}

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
  /** misc.showPronouns */
  getShowPronouns: () => boolean;
  /** misc.openLinksIncognito when private open is supported. */
  getOpenPrivate?: () => boolean;
  /** misc.scrollbackUsercardLimit (hot on each open). */
  getUsercardLimit: () => number;
  getTimeoutButtons: () => TimeoutButton[];
  getSelfLogin: () => string | null;
}): { open: (info: UserCardOpen) => void; close: () => void; syncAvatars: () => void; syncPronouns: () => void; syncMod: () => void } {
  const {
    modal,
    settingsModal,
    searchModal,
    activeChannel,
    autoClose,
    getHideAvatars,
    getShowPronouns,
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
  const pronounsEl = modal.querySelector<HTMLElement>("#usercard-pronouns");
  const localizedRow = modal.querySelector<HTMLElement>("#usercard-localized");
  const localizedText = modal.querySelector<HTMLElement>("#usercard-localized-text");
  const copyLocalizedBtn = modal.querySelector<HTMLButtonElement>("#usercard-copy-localized");
  const userIdRow = modal.querySelector<HTMLElement>("#usercard-userid");
  const userIdText = modal.querySelector<HTMLElement>("#usercard-userid-text");
  const copyIdBtn = modal.querySelector<HTMLButtonElement>("#usercard-copy-id");
  const followersEl = modal.querySelector<HTMLElement>("#usercard-followers");
  const createdEl = modal.querySelector<HTMLElement>("#usercard-created");
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
      syncPronouns: () => undefined,
      syncMod: () => undefined,
    };
  }

  let currentLogin = "";
  let pinned = false;
  let modBusy = false;
  let currentUserId = "";
  let drag: { ox: number; oy: number; sx: number; sy: number } | null = null;

  const clearAvatar = (): void => {
    if (!avatarEl) {
      return;
    }
    avatarEl.hidden = true;
    avatarEl.removeAttribute("src");
    avatarEl.alt = "";
  };

  const clearPronouns = (): void => {
    if (!pronounsEl) {
      return;
    }
    pronounsEl.hidden = true;
    pronounsEl.textContent = "";
  };

  const clearMeta = (): void => {
    if (localizedRow) {
      localizedRow.hidden = true;
    }
    if (localizedText) {
      localizedText.textContent = "";
    }
    if (userIdRow) {
      userIdRow.hidden = true;
    }
    if (userIdText) {
      userIdText.textContent = "";
    }
    if (followersEl) {
      followersEl.hidden = true;
      followersEl.textContent = "";
      followersEl.removeAttribute("title");
    }
    if (createdEl) {
      createdEl.hidden = true;
      createdEl.textContent = "";
      createdEl.removeAttribute("title");
    }
  };

  const setPronounsLabel = (text: string): void => {
    if (!pronounsEl) {
      return;
    }
    pronounsEl.textContent = text;
    pronounsEl.hidden = false;
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

  const showMetaUnavailable = (): void => {
    if (userIdText && userIdRow) {
      userIdText.textContent = "ID: (not available)";
      userIdRow.hidden = false;
    }
    if (followersEl) {
      followersEl.textContent = "Followers: (not available)";
      followersEl.hidden = false;
    }
    if (createdEl) {
      createdEl.textContent = "Created: (not available)";
      createdEl.removeAttribute("title");
      createdEl.hidden = false;
    }
  };

  const applyProfileMeta = (profile: UserProfile, login: string): void => {
    currentUserId = /^\d+$/.test(profile.id) ? profile.id : "";
    const displayName = profile.displayName.trim();
    if (displayName && displayName.toLowerCase() !== login) {
      nameEl.textContent = login;
      if (localizedText) {
        localizedText.textContent = displayName;
      }
      if (localizedRow) {
        localizedRow.hidden = false;
      }
    } else if (localizedRow) {
      localizedRow.hidden = true;
      nameEl.textContent = displayName || login;
    }

    if (userIdText && userIdRow) {
      userIdText.textContent = currentUserId ? `ID: ${currentUserId}` : "ID: (not available)";
      userIdRow.hidden = false;
    }

    if (followersEl) {
      followersEl.textContent = "Followers: (not available)";
      followersEl.hidden = false;
    }

    if (createdEl) {
      const created = profile.createdAt?.trim() ?? "";
      if (created) {
        createdEl.textContent = `Created: ${formatCreatedDate(created)}`;
        createdEl.title = created;
        createdEl.hidden = false;
      } else {
        createdEl.textContent = "Created: (not available)";
        createdEl.removeAttribute("title");
        createdEl.hidden = false;
      }
    }
  };

  const applyProfileAvatar = (profile: UserProfile, login: string): void => {
    if (!avatarEl || getHideAvatars()) {
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
    void loadProfile(currentLogin);
  };

  const syncPronouns = (): void => {
    if (modal.hidden || !currentLogin) {
      return;
    }
    if (!getShowPronouns()) {
      clearPronouns();
      return;
    }
    void loadPronouns(currentLogin);
  };

  const close = (): void => {
    modal.hidden = true;
    currentLogin = "";
    currentUserId = "";
    pinned = false;
    modBusy = false;
    if (pinBtn) {
      pinBtn.classList.remove("is-pinned");
      pinBtn.title = "Pin";
    }
    clearAvatar();
    clearPronouns();
    clearMeta();
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

  const loadFollowers = async (userId: string, login: string): Promise<void> => {
    if (!followersEl || !/^\d+$/.test(userId)) {
      return;
    }
    try {
      const count = await invoke<number | null>("chat_user_followers", {
        broadcasterId: userId,
      });
      if (login !== currentLogin || userId !== currentUserId) {
        return;
      }
      followersEl.textContent =
        count == null
          ? "Followers: (not available)"
          : `Followers: ${formatFollowerCount(count)}`;
      followersEl.hidden = false;
    } catch {
      if (login !== currentLogin) {
        return;
      }
      followersEl.textContent = "Followers: (not available)";
      followersEl.hidden = false;
    }
  };

  const loadProfile = async (login: string): Promise<void> => {
    try {
      const profile = await invoke<UserProfile>("chat_user_profile", { login });
      if (login !== currentLogin) {
        return;
      }
      applyProfileMeta(profile, login);
      applyProfileAvatar(profile, login);
      void loadFollowers(profile.id, login);
    } catch {
      if (login !== currentLogin) {
        return;
      }
      showMetaUnavailable();
      clearAvatar();
    }
  };

  const loadPronouns = async (login: string): Promise<void> => {
    if (!pronounsEl || !getShowPronouns()) {
      clearPronouns();
      return;
    }
    setPronounsLabel("Pronouns: (loading…)");
    try {
      const result = await invoke<{ pronouns: string | null }>("chat_user_pronouns", {
        login,
      });
      if (login !== currentLogin) {
        return;
      }
      if (!getShowPronouns()) {
        clearPronouns();
        return;
      }
      const text = result.pronouns?.trim();
      if (text) {
        setPronounsLabel(`Pronouns: ${text}`);
      } else {
        setPronounsLabel("Pronouns: (unspecified)");
      }
    } catch {
      if (login !== currentLogin) {
        return;
      }
      if (!getShowPronouns()) {
        clearPronouns();
        return;
      }
      setPronounsLabel("Pronouns: (unspecified)");
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
    clearPronouns();
    clearMeta();
    showMetaUnavailable();
    recent.replaceChildren();
    setStatus("");
    const loading = document.createElement("p");
    loading.className = "usercard-empty";
    loading.textContent = "Loading recent messages…";
    recent.append(loading);
    syncModRow();
    placeNear(info.clientX, info.clientY);
    void loadRecent(currentLogin);
    void loadProfile(currentLogin);
    void loadPronouns(currentLogin);
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

  if (copyLocalizedBtn && localizedText) {
    copyLocalizedBtn.addEventListener("click", () => {
      const text = localizedText.textContent?.trim() ?? "";
      if (text) {
        void navigator.clipboard.writeText(text).catch(() => undefined);
      }
    });
  }

  if (copyIdBtn) {
    copyIdBtn.addEventListener("click", () => {
      if (/^\d+$/.test(currentUserId)) {
        void navigator.clipboard.writeText(currentUserId).catch(() => undefined);
      }
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

  return { open, close, syncAvatars, syncPronouns, syncMod: syncModRow };
}
