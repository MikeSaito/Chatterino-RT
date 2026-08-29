import "pixi.js/unsafe-eval";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createChatApp, destroyChatApp } from "./pixi/app";
import { MessageRing, type SlotContext } from "./chat/ring";
import {
  deriveEmoteScaleUrls,
  emoteScaleLinkLabel,
} from "./chat/emoteImageLinks";
import { bindChatIpc, type ChatIpc } from "./chat/ipc";
import { TextureLru } from "./chat/textures";
import { textureLruLimitForDisplay } from "./chat/textureLruLimit";
import { mountPlayer, unmountPlayer, setPlayerLiveHint, bindPlayerOpenTwitch } from "./player/embed";
import { bindScrollChrome } from "./chat/scrollUi";
import { bindChannelList } from "./shell/channels";
import { normalizeChannelInput } from "./shell/channelName";
import { applyChromeIcons } from "./shell/chromeIcons";
import { applyContextMenuChrome, setContextMenuLabel } from "./shell/contextMenuChrome";
import { applyUiLayout, parseUiLayout, type UiLayout } from "./shell/uiLayout";
import { applyWindowMinForLayout } from "./shell/windowMinSize";
import {
  bindStreamPreviewTooltip,
  channelMetaParts,
  effectiveHeaderKnobs,
  parseHeaderKnobs,
  parseThumbnailSizeStream,
  type HeaderKnobs,
  type ThumbnailSizeStream,
} from "./shell/channelHeader";
import { iconEl, type IconName } from "./shell/icons";
import {
  bindStageSplit,
  parsePlayerChatSplit,
} from "./shell/stageSplit";
import { bindSearchPopup } from "./shell/chatFind";
import { bindHeaderMenu, type HeaderMenuAction } from "./shell/headerMenu";
import { bindTabOverflow } from "./shell/tabOverflow";
import { bindJoinPopover } from "./shell/joinPopover";
import { bindAuthMenu } from "./shell/authMenu";
import { bindChatQuickActions } from "./shell/chatQuickActions";
import { bindSettingsBridge } from "./shell/settings/settingsMainBridge";
import { isSettingsWindowOpen, requestOpenSettingsWindow } from "./shell/settings/settingsWindowState";
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
import {
  buildWebSearchUrl,
  webSearchMenuLabel,
} from "./shell/webSearch";
import {
  addStreamerModeOnChange,
  bindStreamerModeBadge,
  isStreamerModeActive,
  streamerModeState,
} from "./shell/streamerMode";
import { startLiveNotifyListener } from "./shell/liveNotify";
import { bindUserCard } from "./shell/userCard";
import { parseTimeoutButtons } from "./shell/timeoutButtons";
import {
  expandModAction,
  parseModActions,
  type ModActionBtn,
} from "./shell/modActions";
import {
  bindImageUpload,
  parseImageUploadKnobs,
  type ImageUploadKnobs,
} from "./shell/imageUpload";
import { bindToastHost } from "./shell/toast";
import { bindReplyThread } from "./shell/replyThread";
import { resolveReplyRoot } from "./shell/replyRoot";
import { findEventByMsgId } from "./shell/eventLookup";
import { bindEmotePopup } from "./shell/emotePopup";
import { cycleChannelIndex } from "./shell/focusTrap";
import {
  bindEmoteTooltip,
  resolveOpenUrlForChatLink,
  parseEmoteTooltipScale,
  parseThumbnailSize,
  parseTooltipPreviewMode,
  type EmoteTooltipScale,
  type TooltipPreviewMode,
} from "./shell/emoteTooltip";
import { isAtUserToken, isColonEmoteToken, tokenAtCursor } from "./chat/token";
import { CHAT_AUTH_EVENT, CHAT_CHANNEL_LIVE_EVENT, CHAT_ROOMS_EVENT, CHAT_SEND_WAIT_EVENT, CHAT_STATUS_EVENT, scrollbackLimitFromKnobs, scrollbackUsercardLimitFromKnobs } from "./constants";
import type { AuthInfo, ChannelLive, ChatEvent, ChatStatus } from "./chat/types";
import type { AppSettings } from "./shell/settings/dialog";

let chatIpc: ChatIpc | null = null;
let teardownChat: (() => void) | null = null;
let bootEpoch = 0;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    bootEpoch += 1;
    teardownChat?.();
    teardownChat = null;
  });
}

window.addEventListener("DOMContentLoaded", () => {
  void boot().catch((err) => {
    const message = err instanceof Error ? err.message : String(err ?? "ошибка загрузки");
    const statusText = document.querySelector<HTMLElement>("#status-text");
    const statusLine = document.querySelector<HTMLElement>("#status");
    if (statusText) {
      statusText.textContent = message;
    } else if (statusLine) {
      statusLine.textContent = message;
    }
    statusLine?.classList.remove("is-connecting");
    const spinner = document.querySelector<HTMLElement>("#status-spinner");
    if (spinner) {
      spinner.hidden = true;
    }
  });
});

window.addEventListener("beforeunload", () => {
  teardownChat?.();
  teardownChat = null;
});
window.addEventListener("pagehide", () => {
  teardownChat?.();
  teardownChat = null;
});

async function boot(): Promise<void> {
  const myEpoch = ++bootEpoch;
  applyChromeIcons();
  const composerWaitIcon = document.querySelector<HTMLElement>(".composer-wait-icon");
  if (composerWaitIcon) {
    composerWaitIcon.append(iconEl("clock", 12));
  }
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
  const joinToggle = document.querySelector<HTMLButtonElement>("#join-toggle");
  const joinPopover = document.querySelector<HTMLElement>("#join-popover");
  const joinPopoverForm = document.querySelector<HTMLFormElement>("#join-popover-form");
  const joinPopoverInput = document.querySelector<HTMLInputElement>("#join-popover-input");
  const listHost = document.querySelector<HTMLElement>("#channel-list-host");
  const list = document.querySelector<HTMLUListElement>("#channel-list");
  const title = document.querySelector<HTMLElement>("#channel-title");
  const headerLive = document.querySelector<HTMLElement>("#header-live");
  const headerChannelName = document.querySelector<HTMLElement>("#header-channel-name");
  const headerAvatar = document.querySelector<HTMLElement>("#header-channel-avatar");
  const headerAvatarImg = document.querySelector<HTMLImageElement>("#header-channel-avatar-img");
  const headerAvatarLetter = document.querySelector<HTMLElement>("#header-channel-avatar-letter");
  const headerMore = document.querySelector<HTMLButtonElement>("#header-more");
  const headerMenu = document.querySelector<HTMLMenuElement>("#header-menu");
  const moderationModeBtn = document.querySelector<HTMLButtonElement>(
    "#moderation-mode-btn",
  );
  const player = document.querySelector<HTMLElement>("#player-slot");
  const stage = document.querySelector<HTMLElement>("#stage");
  const stageSplit = document.querySelector<HTMLElement>("#stage-split");
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
  const chatQuickBar = document.querySelector<HTMLElement>("#chat-quick-actions");
  const chatQaReply = document.querySelector<HTMLButtonElement>("#chat-qa-reply");
  const chatQaCopy = document.querySelector<HTMLButtonElement>("#chat-qa-copy");
  const chatQaMore = document.querySelector<HTMLButtonElement>("#chat-qa-more");
  const chatEmpty = document.querySelector<HTMLElement>("#chat-empty");
  const authChip = document.querySelector<HTMLButtonElement>("#auth-chip");
  const authChipAvatar = document.querySelector<HTMLImageElement>("#auth-chip-avatar");
  const authChipLetter = document.querySelector<HTMLElement>("#auth-chip-letter");
  const authChipLogin = document.querySelector<HTMLElement>("#auth-chip-login");
  const authMenu = document.querySelector<HTMLMenuElement>("#auth-menu");
  const authLogin = document.querySelector<HTMLElement>("#auth-login");
  const authSignin = document.querySelector<HTMLButtonElement>("#auth-signin");
  const authLogout = document.querySelector<HTMLButtonElement>("#auth-logout");
  const authDevice = document.querySelector<HTMLElement>("#auth-device");
  const authPaste = document.querySelector<HTMLTextAreaElement>("#auth-paste");
  const authImport = document.querySelector<HTMLButtonElement>("#auth-import");
  const settingsOpen = document.querySelector<HTMLButtonElement>("#settings-open");
  const searchModal = document.querySelector<HTMLElement>("#search-modal");
  const notesModal = document.querySelector<HTMLElement>("#notes-modal");
  const usercardModal = document.querySelector<HTMLElement>("#usercard-modal");
  const replythreadModal = document.querySelector<HTMLElement>("#replythread-modal");
  const emotepopupModal = document.querySelector<HTMLElement>("#emotepopup-modal");
  const emoteOpen = document.querySelector<HTMLButtonElement>("#emote-open");
  const appRoot = document.querySelector<HTMLElement>("#app");
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
    !joinToggle ||
    !joinPopover ||
    !joinPopoverForm ||
    !joinPopoverInput ||
    !listHost ||
    !list ||
    !title ||
    !headerLive ||
    !headerChannelName ||
    !headerAvatar ||
    !headerAvatarImg ||
    !headerAvatarLetter ||
    !headerMore ||
    !headerMenu ||
    !player ||
    !stage ||
    !stageSplit ||
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
    !chatQuickBar ||
    !chatQaReply ||
    !chatQaCopy ||
    !chatQaMore ||
    !chatEmpty ||
    !authChip ||
    !authChipAvatar ||
    !authChipLetter ||
    !authChipLogin ||
    !authMenu ||
    !authLogin ||
    !authSignin ||
    !authLogout ||
    !authDevice ||
    !authPaste ||
    !authImport ||
    !settingsOpen ||
    !searchModal ||
    !notesModal ||
    !usercardModal ||
    !replythreadModal ||
    !emotepopupModal ||
    !emoteOpen ||
    !appRoot
  ) {
    return;
  }

  const joinControl = joinBtn;
  const joinFormEl = form;
  const joinToggleBtn = joinToggle;
  const joinPopoverEl = joinPopover;
  const joinPopoverFormEl = joinPopoverForm;
  const joinPopoverInputEl = joinPopoverInput;
  const channelListHost = listHost;
  const titleEl = title;
  const headerLiveEl = headerLive;
  const headerChannelNameEl = headerChannelName;
  const headerAvatarEl = headerAvatar;
  const headerAvatarImgEl = headerAvatarImg;
  const headerAvatarLetterEl = headerAvatarLetter;
  const headerMoreBtn = headerMore;
  const headerMenuEl = headerMenu;
  const channelInput = input;
  const playerSlot = player;
  const stageEl = stage;
  const stageSplitEl = stageSplit;
  const statusEl = status;
  const statusTextEl =
    status.querySelector<HTMLElement>("#status-text") ??
    (() => {
      const span = document.createElement("span");
      span.id = "status-text";
      status.append(span);
      return span;
    })();
  const statusSpinnerEl = status.querySelector<HTMLElement>("#status-spinner");
  const setStatus = (message: string, opts?: { spin?: boolean }): void => {
    statusTextEl.textContent = message;
    const spin = opts?.spin ?? false;
    statusEl.classList.toggle("is-connecting", spin);
    if (statusSpinnerEl) {
      statusSpinnerEl.hidden = !spin;
    }
  };
  const toastHostEl = document.querySelector<HTMLElement>("#toast-host");
  if (!toastHostEl) {
    throw new Error("toast-host missing");
  }
  const toast = bindToastHost(toastHostEl);
  const toastCopied = (): void => {
    toast.push({ kind: "success", text: "Скопировано" });
  };
  const syncToastLift = (): void => {
    const replyH = replyBar.hidden ? 0 : replyBar.getBoundingClientRect().height;
    const completeH = completeList.hidden
      ? 0
      : completeList.getBoundingClientRect().height;
    const lift = composer.getBoundingClientRect().height + replyH + completeH;
    toastHostEl.style.bottom = `calc(var(--space-3) + ${Math.ceil(lift)}px)`;
  };
  syncToastLift();
  const toastLiftRo = new ResizeObserver(() => {
    syncToastLift();
  });
  toastLiftRo.observe(composer);
  toastLiftRo.observe(replyBar);
  toastLiftRo.observe(completeList);
  const replyBarAttrObs = new MutationObserver(() => {
    syncToastLift();
  });
  replyBarAttrObs.observe(replyBar, { attributes: true, attributeFilter: ["hidden"] });
  replyBarAttrObs.observe(completeList, { attributes: true, attributeFilter: ["hidden"] });
  const composerInner = document.querySelector<HTMLElement>("#composer-inner");
  const composerWaitText = document.querySelector<HTMLElement>(".composer-wait-text");
  const composerDropHint = document.querySelector<HTMLElement>("#composer-drop-hint");
  const messageInput = composerInput;
  const sendBtn = composerSend;
  const replyBarEl = replyBar;
  const replyLabelEl = replyLabel;
  const replyCancelBtn = replyCancel;
  const contextMenuEl = contextMenu;
  window.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Escape" || contextMenuEl.hidden) {
        return;
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      hideContextMenu();
    },
    true,
  );
  const authChipBtn = authChip;
  const authChipAvatarEl = authChipAvatar;
  const authChipLetterEl = authChipLetter;
  const authChipLoginEl = authChipLogin;
  const authMenuEl = authMenu;
  const contextCustomHost = document.querySelector<HTMLElement>("#chat-context-custom");
  const contextCustomSep = document.querySelector<HTMLElement>("#chat-context-custom-sep");
  const contextImageSep = document.querySelector<HTMLElement>("#chat-context-image-sep");
  const contextImageOpen = document.querySelector<HTMLElement>("#chat-context-image-open");
  const contextImageCopy = document.querySelector<HTMLElement>("#chat-context-image-copy");
  const loginEl = authLogin;
  const signinBtn = authSignin;
  const logoutBtn = authLogout;
  const deviceEl = authDevice;
  const pasteEl = authPaste;
  const importBtn = authImport;
  const settingsBtn = settingsOpen;
  const completeBox = completeList;
  let composerOpts: ComposerChromeOpts = defaultComposerChrome();
  const sendWaitByChannel = new Map<string, string>();
  const composerChrome = bindComposerChrome({
    form: composer,
    inner: composerInner,
    input: messageInput,
    lengthEl: composerLength,
    waitEl: composerWait,
    waitTextEl: composerWaitText,
    replyBar: replyBarEl,
    sendBtn: composerSend,
    getOpts: () => composerOpts,
  });
  composerChrome.sync();
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

  setStatus("Загрузка чата…");
  messageInput.disabled = true;
  sendBtn.disabled = true;
  emoteOpen.disabled = true;

  type ChromeReady = {
    join: ((channel: string, focus?: boolean) => void) | null;
    startLogin: (() => void) | null;
    logout: (() => void) | null;
    importLogin: (() => void) | null;
    headerAction: ((action: HeaderMenuAction) => void) | null;
    getChannel: () => string;
    hasCustomPlayer: () => boolean;
  };
  const chromeReady: ChromeReady = {
    join: null,
    startLogin: null,
    logout: null,
    importLogin: null,
    headerAction: null,
    getChannel: () => "",
    hasCustomPlayer: () => false,
  };
  const pendingJoins: { name: string; focus: boolean }[] = [];

  let headerMenuCtl: ReturnType<typeof bindHeaderMenu> | null = null;
  let joinPopoverCtl: ReturnType<typeof bindJoinPopover> | null = null;
  let authMenuCtl: ReturnType<typeof bindAuthMenu> | null = null;
  let tabOverflowCtl: ReturnType<typeof bindTabOverflow> | null = null;

  const queueOrJoin = (channel: string, focus = true): void => {
    const name = normalizeChannelInput(channel);
    if (!name) {
      return;
    }
    if (chromeReady.join) {
      chromeReady.join(name, focus);
      return;
    }
    pendingJoins.push({ name, focus });
    setStatus("Загрузка чата…");
  };

  let prepareSettingsOpen: (() => void) | null = null;
  const earlyChromeAbort = new AbortController();
  const earlySignal = earlyChromeAbort.signal;

  settingsBtn.addEventListener(
    "click",
    () => {
      if (myEpoch !== bootEpoch) {
        return;
      }
      headerMenuCtl?.hide();
      authMenuCtl?.hide();
      joinPopoverCtl?.hide();
      prepareSettingsOpen?.();
      void requestOpenSettingsWindow().catch((err) => {
        setStatus(formatError(err));
      });
    },
    { signal: earlySignal },
  );

  joinFormEl.addEventListener(
    "submit",
    (ev) => {
      if (myEpoch !== bootEpoch) {
        return;
      }
      ev.preventDefault();
      queueOrJoin(channelInput.value);
    },
    { signal: earlySignal },
  );

  channelInput.addEventListener(
    "keydown",
    (ev) => {
      if (myEpoch !== bootEpoch) {
        return;
      }
      if (ev.key !== "Enter") {
        return;
      }
      ev.preventDefault();
      queueOrJoin(channelInput.value);
    },
    { signal: earlySignal },
  );

  joinPopoverCtl = bindJoinPopover({
    form: joinFormEl,
    toggle: joinToggleBtn,
    popover: joinPopoverEl,
    popoverForm: joinPopoverFormEl,
    popoverInput: joinPopoverInputEl,
    isCompact: () => window.matchMedia("(max-width: 479px)").matches,
    onJoin: (channel) => {
      queueOrJoin(channel);
    },
  });

  headerMenuCtl = bindHeaderMenu({
    button: headerMoreBtn,
    menu: headerMenuEl,
    getChannel: () => chromeReady.getChannel(),
    hasCustomPlayer: () => chromeReady.hasCustomPlayer(),
    onAction: (action) => {
      if (chromeReady.headerAction) {
        chromeReady.headerAction(action);
        return;
      }
      setStatus("Загрузка чата…");
    },
  });

  signinBtn.addEventListener(
    "click",
    () => {
      if (myEpoch !== bootEpoch) {
        return;
      }
      if (chromeReady.startLogin) {
        chromeReady.startLogin();
        return;
      }
      void (async () => {
        signinBtn.disabled = true;
        try {
          await invoke("auth_start");
          setStatus("Ожидание входа…");
        } catch (err) {
          setStatus(formatError(err));
        } finally {
          signinBtn.disabled = false;
        }
      })();
    },
    { signal: earlySignal },
  );

  logoutBtn.addEventListener(
    "click",
    () => {
      if (myEpoch !== bootEpoch) {
        return;
      }
      if (chromeReady.logout) {
        chromeReady.logout();
        return;
      }
      void (async () => {
        logoutBtn.disabled = true;
        try {
          await invoke("auth_logout");
          setStatus("Вход отменён");
        } catch (err) {
          setStatus(formatError(err));
        } finally {
          logoutBtn.disabled = false;
        }
      })();
    },
    { signal: earlySignal },
  );

  importBtn.addEventListener(
    "click",
    () => {
      if (myEpoch !== bootEpoch) {
        return;
      }
      if (chromeReady.importLogin) {
        chromeReady.importLogin();
        return;
      }
      void (async () => {
        importBtn.disabled = true;
        try {
          await invoke("auth_import", { blob: pasteEl.value });
          setStatus("Код принят");
        } catch (err) {
          setStatus(formatError(err));
        } finally {
          importBtn.disabled = false;
        }
      })();
    },
    { signal: earlySignal },
  );

  teardownChat = () => {
    earlyChromeAbort.abort();
    pendingJoins.length = 0;
    headerMenuCtl?.dispose();
    headerMenuCtl = null;
    tabOverflowCtl?.dispose();
    tabOverflowCtl = null;
    joinPopoverCtl?.dispose();
    joinPopoverCtl = null;
    authMenuCtl?.dispose();
    authMenuCtl = null;
  };
  {
    const priorTeardown = teardownChat;
    teardownChat = () => {
      toast.dismissAll();
      toastLiftRo.disconnect();
      replyBarAttrObs.disconnect();
      priorTeardown?.();
    };
  }

  let app;
  try {
    app = await createChatApp(canvas, canvasHost);
  } catch (err) {
    teardownChat?.();
    teardownChat = null;
    throw err;
  }
  const textures = new TextureLru(
    textureLruLimitForDisplay({
      dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
      width: canvasHost.clientWidth || window.innerWidth || 1920,
      height: canvasHost.clientHeight || window.innerHeight || 1080,
    }),
  );
  let bootKnobs: AppSettings["knobs"] = {};
  let menuCommands: AppSettings["commands"] = [];
  let bootModActions: ModActionBtn[] = [];
  try {
    const bootSettings = await invoke<AppSettings>("settings_get");
    bootKnobs = bootSettings.knobs ?? {};
    menuCommands = menuCommandsFromSettings(bootSettings);
    bootModActions = parseModActions(bootSettings.modActions ?? []);
  } catch {
    bootKnobs = {};
  }
  const poolSize = scrollbackLimitFromKnobs(bootKnobs);
  let usercardScrollbackLimit = scrollbackUsercardLimitFromKnobs(bootKnobs);
  let timeoutKnobs: AppSettings["knobs"] = bootKnobs;
  let customUriScheme = String(bootKnobs["external.customURIScheme"] ?? "").trim();
  let imageUploadKnobs: ImageUploadKnobs = parseImageUploadKnobs(bootKnobs);
  let modActionBtns: ModActionBtn[] = bootModActions;
  let modSendBusy = false;
  let lastAuth: AuthInfo = { canSend: false, fromEnv: false };
  let authOp: "idle" | "start" | "import" | "logout" = "idle";
  let authPaintGen = 0;
  const ring = new MessageRing(app, textures, poolSize);
  if (
    import.meta.env.DEV ||
    localStorage.getItem("crt-debug") === "1"
  ) {
    (window as Window & { __crt?: { ring: MessageRing } }).__crt = { ring };
  }
  try {
    await ring.init();
  } catch (err) {
    ring.destroy();
    textures.clear();
    destroyChatApp();
    teardownChat?.();
    teardownChat = null;
    throw err;
  }
  ring.setModActions(modActionBtns);
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
  let unshortLinks = false;
  let openLinksIncognito = false;
  let searchIncognito = false;
  let supportsIncognito = false;
  let searchEnabled = false;
  let searchEngineUrl = "";
  let searchEngineName = "";
  let headerKnobs: HeaderKnobs = parseHeaderKnobs({});
  let thumbnailSizeStream: ThumbnailSizeStream = 2;
  const streamByChannel = new Map<string, ChannelLive>();
  let emoteTooltipCtl: { hide: () => void; refresh: () => void } | null = null;
  let streamPreviewCtl: { hide: () => void; refresh: () => void } | null = null;
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
  const streamTooltip = document.querySelector<HTMLElement>("#stream-tooltip");
  const streamTooltipImg =
    document.querySelector<HTMLImageElement>("#stream-tooltip-img");
  const streamTooltipText =
    document.querySelector<HTMLElement>("#stream-tooltip-text");
  if (titleEl && streamTooltip && streamTooltipImg && streamTooltipText) {
    streamPreviewCtl = bindStreamPreviewTooltip({
      titleEl,
      tooltip: streamTooltip,
      img: streamTooltipImg,
      text: streamTooltipText,
      getSize: () => thumbnailSizeStream,
      getStream: () => {
        const ch = chatIpc?.active();
        if (!ch) {
          return null;
        }
        const stream = streamByChannel.get(ch.toLowerCase());
        return {
          login: ch,
          live: stream?.live === true,
          gameName: stream?.gameName,
          streamTitle: stream?.streamTitle,
        };
      },
    });
  }
  ring.setOnOpenChatLink((url) => {
    void (async () => {
      try {
        const openUrl = await resolveOpenUrlForChatLink(url, unshortLinks);
        await invoke("open_chat_link", {
          url: openUrl,
          private: openLinksIncognito,
        });
      } catch (err) {
        toast.push({ kind: "danger", text: formatError(err) });
      }
    })();
  });
  let unbindImageUpload: (() => void) | null = null;
  const chromeTeardown = teardownChat;
  teardownChat = () => {
    unbindImageUpload?.();
    unbindImageUpload = null;
    chromeTeardown?.();
    stageSplitCtl?.dispose();
    stageSplitCtl = null;
    quickActionsCtl?.dispose();
    quickActionsCtl = null;
    ring.setHoverGuard(undefined);
    streamPreviewCtl?.hide();
    chatIpc?.stop();
    chatIpc = null;
    ring.destroy();
    textures.clear();
    destroyChatApp();
  };
  bindStreamerModeBadge(document.querySelector<HTMLElement>("#streamer-badge"));
  let autoCloseUserPopup = true;
  let autoCloseThreadPopup = false;
  let showTimestamps = true;
  let timestampFormat = "hh:mm";
  let hideTimestampsWhenLive = false;
  let replyThreadCtl: ReturnType<typeof bindReplyThread> | null = null;
  let replyThreadLive: ((events: ChatEvent[]) => void) | null = null;
  let showPronouns = false;
  let hideUsercardAvatars = true;
  let hideUserNotes = true;
  let userCard: ReturnType<typeof bindUserCard> | null = null;
  let lastPointerY = 0;
  let quickActionsCtl: ReturnType<typeof bindChatQuickActions> | null = null;
  const chatEmptyEl = chatEmpty;
  const chatEmptyTitleEl = chatEmptyEl.querySelector<HTMLElement>(".chat-empty-title");
  const chatEmptyHintEl = chatEmptyEl.querySelector<HTMLElement>(".chat-empty-hint");
  const chatEmptyIconEl = chatEmptyEl.querySelector<HTMLElement>(".chat-empty-icon");
  const syncChatEmpty = (): void => {
    const ch = chatIpc?.active()?.trim() ?? "";
    const occupied = ring.occupiedCount();
    if (!ch) {
      chatEmptyEl.hidden = false;
      if (chatEmptyTitleEl) {
        chatEmptyTitleEl.textContent = "Выберите канал";
      }
      if (chatEmptyHintEl) {
        chatEmptyHintEl.textContent = "Подключитесь к каналу, чтобы видеть сообщения";
      }
      if (chatEmptyIconEl) {
        chatEmptyIconEl.replaceChildren(iconEl("plus", 64));
      }
      return;
    }
    if (occupied === 0) {
      chatEmptyEl.hidden = false;
      if (chatEmptyTitleEl) {
        chatEmptyTitleEl.textContent = "Сообщений пока нет";
      }
      if (chatEmptyHintEl) {
        chatEmptyHintEl.textContent = "Напишите первым или дождитесь активности в чате";
      }
      if (chatEmptyIconEl) {
        chatEmptyIconEl.replaceChildren(iconEl("emote", 64));
      }
      return;
    }
    chatEmptyEl.hidden = true;
  };
  const scrollChrome = bindScrollChrome({
    ring,
    host: canvasHost,
    track: scrollTrack,
    thumb: scrollThumb,
    jump: jumpBottom,
    onScroll: () => {
      emoteTooltipCtl?.refresh();
      quickActionsCtl?.syncOnScroll(lastPointerY);
      syncChatEmpty();
    },
  });
  try {
    supportsIncognito =
      (await invoke<boolean>("supports_incognito_links")) === true;
  } catch {
    supportsIncognito = false;
  }
  let uiLayout: UiLayout = "Extended";
  let playerChatSplit = parsePlayerChatSplit(undefined);
  let mountedChannel = "";
  let readActiveChannel = (): string => "";
  let stageSplitCtl: {
    refresh: () => void;
    dispose: () => void;
    isDragging: () => boolean;
  } | null = null;

  function syncPlayerForLayout(joined: string): void {
    if (uiLayout === "Classic") {
      unmountPlayer(playerSlot);
      mountedChannel = "";
      setPlayerLiveHint(null);
      return;
    }
    const ch = joined.trim();
    if (!ch) {
      if (mountedChannel) {
        unmountPlayer(playerSlot);
        mountedChannel = "";
      }
      setPlayerLiveHint(null);
      return;
    }
    if (ch !== mountedChannel) {
      mountPlayer(playerSlot, ch);
      mountedChannel = ch;
    }
    const stream = streamByChannel.get(ch.toLowerCase());
    setPlayerLiveHint(stream ? stream.live : null);
  }

  const settingsCtl = bindSettingsBridge({
    ring,
    openBtn: null,
    onOpen: () => {
      hideContextMenu();
    },
    onDisplay: (data) => {
      usercardScrollbackLimit = scrollbackUsercardLimitFromKnobs(data.knobs);
      timeoutKnobs = data.knobs ?? {};
      customUriScheme = String(data.knobs["external.customURIScheme"] ?? "").trim();
      imageUploadKnobs = parseImageUploadKnobs(data.knobs ?? {});
      modActionBtns = parseModActions(data.modActions ?? []);
      ring.setModActions(modActionBtns);
      userCard?.syncMod();
      autoCloseUserPopup =
        data.knobs["behaviour.autoCloseUserPopup"] !== false;
      autoCloseThreadPopup =
        data.knobs["behaviour.autoCloseThreadPopup"] === true;
      showTimestamps = data.showTimestamps;
      timestampFormat = data.timestampFormat || "hh:mm";
      hideTimestampsWhenLive =
        data.knobs["appearance.hideMessageTimestampsWhenLive"] === true;
      replyThreadCtl?.syncComposer();
      replyThreadCtl?.repaint();
      showPronouns = data.knobs["misc.showPronouns"] === true;
      hideUsercardAvatars =
        data.knobs["streamerMode.hideUsercardAvatars"] !== false;
      hideUserNotes = data.knobs["streamerMode.hideUserNotes"] !== false;
      userCard?.syncAvatars();
      userCard?.syncPronouns();
      userCard?.syncNotes();
      quickActionsCtl?.hide();
      composerOpts = {
        showEmptyInput: data.knobs["appearance.showEmptyInput"] !== false,
        showMessageLength: data.knobs["appearance.showMessageLength"] === true,
        showSendWaitTimer:
          data.knobs["appearance.showSendWaitTimer"] === true,
        showSendButton: data.knobs["ui.showSendButton"] !== false,
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
      unshortLinks = data.knobs["links.unshortLinks"] === true;
      openLinksIncognito = data.knobs["misc.openLinksIncognito"] === true;
      searchIncognito = data.knobs["behaviour.searchIncognito"] === true;
      searchEnabled = data.knobs["behaviour.searchEnabled"] === true;
      searchEngineUrl = String(data.knobs["behaviour.searchEngineUrl"] ?? "");
      searchEngineName = String(data.knobs["behaviour.searchEngineName"] ?? "");
      headerKnobs = parseHeaderKnobs(data.knobs);
      thumbnailSizeStream = parseThumbnailSizeStream(
        data.knobs["appearance.thumbnailSizeStream"],
      );
      menuCommands = menuCommandsFromSettings(data);
      emoteTooltipCtl?.refresh();
      repaintChannelTitle();
      streamPreviewCtl?.refresh();
      uiLayout = parseUiLayout(data.knobs["appearance.uiLayout"]);
      if (!stageSplitCtl?.isDragging()) {
        playerChatSplit = parsePlayerChatSplit(data.knobs["appearance.playerChatSplit"]);
      }
      channels.setShowRecents(false);
      if (uiLayout === "Classic") {
        syncPlayerForLayout(readActiveChannel());
        applyUiLayout(appRoot, uiLayout, {
          settingsBtn: settingsOpen,
          channelList: list,
        });
      } else {
        applyUiLayout(appRoot, uiLayout, {
          settingsBtn: settingsOpen,
          channelList: list,
        });
        syncPlayerForLayout(readActiveChannel());
      }
      stageSplitCtl?.refresh();
      joinPopoverCtl?.sync();
      tabOverflowCtl?.refresh();
      applyWindowMinForLayout(uiLayout);
    },
  });
  prepareSettingsOpen = () => {
    settingsCtl.prepareOpen();
  };
  stageSplitCtl = bindStageSplit({
    stage: stageEl,
    split: stageSplitEl,
    isEnabled: () => uiLayout === "Extended",
    getRatio: () => playerChatSplit,
    setRatio: (ratio) => {
      playerChatSplit = ratio;
    },
    onCommit: (ratio) => {
      void settingsCtl.patchKnobs({ "appearance.playerChatSplit": ratio });
    },
  });
  const ipc = bindChatIpc(ring, {
    afterBatch: (events) => {
      replyThreadLive?.(events);
    },
  });
  readActiveChannel = () => ipc.active().trim();
  unbindImageUpload = bindImageUpload({
    input: messageInput,
    dragHost: composer,
    dropHint: composerDropHint ?? undefined,
    getKnobs: () => imageUploadKnobs,
    getChannel: () => ipc.active(),
    onError: (message) => {
      toast.push({ kind: "danger", text: message });
    },
    onStart: () => {
      toast.push({ kind: "info", text: "Загрузка изображения…" });
    },
    onSuccess: () => {
      toast.push({ kind: "success", text: "Изображение загружено" });
    },
  });

  if (moderationModeBtn) {
    moderationModeBtn.addEventListener("click", () => {
      const next = !ring.moderationModeOn();
      ring.setModerationMode(next);
      moderationModeBtn.setAttribute("aria-pressed", next ? "true" : "false");
      moderationModeBtn.classList.toggle("is-active", next);
      if (next && modActionBtns.length === 0) {
        void requestOpenSettingsWindow();
      }
    });
  }

  let headerAvatarLogin = "";
  const avatarUrlByLogin = new Map<string, string>();

  function paintHeaderAvatar(login: string): void {
    const key = login.trim().toLowerCase();
    if (!key) {
      headerAvatarEl.hidden = true;
      headerAvatarImgEl.hidden = true;
      headerAvatarImgEl.removeAttribute("src");
      headerAvatarImgEl.removeAttribute("data-expect");
      headerAvatarLetterEl.hidden = true;
      headerAvatarLetterEl.textContent = "";
      headerAvatarLogin = "";
      return;
    }
    headerAvatarEl.hidden = false;
    headerAvatarLogin = key;
    const url = avatarUrlByLogin.get(key);
    if (url) {
      headerAvatarImgEl.hidden = false;
      headerAvatarLetterEl.hidden = true;
      headerAvatarLetterEl.textContent = "";
      headerAvatarImgEl.dataset.expect = url;
      if (headerAvatarImgEl.getAttribute("src") !== url) {
        headerAvatarImgEl.src = url;
      }
      return;
    }
    headerAvatarImgEl.hidden = true;
    headerAvatarImgEl.removeAttribute("src");
    headerAvatarImgEl.removeAttribute("data-expect");
    headerAvatarLetterEl.hidden = false;
    headerAvatarLetterEl.textContent = key.slice(0, 1).toUpperCase();
  }

  function requestChannelAvatar(login: string): void {
    const key = login.trim().toLowerCase();
    if (!key) {
      return;
    }
    if (avatarUrlByLogin.has(key)) {
      paintHeaderAvatar(key);
      return;
    }
    void invoke<{ login: string; url: string | null }>("chat_profile_image", {
      login: key,
    })
      .then((res) => {
        if (res.url) {
          avatarUrlByLogin.set(res.login, res.url);
        }
        if (headerAvatarLogin === res.login) {
          paintHeaderAvatar(res.login);
        }
      })
      .catch(() => undefined);
  }

  headerAvatarImgEl.addEventListener("error", () => {
    const key = headerAvatarLogin;
    const expect = headerAvatarImgEl.dataset.expect;
    if (!key || !expect) {
      return;
    }
    if (headerAvatarImgEl.getAttribute("src") !== expect) {
      return;
    }
    avatarUrlByLogin.delete(key);
    headerAvatarImgEl.hidden = true;
    headerAvatarImgEl.removeAttribute("src");
    headerAvatarImgEl.removeAttribute("data-expect");
    headerAvatarLetterEl.hidden = false;
    headerAvatarLetterEl.textContent = key.slice(0, 1).toUpperCase();
  });

  function paintHeaderMeta(
    el: HTMLElement,
    parts: ReturnType<typeof channelMetaParts>,
    live: boolean,
  ): void {
    el.replaceChildren();
    const restBits = [parts.uptime, parts.game, parts.streamTitle].filter(
      (p): p is string => Boolean(p),
    );
    if (parts.viewers) {
      const viewers = document.createElement("span");
      viewers.className = "header-meta-viewers";
      viewers.append(iconEl("viewers", 14), document.createTextNode(parts.viewers));
      el.appendChild(viewers);
    }
    if (restBits.length > 0) {
      const rest = document.createElement("span");
      rest.className = "header-meta-rest";
      const prefix = parts.viewers ? " · " : "";
      rest.textContent = prefix + restBits.join(" · ");
      el.appendChild(rest);
    } else if (!parts.viewers && live) {
      el.textContent = "\u00a0";
    }
  }

  let repaintChannelTitle = (): void => {
    if (!titleEl) {
      return;
    }
    const ch = ipc.active();
    if (!ch) {
      titleEl.replaceChildren();
      headerLiveEl.hidden = true;
      headerChannelNameEl.textContent = "";
      paintHeaderAvatar("");
      setPlayerLiveHint(null);
      ring.setChannelLive(false);
      replyThreadCtl?.repaint();
      return;
    }
    const stream = streamByChannel.get(ch.toLowerCase());
    const live = stream?.live ?? false;
    ring.setChannelLive(live);
    replyThreadCtl?.repaint();
    const sm = streamerModeState();
    const knobs = effectiveHeaderKnobs(headerKnobs, {
      streamerActive: sm.active,
      hideViewerCountAndDuration: sm.hideViewerCountAndDuration,
    });
    headerChannelNameEl.textContent = ch;
    paintHeaderMeta(titleEl, channelMetaParts(ch, stream, knobs), live);
    headerLiveEl.hidden = !live;
    if (headerAvatarLogin !== ch.toLowerCase()) {
      paintHeaderAvatar(ch);
      requestChannelAvatar(ch);
    } else {
      paintHeaderAvatar(ch);
    }
    setPlayerLiveHint(stream ? stream.live : null);
    streamPreviewCtl?.refresh();
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
    if (isSettingsWindowOpen() || !searchModal.hidden) {
      return;
    }
    ring.markLastReadAtBottom();
  });
  const chatFindCtl = bindSearchPopup({
    ring,
    modal: searchModal,
    activeChannel: () => ipc.active(),
    onOpen: () => {
      hideContextMenu();
    },
  });
  chromeReady.getChannel = () => ipc.active();
  chromeReady.hasCustomPlayer = () => Boolean(customUriScheme);
  chromeReady.headerAction = (action) => {
      const channel = ipc.active().trim();
      switch (action) {
        case "search":
          chatFindCtl.open();
          break;
        case "open-browser":
          if (!channel) {
            setStatus("нет активного канала");
            return;
          }
          void invoke("open_chat_link", {
            url: `https://www.twitch.tv/${channel}`,
            private: openLinksIncognito,
          }).catch((err) => {
            setStatus(formatError(err));
          });
          break;
        case "open-streamlink":
          if (!channel) {
            setStatus("нет активного канала");
            return;
          }
          void invoke("open_in_streamlink", { channel }).catch((err) => {
            setStatus(formatError(err));
          });
          break;
        case "open-custom-player":
          if (!channel || !customUriScheme) {
            setStatus(!customUriScheme ? "custom player не настроен" : "нет активного канала");
            return;
          }
          void invoke("open_in_custom_player", { channel }).catch((err) => {
            setStatus(formatError(err));
          });
          break;
        case "reconnect":
          if (!channel) {
            setStatus("нет активного канала");
            return;
          }
          void joinChannel(channel, true);
          break;
        case "leave":
          if (!channel) {
            setStatus("нет активного канала");
            return;
          }
          void leaveChannel(channel);
          break;
      }
  };
  userCard = bindUserCard({
    modal: usercardModal,
    notesModal,
    searchModal,
    activeChannel: () => ipc.active(),
    autoClose: () => autoCloseUserPopup,
    getHideAvatars: () => hideUsercardAvatars && isStreamerModeActive(),
    getHideUserNotes: () => hideUserNotes && isStreamerModeActive(),
    getShowPronouns: () => showPronouns,
    getOpenPrivate: () => openLinksIncognito,
    getUsercardLimit: () => usercardScrollbackLimit,
    getTimeoutButtons: () => parseTimeoutButtons(timeoutKnobs),
    getSelfLogin: () => lastAuth.login?.trim().toLowerCase() || null,
  });
  addStreamerModeOnChange(() => {
    userCard?.syncAvatars();
    userCard?.syncNotes();
    repaintChannelTitle();
  });
  canvasHost.addEventListener("pointermove", (ev) => {
    lastPointerY = ev.clientY;
  });
  quickActionsCtl = bindChatQuickActions({
    host: canvasHost,
    ring,
    bar: chatQuickBar,
    replyBtn: chatQaReply,
    copyBtn: chatQaCopy,
    moreBtn: chatQaMore,
    onReply: (msgId, login, text) => {
      setReply(msgId, login, text);
      messageInput.focus();
    },
    onCopy: (text) => {
      void navigator.clipboard.writeText(text).then(toastCopied).catch(() => undefined);
    },
    onMore: (ctx) => {
      openContextMenu(ctx);
    },
  });
  ring.setHoverGuard(() => quickActionsCtl?.isHoveringBar() === true);
  const replyThread = bindReplyThread({
    modal: replythreadModal,
    activeChannel: () => ipc.active(),
    autoClose: () => autoCloseThreadPopup,
    getCanSend: () => lastAuth.canSend,
    getSelfLogin: () => lastAuth.login?.trim() || null,
    getShowTimestamps: () => showTimestamps,
    getTimestampFormat: () => timestampFormat,
    getHideTimestampsWhenLive: () => hideTimestampsWhenLive,
    getChannelLive: () =>
      streamByChannel.get(ipc.active().trim().toLowerCase())?.live ?? false,
    onStatus: (message) => {
      setStatus(message);
    },
  });
  replyThreadCtl = replyThread;
  replyThreadLive = replyThread.ingestLive;
  const emotePopup = bindEmotePopup({
    modal: emotepopupModal,
    anchor: emoteOpen,
    activeChannel: () => ipc.active(),
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
    emotePopup.toggle();
  });
  function dispatchHotkey(action: HotkeyAction): boolean {
    switch (action) {
      case "showSearch":
        chatFindCtl.open();
        return true;
      case "openSettings":
        hideContextMenu();
        chatFindCtl.close();
        void requestOpenSettingsWindow();
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
  let holdStatus = false;
  let sending = false;
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
  let replyOriginalSeq = 0;
  let viewThreadSeq = 0;
  let copyJsonSeq = 0;
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

  window.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented) {
      return;
    }
    if (
      ev.key === "Tab" &&
      (ev.ctrlKey || ev.metaKey) &&
      !ev.altKey &&
      !isSettingsWindowOpen()
    ) {
      const joined = channels.joined();
      if (joined.length < 2) {
        return;
      }
      const active = ipc.active();
      const cur = joined.indexOf(active);
      if (cur < 0) {
        return;
      }
      ev.preventDefault();
      const next = cycleChannelIndex(cur, joined.length, ev.shiftKey);
      const login = next >= 0 ? joined[next] : undefined;
      if (login) {
        void joinChannel(login, true);
      }
      return;
    }
    const action = resolveAction(ev);
    if (!action) {
      return;
    }
    if (!actionAllowsEditable(action) && isEditableTarget(ev.target)) {
      return;
    }
    if (isSettingsWindowOpen()) {
      return;
    }
    if (dispatchHotkey(action)) {
      ev.preventDefault();
    }
  });

  tabOverflowCtl = bindTabOverflow({ list, host: channelListHost });
  authMenuCtl = bindAuthMenu({
    chip: authChipBtn,
    menu: authMenuEl,
    getAccounts: () => {
      const current = (lastAuth.login ?? "").toLowerCase();
      const rows = lastAuth.accounts ?? [];
      if (rows.length === 0 && lastAuth.login) {
        return [{ login: lastAuth.login, current: true }];
      }
      return rows.map((r) => ({
        login: r.login,
        current: r.login.toLowerCase() === current,
      }));
    },
    canLogout: () => Boolean(lastAuth.login) && !lastAuth.fromEnv,
    onAction: (action) => {
      if (action.kind === "logout") {
        void logout();
        return;
      }
      if (action.kind === "settings") {
        void requestOpenSettingsWindow();
        return;
      }
      void (async () => {
        try {
          await invoke("auth_select", { login: action.login });
          await paintAuthFromServer();
        } catch (err) {
          setStatus(formatError(err));
        }
      })();
    },
  });

  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
  });

  ring.setOnContextMenu((ctx) => {
    openContextMenu(ctx);
  });
  ring.setOnModAction((action, ctx) => {
    hideContextMenu();
    if (modSendBusy) {
      return;
    }
    const text = expandModAction(action, {
      userName: ctx.login,
      msgId: ctx.msgId,
      channel: ipc.active() || "",
    });
    if (!text) {
      setStatus("Could not build moderation command.");
      return;
    }
    modSendBusy = true;
    void (async () => {
      try {
        await invoke("chat_send", { text, replyToId: null });
      } catch (err) {
        setStatus(formatError(err));
      } finally {
        modSendBusy = false;
      }
    })();
  });
  ring.setOnViewerRoleChange(() => {
    userCard?.syncMod();
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
    const customTrigger = btn.dataset.customCmd;
    const target = contextTarget;
    hideContextMenu();
    if (customTrigger) {
      void invoke("chat_exec_custom_command", {
        trigger: customTrigger,
        messageLogin: target.login || null,
        messageDisplay: target.nick || target.login || null,
        messageId: target.msgId || null,
        messageText: target.text || null,
        copyText: target.text || null,
        inputText: messageInput.value,
        replyToId: null,
      }).catch((err) => {
        setStatus(formatError(err));
      });
      return;
    }
    if (action === "copy") {
      void navigator.clipboard.writeText(target.text).then(toastCopied).catch(() => undefined);
      return;
    }
    if (action === "copy-full" && target.fullText) {
      void navigator.clipboard
        .writeText(target.fullText)
        .then(toastCopied)
        .catch(() => undefined);
      return;
    }
    if (action === "copy-id" && target.msgId) {
      void navigator.clipboard
        .writeText(target.msgId)
        .then(toastCopied)
        .catch(() => undefined);
      return;
    }
    if (action === "copy-json" && target.msgId) {
      const msgId = target.msgId;
      const seq = ++copyJsonSeq;
      void (async () => {
        const channel = ipc.active().trim();
        if (!channel) {
          setStatus("нет активного канала");
          return;
        }
        try {
          const snap = await invoke<{ events: ChatEvent[] }>("chat_snapshot", { channel });
          if (seq !== copyJsonSeq || ipc.active().trim() !== channel) {
            return;
          }
          const events = Array.isArray(snap.events) ? snap.events : [];
          const event = findEventByMsgId(events, msgId);
          if (!event) {
            setStatus("сообщение не найдено в scrollback");
            return;
          }
          await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
          toastCopied();
        } catch (err) {
          setStatus(formatError(err));
        }
      })();
      return;
    }
    if (
      (action === "open-link" || action === "open-link-incognito") &&
      target.linkUrl
    ) {
      const forcePrivate = action === "open-link-incognito";
      const linkUrl = target.linkUrl;
      void (async () => {
        try {
          const openUrl = await resolveOpenUrlForChatLink(linkUrl, unshortLinks);
          await invoke("open_chat_link", {
            url: openUrl,
            private: forcePrivate,
          });
        } catch (err) {
          toast.push({ kind: "danger", text: formatError(err) });
        }
      })();
      return;
    }
    if (action === "copy-link" && target.linkUrl) {
      void navigator.clipboard
        .writeText(target.linkUrl)
        .then(toastCopied)
        .catch(() => undefined);
      return;
    }
    if (action === "copy-image-link") {
      const imageUrl = btn.dataset.url?.trim();
      if (imageUrl) {
        void navigator.clipboard.writeText(imageUrl).then(toastCopied).catch(() => undefined);
      }
      return;
    }
    if (action === "open-image-link") {
      const imageUrl = btn.dataset.url?.trim();
      if (imageUrl) {
        void invoke("open_chat_link", {
          url: imageUrl,
          private: openLinksIncognito,
        }).catch(() => undefined);
      }
      return;
    }
    if (action === "web-search") {
      if (!searchEnabled) {
        return;
      }
      const searchUrl = buildWebSearchUrl(searchEngineUrl, target.text);
      if (searchUrl) {
        void invoke("open_chat_link", {
          url: searchUrl,
          private: searchIncognito,
        }).catch(() => undefined);
      }
      return;
    }
    if (action === "reply" && target.login && target.msgId && !target.disabled) {
      setReply(target.msgId, target.login, target.text);
      messageInput.focus();
      return;
    }
    if (action === "reply-original" && target.msgId) {
      const msgId = target.msgId;
      const seq = ++replyOriginalSeq;
      void (async () => {
        const channel = ipc.active().trim();
        if (!channel) {
          setStatus("нет активного канала");
          return;
        }
        try {
          const snap = await invoke<{ events: ChatEvent[] }>("chat_snapshot", { channel });
          if (seq !== replyOriginalSeq || ipc.active().trim() !== channel) {
            return;
          }
          const events = (Array.isArray(snap.events) ? snap.events : []).filter(
            (ev): ev is Extract<ChatEvent, { kind: "privmsg" }> => ev.kind === "privmsg",
          );
          const root = resolveReplyRoot(events, msgId);
          if (!root) {
            setStatus("не удалось найти корень ветки");
            return;
          }
          setReply(root.id, root.login, root.text);
          messageInput.focus();
        } catch (err) {
          setStatus(formatError(err));
        }
      })();
      return;
    }
    if (action === "thread" && target.msgId && target.login && !target.disabled) {
      const msgId = target.msgId;
      const seq = ++viewThreadSeq;
      void (async () => {
        const channel = ipc.active().trim();
        if (!channel) {
          setStatus("нет активного канала");
          return;
        }
        try {
          replyThread.beginOpen({
            rootId: msgId,
            login: target.login,
            text: target.text,
          });
          const snap = await invoke<{ events: ChatEvent[] }>("chat_snapshot", { channel });
          if (seq !== viewThreadSeq || ipc.active().trim() !== channel) {
            replyThread.close();
            return;
          }
          const events = (Array.isArray(snap.events) ? snap.events : []).filter(
            (ev): ev is Extract<ChatEvent, { kind: "privmsg" }> => ev.kind === "privmsg",
          );
          const root = resolveReplyRoot(events, msgId);
          if (!root) {
            replyThread.close();
            setStatus("не удалось найти корень ветки");
            return;
          }
          replyThread.completeOpen({
            rootId: root.id,
            login: root.login,
            text: root.text,
            events,
          });
        } catch (err) {
          replyThread.close();
          setStatus(formatError(err));
        }
      })();
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
        private: openLinksIncognito,
      }).catch(() => undefined);
      return;
    }
    if (action === "open-streamlink") {
      const channel = ipc.active().trim();
      if (!channel) {
        setStatus("нет активного канала");
        return;
      }
      void invoke("open_in_streamlink", { channel }).catch((err) => {
        setStatus(formatError(err));
      });
      return;
    }
    if (action === "open-custom-player") {
      const channel = ipc.active().trim();
      if (!channel) {
        setStatus("нет активного канала");
        return;
      }
      void invoke("open_in_custom_player", { channel }).catch((err) => {
        setStatus(formatError(err));
      });
    }
  });

  replyCancelBtn.addEventListener("click", () => {
    clearReply();
  });

  await startLiveNotifyListener();

  await listen<ChatStatus>(CHAT_STATUS_EVENT, (ev) => {
    if (holdStatus) {
      return;
    }
    const spin =
      ev.payload.state === "connecting" || ev.payload.state === "reconnecting";
    setStatus(formatStatus(ev.payload), { spin });
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
    repaintChannelTitle();
  });

  await listen<{ login: string; url: string }>("chat:profile_image", (ev) => {
    const login = ev.payload.login?.trim().toLowerCase() ?? "";
    const url = ev.payload.url?.trim() ?? "";
    if (!login || !url) {
      return;
    }
    avatarUrlByLogin.set(login, url);
    if (headerAvatarLogin === login) {
      paintHeaderAvatar(login);
    }
  });

  bindPlayerOpenTwitch((channel) => {
    void invoke("open_chat_link", {
      url: `https://www.twitch.tv/${channel}`,
    }).catch((err) => {
      setStatus(formatError(err));
    });
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
      avatarUrlByLogin.delete(ev.payload.dropped.toLowerCase());
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
    authPaintGen += 1;
    applyAuth(ev.payload);
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

  chromeReady.join = (channel, focus = true) => {
    void joinChannel(channel, focus);
  };
  chromeReady.startLogin = () => {
    void startLogin();
  };
  chromeReady.logout = () => {
    void logout();
  };
  chromeReady.importLogin = () => {
    void importLogin();
  };
  emoteOpen.disabled = false;
  if (statusTextEl.textContent === "Загрузка чата…") {
    setStatus("");
  }

  try {
    applyAuth(await invoke<AuthInfo>("auth_status"));
  } catch (err) {
    setStatus(formatError(err));
  }

  try {
    const session = await invoke<{
      lastChannel?: string | null;
      recents?: string[];
      open?: string[];
    }>("session_get");
    if (myEpoch !== bootEpoch) {
      return;
    }
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

  for (const pending of pendingJoins.splice(0)) {
    void joinChannel(pending.name, pending.focus);
  }

  function fillImageScaleSubmenu(
    host: HTMLElement | null,
    action: "open-image-link" | "copy-image-link",
    links: ReturnType<typeof deriveEmoteScaleUrls>,
  ): void {
    if (!host) {
      return;
    }
    const items = host.querySelector<HTMLElement>(".chat-context-submenu-items");
    if (!items) {
      return;
    }
    items.replaceChildren();
    for (const link of links) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.dataset.action = action;
      btn.dataset.url = link.url;
      btn.textContent = emoteScaleLinkLabel(link.factor);
      items.appendChild(btn);
    }
  }

  function openContextMenu(ctx: SlotContext): void {
    headerMenuCtl?.hide();
    contextTarget = ctx;
    if (contextCustomHost && contextCustomSep) {
      contextCustomHost.replaceChildren();
      const cmds = menuCommands.filter(
        (row) => row.showInMessageMenu && String(row.trigger ?? "").trim(),
      );
      for (const row of cmds) {
        const trigger = String(row.trigger).trim();
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("role", "menuitem");
        btn.dataset.customCmd = trigger;
        btn.textContent = trigger;
        contextCustomHost.appendChild(btn);
      }
      const showCustom = cmds.length > 0;
      contextCustomHost.hidden = !showCustom;
      contextCustomSep.hidden = !showCustom;
    }
    const replyBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="reply"]');
    const replyOriginalBtn = contextMenuEl.querySelector<HTMLButtonElement>(
      '[data-action="reply-original"]',
    );
    const threadBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="thread"]');
    const userBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="user"]');
    const twitchBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="open-twitch"]');
    const streamlinkBtn = contextMenuEl.querySelector<HTMLButtonElement>(
      '[data-action="open-streamlink"]',
    );
    const customPlayerBtn = contextMenuEl.querySelector<HTMLButtonElement>(
      '[data-action="open-custom-player"]',
    );
    const copyLinkBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="copy-link"]');
    const copyIdBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="copy-id"]');
    const copyJsonBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="copy-json"]');
    const openLinkBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="open-link"]');
    const openLinkIncognitoBtn = contextMenuEl.querySelector<HTMLButtonElement>(
      '[data-action="open-link-incognito"]',
    );
    const webSearchBtn = contextMenuEl.querySelector<HTMLButtonElement>('[data-action="web-search"]');
    if (replyBtn) {
      replyBtn.hidden = !ctx.login || !ctx.msgId || ctx.disabled;
    }
    if (replyOriginalBtn) {
      replyOriginalBtn.hidden = !ctx.replyToId || !ctx.msgId;
    }
    if (threadBtn) {
      threadBtn.hidden = !ctx.inReplyThread || !ctx.msgId || ctx.disabled;
    }
    if (userBtn) {
      userBtn.hidden = !ctx.login;
    }
    if (twitchBtn) {
      twitchBtn.hidden = !ctx.login;
    }
    if (streamlinkBtn) {
      streamlinkBtn.hidden = !ipc.active().trim();
    }
    if (customPlayerBtn) {
      customPlayerBtn.hidden = !(customUriScheme && ipc.active().trim());
    }
    if (copyIdBtn) {
      copyIdBtn.hidden = !(ctx.shiftOnly && ctx.msgId);
    }
    if (copyJsonBtn) {
      copyJsonBtn.hidden = !(ctx.shiftOnly && ctx.msgId);
    }
    const hasImage = Boolean(ctx.imageUrl);
    const imageLinks = hasImage
      ? deriveEmoteScaleUrls(ctx.imageUrl, {
          provider: ctx.imageProvider || undefined,
          kind: ctx.imageKind === "badge" || ctx.imageKind === "emote" ? ctx.imageKind : undefined,
        })
      : [];
    if (contextImageOpen) {
      contextImageOpen.hidden = imageLinks.length === 0;
    }
    if (contextImageCopy) {
      contextImageCopy.hidden = imageLinks.length === 0;
    }
    fillImageScaleSubmenu(contextImageOpen, "open-image-link", imageLinks);
    fillImageScaleSubmenu(contextImageCopy, "copy-image-link", imageLinks);
    if (contextImageSep) {
      contextImageSep.hidden = imageLinks.length === 0;
    }
    const hasLink = Boolean(ctx.linkUrl);
    if (openLinkBtn) {
      openLinkBtn.hidden = !hasLink;
    }
    if (openLinkIncognitoBtn) {
      openLinkIncognitoBtn.hidden = !hasLink || !supportsIncognito;
    }
    if (copyLinkBtn) {
      copyLinkBtn.hidden = !hasLink;
    }
    if (webSearchBtn) {
      const searchUrl =
        searchEnabled ? buildWebSearchUrl(searchEngineUrl, ctx.text) : null;
      webSearchBtn.hidden = !searchUrl;
      setContextMenuLabel(
        webSearchBtn,
        webSearchMenuLabel(searchEngineName, searchIncognito && supportsIncognito),
      );
    }
    applyContextMenuChrome(contextMenuEl);
    contextMenuEl.hidden = false;
    const pad = 8;
    const flyoutW = imageLinks.length > 0 ? 128 : 0;
    const rect = contextMenuEl.getBoundingClientRect();
    const nearRight =
      flyoutW > 0 && ctx.clientX + rect.width + flyoutW > window.innerWidth - pad;
    for (const el of [contextImageOpen, contextImageCopy]) {
      el?.classList.toggle("chat-context-submenu-flip", nearRight);
    }
    let x = ctx.clientX;
    if (nearRight) {
      x = Math.max(pad + flyoutW, Math.min(x, window.innerWidth - rect.width - pad));
    } else if (flyoutW > 0) {
      x = Math.min(x, window.innerWidth - rect.width - flyoutW - pad);
    } else {
      x = Math.min(x, window.innerWidth - rect.width - pad);
    }
    const y = Math.min(ctx.clientY, window.innerHeight - rect.height - pad);
    contextMenuEl.style.left = `${Math.max(pad, x)}px`;
    contextMenuEl.style.top = `${Math.max(pad, y)}px`;
  }

  function hideContextMenu(): void {
    contextMenuEl.hidden = true;
    contextTarget = null;
    headerMenuCtl?.hide();
    authMenuCtl?.hide();
    joinPopoverCtl?.hide();
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
    ring.setSelfLogin(info.login);
    userCard?.syncMod();
    replyThreadCtl?.syncComposer();
    const signed = Boolean(info.login);
    const pendingPaste = Boolean(info.pendingPaste);
    const pendingDevice = Boolean(info.userCode);
    const pending = pendingPaste || pendingDevice;
    const showChip = signed && !pending;
    loginEl.hidden = true;
    loginEl.textContent = "";
    authChipBtn.hidden = !showChip;
    authChipLoginEl.textContent = showChip ? info.login! : "";
    const avatarUrl = info.profileImageUrl?.trim() ?? "";
    authChipBtn.classList.toggle("has-avatar", Boolean(showChip && avatarUrl));
    if (showChip && avatarUrl) {
      authChipAvatarEl.hidden = false;
      authChipLetterEl.hidden = true;
      authChipLetterEl.textContent = "";
      if (authChipAvatarEl.src !== avatarUrl) {
        authChipAvatarEl.src = avatarUrl;
      }
    } else if (showChip) {
      authChipAvatarEl.hidden = true;
      authChipAvatarEl.removeAttribute("src");
      authChipLetterEl.hidden = false;
      authChipLetterEl.textContent = (info.login ?? "?").slice(0, 1).toUpperCase();
    } else {
      authChipAvatarEl.hidden = true;
      authChipAvatarEl.removeAttribute("src");
      authChipLetterEl.hidden = true;
      authChipLetterEl.textContent = "";
    }
    authChipAvatarEl.onerror = () => {
      if (!lastAuth.login || authChipBtn.hidden) {
        return;
      }
      authChipAvatarEl.hidden = true;
      authChipAvatarEl.removeAttribute("src");
      authChipBtn.classList.remove("has-avatar");
      authChipLetterEl.hidden = false;
      authChipLetterEl.textContent = lastAuth.login.slice(0, 1).toUpperCase();
    };
    if (!showChip) {
      authMenuCtl?.hide();
    }
    // Idle unsigned → только «Войти» + настройки; любой pending скрывает «Войти».
    signinBtn.hidden = signed || pending;
    signinBtn.disabled = pending || authOp === "start";
    // Настройки: рядом с «Войти» без сессии; в меню chip когда вошли.
    settingsBtn.hidden = showChip;
    // Pending: «Отмена»; signed idle — logout только через chip-меню.
    logoutBtn.hidden = !pending;
    logoutBtn.textContent = "Отмена";
    logoutBtn.disabled = authOp === "logout";
    // «Вставить код» только в pendingPaste, никогда в idle.
    pasteEl.hidden = !pendingPaste;
    importBtn.hidden = !pendingPaste;
    importBtn.disabled = authOp === "import";
    if (pendingDevice) {
      deviceEl.hidden = false;
      const code = `код: ${info.userCode}`;
      deviceEl.textContent = info.message ? `${code}\n${info.message}` : code;
    } else if (pendingPaste) {
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

  async function paintAuthFromServer(message?: string): Promise<void> {
    const gen = ++authPaintGen;
    const info = await invoke<AuthInfo>("auth_status");
    if (gen !== authPaintGen) {
      return;
    }
    applyAuth(message ? { ...info, message } : info);
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
    const op = "start" as const;
    authOp = op;
    signinBtn.disabled = true;
    try {
      await invoke("auth_start");
      await paintAuthFromServer();
    } catch (err) {
      try {
        await paintAuthFromServer(formatError(err));
      } catch {
        applyAuth({ ...lastAuth, message: formatError(err) });
      }
    } finally {
      if (authOp === op) {
        authOp = "idle";
        applyAuth(lastAuth);
      }
    }
  }

  async function importLogin(): Promise<void> {
    const blob = pasteEl.value;
    const op = "import" as const;
    authOp = op;
    importBtn.disabled = true;
    try {
      await invoke("auth_import", { blob });
      pasteEl.value = "";
      try {
        await navigator.clipboard.writeText("");
      } catch {
        /* clipboard may be denied */
      }
      await paintAuthFromServer();
    } catch (err) {
      try {
        await paintAuthFromServer(formatError(err));
      } catch {
        applyAuth({ ...lastAuth, message: formatError(err) });
      }
    } finally {
      if (authOp === op) {
        authOp = "idle";
        applyAuth(lastAuth);
      }
    }
  }

  async function logout(): Promise<void> {
    const op = "logout" as const;
    authOp = op;
    logoutBtn.disabled = true;
    try {
      await invoke("auth_logout");
      await paintAuthFromServer();
    } catch (err) {
      setStatus(formatError(err));
      try {
        await paintAuthFromServer();
      } catch {
        /* keep lastAuth */
      }
    } finally {
      if (authOp === op) {
        authOp = "idle";
        applyAuth(lastAuth);
      }
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
      setStatus(formatError(err));
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
    const iconName: IconName = complete.popup === "at" ? "user" : "emote";
    complete.items.forEach((item, i) => {
      const li = document.createElement("li");
      const iconWrap = document.createElement("span");
      iconWrap.className = "complete-icon";
      iconWrap.append(iconEl(iconName, 14));
      const text = document.createElement("span");
      text.className = "complete-text";
      text.textContent = item.trimEnd();
      li.append(iconWrap, text);
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
      setStatus(formatError(err));
    } finally {
      sending = false;
      syncComposer();
    }
  }

  function applyMounted(joined: string): void {
    replyThreadCtl?.close();
    channels.remember(joined);
    streamByChannel.delete(joined.toLowerCase());
    ring.setChannelLive(false);
    repaintChannelTitle();
    channelInput.value = joined;
    syncPlayerForLayout(joined);
    chatFindCtl.onChannelChanged();
    applySendWaitForActive();
    userCard?.syncMod();
    userCard?.syncSubage();
    quickActionsCtl?.hide();
    ring.clearHover();
    syncChatEmpty();
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
        syncPlayerForLayout("");
        chatFindCtl.onChannelChanged();
        applySendWaitForActive();
      }
    } catch (err) {
      holdStatus = true;
      setStatus(formatError(err));
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
        syncPlayerForLayout("");
        chatFindCtl.onChannelChanged();
        applySendWaitForActive();
        quickActionsCtl?.hide();
        ring.clearHover();
        syncChatEmpty();
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
      setStatus(formatError(err));
    } finally {
      channelBusy = false;
      joinControl.disabled = false;
      drainChannelQueue();
    }
  }

  async function joinChannel(raw: string, focus = true): Promise<void> {
    const name = normalizeChannelInput(raw);
    if (!name) {
      holdStatus = true;
      setStatus("имя канала: 1-25 символов [a-z0-9_]");
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
      setStatus(formatError(err));
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
      return "";
    case "reconnecting":
      return "переподключение…";
    case "error":
      return s.message || "ошибка";
    case "connecting":
      return "подключение…";
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

function menuCommandsFromSettings(data: AppSettings): AppSettings["commands"] {
  if (!Array.isArray(data.commands)) {
    return [];
  }
  return data.commands.filter(
    (row) => row.showInMessageMenu && String(row.trigger ?? "").trim(),
  );
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
