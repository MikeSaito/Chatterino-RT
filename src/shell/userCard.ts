import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent, ViewerRole } from "../chat/types";
import {
  moderationSlashCommand,
  type ModerationCommandKind,
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

type IgnoreHighlightsState = {
  ignored: boolean;
  regexLocked: boolean;
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
}): { open: (info: UserCardOpen) => void; close: () => void; syncAvatars: () => void; syncPronouns: () => void; syncMod: () => void; syncSubage: () => void } {
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
  const followageEl = modal.querySelector<HTMLElement>("#usercard-followage");
  const subageEl = modal.querySelector<HTMLElement>("#usercard-subage");
  const recent = modal.querySelector<HTMLElement>("#usercard-recent");
  const openTwitch = modal.querySelector<HTMLButtonElement>("#usercard-open-twitch");
  const modRow = modal.querySelector<HTMLElement>("#usercard-mod-row");
  const rolesEl = modal.querySelector<HTMLElement>("#usercard-roles");
  const roleModBtn = modal.querySelector<HTMLButtonElement>("#usercard-mod");
  const roleUnmodBtn = modal.querySelector<HTMLButtonElement>("#usercard-unmod");
  const roleVipBtn = modal.querySelector<HTMLButtonElement>("#usercard-vip");
  const roleUnvipBtn = modal.querySelector<HTMLButtonElement>("#usercard-unvip");
  const timeoutsEl = modal.querySelector<HTMLElement>("#usercard-timeouts");
  const banBtn = modal.querySelector<HTMLButtonElement>("#usercard-ban");
  const unbanBtn = modal.querySelector<HTMLButtonElement>("#usercard-unban");
  const blockRow = modal.querySelector<HTMLElement>("#usercard-block-row");
  const blockCheckbox = modal.querySelector<HTMLInputElement>("#usercard-block");
  const ignoreHighlightsRow = modal.querySelector<HTMLElement>("#usercard-ignore-highlights-row");
  const ignoreHighlightsCheckbox = modal.querySelector<HTMLInputElement>("#usercard-ignore-highlights");
  const statusEl = modal.querySelector<HTMLElement>("#usercard-status");
  const head = modal.querySelector<HTMLElement>(".popup-head");
  if (!dialog || !closeBtn || !nameEl || !loginEl || !recent || !openTwitch || !head) {
    return {
      open: () => undefined,
      close: () => undefined,
      syncAvatars: () => undefined,
      syncPronouns: () => undefined,
      syncMod: () => undefined,
      syncSubage: () => undefined,
    };
  }

  let currentLogin = "";
  let pinned = false;
  let modBusy = false;
  let currentUserId = "";
  let modRowSeq = 0;
  let blockSeq = 0;
  let blockBusy = false;
  let suppressBlockChange = false;
  let ignoreHighlightsSeq = 0;
  let ignoreHighlightsBusy = false;
  let suppressIgnoreHighlightsChange = false;
  let subageSeq = 0;
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
    hideSubage();
  };

  const hideSubage = (): void => {
    if (followageEl) {
      followageEl.hidden = true;
      followageEl.textContent = "";
      followageEl.removeAttribute("title");
    }
    if (subageEl) {
      subageEl.hidden = true;
      subageEl.textContent = "";
      subageEl.removeAttribute("title");
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
    void loadBlockState(login, profile.id);
    void loadIgnoreHighlightsState(login);
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
    if (roleModBtn) {
      roleModBtn.disabled = busy;
    }
    if (roleUnmodBtn) {
      roleUnmodBtn.disabled = busy;
    }
    if (roleVipBtn) {
      roleVipBtn.disabled = busy;
    }
    if (roleUnvipBtn) {
      roleUnvipBtn.disabled = busy;
    }
    if (timeoutsEl) {
      for (const btn of timeoutsEl.querySelectorAll("button")) {
        btn.disabled = busy;
      }
    }
  };

  const hideModRow = (): void => {
    if (modRow) {
      modRow.hidden = true;
    }
    if (rolesEl) {
      rolesEl.hidden = true;
    }
    if (banBtn) {
      banBtn.hidden = true;
    }
    if (unbanBtn) {
      unbanBtn.hidden = true;
    }
    if (timeoutsEl) {
      timeoutsEl.replaceChildren();
    }
  };

  const hideBlockRow = (): void => {
    if (blockRow) {
      blockRow.hidden = true;
    }
    if (blockCheckbox) {
      blockCheckbox.checked = false;
      blockCheckbox.disabled = false;
    }
  };

  const syncBlockRowVisibility = (): void => {
    if (!blockRow || !blockCheckbox) {
      return;
    }
    const self = getSelfLogin()?.trim().toLowerCase() ?? "";
    const hide = !currentLogin || !self || self === currentLogin;
    if (hide) {
      hideBlockRow();
      return;
    }
    blockRow.hidden = false;
  };

  const resetBlockUi = (): void => {
    blockSeq += 1;
    blockBusy = false;
    if (blockCheckbox) {
      suppressBlockChange = true;
      blockCheckbox.checked = false;
      suppressBlockChange = false;
      blockCheckbox.disabled = true;
    }
    syncBlockRowVisibility();
  };

  const hideIgnoreHighlightsRow = (): void => {
    if (ignoreHighlightsRow) {
      ignoreHighlightsRow.hidden = true;
    }
    if (ignoreHighlightsCheckbox) {
      suppressIgnoreHighlightsChange = true;
      ignoreHighlightsCheckbox.checked = false;
      suppressIgnoreHighlightsChange = false;
      ignoreHighlightsCheckbox.disabled = false;
      ignoreHighlightsCheckbox.removeAttribute("title");
    }
  };

  const syncIgnoreHighlightsRowVisibility = (): void => {
    if (!ignoreHighlightsRow || !ignoreHighlightsCheckbox) {
      return;
    }
    const self = getSelfLogin()?.trim().toLowerCase() ?? "";
    const hide = !currentLogin || !self || self === currentLogin;
    if (hide) {
      hideIgnoreHighlightsRow();
      return;
    }
    ignoreHighlightsRow.hidden = false;
  };

  const applyIgnoreHighlightsUi = (state: IgnoreHighlightsState): void => {
    if (!ignoreHighlightsCheckbox) {
      return;
    }
    suppressIgnoreHighlightsChange = true;
    ignoreHighlightsCheckbox.checked = state.ignored;
    suppressIgnoreHighlightsChange = false;
    if (ignoreHighlightsBusy) {
      ignoreHighlightsCheckbox.disabled = true;
      return;
    }
    ignoreHighlightsCheckbox.disabled = state.regexLocked;
    if (state.regexLocked) {
      ignoreHighlightsCheckbox.title = "Name matched by regex";
    } else {
      ignoreHighlightsCheckbox.removeAttribute("title");
    }
  };

  const resetIgnoreHighlightsUi = (): void => {
    ignoreHighlightsSeq += 1;
    ignoreHighlightsBusy = false;
    if (ignoreHighlightsCheckbox) {
      suppressIgnoreHighlightsChange = true;
      ignoreHighlightsCheckbox.checked = false;
      suppressIgnoreHighlightsChange = false;
      ignoreHighlightsCheckbox.disabled = true;
      ignoreHighlightsCheckbox.removeAttribute("title");
    }
    syncIgnoreHighlightsRowVisibility();
  };

  const loadIgnoreHighlightsState = async (login: string): Promise<void> => {
    if (!ignoreHighlightsRow || !ignoreHighlightsCheckbox) {
      return;
    }
    const seq = ++ignoreHighlightsSeq;
    syncIgnoreHighlightsRowVisibility();
    if (ignoreHighlightsRow.hidden) {
      return;
    }
    ignoreHighlightsCheckbox.disabled = true;
    try {
      const state = await invoke<IgnoreHighlightsState>("chat_user_ignore_highlights", { login });
      if (seq !== ignoreHighlightsSeq || login !== currentLogin) {
        return;
      }
      if (!ignoreHighlightsBusy) {
        applyIgnoreHighlightsUi(state);
      }
    } catch {
      if (seq !== ignoreHighlightsSeq || login !== currentLogin) {
        return;
      }
      suppressIgnoreHighlightsChange = true;
      ignoreHighlightsCheckbox.checked = false;
      suppressIgnoreHighlightsChange = false;
      ignoreHighlightsCheckbox.disabled = true;
      ignoreHighlightsCheckbox.removeAttribute("title");
    }
  };

  const loadBlockState = async (login: string, userId: string): Promise<void> => {
    if (!blockRow || !blockCheckbox) {
      return;
    }
    const seq = ++blockSeq;
    syncBlockRowVisibility();
    if (blockRow.hidden) {
      return;
    }
    if (!/^\d+$/.test(userId)) {
      blockCheckbox.disabled = true;
      blockCheckbox.checked = false;
      return;
    }
    blockCheckbox.disabled = true;
    try {
      const blocked = await invoke<boolean>("chat_user_blocked", { userId, login });
      if (seq !== blockSeq || login !== currentLogin || userId !== currentUserId) {
        return;
      }
      if (!blockBusy) {
        suppressBlockChange = true;
        blockCheckbox.checked = blocked;
        suppressBlockChange = false;
      }
      blockCheckbox.disabled = blockBusy;
    } catch {
      if (seq !== blockSeq || login !== currentLogin) {
        return;
      }
      suppressBlockChange = true;
      blockCheckbox.checked = false;
      suppressBlockChange = false;
      blockCheckbox.disabled = true;
    }
  };

  const refreshModUi = (): void => {
    if (!modRow || !timeoutsEl) {
      return;
    }
    const loginAtStart = currentLogin;
    const self = getSelfLogin()?.trim().toLowerCase() ?? "";
    const hideSelf = Boolean(self) && self === loginAtStart;
    if (!loginAtStart || hideSelf) {
      hideModRow();
      return;
    }
    const channel = activeChannel().trim();
    if (!channel) {
      hideModRow();
      return;
    }
    hideModRow();
    const seq = ++modRowSeq;
    void (async () => {
      try {
        const role = await invoke<ViewerRole>("chat_viewer_role", { channel });
        if (
          seq !== modRowSeq ||
          loginAtStart !== currentLogin ||
          activeChannel().trim() !== channel
        ) {
          return;
        }
        const showMod = role.isMod;
        const showRoles = role.isBroadcaster;
        if (!showMod && !showRoles) {
          hideModRow();
          return;
        }
        modRow.hidden = false;
        if (rolesEl) {
          rolesEl.hidden = !showRoles;
        }
        if (banBtn) {
          banBtn.hidden = !showMod;
        }
        if (unbanBtn) {
          unbanBtn.hidden = !showMod;
        }
        timeoutsEl.replaceChildren();
        if (showMod) {
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
        }
      } catch {
        if (seq !== modRowSeq || loginAtStart !== currentLogin) {
          return;
        }
        hideModRow();
      }
    })();
  };

  const sendMod = async (
    kind: ModerationCommandKind,
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

  const syncSubage = (): void => {
    if (modal.hidden || !currentLogin) {
      return;
    }
    void loadSubage(currentLogin);
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
    modRowSeq += 1;
    hideModRow();
    blockSeq += 1;
    blockBusy = false;
    hideBlockRow();
    ignoreHighlightsSeq += 1;
    ignoreHighlightsBusy = false;
    hideIgnoreHighlightsRow();
    subageSeq += 1;
    hideSubage();
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

  const loadSubage = async (login: string): Promise<void> => {
    if (!followageEl && !subageEl) {
      return;
    }
    const seq = ++subageSeq;
    const channel = activeChannel().trim();
    hideSubage();
    if (!channel || !login) {
      return;
    }
    try {
      const result = await invoke<{
        followage: string | null;
        followageAgo: string | null;
        subage: string | null;
      }>("chat_user_subage", { login, channel });
      if (seq !== subageSeq || login !== currentLogin || activeChannel().trim() !== channel) {
        return;
      }
      const followText = result.followage?.trim() ?? "";
      if (followageEl) {
        if (followText) {
          followageEl.textContent = followText;
          const ago = result.followageAgo?.trim() ?? "";
          if (ago) {
            followageEl.title = ago;
          } else {
            followageEl.removeAttribute("title");
          }
          followageEl.hidden = false;
        } else {
          followageEl.hidden = true;
          followageEl.textContent = "";
          followageEl.removeAttribute("title");
        }
      }
      const subText = result.subage?.trim() ?? "";
      if (subageEl) {
        if (subText) {
          subageEl.textContent = subText;
          subageEl.removeAttribute("title");
          subageEl.hidden = false;
        } else {
          subageEl.hidden = true;
          subageEl.textContent = "";
        }
      }
    } catch {
      if (seq !== subageSeq || login !== currentLogin) {
        return;
      }
      hideSubage();
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
      if (blockCheckbox) {
        suppressBlockChange = true;
        blockCheckbox.checked = false;
        suppressBlockChange = false;
        blockCheckbox.disabled = true;
      }
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
    currentUserId = "";
    subageSeq += 1;
    resetBlockUi();
    resetIgnoreHighlightsUi();
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
    refreshModUi();
    placeNear(info.clientX, info.clientY);
    void loadIgnoreHighlightsState(currentLogin);
    void loadSubage(currentLogin);
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
  if (blockCheckbox) {
    blockCheckbox.addEventListener("change", () => {
      if (suppressBlockChange || blockBusy || !currentLogin || modal.hidden) {
        return;
      }
      const login = currentLogin;
      const userId = currentUserId;
      if (!/^\d+$/.test(userId)) {
        suppressBlockChange = true;
        blockCheckbox.checked = false;
        suppressBlockChange = false;
        return;
      }
      const wantBlocked = blockCheckbox.checked;
      if (wantBlocked) {
        const ok = window.confirm(
          `Blocking ${login} can cause unintended side-effects like unfollowing.\n\nAre you sure you want to block ${login}?`,
        );
        if (!ok) {
          suppressBlockChange = true;
          blockCheckbox.checked = false;
          suppressBlockChange = false;
          return;
        }
      }
      void (async () => {
        blockBusy = true;
        blockCheckbox.disabled = true;
        try {
          await invoke("chat_set_user_blocked", {
            userId,
            login,
            blocked: wantBlocked,
          });
          if (login !== currentLogin || modal.hidden) {
            return;
          }
          setStatus(wantBlocked ? `Blocked @${login}` : `Unblocked @${login}`);
        } catch (e) {
          if (login !== currentLogin || modal.hidden) {
            return;
          }
          suppressBlockChange = true;
          blockCheckbox.checked = !wantBlocked;
          suppressBlockChange = false;
          const msg =
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : "Could not update block.";
          setStatus(msg);
        } finally {
          blockBusy = false;
          if (login === currentLogin && !modal.hidden) {
            blockCheckbox.disabled = false;
          }
        }
      })();
    });
  }
  if (ignoreHighlightsCheckbox) {
    ignoreHighlightsCheckbox.addEventListener("change", () => {
      if (
        suppressIgnoreHighlightsChange ||
        ignoreHighlightsBusy ||
        !currentLogin ||
        modal.hidden
      ) {
        return;
      }
      const login = currentLogin;
      const wantIgnored = ignoreHighlightsCheckbox.checked;
      void (async () => {
        ignoreHighlightsBusy = true;
        ignoreHighlightsCheckbox.disabled = true;
        try {
          await invoke("chat_set_user_ignore_highlights", {
            login,
            ignored: wantIgnored,
          });
          if (login !== currentLogin || modal.hidden) {
            return;
          }
          setStatus(
            wantIgnored
              ? `Highlights ignored for @${login}`
              : `Highlights restored for @${login}`,
          );
        } catch (e) {
          if (login !== currentLogin || modal.hidden) {
            return;
          }
          suppressIgnoreHighlightsChange = true;
          ignoreHighlightsCheckbox.checked = !wantIgnored;
          suppressIgnoreHighlightsChange = false;
          const msg =
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : "Could not update ignore highlights.";
          setStatus(msg);
        } finally {
          ignoreHighlightsBusy = false;
          if (login === currentLogin && !modal.hidden) {
            void loadIgnoreHighlightsState(login);
          }
        }
      })();
    });
  }
  if (roleModBtn) {
    roleModBtn.addEventListener("click", () => {
      void sendMod("mod");
    });
  }
  if (roleUnmodBtn) {
    roleUnmodBtn.addEventListener("click", () => {
      void sendMod("unmod");
    });
  }
  if (roleVipBtn) {
    roleVipBtn.addEventListener("click", () => {
      void sendMod("vip");
    });
  }
  if (roleUnvipBtn) {
    roleUnvipBtn.addEventListener("click", () => {
      void sendMod("unvip");
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

  return { open, close, syncAvatars, syncPronouns, syncMod: refreshModUi, syncSubage };
}
