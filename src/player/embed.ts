import { onLocaleChange, t } from "../i18n";
import { iconEl } from "../shell/icons";

let playerEpoch = 0;
let localeUnsub: (() => void) | null = null;
let slotWaitCleanup: (() => void) | null = null;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let mountDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let errorRetryTimer: ReturnType<typeof setTimeout> | null = null;
let reinsertTimer: ReturnType<typeof setTimeout> | null = null;
let activeHost: HTMLElement | null = null;
let activeChannel = "";
let iframeLoaded = false;
let liveKnown: boolean | null = null;
let overlayMode: "loading" | "offline" | "error" | "ready" = "loading";
/** Non-null while a frame exists or is mid-insert (before appendChild). */
let frameEl: HTMLIFrameElement | null = null;
let openTwitchBound = false;
/** Insert closure for the current mount epoch; kept across offline→online. */
let insertEmbed: (() => void) | null = null;
/** Last failed insert / tear-down — blocks live-hint remount spam / 429 loops. */
let lastErrorAt = 0;
/** Last successful iframe append (anti flap offline↔online). */
let lastInsertAt = 0;
/** Pending channel from debounced mountPlayer (abort in-flight switches). */
let pendingChannel = "";

const LOAD_TIMEOUT_MS = 12_000;
const CHANNEL_SWITCH_DEBOUNCE_MS = 320;
const ERROR_RETRY_MIN_MS = 60_000;
const REINSERT_COOLDOWN_MS = 8_000;
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

function clearMountDebounce(): void {
  if (mountDebounceTimer != null) {
    clearTimeout(mountDebounceTimer);
    mountDebounceTimer = null;
  }
}

function clearErrorRetryTimer(): void {
  if (errorRetryTimer != null) {
    clearTimeout(errorRetryTimer);
    errorRetryTimer = null;
  }
}

function clearReinsertTimer(): void {
  if (reinsertTimer != null) {
    clearTimeout(reinsertTimer);
    reinsertTimer = null;
  }
}

function openTwitchChannel(): string {
  return activeChannel || pendingChannel;
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
  // Off-layout / scrolled fully away — Twitch still treats as hidden for autoplay.
  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= (window.innerHeight || 0) ||
    rect.left >= (window.innerWidth || 0)
  ) {
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

/**
 * Blank then remove so Twitch Player EventEmitters cannot stack across remounts.
 * Claimed slot (`frameEl`) must already be cleared by the caller.
 */
function destroyFrame(frame: HTMLIFrameElement | null): void {
  if (!frame) {
    return;
  }
  try {
    const abort = (frame as HTMLIFrameElement & { __crtAbort?: AbortController }).__crtAbort;
    abort?.abort();
    frame.onload = null;
    frame.removeAttribute("src");
    frame.src = "about:blank";
  } catch {
    /* detach anyway */
  }
  frame.remove();
}

function removeFrame(): void {
  const frame = frameEl;
  frameEl = null;
  iframeLoaded = false;
  clearLoadTimer();
  destroyFrame(frame);
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
    // Timeout while known-offline is irrelevant; null|true both need recovery UX.
    if (!isLive() || iframeLoaded || liveKnown === false) {
      return;
    }
    enterErrorState(isLive);
  }, LOAD_TIMEOUT_MS);
}

function enterErrorState(isLive: () => boolean): void {
  lastErrorAt = Date.now();
  removeFrame();
  overlayMode = "error";
  paintOverlay();
  armErrorRetry(isLive);
}

function armErrorRetry(isLive: () => boolean): void {
  clearErrorRetryTimer();
  if (lastErrorAt <= 0) {
    return;
  }
  const wait = Math.max(0, ERROR_RETRY_MIN_MS - (Date.now() - lastErrorAt));
  errorRetryTimer = setTimeout(() => {
    errorRetryTimer = null;
    if (!isLive() || liveKnown === false || frameEl) {
      return;
    }
    if (overlayMode === "error" || overlayMode === "offline") {
      overlayMode = "loading";
      paintOverlay();
    }
    scheduleInsert(isLive);
  }, wait);
}

/** Insert unless channel is known offline (Helix). Do not wait for live=true. */
function canInsertEmbed(): boolean {
  return liveKnown !== false;
}

function errorBackoffBlocksRetry(): boolean {
  if (lastErrorAt <= 0) {
    return false;
  }
  return Date.now() - lastErrorAt < ERROR_RETRY_MIN_MS;
}

function reinsertCooldownBlocks(): boolean {
  return lastInsertAt > 0 && Date.now() - lastInsertAt < REINSERT_COOLDOWN_MS;
}

function scheduleInsert(isLive: () => boolean): void {
  if (!activeHost || !insertEmbed) {
    return;
  }
  if (!canInsertEmbed()) {
    return;
  }
  // frameEl claimed as soon as insert begins — blocks stacked Playing listeners / 429.
  if (frameEl) {
    return;
  }
  if (errorBackoffBlocksRetry()) {
    armErrorRetry(isLive);
    return;
  }
  if (reinsertCooldownBlocks()) {
    if (reinsertTimer == null) {
      const wait = Math.max(0, REINSERT_COOLDOWN_MS - (Date.now() - lastInsertAt));
      reinsertTimer = setTimeout(() => {
        reinsertTimer = null;
        if (!isLive() || !canInsertEmbed() || frameEl) {
          return;
        }
        scheduleInsert(isLive);
      }, wait);
    }
    return;
  }
  whenSlotReady(activeHost, isLive, insertEmbed);
}

function syncOverlayAfterLive(isLive: () => boolean): void {
  if (!isLive()) {
    return;
  }
  // Offline first — never leave a stale error chrome after Helix says offline.
  if (liveKnown === false) {
    clearErrorRetryTimer();
    clearReinsertTimer();
    slotWaitCleanup?.();
    slotWaitCleanup = null;
    removeFrame();
    overlayMode = "offline";
    paintOverlay();
    // Keep lastErrorAt so a Helix offline blip cannot bypass ERROR_RETRY_MIN_MS.
    return;
  }
  if (liveKnown === null) {
    if (frameEl?.isConnected && iframeLoaded) {
      overlayMode = "ready";
      paintOverlay();
      return;
    }
    if (frameEl) {
      overlayMode = "loading";
      paintOverlay();
      return;
    }
    if (overlayMode === "error") {
      if (errorBackoffBlocksRetry()) {
        paintOverlay();
        return;
      }
      overlayMode = "loading";
    } else {
      overlayMode = "loading";
    }
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
  if (frameEl && !iframeLoaded) {
    if (overlayMode !== "error") {
      overlayMode = "loading";
    }
    paintOverlay();
    armLoadTimeout(isLive);
    return;
  }
  if (overlayMode === "error" && errorBackoffBlocksRetry()) {
    paintOverlay();
    return;
  }
  if (overlayMode === "error") {
    overlayMode = "loading";
  } else if (overlayMode !== "loading") {
    overlayMode = "loading";
  }
  paintOverlay();
  scheduleInsert(isLive);
}

export function setPlayerLiveHint(live: PlayerLiveHint): void {
  const prev = liveKnown;
  liveKnown = live;
  if (!activeHost) {
    return;
  }
  // Debounced mount: no insertEmbed yet — only track hint / offline chrome.
  if (!insertEmbed) {
    if (live === false) {
      clearErrorRetryTimer();
      clearReinsertTimer();
      removeFrame();
      overlayMode = "offline";
      paintOverlay();
    } else if (live === true && overlayMode === "offline") {
      overlayMode = "loading";
      paintOverlay();
    }
    return;
  }
  if (live === prev) {
    // Same hint: kick waiting insert; after error backoff, allow one recovery attempt.
    if (live === false || frameEl) {
      return;
    }
    if (overlayMode === "error") {
      if (errorBackoffBlocksRetry()) {
        return;
      }
      overlayMode = "loading";
      paintOverlay();
    }
    const epoch = playerEpoch;
    scheduleInsert(() => epoch === playerEpoch);
    return;
  }
  const epoch = playerEpoch;
  const isLive = () => epoch === playerEpoch;
  if (live === true && overlayMode === "error" && !errorBackoffBlocksRetry()) {
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
    if (!openTwitchChannel()) {
      return;
    }
    handler(openTwitchChannel());
  });
}

function createPlayerFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = t("player.iframeTitle");
  // No bluetooth: Twitch may still log Permissions-Policy noise from its own iframe.
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

function beginMount(host: HTMLElement, channel: string, hint: PlayerLiveHint): void {
  ensureLocaleHook();
  const epoch = ++playerEpoch;
  activeHost = host;
  activeChannel = channel;
  pendingChannel = channel;
  iframeLoaded = false;
  // Preserve Helix hint applied while debounce waited (avoid null→insert→offline flap).
  liveKnown = hint;
  lastErrorAt = 0;
  if (hint === false) {
    overlayMode = "offline";
  } else {
    overlayMode = "loading";
  }
  frameEl = null;
  insertEmbed = null;
  ensurePlaceholder(host);
  paintOverlay();

  const isLive = () => epoch === playerEpoch;

  const insert = () => {
    if (!isLive() || frameEl) {
      return;
    }
    if (!canInsertEmbed()) {
      return;
    }
    if (errorBackoffBlocksRetry()) {
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
    // Claim the slot before DOM work so a re-entrant scheduleInsert cannot stack iframes.
    const frame = createPlayerFrame();
    frameEl = frame;
    frame.width = String(w);
    frame.height = String(h);
    // One live iframe only: destroy any stray node before append.
    host.querySelectorAll("iframe").forEach((node) => {
      if (node !== frame) {
        destroyFrame(node);
      }
    });
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
        lastErrorAt = 0;
        clearErrorRetryTimer();
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
    // Detach before append: hidden placeholder still flashes if recreated later.
    detachPlaceholder(host);
    // Canon: insert with src already set (compensation.md).
    frame.src = buildTwitchPlayerSrc(channel);
    host.appendChild(frame);
    lastInsertAt = Date.now();
    armLoadTimeout(isLive);
  };

  insertEmbed = insert;
  if (hint === false) {
    return;
  }
  // Start embed immediately when not known-offline; Helix only tears down on offline.
  scheduleInsert(isLive);
}

/**
 * Mount (or remount) the Twitch embed. Channel switches are debounced; the previous
 * iframe is destroyed immediately so Playing listeners and fp? requests cannot stack.
 */
export function mountPlayer(host: HTMLElement, channel: string): void {
  const ch = channel.trim().toLowerCase();
  if (!ch) {
    unmountPlayer(host);
    return;
  }
  if (activeHost === host && activeChannel === ch && mountDebounceTimer == null) {
    return;
  }
  if (activeHost === host && pendingChannel === ch && mountDebounceTimer != null) {
    return;
  }
  pendingChannel = ch;
  // Tear down the previous embed immediately — do not let old Twitch sessions keep polling.
  clearMountDebounce();
  clearErrorRetryTimer();
  clearReinsertTimer();
  slotWaitCleanup?.();
  slotWaitCleanup = null;
  clearLoadTimer();
  insertEmbed = null;
  removeFrame();
  playerEpoch += 1;
  activeHost = host;
  // Keep pending login for Open Twitch during debounce; activeChannel set in beginMount.
  activeChannel = ch;
  iframeLoaded = false;
  // Null until syncPlayerForLayout / Helix hint; do not reuse the previous channel's live flag.
  liveKnown = null;
  lastErrorAt = 0;
  lastInsertAt = 0;
  overlayMode = "loading";
  host.querySelectorAll("iframe").forEach((node) => {
    destroyFrame(node);
  });
  ensurePlaceholder(host);
  paintOverlay();

  mountDebounceTimer = setTimeout(() => {
    mountDebounceTimer = null;
    if (pendingChannel !== ch || activeHost !== host) {
      return;
    }
    beginMount(host, ch, liveKnown);
  }, CHANNEL_SWITCH_DEBOUNCE_MS);
}

export function unmountPlayer(host: HTMLElement): void {
  playerEpoch += 1;
  clearMountDebounce();
  clearErrorRetryTimer();
  clearReinsertTimer();
  pendingChannel = "";
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
    lastErrorAt = 0;
    lastInsertAt = 0;
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
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === "function") {
    io = new IntersectionObserver(
      () => {
        kick();
      },
      { threshold: 0 },
    );
  }
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
    io?.disconnect();
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
    if (frameEl) {
      done = true;
      cleanup();
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
    io?.disconnect();
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
        if (!isLive() || !canInsertEmbed() || frameEl) {
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
  io?.observe(host);
  document.addEventListener("visibilitychange", onVisibility);
  raf = requestAnimationFrame(() => {
    raf = 0;
    kick();
  });
}
