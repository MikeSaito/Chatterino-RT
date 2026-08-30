import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CHAT_OUTGOING_RAID_EVENT } from "../constants.ts";
import { t } from "../i18n/index.ts";

export const OUTGOING_RAID_DURATION_MS = 90_000;
const RAID_INTENT_TTL_MS = 120_000;

export type OutgoingRaidPayload = {
  channel: string;
  active: boolean;
  targetLogin?: string;
  targetDisplayName?: string;
  startedAtMs?: number;
  durationMs?: number;
};

export type OutgoingRaidIntent = {
  channel: string;
  login: string;
  displayName: string;
  createdAtMs: number;
};

export type OutgoingRaidBannerHandlers = {
  activeChannel: () => string;
  resolveAvatar: (login: string) => string | null | Promise<string | null>;
  onVisibilityChange?: () => void;
};

type ActiveRaid = {
  channel: string;
  targetLogin: string;
  targetDisplayName: string;
  startedAtMs: number;
  durationMs: number;
};

type BannerEls = {
  root: HTMLElement;
  avatar: HTMLImageElement;
  letter: HTMLElement;
  label: HTMLElement;
  timer: HTMLElement;
  progress: HTMLElement;
  close: HTMLButtonElement;
};

export function parseOutgoingRaidIntent(
  channel: string,
  raw: string,
  nowMs = Date.now(),
): OutgoingRaidIntent | null {
  const source = channel.trim().toLowerCase();
  if (!source) {
    return null;
  }
  const match = raw
    .trim()
    .match(/^[/.]raid\s+([A-Za-z0-9_]{1,25})(?:\s|$)/i);
  if (!match) {
    return null;
  }
  const displayName = match[1];
  return {
    channel: source,
    login: displayName.toLowerCase(),
    displayName,
    createdAtMs: nowMs,
  };
}

export function outgoingRaidPayloadFromEvent(
  event: unknown,
  fallback?: OutgoingRaidIntent | null,
  nowMs = Date.now(),
): ActiveRaid | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const raw = event as Record<string, unknown>;
  const channel = String(raw.channel ?? "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();
  if (!channel || raw.active !== true) {
    return null;
  }
  const loginRaw = String(raw.targetLogin ?? "").trim();
  const displayRaw = String(raw.targetDisplayName ?? loginRaw).trim();
  const freshFallback =
    fallback &&
    fallback.channel === channel &&
    nowMs - fallback.createdAtMs <= RAID_INTENT_TTL_MS
      ? fallback
      : null;
  const targetLogin = (loginRaw || freshFallback?.login || "").toLowerCase();
  const targetDisplayName =
    displayRaw || freshFallback?.displayName || targetLogin;
  const startedAtMs = Number(raw.startedAtMs);
  const durationMs = Number(raw.durationMs);
  const safeStarted =
    Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : nowMs;
  const safeDuration =
    Number.isFinite(durationMs) &&
    durationMs >= 1_000 &&
    durationMs <= 10 * 60_000
      ? durationMs
      : OUTGOING_RAID_DURATION_MS;
  if (!targetLogin || !/^[a-z0-9_]{1,25}$/.test(targetLogin)) {
    return null;
  }
  return {
    channel,
    targetLogin,
    targetDisplayName,
    startedAtMs: safeStarted,
    durationMs: safeDuration,
  };
}

export function formatRaidCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function bindOutgoingRaidBanner(
  els: BannerEls,
  handlers: OutgoingRaidBannerHandlers,
): {
  noteMessage: (channel: string, text: string) => void;
  syncActiveChannel: () => void;
  relabel: () => void;
  stop: () => void;
} {
  let active: ActiveRaid | null = null;
  let dismissedKey = "";
  let lastIntent: OutgoingRaidIntent | null = null;
  let frame = 0;
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
  let lastTimerText = "";

  const notify = (): void => {
    handlers.onVisibilityChange?.();
  };

  const setVisible = (visible: boolean): void => {
    els.root.hidden = !visible;
    notify();
  };

  const clearFrame = (): void => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  const scheduleTick = (): void => {
    clearFrame();
    frame = requestAnimationFrame(tick);
  };

  const avatarFallback = (displayName: string): void => {
    els.avatar.hidden = true;
    els.avatar.removeAttribute("src");
    els.letter.hidden = false;
    els.letter.textContent = displayName.slice(0, 1).toUpperCase();
  };

  const paintLabels = (): void => {
    if (!active) {
      return;
    }
    const marker = "\u0001";
    const templated = t("outgoingRaid.label", { login: marker });
    const ix = templated.indexOf(marker);
    els.label.replaceChildren();
    if (ix < 0) {
      els.label.textContent = t("outgoingRaid.label", {
        login: active.targetDisplayName,
      });
    } else {
      if (ix > 0) {
        els.label.append(document.createTextNode(templated.slice(0, ix)));
      }
      const strong = document.createElement("strong");
      strong.textContent = active.targetDisplayName;
      els.label.append(strong);
      if (ix + marker.length < templated.length) {
        els.label.append(
          document.createTextNode(templated.slice(ix + marker.length)),
        );
      }
    }
    els.close.title = t("outgoingRaid.dismiss");
    els.close.setAttribute("aria-label", t("outgoingRaid.dismiss"));
    els.root.setAttribute(
      "aria-label",
      `${t("outgoingRaid.label", { login: active.targetDisplayName })} ${els.timer.textContent ?? ""}`.trim(),
    );
  };

  const hide = (rememberDismiss = false): void => {
    if (rememberDismiss && active) {
      dismissedKey = `${active.channel}:${active.targetLogin}:${active.startedAtMs}`;
    }
    active = null;
    lastTimerText = "";
    clearFrame();
    setVisible(false);
  };

  const tick = (): void => {
    frame = 0;
    if (!active || stopped) {
      return;
    }
    if (handlers.activeChannel().trim().toLowerCase() !== active.channel) {
      setVisible(false);
      scheduleTick();
      return;
    }
    const remaining = active.startedAtMs + active.durationMs - Date.now();
    if (remaining <= 0) {
      hide();
      return;
    }
    const ratio = Math.max(0, Math.min(1, remaining / active.durationMs));
    const timerText = formatRaidCountdown(remaining);
    els.timer.textContent = timerText;
    els.progress.style.transform = `scaleX(${ratio})`;
    if (timerText !== lastTimerText) {
      lastTimerText = timerText;
      paintLabels();
    }
    setVisible(true);
    scheduleTick();
  };

  const show = (next: ActiveRaid): void => {
    const key = `${next.channel}:${next.targetLogin}:${next.startedAtMs}`;
    if (key === dismissedKey) {
      return;
    }
    active = next;
    lastTimerText = "";
    avatarFallback(next.targetDisplayName);
    paintLabels();
    scheduleTick();
    void Promise.resolve(handlers.resolveAvatar(next.targetLogin)).then(
      (url) => {
        if (!active || active.targetLogin !== next.targetLogin || !url) {
          return;
        }
        els.avatar.src = url;
        els.avatar.hidden = false;
        els.letter.hidden = true;
      },
    );
  };

  const onClose = (ev: Event): void => {
    ev.preventDefault();
    hide(true);
  };
  els.close.addEventListener("click", onClose);

  void listen<OutgoingRaidPayload>(CHAT_OUTGOING_RAID_EVENT, (ev) => {
    if (stopped) {
      return;
    }
    if (!ev.payload?.active) {
      const channel = String(ev.payload?.channel ?? "")
        .trim()
        .toLowerCase();
      if (!channel || active?.channel === channel) {
        hide();
      }
      return;
    }
    const next = outgoingRaidPayloadFromEvent(ev.payload, lastIntent);
    if (next) {
      show(next);
    }
  }).then((fn) => {
    if (stopped) {
      fn();
      return;
    }
    unlisten = fn;
  });

  return {
    noteMessage: (channel, text) => {
      lastIntent = parseOutgoingRaidIntent(channel, text);
    },
    syncActiveChannel: () => {
      if (!active) {
        setVisible(false);
        return;
      }
      if (handlers.activeChannel().trim().toLowerCase() === active.channel) {
        scheduleTick();
      } else {
        setVisible(false);
      }
    },
    relabel: () => {
      lastTimerText = "";
      paintLabels();
    },
    stop: () => {
      stopped = true;
      clearFrame();
      unlisten?.();
      unlisten = null;
      els.close.removeEventListener("click", onClose);
      active = null;
      setVisible(false);
    },
  };
}
