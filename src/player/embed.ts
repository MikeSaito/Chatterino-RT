import { onLocaleChange, t } from "../i18n";
import { iconEl } from "../shell/icons";

let playerEpoch = 0;
let localeUnsub: (() => void) | null = null;
let slotWaitCleanup: (() => void) | null = null;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let activeHost: HTMLElement | null = null;
let activeChannel = "";
let iframeLoaded = false;
let liveKnown: boolean | null = null;
let overlayMode: "loading" | "offline" | "error" | "ready" = "loading";
let frameEl: HTMLIFrameElement | null = null;
let openTwitchBound = false;
/** Insert closure for the current mount epoch; kept across offline→online. */
let insertEmbed: (() => void) | null = null;

const LOAD_TIMEOUT_MS = 12_000;
const MIN_PLAYER_W = 400;
const MIN_PLAYER_H = 300;

export type PlayerLiveHint = boolean | null;

/** Domains Twitch embed will accept as `parent` for this WebView. */
function twitchEmbedParents(): string[] {
  const hosts = new Set<string>();
  const host = (window.location.hostname || "").trim().toLowerCase();
  if (host) {
    hosts.add(host);
  }
  // Dev Vite (`localhost`) + Tauri WebView2 prod (`tauri.localhost` via useHttpsScheme).
  hosts.add("localhost");
  hosts.add("127.0.0.1");
  hosts.add("tauri.localhost");
  return [...hosts];
}

function buildTwitchPlayerSrc(channel: string): string {
  const params = new URLSearchParams({
    channel,
    muted: "true",
    autoplay: "true",
  });
  for (const parent of twitchEmbedParents()) {
    params.append("parent", parent);
  }
  return `https://player.twitch.tv/?${params.toString()}`;
}

function clearLoadTimer(): void {
  if (loadTimer != null) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
}

/** Twitch autoplay walks ancestors for visibility / display / opacity and needs a real box. */
function isEmbedSurfaceVisible(el: HTMLElement): boolean {
  if (document.visibilityState !== "visible") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width + 0.5 < MIN_PLAYER_W || rect.height + 0.5 < MIN_PLAYER_H) {
    return false;
  }
  let node: HTMLElement | null = el;
  while (node) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number.parseFloat(style.opacity || "1") === 0
    ) {
      return false;
    }
    node = node.parentElement;
  }
  return true;
}

function slotSize(host: HTMLElement): { w: number; h: number } {
  const rect = host.getBoundingClientRect();
  const w = Math.floor(Math.max(host.clientWidth || 0, rect.width));
  const h = Math.floor(Math.max(host.clientHeight || 0, rect.height));
  return { w, h };
}

function ensurePlaceholder(host: HTMLElement): HTMLElement {
  let ph = host.querySelector<HTMLElement>("#player-placeholder");
  if (ph) {
    return ph;
  }
  ph = document.createElement("div");
  ph.id = "player-placeholder";
  ph.setAttribute("aria-live", "polite");

  const iconWrap = document.createElement("div");
  iconWrap.id = "player-placeholder-icon";
  iconWrap.appendChild(iconEl("play", 48));

  const label = document.createElement("p");
  label.id = "player-placeholder-label";
  label.textContent = t("player.loading");

  const action = document.createElement("button");
  action.type = "button";
  action.id = "player-placeholder-action";
  action.className = "btn btn-primary";
  action.textContent = t("player.openTwitch");
  action.hidden = true;

  ph.append(iconWrap, label, action);
  host.appendChild(ph);
  return ph;
}

/** Drop placeholder entirely so it cannot occlude the Twitch iframe. */
function detachPlaceholder(host: HTMLElement): void {
  host.querySelector("#player-placeholder")?.remove();
}

/** Blank then remove so Twitch Player EventEmitters cannot stack across remounts. */
function destroyFrame(frame: HTMLIFrameElement | null): void {
  if (!frame) {
    return;
  }
  try {
    const abort = (frame as HTMLIFrameElement & { __crtAbort?: AbortController }).__crtAbort;
    abort?.abort();
    frame.removeAttribute("src");
    frame.src = "about:blank";
  } catch {
    /* detach anyway */
  }
  frame.remove();
}

function removeFrame(): void {
  if (frameEl) {
    destroyFrame(frameEl);
    frameEl = null;
  }
  iframeLoaded = false;
  clearLoadTimer();
}

function paintOverlay(): void {
  if (!activeHost) {
    return;
  }
  // Never recreate #player-placeholder while the iframe is up: ensurePlaceholder
  // would append an opaque z-index:2 layer and fail Twitch autoplay (style visibility).
  if (frameEl?.isConnected && (overlayMode === "ready" || overlayMode === "loading")) {
    detachPlaceholder(activeHost);
    return;
  }

  const ph = ensurePlaceholder(activeHost);
  const label = ph.querySelector<HTMLElement>("#player-placeholder-label");
  const action = ph.querySelector<HTMLButtonElement>("#player-placeholder-action");
  if (!label || !action) {
    return;
  }
  ph.classList.remove("is-ready", "is-error");
  ph.removeAttribute("aria-hidden");
  action.hidden = true;
  ph.hidden = false;

  if (overlayMode === "ready") {
    label.textContent = "";
    detachPlaceholder(activeHost);
    return;
  }
  action.textContent = t("player.openTwitch");
  if (overlayMode === "error") {
    label.textContent = t("player.error");
    action.hidden = false;
    ph.classList.add("is-error");
    return;
  }
  if (overlayMode === "offline") {
    label.textContent = t("player.offline");
    return;
  }
  label.textContent = t("player.loading");
}

function armLoadTimeout(isLive: () => boolean): void {
  clearLoadTimer();
  loadTimer = setTimeout(() => {
    loadTimer = null;
    if (!isLive() || iframeLoaded || liveKnown !== true) {
      return;
    }
    removeFrame();
    overlayMode = "error";
    paintOverlay();
  }, LOAD_TIMEOUT_MS);
}

/** Insert unless channel is known offline (Helix). Do not wait for live=true. */
function canInsertEmbed(): boolean {
  return liveKnown !== false;
}

function scheduleInsert(isLive: () => boolean): void {
  if (!activeHost || !insertEmbed) {
    return;
  }
  if (!canInsertEmbed()) {
    return;
  }
  if (frameEl?.isConnected) {
    return;
  }
  whenSlotReady(activeHost, isLive, insertEmbed);
}

function syncOverlayAfterLive(isLive: () => boolean): void {
  if (!isLive()) {
    return;
  }
  if (overlayMode === "error" && liveKnown !== true) {
    paintOverlay();
    return;
  }
  if (liveKnown === false) {
    slotWaitCleanup?.();
    slotWaitCleanup = null;
    removeFrame();
    overlayMode = "offline";
    paintOverlay();
    return;
  }
  if (liveKnown === null) {
    if (frameEl?.isConnected && iframeLoaded) {
      overlayMode = "ready";
      paintOverlay();
      return;
    }
    if (frameEl?.isConnected) {
      overlayMode = "loading";
      paintOverlay();
      return;
    }
    overlayMode = "loading";
    paintOverlay();
    scheduleInsert(isLive);
    return;
  }
  // liveKnown === true
  if (iframeLoaded && frameEl?.isConnected) {
    overlayMode = "ready";
    paintOverlay();
    return;
  }
  if (overlayMode !== "error") {
    overlayMode = "loading";
  }
  paintOverlay();
  if (frameEl?.isConnected && !iframeLoaded) {
    armLoadTimeout(isLive);
  }
  scheduleInsert(isLive);
}

export function setPlayerLiveHint(live: PlayerLiveHint): void {
  liveKnown = live;
  if (!activeHost) {
    return;
  }
  const epoch = playerEpoch;
  const isLive = () => epoch === playerEpoch;
  if (live === true && overlayMode === "error") {
    overlayMode = "loading";
  }
  syncOverlayAfterLive(isLive);
}

export function bindPlayerOpenTwitch(
  handler: (channel: string) => void,
): void {
  if (openTwitchBound) {
    return;
  }
  openTwitchBound = true;
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) {
      return;
    }
    if (!t.closest("#player-placeholder-action")) {
      return;
    }
    if (!activeChannel) {
      return;
    }
    handler(activeChannel);
  });
}

function createPlayerFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = t("player.iframeTitle");
  frame.allow =
    "autoplay; encrypted-media; picture-in-picture; storage-access; accelerometer; gyroscope";
  frame.allowFullscreen = true;
  frame.setAttribute("allowfullscreen", "");
  frame.style.visibility = "visible";
  frame.style.opacity = "1";
  frame.style.display = "block";
  return frame;
}

function ensureLocaleHook(): void {
  if (localeUnsub) {
    return;
  }
  localeUnsub = onLocaleChange(() => {
    if (!activeHost) {
      return;
    }
    if (frameEl?.isConnected) {
      frameEl.title = t("player.iframeTitle");
    }
    paintOverlay();
  });
}

export function mountPlayer(host: HTMLElement, channel: string): void {
  unmountPlayer(host);
  ensureLocaleHook();
  const epoch = ++playerEpoch;
  activeHost = host;
  activeChannel = channel.trim().toLowerCase();
  iframeLoaded = false;
  liveKnown = null;
  overlayMode = "loading";
  frameEl = null;
  insertEmbed = null;
  ensurePlaceholder(host);
  paintOverlay();

  const isLive = () => epoch === playerEpoch;

  const insert = () => {
    if (!isLive() || frameEl?.isConnected) {
      return;
    }
    if (!canInsertEmbed()) {
      return;
    }
    if (!isEmbedSurfaceVisible(host)) {
      whenSlotReady(host, isLive, insert);
      return;
    }
    const { w, h } = slotSize(host);
    if (w < MIN_PLAYER_W || h < MIN_PLAYER_H) {
      whenSlotReady(host, isLive, insert);
      return;
    }
    // One live iframe only: destroy any stray node before append.
    host.querySelectorAll("iframe").forEach((node) => {
      destroyFrame(node);
    });
    const frame = createPlayerFrame();
    frame.width = String(w);
    frame.height = String(h);
    const loadAbort = new AbortController();
    (frame as HTMLIFrameElement & { __crtAbort?: AbortController }).__crtAbort = loadAbort;
    frame.addEventListener(
      "load",
      () => {
        if (!isLive() || frameEl !== frame) {
          return;
        }
        // about:blank teardown load — ignore.
        if (!frame.src || frame.src === "about:blank") {
          return;
        }
        iframeLoaded = true;
        clearLoadTimer();
        if (liveKnown === false) {
          removeFrame();
          overlayMode = "offline";
          paintOverlay();
          return;
        }
        overlayMode = "ready";
        paintOverlay();
      },
      { signal: loadAbort.signal },
    );
    frameEl = frame;
    // Detach before append: hidden placeholder still flashes if recreated later.
    detachPlaceholder(host);
    // Canon: insert with src already set (compensation.md).
    frame.src = buildTwitchPlayerSrc(channel);
    host.appendChild(frame);
    armLoadTimeout(isLive);
  };

  insertEmbed = insert;
  // Start embed immediately; Helix live hint only tears down on offline.
  scheduleInsert(isLive);
}

export function unmountPlayer(host: HTMLElement): void {
  playerEpoch += 1;
  slotWaitCleanup?.();
  slotWaitCleanup = null;
  clearLoadTimer();
  insertEmbed = null;
  removeFrame();
  if (activeHost === host) {
    activeHost = null;
    activeChannel = "";
    iframeLoaded = false;
    liveKnown = null;
    overlayMode = "loading";
  }
  host.querySelectorAll("iframe").forEach((node) => {
    destroyFrame(node);
  });
  host.replaceChildren();
}

function whenSlotReady(host: HTMLElement, isLive: () => boolean, run: () => void): void {
  slotWaitCleanup?.();
  let done = false;
  let raf = 0;
  let nestedRaf = 0;
  const observer = new ResizeObserver(() => {
    kick();
  });
  const onVisibility = () => {
    kick();
  };

  const cancelRafs = () => {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (nestedRaf !== 0) {
      cancelAnimationFrame(nestedRaf);
      nestedRaf = 0;
    }
  };

  const cleanup = () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    cancelRafs();
    if (slotWaitCleanup === cleanup) {
      slotWaitCleanup = null;
    }
  };

  const kick = () => {
    if (done) {
      return;
    }
    if (!isLive()) {
      done = true;
      cleanup();
      return;
    }
    if (!canInsertEmbed()) {
      return;
    }
    if (!isEmbedSurfaceVisible(host)) {
      return;
    }
    const { w, h } = slotSize(host);
    if (w < MIN_PLAYER_W || h < MIN_PLAYER_H) {
      return;
    }
    done = true;
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    const pendingPaintCleanup = () => {
      cancelRafs();
      if (slotWaitCleanup === pendingPaintCleanup) {
        slotWaitCleanup = null;
      }
    };
    slotWaitCleanup = pendingPaintCleanup;
    // Two rAFs: after layout+paint so Twitch's first visibility walk sees a real box.
    raf = requestAnimationFrame(() => {
      raf = 0;
      nestedRaf = requestAnimationFrame(() => {
        nestedRaf = 0;
        if (slotWaitCleanup === pendingPaintCleanup) {
          slotWaitCleanup = null;
        }
        if (!isLive() || !canInsertEmbed()) {
          return;
        }
        if (isEmbedSurfaceVisible(host)) {
          const size = slotSize(host);
          if (size.w >= MIN_PLAYER_W && size.h >= MIN_PLAYER_H) {
            run();
            return;
          }
        }
        whenSlotReady(host, isLive, run);
      });
    });
  };

  slotWaitCleanup = cleanup;
  observer.observe(host);
  document.addEventListener("visibilitychange", onVisibility);
  raf = requestAnimationFrame(() => {
    raf = 0;
    kick();
  });
}
