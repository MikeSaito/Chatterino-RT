/** Channel pinned message banner (Закреп): Helix pins via Rust, slide animation in JS. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onLocaleChange, t } from "../i18n/index.ts";
import { iconEl, setButtonIcon } from "./icons";

export const CHAT_PINNED_EVENT = "chat:pinned";
export const PINNED_AUTO_HIDE_MS = 30_000;

export type PinnedMessage = {
  messageId: string;
  messageText: string;
  pinnedByLogin: string;
  pinnedByName: string;
  senderLogin: string;
  senderName: string;
  startsAt?: string;
  endsAt?: string;
};

export type PinnedPayload = {
  channel: string;
  pin?: PinnedMessage | null;
};

export type BindPinnedBannerOpts = {
  host: HTMLElement;
  chatColumn: HTMLElement;
  activeChannel: () => string;
  alwaysShow: () => boolean;
};

type BannerState = {
  channel: string;
  pin: PinnedMessage;
  el: HTMLElement;
  hideTimer: ReturnType<typeof setTimeout> | null;
  endsTimer: ReturnType<typeof setTimeout> | null;
  leaving: boolean;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Linkify http(s), www., and bare host/path like t.me/x. */
export function formatPinnedBody(text: string): string {
  const escaped = escapeHtml(text);
  const re =
    /(https?:\/\/[^\s<]+)|(www\.[^\s<]+)|((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<]*)?)/gi;
  return escaped.replace(re, (raw) => {
    const display = stripUrlTail(raw);
    const href = normalizePinnedUrl(display);
    if (!href) {
      return raw;
    }
    return `<a class="pinned-banner-link" href="${escapeHtml(href)}" rel="noopener noreferrer">${display}</a>`;
  });
}

function stripUrlTail(raw: string): string {
  return raw.replace(/[),.;:!?\]]+$/g, "");
}

function normalizePinnedUrl(display: string): string | null {
  const trimmed = display.trim();
  if (!trimmed) {
    return null;
  }
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return null;
    }
    if (u.username || u.password) {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeChannel(raw: string): string {
  return raw.trim().toLowerCase();
}

function endsAtMs(endsAt: string | undefined): number | null {
  if (!endsAt) {
    return null;
  }
  const ms = Date.parse(endsAt);
  return Number.isFinite(ms) ? ms : null;
}

export function bindPinnedBanner(opts: BindPinnedBannerOpts): {
  sync: () => void;
  setAlwaysShow: (value: boolean) => void;
  stop: () => void;
} {
  const byChannel = new Map<string, PinnedMessage>();
  const dismissedByChannel = new Map<string, string>();
  let alwaysShow = opts.alwaysShow();
  let active: BannerState | null = null;
  let stopped = false;
  let unlistenEvent: UnlistenFn | null = null;
  const unlistenLocale = onLocaleChange(() => paint());
  const resize = new ResizeObserver(() => syncOffset());
  resize.observe(opts.host);

  void listen<PinnedPayload>(CHAT_PINNED_EVENT, (ev) => {
    if (stopped) {
      return;
    }
    const channel = normalizeChannel(ev.payload.channel);
    if (!channel) {
      return;
    }
    const pin = ev.payload.pin ?? null;
    if (!pin || !pin.messageId || !pin.messageText.trim()) {
      byChannel.delete(channel);
      dismissedByChannel.delete(channel);
    } else {
      const prev = byChannel.get(channel);
      byChannel.set(channel, pin);
      if (prev && prev.messageId !== pin.messageId) {
        dismissedByChannel.delete(channel);
      }
    }
    paint();
  }).then((dispose) => {
    if (stopped) {
      dispose();
      return;
    }
    unlistenEvent = dispose;
  });

  opts.host.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) {
      return;
    }
    const link = target.closest<HTMLAnchorElement>("a.pinned-banner-link");
    if (link?.href) {
      ev.preventDefault();
      void invoke("open_chat_link", { url: link.href }).catch(() => undefined);
    }
  });

  function clearTimers(state: BannerState): void {
    if (state.hideTimer !== null) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    if (state.endsTimer !== null) {
      clearTimeout(state.endsTimer);
      state.endsTimer = null;
    }
  }

  function syncOffset(): void {
    const height = opts.host.hidden
      ? 0
      : Math.ceil(opts.host.getBoundingClientRect().height);
    opts.chatColumn.style.setProperty(
      "--pinned-banner-offset",
      height ? `${height}px` : "0px",
    );
  }

  function collapse(state: BannerState, remove: boolean): void {
    if (state.leaving) {
      return;
    }
    state.leaving = true;
    clearTimers(state);
    state.el.classList.remove("is-visible");
    state.el.classList.add("is-leaving");
    const done = (): void => {
      state.el.removeEventListener("transitionend", done);
      if (remove) {
        state.el.remove();
      }
      if (active === state) {
        active = null;
        if (remove) {
          opts.host.replaceChildren();
        }
        opts.host.hidden = true;
        opts.host.classList.add("is-collapsed");
      }
      syncOffset();
    };
    state.el.addEventListener("transitionend", done);
    window.setTimeout(done, 320);
    window.requestAnimationFrame(() => syncOffset());
  }

  function scheduleHide(state: BannerState): void {
    clearTimers(state);
    const endMs = endsAtMs(state.pin.endsAt);
    if (endMs !== null) {
      const left = endMs - Date.now();
      if (left <= 0) {
        byChannel.delete(state.channel);
        collapse(state, true);
        return;
      }
      state.endsTimer = setTimeout(() => {
        byChannel.delete(state.channel);
        if (active === state) {
          collapse(state, true);
        }
      }, left);
    }
    if (!alwaysShow) {
      state.hideTimer = setTimeout(() => {
        if (active === state && !state.leaving) {
          dismissedByChannel.set(state.channel, state.pin.messageId);
          collapse(state, false);
        }
      }, PINNED_AUTO_HIDE_MS);
    }
  }

  function renderBanner(pin: PinnedMessage): HTMLElement {
    const root = document.createElement("section");
    root.className = "pinned-banner";
    root.setAttribute("role", "status");
    root.dataset.messageId = pin.messageId;

    const body = document.createElement("div");
    body.className = "pinned-banner-body";

    const row = document.createElement("div");
    row.className = "pinned-banner-row";
    const pinIcon = iconEl("pin", 14);
    pinIcon.classList.add("pinned-banner-pin");
    const text = document.createElement("p");
    text.className = "pinned-banner-text";
    text.innerHTML = formatPinnedBody(pin.messageText);
    row.append(pinIcon, text);

    const meta = document.createElement("div");
    meta.className = "pinned-banner-meta";
    const label = document.createElement("span");
    label.className = "pinned-banner-label";
    label.textContent = t("pinned.label");
    const badge = document.createElement("span");
    badge.className = "pinned-banner-mod-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.title = "Moderator";
    const who = document.createElement("span");
    who.className = "pinned-banner-who";
    who.textContent = pin.pinnedByLogin || pin.pinnedByName;
    meta.append(label, badge, who);

    body.append(row, meta);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-icon pinned-banner-close";
    closeBtn.title = t("pinned.dismiss");
    closeBtn.setAttribute("aria-label", t("pinned.dismiss"));
    setButtonIcon(closeBtn, "close", { size: 14 });
    closeBtn.addEventListener("click", () => {
      if (!active || active.el !== root) {
        return;
      }
      dismissedByChannel.set(active.channel, pin.messageId);
      collapse(active, false);
    });

    root.append(body, closeBtn);
    return root;
  }

  function paint(): void {
    const channel = normalizeChannel(opts.activeChannel());
    const pin = channel ? byChannel.get(channel) : undefined;
    if (!channel || !pin) {
      if (active) {
        collapse(active, true);
      } else {
        opts.host.replaceChildren();
        opts.host.hidden = true;
        opts.host.classList.add("is-collapsed");
        syncOffset();
      }
      return;
    }
    if (endsAtMs(pin.endsAt) !== null && (endsAtMs(pin.endsAt) as number) <= Date.now()) {
      byChannel.delete(channel);
      if (active) {
        collapse(active, true);
      }
      return;
    }

    if (dismissedByChannel.get(channel) === pin.messageId && !alwaysShow) {
      if (active && active.channel === channel && !active.leaving) {
        collapse(active, false);
      } else {
        opts.host.hidden = true;
        opts.host.classList.add("is-collapsed");
        syncOffset();
      }
      return;
    }

    if (alwaysShow) {
      dismissedByChannel.delete(channel);
    }

    const same =
      active &&
      !active.leaving &&
      active.channel === channel &&
      active.pin.messageId === pin.messageId &&
      active.pin.messageText === pin.messageText &&
      active.pin.pinnedByLogin === pin.pinnedByLogin;

    if (same && active) {
      scheduleHide(active);
      return;
    }

    if (active) {
      clearTimers(active);
      active = null;
    }

    opts.host.replaceChildren();
    opts.host.hidden = false;
    opts.host.classList.remove("is-collapsed");
    const el = renderBanner(pin);
    opts.host.append(el);
    const state: BannerState = {
      channel,
      pin,
      el,
      hideTimer: null,
      endsTimer: null,
      leaving: false,
    };
    active = state;
    requestAnimationFrame(() => {
      if (active === state) {
        el.classList.add("is-visible");
        syncOffset();
      }
    });
    scheduleHide(state);
    syncOffset();
  }

  paint();

  return {
    sync: paint,
    setAlwaysShow(value: boolean) {
      alwaysShow = value;
      if (alwaysShow) {
        dismissedByChannel.clear();
      }
      if (active && !active.leaving) {
        if (alwaysShow) {
          if (active.hideTimer !== null) {
            clearTimeout(active.hideTimer);
            active.hideTimer = null;
          }
        } else {
          scheduleHide(active);
        }
      } else {
        paint();
      }
    },
    stop() {
      stopped = true;
      unlistenEvent?.();
      unlistenLocale();
      resize.disconnect();
      if (active) {
        clearTimers(active);
      }
      active = null;
      byChannel.clear();
      dismissedByChannel.clear();
      opts.host.replaceChildren();
      opts.host.hidden = true;
      opts.host.classList.add("is-collapsed");
      syncOffset();
    },
  };
}
