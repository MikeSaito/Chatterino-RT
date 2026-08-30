/**
 * DOM accessibility layer for Pixi chat.
 * Canvas stays GPU-only (aria-hidden); sibling live/status regions + focusable
 * host expose scroll keys and throttled announcements without touching the ring layout path.
 */

import type { MessageRing } from "./ring";
import type { ScrollSnapshot } from "./scroll";
import { onLocaleChange, t } from "../i18n/index.ts";

export const A11Y_READBACK_LIMIT = 6;
export const A11Y_PENDING_THROTTLE_MS = 2500;

export type A11yPlainLine = {
  nick: string;
  text: string;
  system: boolean;
};

export function formatA11yLine(line: A11yPlainLine): string {
  const text = line.text.trim();
  if (!text) {
    return "";
  }
  if (line.system || !line.nick.trim()) {
    return text;
  }
  return `${line.nick.trim()}: ${text}`;
}

export function formatA11yReadback(
  lines: A11yPlainLine[],
  emptyLabel: string,
): string {
  const parts: string[] = [];
  for (const line of lines) {
    const s = formatA11yLine(line);
    if (s) {
      parts.push(s);
    }
  }
  if (parts.length === 0) {
    return emptyLabel;
  }
  return parts.join(". ");
}

/** Announce when pending below grows while scrolled up. */
export function shouldAnnouncePending(prev: number, next: number): boolean {
  return next > prev && next > 0;
}

export function pendingAnnounceLabel(count: number): string {
  if (count <= 0) {
    return "";
  }
  if (count > 99) {
    return t("chat.a11y.pendingMax");
  }
  return t("chat.a11y.pending", { count });
}

export type ChatEmptyKind = "hidden" | "noChannel" | "noMessages";

export function bindChatA11y(opts: {
  ring: MessageRing;
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  live: HTMLElement;
  status?: HTMLElement | null;
  empty?: HTMLElement | null;
  track: HTMLElement;
}): {
  onScroll: (state: ScrollSnapshot) => void;
  refreshLocale: () => void;
  setEmptyKind: (kind: ChatEmptyKind) => void;
  dispose: () => void;
} {
  const { ring, host, canvas, live, track } = opts;
  const status = opts.status ?? null;
  const empty = opts.empty ?? null;
  let disposed = false;
  let liveRaf = 0;
  let liveClearTimer = 0;
  let lastPending = ring.pendingBelowCount();
  let lastAnnounceAt = 0;
  let emptyKind: ChatEmptyKind = "hidden";

  canvas.setAttribute("aria-hidden", "true");
  canvas.setAttribute("role", "presentation");

  // region (not log): host wraps toast/empty chrome; live text lives as a sibling.
  host.setAttribute("role", "region");
  host.setAttribute("tabindex", "0");
  if (!host.id) {
    host.id = "chat-canvas-host";
  }

  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  live.classList.add("sr-only");

  if (status) {
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    status.classList.add("sr-only");
  }

  track.setAttribute("aria-controls", host.id);

  const applyEmptyStatus = (): void => {
    if (!status) {
      return;
    }
    if (emptyKind === "noChannel") {
      status.textContent = t("chat.empty.noChannel.title");
    } else if (emptyKind === "noMessages") {
      status.textContent = t("chat.empty.noMessages.title");
    } else {
      status.textContent = "";
    }
  };

  const applyLabels = (): void => {
    host.setAttribute("aria-label", t("chat.a11y.log"));
    host.setAttribute("aria-description", t("chat.a11y.logHint"));
    track.setAttribute("aria-label", t("chat.a11y.scrollbar"));
    applyEmptyStatus();
    if (empty) {
      empty.setAttribute("aria-hidden", emptyKind === "hidden" ? "true" : "false");
    }
  };

  const setEmptyKind = (kind: ChatEmptyKind): void => {
    emptyKind = kind;
    applyEmptyStatus();
    if (empty) {
      empty.setAttribute("aria-hidden", kind === "hidden" ? "true" : "false");
    }
  };

  const clearLiveTimers = (): void => {
    if (liveRaf !== 0) {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
    }
    if (liveClearTimer !== 0) {
      window.clearTimeout(liveClearTimer);
      liveClearTimer = 0;
    }
  };

  const setLiveText = (text: string): void => {
    if (!text || disposed) {
      return;
    }
    clearLiveTimers();
    live.textContent = "";
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      if (disposed) {
        return;
      }
      live.textContent = text;
      liveClearTimer = window.setTimeout(() => {
        liveClearTimer = 0;
        if (!disposed) {
          live.textContent = "";
        }
      }, 4000);
    });
  };

  const announcePending = (count: number): void => {
    const label = pendingAnnounceLabel(count);
    if (label) {
      setLiveText(label);
    }
  };

  const readback = (): void => {
    const lines = ring.a11yPlainLines(A11Y_READBACK_LIMIT);
    setLiveText(formatA11yReadback(lines, t("chat.a11y.readbackEmpty")));
  };

  const onScroll = (state: ScrollSnapshot): void => {
    if (disposed) {
      return;
    }
    const pending = ring.pendingBelowCount();
    if (shouldAnnouncePending(lastPending, pending) && !state.atBottom) {
      const now = performance.now();
      if (now - lastAnnounceAt >= A11Y_PENDING_THROTTLE_MS) {
        lastAnnounceAt = now;
        announcePending(pending);
      }
    }
    lastPending = pending;
  };

  const onHostKey = (ev: KeyboardEvent): void => {
    if (disposed || ev.target !== host) {
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      readback();
      return;
    }
    const state = ring.scrollSnapshot();
    const anim = ring.isSmoothScrolling();
    if (ev.key === "Home") {
      ev.preventDefault();
      ring.setDesired(0, anim);
      return;
    }
    if (ev.key === "End") {
      ev.preventDefault();
      ring.goToBottom();
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      ring.setDesired(state.desired - 1, anim);
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      ring.setDesired(state.desired + 1, anim);
      return;
    }
    if (ev.key === "PageUp") {
      ev.preventDefault();
      ring.setDesired(state.desired - state.viewRows, anim);
      return;
    }
    if (ev.key === "PageDown") {
      ev.preventDefault();
      ring.setDesired(state.desired + state.viewRows, anim);
    }
  };

  /** Mouse must not steal focus from composer; Tab still focuses the region. */
  const onHostPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) {
      return;
    }
    const target = ev.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest("button, a, input, textarea, select")) {
      return;
    }
    const focusable = target.closest("[tabindex]");
    if (focusable && focusable !== host) {
      return;
    }
    ev.preventDefault();
  };

  applyLabels();
  host.addEventListener("keydown", onHostKey);
  host.addEventListener("pointerdown", onHostPointerDown);
  const unlistenLocale = onLocaleChange(() => {
    if (!disposed) {
      applyLabels();
    }
  });

  return {
    onScroll,
    refreshLocale: applyLabels,
    setEmptyKind,
    dispose: () => {
      disposed = true;
      host.removeEventListener("keydown", onHostKey);
      host.removeEventListener("pointerdown", onHostPointerDown);
      unlistenLocale();
      clearLiveTimers();
      live.textContent = "";
      if (status) {
        status.textContent = "";
      }
    },
  };
}
