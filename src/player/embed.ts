import { iconEl } from "../shell/icons";

let playerEpoch = 0;
let slotWaitCleanup: (() => void) | null = null;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let activeHost: HTMLElement | null = null;
let activeChannel = "";
let iframeLoaded = false;
let liveKnown: boolean | null = null;
let overlayMode: "loading" | "offline" | "error" | "ready" = "loading";
let frameEl: HTMLIFrameElement | null = null;
let openTwitchBound = false;
let pendingInsert: (() => void) | null = null;

const LOAD_TIMEOUT_MS = 12_000;

export type PlayerLiveHint = boolean | null;

function clearLoadTimer(): void {
  if (loadTimer != null) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
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
  label.textContent = "Загрузка…";

  const action = document.createElement("button");
  action.type = "button";
  action.id = "player-placeholder-action";
  action.className = "btn btn-primary";
  action.textContent = "Открыть на Twitch";
  action.hidden = true;

  ph.append(iconWrap, label, action);
  host.appendChild(ph);
  return ph;
}

function paintOverlay(): void {
  if (!activeHost) {
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

  // Twitch autoplay checks style visibility / occlusion: never cover a live iframe.
  if (frameEl?.isConnected) {
    ph.hidden = true;
    ph.setAttribute("aria-hidden", "true");
    return;
  }

  ph.hidden = false;

  if (overlayMode === "ready") {
    label.textContent = "";
    ph.hidden = true;
    ph.setAttribute("aria-hidden", "true");
    return;
  }
  if (overlayMode === "error") {
    label.textContent = "Не удалось загрузить плеер";
    action.hidden = false;
    ph.classList.add("is-error");
    return;
  }
  if (overlayMode === "offline") {
    label.textContent = "Канал оффлайн";
    return;
  }
  label.textContent = "Загрузка…";
}

function removeFrame(): void {
  if (frameEl) {
    frameEl.remove();
    frameEl = null;
  }
  iframeLoaded = false;
  clearLoadTimer();
}

function armLoadTimeout(isLive: () => boolean): void {
  clearLoadTimer();
  loadTimer = setTimeout(() => {
    loadTimer = null;
    if (!isLive() || iframeLoaded || overlayMode === "offline") {
      return;
    }
    overlayMode = "error";
    paintOverlay();
  }, LOAD_TIMEOUT_MS);
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
    overlayMode = "offline";
    removeFrame();
    slotWaitCleanup?.();
    slotWaitCleanup = null;
    pendingInsert = null;
    paintOverlay();
    return;
  }
  if (liveKnown === null) {
    overlayMode = "loading";
    paintOverlay();
    return;
  }
  // liveKnown === true
  if (iframeLoaded) {
    overlayMode = "ready";
    paintOverlay();
    return;
  }
  if (overlayMode !== "error") {
    overlayMode = "loading";
  }
  paintOverlay();
  if (pendingInsert) {
    const run = pendingInsert;
    whenSlotReady(activeHost!, isLive, run);
  }
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

export function mountPlayer(host: HTMLElement, channel: string): HTMLIFrameElement {
  unmountPlayer(host);
  const epoch = ++playerEpoch;
  activeHost = host;
  activeChannel = channel.trim().toLowerCase();
  iframeLoaded = false;
  liveKnown = null;
  overlayMode = "loading";
  frameEl = null;
  ensurePlaceholder(host);
  paintOverlay();

  const frame = document.createElement("iframe");
  frame.title = "Twitch player";
  frame.allow =
    "autoplay; encrypted-media; picture-in-picture; storage-access; accelerometer; gyroscope";
  frame.allowFullscreen = true;
  frame.setAttribute("allowfullscreen", "");
  frame.style.visibility = "visible";
  frame.style.opacity = "1";
  frame.style.display = "block";
  const parent = window.location.hostname || "localhost";
  const params = new URLSearchParams({
    channel,
    parent,
    muted: "true",
    autoplay: "true",
  });

  const isLive = () => epoch === playerEpoch;

  frame.addEventListener("load", () => {
    if (!isLive() || frameEl !== frame) {
      return;
    }
    iframeLoaded = true;
    clearLoadTimer();
    if (liveKnown === true) {
      overlayMode = "ready";
      paintOverlay();
    } else {
      syncOverlayAfterLive(isLive);
    }
  });

  const insert = () => {
    if (!isLive() || frame.isConnected || frame.getAttribute("src")) {
      return;
    }
    if (liveKnown !== true) {
      pendingInsert = insert;
      return;
    }
    const box = host.getBoundingClientRect();
    if (box.width < 400 || box.height < 300) {
      whenSlotReady(host, isLive, insert);
      return;
    }
    pendingInsert = null;
    frame.width = String(Math.floor(box.width));
    frame.height = String(Math.floor(box.height));
    frameEl = frame;
    // Hide overlay before iframe joins so autoplay sees an unobscured player.
    const ph = host.querySelector<HTMLElement>("#player-placeholder");
    if (ph) {
      ph.hidden = true;
      ph.setAttribute("aria-hidden", "true");
    }
    host.appendChild(frame);
    // Set src only after the frame is in-tree and unobscured (Twitch visibility checks).
    frame.src = `https://player.twitch.tv/?${params.toString()}`;
    armLoadTimeout(isLive);
  };

  pendingInsert = insert;
  if (liveKnown === true) {
    whenSlotReady(host, isLive, insert);
  }
  return frame;
}

export function unmountPlayer(host: HTMLElement): void {
  playerEpoch += 1;
  slotWaitCleanup?.();
  slotWaitCleanup = null;
  clearLoadTimer();
  pendingInsert = null;
  frameEl = null;
  if (activeHost === host) {
    activeHost = null;
    activeChannel = "";
    iframeLoaded = false;
    liveKnown = null;
    overlayMode = "loading";
  }
  host.replaceChildren();
}

function whenSlotReady(host: HTMLElement, isLive: () => boolean, run: () => void): void {
  slotWaitCleanup?.();
  let done = false;
  let raf = 0;
  const observer = new ResizeObserver(() => {
    kick();
  });
  const onVisibility = () => {
    kick();
  };

  const cleanup = () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
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
    if (liveKnown !== true) {
      return;
    }
    // Twitch embed отключает autoplay, если в момент инициализации документ скрыт.
    if (document.visibilityState !== "visible") {
      return;
    }
    const box = host.getBoundingClientRect();
    if (box.width < 400 || box.height < 300) {
      return;
    }
    done = true;
    cleanup();
    requestAnimationFrame(() => {
      if (isLive()) {
        run();
      }
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
