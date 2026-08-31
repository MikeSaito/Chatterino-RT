import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent, ViewerRole } from "../chat/types";
import { t } from "../i18n";
import { formatInvokeError } from "../i18n/formatError";
import { isSettingsWindowOpen } from "./settings/settingsWindowState";
import {
  closeModal,
  closeModalImmediate,
  prepareModalOpen,
} from "./modalClose";
import { bindFocusTrap } from "./focusTrap";
import {
  snapshotModChannel,
  userCardModChannelMatches,
} from "./modChannelBind";
import {
  moderationSlashCommand,
  warnSlashCommand,
  warnReasonRejectReason,
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
  notesModal: HTMLElement;
  searchModal: HTMLElement;
  activeChannel: () => string;
  autoClose: () => boolean;
  getHideAvatars: () => boolean;
  /** streamerMode.hideUserNotes && streamer mode active */
  getHideUserNotes: () => boolean;
  /** misc.showPronouns */
  getShowPronouns: () => boolean;
  /** misc.openLinksIncognito when private open is supported. */
  getOpenPrivate?: () => boolean;
  /** misc.scrollbackUsercardLimit (hot on each open). */
  getUsercardLimit: () => number;
  getTimeoutButtons: () => TimeoutButton[];
  getSelfLogin: () => string | null;
}): {
  open: (info: UserCardOpen) => void;
  close: () => void;
  syncAvatars: () => void;
  syncPronouns: () => void;
  syncMod: () => void;
  syncSubage: () => void;
  syncNotes: () => void;
  relabelChrome: () => void;
} {
  const {
    modal,
    notesModal,
    searchModal,
    activeChannel,
    autoClose,
    getHideAvatars,
    getHideUserNotes,
    getShowPronouns,
    getOpenPrivate,
    getUsercardLimit,
    getTimeoutButtons,
    getSelfLogin,
  } = opts;
  const dialog = modal.querySelector<HTMLElement>("#usercard-dialog");
  const notesDialog = notesModal.querySelector<HTMLElement>("#notes-dialog");
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
  const warnBtn = modal.querySelector<HTMLButtonElement>("#usercard-warn");
  const banBtn = modal.querySelector<HTMLButtonElement>("#usercard-ban");
  const unbanBtn = modal.querySelector<HTMLButtonElement>("#usercard-unban");
  const blockRow = modal.querySelector<HTMLElement>("#usercard-block-row");
  const blockCheckbox = modal.querySelector<HTMLInputElement>("#usercard-block");
  const ignoreHighlightsRow = modal.querySelector<HTMLElement>("#usercard-ignore-highlights-row");
  const ignoreHighlightsCheckbox = modal.querySelector<HTMLInputElement>("#usercard-ignore-highlights");
  const notesPreviewEl = modal.querySelector<HTMLElement>("#usercard-notes-preview");
  const addNotesBtn = modal.querySelector<HTMLButtonElement>("#usercard-add-notes");
  const statusEl = modal.querySelector<HTMLElement>("#usercard-status");
  const skeletonEl = modal.querySelector<HTMLElement>("#usercard-skeleton");
  const head = modal.querySelector<HTMLElement>(".popup-head");
  const notesTitle = notesModal.querySelector<HTMLElement>("#notes-title");
  const notesEditor = notesModal.querySelector<HTMLTextAreaElement>("#notes-editor");
  const notesCounter = notesModal.querySelector<HTMLElement>("#notes-counter");
  const notesOk = notesModal.querySelector<HTMLButtonElement>("#notes-ok");
  const notesCancel = notesModal.querySelector<HTMLButtonElement>("#notes-cancel");
  const notesClose = notesModal.querySelector<HTMLButtonElement>("#notes-close");
  const notesBackdrop = notesModal.querySelector<HTMLElement>("#notes-backdrop");
  if (
    !dialog ||
    !notesDialog ||
    !closeBtn ||
    !nameEl ||
    !loginEl ||
    !recent ||
    !openTwitch ||
    !head
  ) {
    return {
      open: () => undefined,
      close: () => undefined,
      syncAvatars: () => undefined,
      syncPronouns: () => undefined,
      syncMod: () => undefined,
      syncSubage: () => undefined,
      syncNotes: () => undefined,
      relabelChrome: () => undefined,
    };
  }

  let currentLogin = "";
  let currentName = "";
  /** Channel login the card was opened on; mod actions bind to this only. */
  let openChannel = "";
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
  let notesSeq = 0;
  let cachedNotes = "";
  let notesBusy = false;
  let drag: { ox: number; oy: number; sx: number; sy: number } | null = null;

  const paintNotesCounter = (): void => {
    if (!notesCounter || !notesEditor) {
      return;
    }
    notesCounter.textContent = String([...notesEditor.value].length);
  };

  const showSkeleton = (): void => {
    if (skeletonEl) {
      skeletonEl.hidden = false;
    }
    dialog.classList.add("is-loading");
  };

  const hideSkeleton = (): void => {
    if (skeletonEl) {
      skeletonEl.hidden = true;
    }
    dialog.classList.remove("is-loading");
  };

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
    hideNotesPreview();
    cachedNotes = "";
    setAddNotesEnabled(false);
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

  const hideNotesPreview = (): void => {
    if (notesPreviewEl) {
      notesPreviewEl.hidden = true;
      notesPreviewEl.textContent = "";
    }
  };

  const setAddNotesEnabled = (enabled: boolean): void => {
    if (addNotesBtn) {
      addNotesBtn.disabled = !enabled || notesBusy;
    }
  };

  const applyNotesPreview = (notes: string): void => {
    if (!notesPreviewEl) {
      return;
    }
    const trimmed = notes.trim();
    if (!trimmed) {
      hideNotesPreview();
      return;
    }
    if (getHideUserNotes()) {
      notesPreviewEl.textContent = t("usercard.notes.hiddenStreamer");
      notesPreviewEl.hidden = false;
      return;
    }
    notesPreviewEl.textContent = notes;
    notesPreviewEl.hidden = false;
  };

  const closeNotesDialog = (): void => {
    if (notesBusy) {
      return;
    }
    if (notesEditor) {
      notesEditor.value = "";
    }
    notesTrap.deactivate();
    void closeModal(notesModal);
  };

  const forceCloseNotesDialog = (): void => {
    notesTrap.deactivate();
    closeModalImmediate(notesModal);
    if (notesEditor) {
      notesEditor.value = "";
    }
  };

  const setNotesDialogBusy = (busy: boolean): void => {
    if (notesOk) {
      notesOk.disabled = busy;
    }
    if (notesCancel) {
      notesCancel.disabled = busy;
    }
    if (notesClose) {
      notesClose.disabled = busy;
    }
    if (notesEditor) {
      notesEditor.readOnly = busy;
    }
  };

  const openNotesDialog = (): void => {
    if (!/^\d+$/.test(currentUserId) || !notesEditor || !notesTitle) {
      return;
    }
    if (isSettingsWindowOpen() || !searchModal.hidden) {
      return;
    }
    notesTitle.textContent = t("usercard.notes.title", {
      name: nameEl.textContent?.trim() || currentLogin || t("usercard.notes.title.fallbackUser"),
    });
    notesEditor.value = cachedNotes;
    paintNotesCounter();
    prepareModalOpen(notesModal);
    notesTrap.activate();
    notesEditor.focus();
  };

  const loadNotes = async (userId: string): Promise<void> => {
    const seq = ++notesSeq;
    if (!/^\d+$/.test(userId)) {
      cachedNotes = "";
      hideNotesPreview();
      setAddNotesEnabled(false);
      return;
    }
    setAddNotesEnabled(true);
    try {
      const result = await invoke<{ notes: string }>("chat_user_notes", { userId });
      if (seq !== notesSeq || userId !== currentUserId) {
        return;
      }
      cachedNotes = typeof result.notes === "string" ? result.notes : "";
      applyNotesPreview(cachedNotes);
    } catch {
      if (seq !== notesSeq || userId !== currentUserId) {
        return;
      }
      cachedNotes = "";
      hideNotesPreview();
    }
  };

  const syncNotes = (): void => {
    if (modal.hidden) {
      return;
    }
    applyNotesPreview(cachedNotes);
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
      userIdText.textContent = t("usercard.id.na");
      userIdRow.hidden = false;
    }
    if (followersEl) {
      followersEl.textContent = t("usercard.followers.na");
      followersEl.hidden = false;
    }
    if (createdEl) {
      createdEl.textContent = t("usercard.created.na");
      createdEl.removeAttribute("title");
      createdEl.hidden = false;
    }
  };

  const applyProfileMeta = (profile: UserProfile, login: string): void => {
    hideSkeleton();
    currentUserId = /^\d+$/.test(profile.id) ? profile.id : "";
    const displayName = profile.displayName.trim();
    if (displayName && displayName.toLowerCase() !== login) {
      nameEl.textContent = login;
      currentName = login;
      if (localizedText) {
        localizedText.textContent = displayName;
      }
      if (localizedRow) {
        localizedRow.hidden = false;
      }
    } else if (localizedRow) {
      localizedRow.hidden = true;
      nameEl.textContent = displayName || login;
      currentName = displayName || login;
    }

    if (userIdText && userIdRow) {
      userIdText.textContent = currentUserId
        ? t("usercard.id", { id: currentUserId })
        : t("usercard.id.na");
      userIdRow.hidden = false;
    }

    if (followersEl) {
      followersEl.textContent = t("usercard.followers.na");
      followersEl.hidden = false;
    }

    if (createdEl) {
      const created = profile.createdAt?.trim() ?? "";
      if (created) {
        createdEl.textContent = t("usercard.created", {
          date: formatCreatedDate(created),
        });
        createdEl.title = created;
        createdEl.hidden = false;
      } else {
        createdEl.textContent = t("usercard.created.na");
        createdEl.removeAttribute("title");
        createdEl.hidden = false;
      }
    }
    void loadBlockState(login, profile.id);
    void loadIgnoreHighlightsState(login);
    void loadNotes(profile.id);
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
    if (warnBtn) {
      warnBtn.disabled = busy;
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
    if (warnBtn) {
      warnBtn.hidden = true;
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
      ignoreHighlightsCheckbox.title = t("usercard.ignoreHighlights.regexTitle");
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
    const channel = openChannel;
    if (!channel || !userCardModChannelMatches(channel, activeChannel())) {
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
          openChannel !== channel ||
          !userCardModChannelMatches(channel, activeChannel())
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
        if (warnBtn) {
          warnBtn.hidden = !showMod;
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
            btn.title = t("usercard.timeout.title", { n: btnDef.seconds });
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
    const channel = openChannel;
    if (!channel) {
      setStatus(t("usercard.empty.noChannel"));
      return;
    }
    if (!userCardModChannelMatches(channel, activeChannel())) {
      hideModRow();
      setStatus(t("usercard.empty.noChannel"));
      return;
    }
    const text = moderationSlashCommand(kind, loginAtSend, seconds);
    if (!text) {
      setStatus(t("usercard.error.invalidUser"));
      return;
    }
    setStatus("");
    setModBusy(true);
    try {
      if (
        !userCardModChannelMatches(channel, activeChannel()) ||
        openChannel !== channel
      ) {
        hideModRow();
        setStatus(t("usercard.empty.noChannel"));
        return;
      }
      await invoke("chat_send", { text, replyToId: null, channel });
    } catch (e) {
      if (modal.hidden || currentLogin !== loginAtSend) {
        return;
      }
      setStatus(formatInvokeError(e));
    } finally {
      if (!modal.hidden && currentLogin === loginAtSend) {
        setModBusy(false);
      } else {
        modBusy = false;
      }
    }
  };

  const sendWarn = async (): Promise<void> => {
    if (!currentLogin || modBusy || modal.hidden) {
      return;
    }
    const loginAtSend = currentLogin;
    const channel = openChannel;
    if (!channel) {
      setStatus(t("usercard.empty.noChannel"));
      return;
    }
    if (!userCardModChannelMatches(channel, activeChannel())) {
      hideModRow();
      setStatus(t("usercard.empty.noChannel"));
      return;
    }
    const raw = window.prompt(t("usercard.warn.prompt"));
    if (raw === null) {
      return;
    }
    if (modal.hidden || currentLogin !== loginAtSend || modBusy) {
      return;
    }
    if (!userCardModChannelMatches(channel, activeChannel()) || openChannel !== channel) {
      hideModRow();
      setStatus(t("usercard.empty.noChannel"));
      return;
    }
    const reason = raw.trim();
    const reject = warnReasonRejectReason(reason);
    if (reject === "empty" || reject === "controls") {
      setStatus(t("usercard.warn.reasonRequired"));
      return;
    }
    if (reject === "too_long") {
      setStatus(t("usercard.warn.reasonTooLong"));
      return;
    }
    const text = warnSlashCommand(loginAtSend, reason);
    if (!text) {
      setStatus(t("usercard.error.invalidUser"));
      return;
    }
    setStatus("");
    setModBusy(true);
    try {
      if (
        !userCardModChannelMatches(channel, activeChannel()) ||
        openChannel !== channel
      ) {
        hideModRow();
        setStatus(t("usercard.empty.noChannel"));
        return;
      }
      await invoke("chat_send", { text, replyToId: null, channel });
    } catch (e) {
      if (modal.hidden || currentLogin !== loginAtSend) {
        return;
      }
      setStatus(formatInvokeError(e));
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
    cardTrap.deactivate();
    void closeModal(modal);
    currentLogin = "";
    currentUserId = "";
    currentName = "";
    openChannel = "";
    pinned = false;
    modBusy = false;
    if (pinBtn) {
      pinBtn.classList.remove("is-pinned");
      pinBtn.title = t("usercard.pin");
      pinBtn.setAttribute("aria-label", t("usercard.pin"));
    }
    clearAvatar();
    clearPronouns();
    clearMeta();
    recent.replaceChildren();
    setStatus("");
    if (banBtn) {
      banBtn.disabled = false;
    }
    if (warnBtn) {
      warnBtn.disabled = false;
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
    notesSeq += 1;
    cachedNotes = "";
    hideNotesPreview();
    setAddNotesEnabled(false);
    forceCloseNotesDialog();
  };

  const cardTrap = bindFocusTrap(dialog, {
    isActive: () => !modal.hidden && notesModal.hidden,
    onEscape: () => {
      if (pinned) {
        return false;
      }
      close();
      return true;
    },
  });
  const notesTrap = bindFocusTrap(notesDialog, {
    isActive: () => !notesModal.hidden,
    onEscape: () => {
      if (notesBusy) {
        return false;
      }
      closeNotesDialog();
      return true;
    },
  });

  const placeNear = (clientX: number, clientY: number): void => {
    prepareModalOpen(modal);
    cardTrap.activate();
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
          ? t("usercard.followers.na")
          : t("usercard.followers", { count: formatFollowerCount(count) });
      followersEl.hidden = false;
    } catch {
      if (login !== currentLogin) {
        return;
      }
      followersEl.textContent = t("usercard.followers.na");
      followersEl.hidden = false;
    }
  };

  const loadSubage = async (login: string): Promise<void> => {
    if (!followageEl && !subageEl) {
      return;
    }
    const seq = ++subageSeq;
    const channel = openChannel;
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
      if (
        seq !== subageSeq ||
        login !== currentLogin ||
        openChannel !== channel
      ) {
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
      hideSkeleton();
      showMetaUnavailable();
      clearAvatar();
      cachedNotes = "";
      hideNotesPreview();
      setAddNotesEnabled(false);
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
    setPronounsLabel(t("usercard.pronouns.loading"));
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
        setPronounsLabel(t("usercard.pronouns", { text }));
      } else {
        setPronounsLabel(t("usercard.pronouns.unspecified"));
      }
    } catch {
      if (login !== currentLogin) {
        return;
      }
      if (!getShowPronouns()) {
        clearPronouns();
        return;
      }
      setPronounsLabel(t("usercard.pronouns.unspecified"));
    }
  };

  const open = (info: UserCardOpen): void => {
    if (isSettingsWindowOpen() || !searchModal.hidden) {
      return;
    }
    currentLogin = info.login.toLowerCase();
    currentUserId = "";
    currentName = info.nick || info.login;
    openChannel = snapshotModChannel(activeChannel());
    subageSeq += 1;
    notesSeq += 1;
    cachedNotes = "";
    notesBusy = false;
    setNotesDialogBusy(false);
    forceCloseNotesDialog();
    resetBlockUi();
    resetIgnoreHighlightsUi();
    nameEl.textContent = currentName;
    loginEl.textContent = info.login ? `@${info.login}` : "";
    clearAvatar();
    clearPronouns();
    clearMeta();
    showMetaUnavailable();
    recent.replaceChildren();
    setStatus("");
    showSkeleton();
    refreshModUi();
    placeNear(info.clientX, info.clientY);
    void loadIgnoreHighlightsState(currentLogin);
    void loadSubage(currentLogin);
    void loadRecent(currentLogin);
    void loadProfile(currentLogin);
    void loadPronouns(currentLogin);
  };

  const loadRecent = async (login: string): Promise<void> => {
    const channel = openChannel;
    if (!channel) {
      recent.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "usercard-empty";
      empty.textContent = t("usercard.empty.noChannel");
      recent.append(empty);
      return;
    }
    try {
      const snap = await invoke<{ events: ChatEvent[] }>("chat_snapshot", { channel });
      if (login !== currentLogin || openChannel !== channel) {
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
        empty.textContent = t("usercard.empty.noMessages");
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
      err.textContent = t("usercard.error.loadMessages");
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
      pinBtn.title = pinned ? t("usercard.unpin") : t("usercard.pin");
      pinBtn.setAttribute("aria-label", pinned ? t("usercard.unpin") : t("usercard.pin"));
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
    const el = ev.target as HTMLElement;
    if (el.closest("button")) {
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
  if (warnBtn) {
    warnBtn.addEventListener("click", () => {
      void sendWarn();
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
          setStatus(
            wantBlocked
              ? t("usercard.status.blocked", { login })
              : t("usercard.status.unblocked", { login }),
          );
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
              : t("usercard.error.block");
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
              ? t("usercard.status.highlightsIgnored", { login })
              : t("usercard.status.highlightsRestored", { login }),
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
              : t("usercard.error.ignoreHighlights");
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

  if (addNotesBtn) {
    addNotesBtn.addEventListener("click", () => {
      openNotesDialog();
    });
  }

  if (notesEditor) {
    notesEditor.addEventListener("input", paintNotesCounter);
  }

  const saveNotesFromDialog = (): void => {
    if (notesBusy || !notesEditor || !/^\d+$/.test(currentUserId)) {
      return;
    }
    const userId = currentUserId;
    const loginAtSave = currentLogin;
    const nextNotes = notesEditor.value;
    notesBusy = true;
    setNotesDialogBusy(true);
    setAddNotesEnabled(false);
    void (async () => {
      try {
        await invoke("chat_set_user_notes", { userId, notes: nextNotes });
        if (userId !== currentUserId || loginAtSave !== currentLogin) {
          return;
        }
        forceCloseNotesDialog();
        await loadNotes(userId);
      } catch (e) {
        if (userId !== currentUserId || modal.hidden) {
          return;
        }
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : t("usercard.error.saveNotes");
        setStatus(msg);
      } finally {
        notesBusy = false;
        setNotesDialogBusy(false);
        if (/^\d+$/.test(currentUserId)) {
          setAddNotesEnabled(true);
        }
      }
    })();
  };

  if (notesOk) {
    notesOk.addEventListener("click", () => {
      saveNotesFromDialog();
    });
  }
  if (notesCancel) {
    notesCancel.addEventListener("click", () => {
      closeNotesDialog();
    });
  }
  if (notesClose) {
    notesClose.addEventListener("click", () => {
      closeNotesDialog();
    });
  }
  if (notesBackdrop) {
    notesBackdrop.addEventListener("click", () => {
      closeNotesDialog();
    });
  }

  document.addEventListener("pointerdown", (ev) => {
    if (!notesModal.hidden) {
      return;
    }
    if (modal.hidden || pinned || !autoClose()) {
      return;
    }
    const node = ev.target as Node;
    if (dialog.contains(node)) {
      return;
    }
    close();
  });

  const relabelChrome = (): void => {
    if (pinBtn) {
      pinBtn.title = pinned ? t("usercard.unpin") : t("usercard.pin");
      pinBtn.setAttribute(
        "aria-label",
        pinned ? t("usercard.unpin") : t("usercard.pin"),
      );
    }
    if (!modal.hidden && currentLogin) {
      if (currentName) {
        nameEl.textContent = currentName;
      }
      if (currentUserId) {
        if (userIdText && userIdRow) {
          userIdText.textContent = t("usercard.id", { id: currentUserId });
          userIdRow.hidden = false;
        }
      } else if (userIdText && userIdRow && !userIdRow.hidden) {
        userIdText.textContent = t("usercard.id.na");
      }
      applyNotesPreview(cachedNotes);
      if (!notesModal.hidden && notesTitle) {
        notesTitle.textContent = t("usercard.notes.title", {
          name:
            nameEl.textContent?.trim() ||
            currentLogin ||
            t("usercard.notes.title.fallbackUser"),
        });
      }
      if (timeoutsEl) {
        for (const btn of timeoutsEl.querySelectorAll("button")) {
          const seconds = Number((btn as HTMLButtonElement).dataset.seconds);
          if (Number.isFinite(seconds) && seconds > 0) {
            (btn as HTMLButtonElement).title = t("usercard.timeout.title", {
              n: seconds,
            });
          }
        }
      }
      if (
        ignoreHighlightsCheckbox &&
        !ignoreHighlightsCheckbox.disabled &&
        ignoreHighlightsCheckbox.title
      ) {
        ignoreHighlightsCheckbox.title = t(
          "usercard.ignoreHighlights.regexTitle",
        );
      }
    }
  };

  return {
    open,
    close,
    syncAvatars,
    syncPronouns,
    syncMod: refreshModUi,
    syncSubage,
    syncNotes,
    relabelChrome,
  };
}
