import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createChatApp, destroyChatApp } from "./pixi/app";
import { MessageRing, type SlotContext } from "./chat/ring";
import { bindChatIpc, type ChatIpc } from "./chat/ipc";
import { TextureLru } from "./chat/textures";
import { mountPlayer, unmountPlayer } from "./player/embed";
import { bindScrollChrome } from "./chat/scrollUi";
import { bindChannelList } from "./shell/channels";
import {
  formatChannelTitle,
  parseHeaderKnobs,
  type HeaderKnobs,
} from "./shell/channelHeader";
import { bindSearchPopup } from "./shell/chatFind";
import { bindSettingsDialog } from "./shell/settings/dialog";
import {
  actionAllowsEditable,
  resolveAction,
  type HotkeyAction,
} from "./shell/hotkeys";
import {
  bindComposerChrome,
  defaultComposerChrome,
  parseMessageOverflow,
  type ComposerChromeOpts,
} from "./shell/composerUi";
import {
  parseUsernameRclickAction,
  parseUsernameRclickModifier,
  resolveUsernameRightClick,
  type UsernameRclickAction,
  type UsernameRclickModifier,
} from "./shell/usernameRclick";
import { mentionInsertText } from "./shell/mentionFormat";
import { bindStreamerModeBadge, isStreamerModeActive } from "./shell/streamerMode";
import { bindUserCard } from "./shell/userCard";
import { bindReplyThread } from "./shell/replyThread";
import { bindEmotePopup } from "./shell/emotePopup";
import {
  bindEmoteTooltip,
  parseEmoteTooltipScale,
  parseThumbnailSize,
  parseTooltipPreviewMode,
  type EmoteTooltipScale,
  type TooltipPreviewMode,
} from "./shell/emoteTooltip";
import { isAtUserToken, isColonEmoteToken, tokenAtCursor } from "./chat/token";
import { CHAT_AUTH_EVENT, CHAT_CHANNEL_LIVE_EVENT, CHAT_ROOMS_EVENT, CHAT_SEND_WAIT_EVENT, CHAT_STATUS_EVENT } from "./constants";
import type { AuthInfo, ChannelLive, ChatStatus } from "./chat/types";

let chatIpc: ChatIpc | null = null;
let teardownChat: (() => void) | null = null;

window.addEventListener("DOMContentLoaded", () => {
  void boot();
});

window.addEventListener("beforeunload", () => {
  teardownChat?.();
  teardownChat = null;
});

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#chat-canvas");
  const pane = document.querySelector<HTMLElement>("#chat-pane");
  const canvasHost = document.querySelector<HTMLElement>("#chat-canvas-host");
  const scrollTrack = document.querySelector<HTMLElement>("#chat-scroll");
  const scrollThumb = document.querySelector<HTMLElement>("#chat-scroll-thumb");
  const jumpBottom = document.querySelector<HTMLButtonElement>("#chat-jump-bottom");
  const completeList = document.querySelector<HTMLUListElement>("#complete-list");
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
  const composerLength = document.querySelector<HTMLElement>("#composer-length");
  const composerWait = document.querySelector<HTMLElement>("#composer-wait");
  const replyBar = document.querySelector<HTMLElement>("#reply-bar");
  const replyLabel = document.querySelector<HTMLElement>("#reply-label");
  const replyCancel = document.querySelector<HTMLButtonElement>("#reply-cancel");
  const contextMenu = document.querySelector<HTMLMenuElement>("#chat-context");
  const authLogin = document.querySelector<HTMLElement>("#auth-login");
  const authSignin = document.querySelector<HTMLButtonElement>("#auth-signin");
  const authLogout = document.querySelector<HTMLButtonElement>("#auth-logout");
  const authDevice = document.querySelector<HTMLElement>("#auth-device");
  const authPaste = document.querySelector<HTMLTextAreaElement>("#auth-paste");
  const authImport = document.querySelector<HTMLButtonElement>("#auth-import");
  const settingsModal = document.querySelector<HTMLElement>("#settings-modal");
  const settingsOpen = document.querySelector<HTMLButtonElement>("#settings-open");
  const searchModal = document.querySelector<HTMLElement>("#search-modal");
  const usercardModal = document.querySelector<HTMLElement>("#usercard-modal");
  const replythreadModal = document.querySelector<HTMLElement>("#replythread-modal");
  const emotepopupModal = document.querySelector<HTMLElement>("#emotepopup-modal");
  const emoteOpen = document.querySelector<HTMLButtonElement>("#emote-open");
  if (
    !canvas ||
    !pane ||
    !canvasHost ||
    !scrollTrack ||
    !scrollThumb ||
    !jumpBottom ||
    !completeList ||
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
    !composerLength ||
    !composerWait ||
    !replyBar ||
    !replyLabel ||
    !replyCancel ||
    !contextMenu ||
    !authLogin ||
    !authSignin ||
    !authLogout ||
    !authDevice ||
    !authPaste ||
    !authImport ||
    !settingsModal ||
    !settingsOpen ||
    !searchModal ||
    !usercardModal ||
    !replythreadModal ||
    !emotepopupModal ||
    !emoteOpen
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
  const replyBarEl = replyBar;
  const replyLabelEl = replyLabel;
  const replyCancelBtn = replyCancel;
  const contextMenuEl = contextMenu;
  const loginEl = authLogin;
  const signinBtn = authSignin;
  const logoutBtn = authLogout;
  const deviceEl = authDevice;
  const pasteEl = authPaste;
  const importBtn = authImport;
  const completeBox = completeList;
  let composerOpts: ComposerChromeOpts = defaultComposerChrome();
  const sendWaitByChannel = new Map<string, string>();
  const composerChrome = bindComposerChrome({
    form: composer,
    input: messageInput,
    lengthEl: composerLength,
    waitEl: composerWait,
    replyBar: replyBarEl,
    getOpts: () => composerOpts,
  });
  let nickRclick = {
    behavior: "Mention" as UsernameRclickAction,
    modBehavior: "Reply" as UsernameRclickAction,
    modifier: "Shift" as UsernameRclickModifier,
  };
  let mentionUsersWithComma = true;
  let emoteCompletionWithColon = true;
  let showUsernameCompletionMenu = true;
  completeBox.addEventListener("mousedown", (ev) => {
    const li = (ev.target as HTMLElement).closest("li");
    if (!li || !completeBox.contains(li)) {
      return;
    }
    ev.preventDefault();
    if (!complete) {
      return;
    }
    const i = Number(li.dataset.index);
    if (!Number.isInteger(i) || i < 0 || i >= complete.items.length) {
      return;
    }
    complete.index = i;
    writeComplete();
    messageInput.focus();
  });

  const app = await createChatApp(canvas, canvasHost);
  const textures = new TextureLru();
  const ring = new MessageRing(app, textures);
  await ring.init();
  const emoteTooltip = document.querySelector<HTMLElement>("#emote-tooltip");
  const emoteTooltipImg =
    document.querySelector<HTMLImageElement>("#emote-tooltip-img");
  const emoteTooltipText =
    document.querySelector<HTMLElement>("#emote-tooltip-text");
  let emotesTooltipPreview: TooltipPreviewMode = "AlwaysShow";
  let emoteTooltipScale: EmoteTooltipScale = "Medium";
  let linkInfoTooltip = false;
  let thumbnailSizePx = 0;
  let hideLinkThumbnails = true;
  let headerKnobs: HeaderKnobs = parseHeaderKnobs({});
  const streamByChannel = new Map<string, ChannelLive>();
  let emoteTooltipCtl: { hide: () => void; refresh: () => void } | null = null;
  if (emoteTooltip && emoteTooltipImg && emoteTooltipText && canvasHost) {
    emoteTooltipCtl = bindEmoteTooltip({
      host: canvasHost,
      ring,
      tooltip: emoteTooltip,
      img: emoteTooltipImg,
      text: emoteTooltipText,
      getPreviewMode: () => emotesTooltipPreview,
      getScale: () => emoteTooltipScale,
      getLinkInfoEnabled: () => linkInfoTooltip,
      getThumbnailSizePx: () => thumbnailSizePx,
      getHideLinkThumbnails: () => hideLinkThumbnails && isStreamerModeActive(),
    });
  }
  teardownChat = () => {
    chatIpc?.stop();
    chatIpc = null;
    ring.destroy();
    textures.clear();
    destroyChatApp();
  };
  bindStreamerModeBadge(document.querySelector<HTMLElement>("#streamer-badge"));
  let autoCloseUserPopup = true;
  let autoCloseThreadPopup = false;
  const replyBtn = document.querySelector<HTMLButtonElement>("#chat-reply-btn");
  let replyHover: { msgId: string; login: string; text: string } | null = null;
  let lastPointerY = 0;
  const scrollChrome = bindScrollChrome({
    ring,
    host: canvasHost,
    track: scrollTrack,
    thumb: scrollThumb,
    jump: jumpBottom,
    onScroll: () => {
      emoteTooltipCtl?.refresh();
      if (!replyBtn || replyBtn.hidden || !replyHover) {
        return;
      }
      const anchor = ring.replyAnchorAt(0, lastPointerY);
      if (!anchor || anchor.msgId !== replyHover.msgId) {
        replyBtn.hidden = true;
        replyHover = null;
        return;
      }
      const hostRect = canvasHost.getBoundingClientRect();
      replyBtn.style.top = `${Math.max(4, anchor.top - hostRect.top)}px`;
    },
  });
  const settingsCtl = bindSettingsDialog({
    ring,
    openBtn: settingsOpen,
    modal: settingsModal,
    onDisplay: (data) => {
      autoCloseUserPopup =
        data.knobs["behaviour.autoCloseUserPopup"] !== false;
      autoCloseThreadPopup =
        data.knobs["behaviour.autoCloseThreadPopup"] === true;
      if (!data.knobs["appearance.showReplyButton"] && replyBtn) {
        replyBtn.hidden = true;
        replyHover = null;
      }
      composerOpts = {
        showEmptyInput: data.knobs["appearance.showEmptyInput"] !== false,
        showMessageLength: data.knobs["appearance.showMessageLength"] === true,
        showSendWaitTimer:
          data.knobs["appearance.showSendWaitTimer"] === true,
        overflow: parseMessageOverflow(data.knobs["appearance.messageOverflow"]),
        pulseOnSelf:
          data.knobs["appearance.pulseTextInputOnSelfMessage"] === true,
      };
      composerChrome.sync();
      scrollThumb.classList.toggle(
        "is-hidden-thumb",
        data.knobs["appearance.hideScrollbarThumb"] === true,
      );
      scrollChrome.setHideHighlights(
        data.knobs["appearance.hideScrollbarHighlights"] === true,
      );
      nickRclick = {
        behavior: parseUsernameRclickAction(
          data.knobs["behaviour.usernameRightClickBehavior"],
        ),
        modBehavior: parseUsernameRclickAction(
          data.knobs["behaviour.usernameRightClickModifierBehavior"],
        ),
        modifier: parseUsernameRclickModifier(
          data.knobs["behaviour.usernameRightClickModifier"],
        ),
      };
      mentionUsersWithComma =
        data.knobs["behaviour.mentionUsersWithComma"] !== false;
      const colonOn = data.knobs["behaviour.emoteCompletionWithColon"] !== false;
      const usernameMenuOn =
        data.knobs["behaviour.showUsernameCompletionMenu"] !== false;
      if (!colonOn && complete?.popup === "colon") {
        clearComplete();
      }
      if (!usernameMenuOn && complete?.popup === "at") {
        clearComplete();
      }
      emoteCompletionWithColon = colonOn;
      showUsernameCompletionMenu = usernameMenuOn;
      emotesTooltipPreview = parseTooltipPreviewMode(
        data.knobs["misc.emotesTooltipPreview"],
      );
      emoteTooltipScale = parseEmoteTooltipScale(
        data.knobs["emotes.emoteTooltipScale"],
      );
      linkInfoTooltip = data.knobs["links.linkInfoTooltip"] === true;
      thumbnailSizePx = parseThumbnailSize(data.knobs["appearance.thumbnailSize"]);
      hideLinkThumbnails = data.knobs["streamerMode.hideLinkThumbnails"] !== false;
      headerKnobs = parseHeaderKnobs(data.knobs);
      emoteTooltipCtl?.refresh();
      repaintChannelTitle();
    },
  });
  const ipc = bindChatIpc(ring);

  let repaintChannelTitle = (): void => {
    if (!titleEl) {
      return;
    }
    const ch = ipc.active();
    if (!ch) {
      titleEl.textContent = "";
      ring.setChannelLive(false);
      return;
    }
    const stream = streamByChannel.get(ch.toLowerCase());
    ring.setChannelLive(stream?.live ?? false);
    titleEl.textContent = formatChannelTitle(ch, stream, headerKnobs);
  };

  function applySendWaitForActive(): void {
    const ch = ipc.active().toLowerCase();
    composerChrome.setWaitText(ch ? (sendWaitByChannel.get(ch) ?? "") : "");
  }
  chatIpc = ipc;
  // Stock WindowDeactivate ≈ tab away / minimize. Prefer visibility hidden so
  // iframe player focus and in-window dialogs do not move the last-read line.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") {
      return;
    }
    if (!settingsModal.hidden || !searchModal.hidden) {
      return;
    }
    ring.markLastReadAtBottom();
  });
  const chatFindCtl = bindSearchPopup({
    ring,
    modal: searchModal,
    settingsModal,
    activeChannel: () => ipc.active(),
    onOpen: () => {
      hideContextMenu();
    },
  });
  const userCard = bindUserCard({
    modal: usercardModal,
    settingsModal,
    searchModal,
    activeChannel: () => ipc.active(),
    autoClose: () => autoCloseUserPopup,
  });
  if (replyBtn) {
    canvasHost.addEventListener("pointermove", (ev) => {
      lastPointerY = ev.clientY;
      if (!ring.isReplyButtonEnabled()) {
        replyBtn.hidden = true;
        replyHover = null;
        return;
      }
      const anchor = ring.replyAnchorAt(ev.clientX, ev.clientY);
      if (!anchor) {
        replyBtn.hidden = true;
        replyHover = null;
        return;
      }
      replyHover = {
        msgId: anchor.msgId,
        login: anchor.login,
        text: anchor.text,
      };
      const hostRect = canvasHost.getBoundingClientRect();
      replyBtn.hidden = false;
      replyBtn.style.top = `${Math.max(4, anchor.top - hostRect.top)}px`;
      replyBtn.style.right = "28px";
    });
    canvasHost.addEventListener("pointerleave", () => {
      if (replyBtn.matches(":hover")) {
        return;
      }
      replyBtn.hidden = true;
      replyHover = null;
    });
    replyBtn.addEventListener("pointerleave", () => {
      replyBtn.hidden = true;
      replyHover = null;
    });
    replyBtn.addEventListener("click", () => {
      if (!replyHover) {
        return;
      }
      setReply(replyHover.msgId, replyHover.login, replyHover.text);
      messageInput.focus();
      replyBtn.hidden = true;
    });
  }
  const replyThread = bindReplyThread({
    modal: replythreadModal,
    settingsModal,
    activeChannel: () => ipc.active(),
    autoClose: () => autoCloseThreadPopup,
    onReply: (id, login, text) => {
      setReply(id, login, text);
      messageInput.focus();
    },
  });
  const emotePopup = bindEmotePopup({
    modal: emotepopupModal,
    settingsModal,
    insertEmote: (code) => {
      const start = messageInput.selectionStart ?? messageInput.value.length;
      const end = messageInput.selectionEnd ?? start;
      const before = messageInput.value.slice(0, start);
      const after = messageInput.value.slice(end);
      const padL = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const padR = after.length > 0 && !after.startsWith(" ") ? " " : "";
      messageInput.value = `${before}${padL}${code}${padR}${after}`;
      const caret = before.length + padL.length + code.length + padR.length;
      messageInput.setSelectionRange(caret, caret);
      messageInput.focus();
    },
  });
  emoteOpen.addEventListener("click", () => {
    emotePopup.open();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented) {
      return;
    }
    const action = resolveAction(ev);
    if (!action) {
      return;
    }
    if (!actionAllowsEditable(action) && isEditableTarget(ev.target)) {
      return;
    }
    if (!settingsModal.hidden) {
      return;
    }
    if (dispatchHotkey(action)) {
      ev.preventDefault();
    }
  });
  function dispatchHotkey(action: HotkeyAction): boolean {
    switch (action) {
      case "showSearch":
        chatFindCtl.open();
        return true;
      case "openSettings":
        chatFindCtl.close();
        settingsCtl.open();
        return true;
      case "openEmotesPopup":
        chatFindCtl.close();
        emotePopup.open();
        return true;
      case "scrollToBottom":
        ring.goToBottom();
        return true;
      case "zoomIn":
        void settingsCtl.bumpZoom(1);
        return true;
      case "zoomOut":
        void settingsCtl.bumpZoom(-1);
        return true;
      case "zoomReset":
        void settingsCtl.bumpZoom(0);
        return true;
      default:
        return false;
    }
  }
  let mountedChannel = "";
  let holdStatus = false;
  let sending = false;
  let lastAuth: AuthInfo = { canSend: false, fromEnv: false };
  let complete: {
    start: number;
    suffix: string;
    items: string[];
    index: number;
    popup: "colon" | "at" | null;
    query: string;
  } | null = null;
  let applyingComplete = false;
  let completeSeq = 0;
  let completeInFlight = false;
  let completePending = 0;
  let replyTarget: { id: string; login: string; text: string } | null = null;
  let contextTarget: SlotContext | null = null;
  let channelBusy = false;
  const channelQueue: {
    kind: "join" | "leave" | "sync";
    name: string;
    focus?: boolean;
  }[] = [];

  const channels = bindChannelList(
    list,
    (login) => {
      void joinChannel(login);
    },
    (login) => {
      void leaveChannel(login);
    },
  );

  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
  });

  ring.setOnContextMenu((ctx) => {
    openContextMenu(ctx);
  });
  ring.setOnNickClick((ctx) => {
    hideContextMenu();
    userCard.open({
      login: ctx.login,
      nick: ctx.nick || ctx.login,
      clientX: ctx.clientX,
      clientY: ctx.clientY,
    });
  });
  ring.setOnNickRightClick((ctx, ev) => {
    hideContextMenu();
    const action = resolveUsernameRightClick({
      behavior: nickRclick.behavior,
      modBehavior: nickRclick.modBehavior,
      modifier: nickRclick.modifier,
      keys: {
        shiftKey: ev.shiftKey,
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
      },
    });
    if (action === "Ignore") {
      return;
    }
    if (action === "Reply") {
      const author = ctx.authorLogin || ctx.login;
      if (author && ctx.msgId && !ctx.disabled) {
        setReply(ctx.msgId, author, ctx.text);
        messageInput.focus();
      }
      return;
    }
    if (!ctx.login) {
      return;
    }
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? start;
    const before = messageInput.value.slice(0, start);
    const after = messageInput.value.slice(end);
    const isFirstWord = !before.includes(" ");
    const mention = mentionInsertText(
      ctx.login,
      isFirstWord,
      mentionUsersWithComma,
    );
    if (!mention) {
      return;
    }
    messageInput.value = `${before}${mention}${after}`;
    const caret = before.length + mention.length;
    messageInput.setSelectionRange(caret, caret);
    composer.hidden = false;
    messageInput.focus();
    composerChrome.sync();
  });

  document.addEventListener("pointerdown", (ev) => {
    if (!contextMenuEl.hidden && !contextMenuEl.contains(ev.target as Node)) {
      hideContextMenu();
    }
  });

  contextMenuEl.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    if (!btn || !contextMenuEl.contains(btn) || !contextTarget) {
      return;
    }
    const action = btn.dataset.action;
    const target = contextTarget;
    hideContextMenu();
    if (action === "copy") {
      void navigator.clipboard.writeText(target.text).catch(() => undefined);
      return;
    }
    if (action === "copy-link" && target.linkUrl) {
      void navigator.clipboard.writeText(target.linkUrl).catch(() => undefined);
      return;
    }
    if (action === "reply" && target.login && target.msgId && !target.disabled) {
      setReply(target.msgId, target.login, target.text);
      messageInput.focus();
      return;
    }
    if (action === "thread" && target.msgId && target.login && !target.disabled) {
      replyThread.open({
        rootId: target.replyToId || target.msgId,
        login: target.login,
        text: target.text,
      });
      return;
    }
    if (action === "user" && target.login) {
      userCard.open({
        login: target.login,
        nick: target.nick || target.login,
        clientX: target.clientX,
        clientY: target.clientY,
      });
      return;
    }
    if (action === "open-twitch" && target.login) {
      void invoke("open_chat_link", {
        url: `https://www.twitch.tv/${target.login}`,
      }).catch(() => undefined);
    }
  });

  replyCancelBtn.addEventListener("click", () => {
    clearReply();
  });

  await listen<ChatStatus>(CHAT_STATUS_EVENT, (ev) => {
    if (holdStatus) {
      return;
    }
    statusEl.textContent = formatStatus(ev.payload);
  });

  await listen<ChannelLive>(CHAT_CHANNEL_LIVE_EVENT, (ev) => {
    const ch = ev.payload.channel?.trim().toLowerCase() ?? "";
    if (!ch) {
      return;
    }
    streamByChannel.set(ch, ev.payload);
    if (ch !== ipc.active().toLowerCase()) {
      return;
    }
    ring.setChannelLive(ev.payload.live);
    repaintChannelTitle();
  });

  await listen<{
    active?: string | null;
    open?: string[];
    dropped?: string | null;
  }>(CHAT_ROOMS_EVENT, (ev) => {
    const open = Array.isArray(ev.payload.open) ? ev.payload.open : [];
    const focus = ev.payload.active || "";
    if (ev.payload.dropped) {
      channels.remove(ev.payload.dropped);
      sendWaitByChannel.delete(ev.payload.dropped.toLowerCase());
      streamByChannel.delete(ev.payload.dropped.toLowerCase());
    }
    channels.syncOpen(open, focus);
    channelQueue.push({ kind: "sync", name: focus });
    if (!channelBusy) {
      drainChannelQueue();
    }
  });

  await listen<{ channelId: string; text: string }>(CHAT_SEND_WAIT_EVENT, (ev) => {
    const ch = ev.payload.channelId?.trim().toLowerCase() ?? "";
    const text = ev.payload.text ?? "";
    if (!ch) {
      return;
    }
    if (text) {
      sendWaitByChannel.set(ch, text);
    } else {
      sendWaitByChannel.delete(ch);
    }
    if (ipc.active().toLowerCase() === ch) {
      composerChrome.setWaitText(text);
    }
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
    if (ev.key === "Tab") {
      ev.preventDefault();
      void cycleComplete(ev.shiftKey);
      return;
    }
    if (ev.key === "Escape") {
      clearComplete();
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void sendMessage();
    }
  });

  messageInput.addEventListener("input", () => {
    if (applyingComplete) {
      composerChrome.sync();
      return;
    }
    const cursor = messageInput.selectionStart ?? 0;
    const { token } = tokenAtCursor(messageInput.value, cursor);
    if (emoteCompletionWithColon && isColonEmoteToken(token)) {
      void refreshColonComplete();
    } else if (showUsernameCompletionMenu && isAtUserToken(token)) {
      void refreshAtUserComplete();
    } else {
      clearComplete();
    }
    composerChrome.sync();
  });

  document.addEventListener("selectionchange", () => {
    if (applyingComplete || document.activeElement !== messageInput) {
      return;
    }
    const cursor = messageInput.selectionStart ?? 0;
    const { token } = tokenAtCursor(messageInput.value, cursor);
    if (emoteCompletionWithColon && isColonEmoteToken(token)) {
      void refreshColonComplete();
    } else if (showUsernameCompletionMenu && isAtUserToken(token)) {
      void refreshAtUserComplete();
    } else if (complete?.popup) {
      clearComplete();
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (!composer.hidden || !lastAuth.canSend || sending) {
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      return;
    }
    if (ev.key.length !== 1) {
      return;
    }
    const t = ev.target as HTMLElement | null;
    if (
      t &&
      !composer.contains(t) &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable)
    ) {
      return;
    }
    ev.preventDefault();
    messageInput.value = ev.key;
    composer.hidden = false;
    messageInput.focus();
    composerChrome.sync();
  });

  messageInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement !== completeBox && document.activeElement !== messageInput) {
        clearComplete();
      }
    }, 0);
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

  try {
    applyAuth(await invoke<AuthInfo>("auth_status"));
  } catch (err) {
    statusEl.textContent = formatError(err);
  }

  try {
    const session = await invoke<{
      lastChannel?: string | null;
      recents?: string[];
      open?: string[];
    }>("session_get");
    const recents = Array.isArray(session.recents) ? session.recents : [];
    const open = Array.isArray(session.open) ? session.open : [];
    const focus =
      session.lastChannel && open.includes(session.lastChannel)
        ? session.lastChannel
        : open[0] || session.lastChannel || "";
    channels.hydrate(recents, open, focus);
    const restore = open.length > 0 ? open : focus ? [focus] : [];
    for (const login of restore) {
      if (login === focus) {
        continue;
      }
      void joinChannel(login, false);
    }
    if (focus) {
      void joinChannel(focus, true);
    }
  } catch {
    /* first run */
  }

  function openContextMenu(ctx: SlotContext): void {
    contextTarget = ctx;
    const replyBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="reply"]');
    const threadBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="thread"]');
    const userBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="user"]');
    const twitchBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="open-twitch"]');
    const copyLinkBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="copy-link"]');
    if (replyBtn) {
      replyBtn.hidden = !ctx.login || !ctx.msgId || ctx.disabled;
    }
    if (threadBtn) {
      threadBtn.hidden = !ctx.msgId || ctx.disabled;
    }
    if (userBtn) {
      userBtn.hidden = !ctx.login;
    }
    if (twitchBtn) {
      twitchBtn.hidden = !ctx.login;
    }
    if (copyLinkBtn) {
      copyLinkBtn.hidden = !ctx.linkUrl;
    }
    contextMenuEl.hidden = false;
    const pad = 8;
    const rect = contextMenuEl.getBoundingClientRect();
    const x = Math.min(ctx.clientX, window.innerWidth - rect.width - pad);
    const y = Math.min(ctx.clientY, window.innerHeight - rect.height - pad);
    contextMenuEl.style.left = `${Math.max(pad, x)}px`;
    contextMenuEl.style.top = `${Math.max(pad, y)}px`;
  }

  function hideContextMenu(): void {
    contextMenuEl.hidden = true;
    contextTarget = null;
  }

  function setReply(id: string, login: string, text: string): void {
    replyTarget = { id, login, text };
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    replyLabelEl.textContent = `Ответ @${login}: ${preview}`;
    replyBarEl.hidden = false;
    composerChrome.sync();
  }

  function clearReply(): void {
    replyTarget = null;
    replyLabelEl.textContent = "";
    replyBarEl.hidden = true;
    composerChrome.sync();
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
    composerChrome.sync();
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

  async function refreshColonComplete(): Promise<void> {
    if (applyingComplete || !emoteCompletionWithColon) {
      return;
    }
    const cursor = messageInput.selectionStart ?? 0;
    const text = messageInput.value;
    const { start, token, firstWord } = tokenAtCursor(text, cursor);
    if (!isColonEmoteToken(token)) {
      if (complete?.popup === "colon") {
        clearComplete();
      }
      return;
    }
    const seq = ++completeSeq;
    completeInFlight = true;
    let items: string[] = [];
    try {
      items = await invoke<string[]>("chat_complete", { token, firstWord });
    } catch {
      if (seq === completeSeq && complete?.popup === "colon") {
        clearComplete();
      }
      return;
    } finally {
      if (seq === completeSeq) {
        completeInFlight = false;
      }
    }
    if (seq !== completeSeq) {
      return;
    }
    const now = messageInput.value;
    const nowCursor = messageInput.selectionStart ?? 0;
    const nowTok = tokenAtCursor(now, nowCursor);
    if (nowTok.start !== start || nowTok.token !== token) {
      clearComplete();
      if (emoteCompletionWithColon && isColonEmoteToken(nowTok.token)) {
        void refreshColonComplete();
      }
      return;
    }
    if (items.length === 0) {
      clearComplete();
      return;
    }
    complete = {
      start,
      suffix: now.slice(nowCursor),
      items,
      index: 0,
      popup: "colon",
      query: token,
    };
    paintComplete();
  }

  async function refreshAtUserComplete(): Promise<void> {
    if (applyingComplete || !showUsernameCompletionMenu) {
      return;
    }
    const cursor = messageInput.selectionStart ?? 0;
    const text = messageInput.value;
    const { start, token, firstWord } = tokenAtCursor(text, cursor);
    if (!isAtUserToken(token)) {
      if (complete?.popup === "at") {
        clearComplete();
      }
      return;
    }
    const seq = ++completeSeq;
    completeInFlight = true;
    let items: string[] = [];
    try {
      items = await invoke<string[]>("chat_complete", { token, firstWord });
    } catch {
      if (seq === completeSeq && complete?.popup === "at") {
        clearComplete();
      }
      return;
    } finally {
      if (seq === completeSeq) {
        completeInFlight = false;
      }
    }
    if (seq !== completeSeq) {
      return;
    }
    const now = messageInput.value;
    const nowCursor = messageInput.selectionStart ?? 0;
    const nowTok = tokenAtCursor(now, nowCursor);
    if (nowTok.start !== start || nowTok.token !== token) {
      clearComplete();
      if (showUsernameCompletionMenu && isAtUserToken(nowTok.token)) {
        void refreshAtUserComplete();
      }
      return;
    }
    if (items.length === 0) {
      clearComplete();
      return;
    }
    complete = {
      start,
      suffix: now.slice(nowCursor),
      items,
      index: 0,
      popup: "at",
      query: token,
    };
    paintComplete();
  }

  async function cycleComplete(reverse: boolean): Promise<void> {
    const cursor = messageInput.selectionStart ?? 0;
    const text = messageInput.value;
    if (complete) {
      const current = complete.items[complete.index];
      if (text.slice(complete.start, cursor) === current) {
        const n = complete.items.length;
        complete.index = reverse
          ? (complete.index - 1 + n) % n
          : (complete.index + 1) % n;
        writeComplete();
        return;
      }
      if (complete.popup && complete.items.length > 0) {
        const { token } = tokenAtCursor(text, cursor);
        const popupKind = isColonEmoteToken(token)
          ? "colon"
          : isAtUserToken(token)
            ? "at"
            : null;
        if (
          popupKind === complete.popup &&
          complete.start === tokenAtCursor(text, cursor).start &&
          token === complete.query
        ) {
          if (reverse) {
            const n = complete.items.length;
            complete.index = (complete.index - 1 + n) % n;
          }
          writeComplete();
          return;
        }
        clearComplete();
      }
    }
    if (completeInFlight) {
      completePending += reverse ? -1 : 1;
      return;
    }
    const { start, token, firstWord } = tokenAtCursor(text, cursor);
    const minLen = isColonEmoteToken(token) ? 1 : 2;
    if (Array.from(token).length < minLen) {
      clearComplete();
      return;
    }
    complete = null;
    completeBox.replaceChildren();
    completeBox.hidden = true;
    completePending = 0;
    const seq = ++completeSeq;
    completeInFlight = true;
    let items: string[] = [];
    try {
      items = await invoke<string[]>("chat_complete", { token, firstWord });
    } catch (err) {
      statusEl.textContent = formatError(err);
      if (seq === completeSeq) {
        clearComplete();
      }
      return;
    } finally {
      completeInFlight = false;
    }
    if (seq !== completeSeq) {
      return;
    }
    const now = messageInput.value;
    const nowCursor = messageInput.selectionStart ?? 0;
    if (now.slice(start, nowCursor) !== token) {
      clearComplete();
      return;
    }
    if (items.length === 0) {
      clearComplete();
      return;
    }
    const n = items.length;
    const extra = completePending;
    completePending = 0;
    const index = ((extra % n) + n) % n;
    complete = {
      start,
      suffix: now.slice(nowCursor),
      items,
      index,
      popup: isColonEmoteToken(token)
        ? "colon"
        : isAtUserToken(token)
          ? "at"
          : null,
      query: token,
    };
    writeComplete();
  }

  function writeComplete(): void {
    if (!complete) {
      return;
    }
    const item = complete.items[complete.index];
    applyingComplete = true;
    try {
      messageInput.value = `${messageInput.value.slice(0, complete.start)}${item}${complete.suffix}`;
      const pos = complete.start + item.length;
      messageInput.setSelectionRange(pos, pos);
      complete.popup = null;
      paintComplete();
    } finally {
      applyingComplete = false;
    }
  }

  function paintComplete(): void {
    completeBox.replaceChildren();
    if (!complete) {
      completeBox.hidden = true;
      return;
    }
    completeBox.hidden = false;
    complete.items.forEach((item, i) => {
      const li = document.createElement("li");
      li.textContent = item.trimEnd();
      li.dataset.index = String(i);
      if (i === complete?.index) {
        li.className = "active";
      }
      completeBox.append(li);
    });
    const active = completeBox.querySelector(".active");
    active?.scrollIntoView({ block: "nearest" });
  }

  function clearComplete(): void {
    completeSeq += 1;
    completePending = 0;
    complete = null;
    completeBox.replaceChildren();
    completeBox.hidden = true;
  }

  async function sendMessage(): Promise<void> {
    if (!lastAuth.canSend || sending) {
      return;
    }
    const text = messageInput.value;
    sending = true;
    syncComposer();
    try {
      await invoke("chat_send", {
        text,
        replyToId: replyTarget?.id ?? null,
      });
      messageInput.value = "";
      clearComplete();
      clearReply();
      composerChrome.pulse();
    } catch (err) {
      statusEl.textContent = formatError(err);
    } finally {
      sending = false;
      syncComposer();
    }
  }

  function applyMounted(joined: string): void {
    channels.remember(joined);
    streamByChannel.delete(joined.toLowerCase());
    ring.setChannelLive(false);
    repaintChannelTitle();
    channelInput.value = joined;
    if (joined !== mountedChannel) {
      unmountPlayer(playerSlot);
      mountPlayer(playerSlot, joined);
      mountedChannel = joined;
    }
    chatFindCtl.onChannelChanged();
    applySendWaitForActive();
  }

  function drainChannelQueue(): void {
    const next = channelQueue.shift();
    if (!next) {
      return;
    }
    if (next.kind === "leave") {
      void leaveChannel(next.name);
      return;
    }
    if (next.kind === "sync") {
      void syncRooms(next.name);
      return;
    }
    void joinChannel(next.name, next.focus !== false);
  }

  async function syncRooms(focus: string): Promise<void> {
    if (channelBusy) {
      channelQueue.unshift({ kind: "sync", name: focus });
      return;
    }
    channelBusy = true;
    joinControl.disabled = true;
    try {
      await ipc.syncActive(focus || null);
      if (focus) {
        applyMounted(focus);
      } else {
        repaintChannelTitle();
        channelInput.value = "";
        if (mountedChannel) {
          unmountPlayer(playerSlot);
          mountedChannel = "";
        }
        chatFindCtl.onChannelChanged();
        applySendWaitForActive();
      }
    } catch (err) {
      holdStatus = true;
      statusEl.textContent = formatError(err);
    } finally {
      channelBusy = false;
      joinControl.disabled = false;
      drainChannelQueue();
    }
  }

  async function leaveChannel(raw: string): Promise<void> {
    const name = raw.trim();
    if (!name) {
      return;
    }
    if (channelBusy) {
      channelQueue.push({ kind: "leave", name });
      return;
    }
    channelBusy = true;
    joinControl.disabled = true;
    clearComplete();
    clearReply();
    hideContextMenu();
    const leftActive = ipc.active() === name;
    try {
      const next = await ipc.leave(name);
      channels.remove(name);
      sendWaitByChannel.delete(name.toLowerCase());
      streamByChannel.delete(name.toLowerCase());
      if (!next) {
        repaintChannelTitle();
        channelInput.value = "";
        if (mountedChannel) {
          unmountPlayer(playerSlot);
          mountedChannel = "";
        }
        chatFindCtl.onChannelChanged();
        applySendWaitForActive();
        return;
      }
      if (leftActive) {
        applyMounted(next);
      } else {
        channels.paint(ipc.active());
        applySendWaitForActive();
      }
    } catch (err) {
      holdStatus = true;
      statusEl.textContent = formatError(err);
    } finally {
      channelBusy = false;
      joinControl.disabled = false;
      drainChannelQueue();
    }
  }

  async function joinChannel(raw: string, focus = true): Promise<void> {
    const name = raw.trim();
    if (!name) {
      holdStatus = true;
      statusEl.textContent = "имя канала: 1-25 символов [a-z0-9_]";
      return;
    }
    if (channelBusy) {
      channelQueue.push({ kind: "join", name, focus });
      return;
    }
    channelBusy = true;
    joinControl.disabled = true;
    holdStatus = false;
    clearComplete();
    clearReply();
    hideContextMenu();
    try {
      const joined = await ipc.join(name, focus);
      if (focus) {
        applyMounted(joined);
      } else {
        channels.remember(joined, false);
      }
    } catch (err) {
      holdStatus = true;
      statusEl.textContent = formatError(err);
    } finally {
      channelBusy = false;
      joinControl.disabled = false;
      drainChannelQueue();
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const composer = target.closest("#composer");
  if (composer instanceof HTMLElement && composer.hidden) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
