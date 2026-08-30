/** Mass gift sub toast (USERNOTICE submysterygift): top-right green card. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../i18n/index.ts";
import { iconEl } from "./icons.ts";

export const CHAT_GIFT_TOAST_EVENT = "chat:gift_toast";
export const GIFT_TOAST_DURATION_MS = 10_000;
export const GIFT_TOAST_MAX_VISIBLE = 4;

export type GiftToastPayload = {
  channel: string;
  msgId: string;
  login: string;
  displayName: string;
  count: number;
  anon: boolean;
};

export type GiftToastHandlers = {
  onFocusChannel: (channel: string) => void | Promise<void>;
};

type ActiveCard = {
  id: string;
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  leaving: boolean;
};

export function giftToastPayloadFromEvent(
  event: unknown,
): GiftToastPayload | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const raw = event as Record<string, unknown>;
  const channel = String(raw.channel ?? "")
    .trim()
    .replace(/^#/, "");
  const msgId = String(raw.msgId ?? "").trim();
  const login = String(raw.login ?? "")
    .trim()
    .toLowerCase();
  const displayName = String(raw.displayName ?? raw.login ?? "").trim();
  const count = Number(raw.count);
  const anon = raw.anon === true;
  if (
    !channel ||
    !msgId ||
    (!anon && !login) ||
    !displayName ||
    !Number.isFinite(count) ||
    count < 1
  ) {
    return null;
  }
  return {
    channel,
    msgId,
    login: anon ? "ananonymousgifter" : login,
    displayName: anon ? t("chat.usernotice.anonymousGifter") : displayName,
    count: Math.floor(count),
    anon,
  };
}

export function bindGiftToast(
  host: HTMLElement,
  handlers: GiftToastHandlers,
): { stop: () => void } {
  let unlisten: UnlistenFn | null = null;
  const active: ActiveCard[] = [];

  const clearTimer = (card: ActiveCard): void => {
    if (card.timer !== null) {
      clearTimeout(card.timer);
      card.timer = null;
    }
  };

  const dismiss = (card: ActiveCard): void => {
    if (card.leaving) {
      return;
    }
    card.leaving = true;
    clearTimer(card);
    card.el.classList.remove("is-visible");
    card.el.classList.add("is-leaving");
    const done = (): void => {
      card.el.removeEventListener("transitionend", done);
      card.el.remove();
      const ix = active.indexOf(card);
      if (ix >= 0) {
        active.splice(ix, 1);
      }
    };
    card.el.addEventListener("transitionend", done);
    window.setTimeout(done, 320);
  };

  const dismissDuplicate = (id: string): void => {
    for (const card of [...active]) {
      if (card.id === id) {
        dismiss(card);
      }
    }
  };

  const trimVisible = (): void => {
    while (active.length > GIFT_TOAST_MAX_VISIBLE) {
      const oldest = active[0];
      if (!oldest) {
        return;
      }
      dismiss(oldest);
    }
  };

  const show = (raw: unknown): void => {
    const payload = giftToastPayloadFromEvent(raw);
    if (!payload) {
      return;
    }
    dismissDuplicate(payload.msgId);

    const card = document.createElement("button");
    card.type = "button";
    card.className = "gift-toast";
    card.setAttribute(
      "aria-label",
      `${t("giftToast.label")} ${payload.displayName} +${payload.count}`,
    );

    const iconWrap = document.createElement("span");
    iconWrap.className = "gift-toast-icon";
    iconWrap.append(iconEl("gift", 22));

    const meta = document.createElement("span");
    meta.className = "gift-toast-meta";
    const label = document.createElement("span");
    label.className = "gift-toast-label";
    label.textContent = t("giftToast.label");
    const login = document.createElement("span");
    login.className = "gift-toast-login";
    login.textContent = payload.displayName;
    meta.append(label, login);

    const count = document.createElement("span");
    count.className = "gift-toast-count";
    const plus = document.createElement("span");
    plus.className = "gift-toast-plus";
    plus.textContent = `+${payload.count.toLocaleString()}`;
    const subs = document.createElement("span");
    subs.className = "gift-toast-subs";
    subs.textContent = t("giftToast.subs");
    count.append(plus, subs);

    card.append(iconWrap, meta, count);
    host.append(card);

    const item: ActiveCard = {
      id: payload.msgId,
      el: card,
      timer: null,
      leaving: false,
    };
    active.push(item);
    trimVisible();

    requestAnimationFrame(() => {
      card.classList.add("is-visible");
    });

    item.timer = setTimeout(() => {
      dismiss(item);
    }, GIFT_TOAST_DURATION_MS);

    card.addEventListener("click", (ev) => {
      ev.preventDefault();
      dismiss(item);
      void handlers.onFocusChannel(payload.channel);
    });
  };

  void listen<GiftToastPayload>(CHAT_GIFT_TOAST_EVENT, (ev) => {
    show(ev.payload);
  }).then((fn) => {
    unlisten = fn;
  });

  return {
    stop: () => {
      for (const card of [...active]) {
        dismiss(card);
      }
      unlisten?.();
      unlisten = null;
    },
  };
}
