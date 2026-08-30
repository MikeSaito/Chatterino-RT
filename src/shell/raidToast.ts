import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../i18n/index.ts";
import { isStreamerModeActive, streamerModeState } from "./streamerMode.ts";

export const CHAT_RAID_EVENT = "chat:raid";
export const RAID_TOAST_DURATION_MS = 10_000;
export const RAID_TOAST_MAX_VISIBLE = 4;

export type RaidToastPayload = {
  channel: string;
  msgId: string;
  login: string;
  displayName: string;
  viewerCount: number;
};

export type RaidToastHandlers = {
  onFocusChannel: (channel: string) => void | Promise<void>;
  resolveAvatar: (login: string) => string | null | Promise<string | null>;
};

type ActiveCard = {
  id: string;
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  leaving: boolean;
};

export function raidToastPayloadFromEvent(
  event: unknown,
): RaidToastPayload | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const raw = event as Record<string, unknown>;
  const channel = String(raw.channel ?? "").trim().replace(/^#/, "");
  const msgId = String(raw.msgId ?? "").trim();
  const login = String(raw.login ?? "").trim().toLowerCase();
  const displayName = String(raw.displayName ?? raw.login ?? "").trim();
  const viewerCount = Number(raw.viewerCount);
  if (
    !channel ||
    !msgId ||
    !login ||
    !displayName ||
    !Number.isFinite(viewerCount) ||
    viewerCount < 1
  ) {
    return null;
  }
  return {
    channel,
    msgId,
    login,
    displayName,
    viewerCount: Math.floor(viewerCount),
  };
}

export function bindRaidToast(
  host: HTMLElement,
  handlers: RaidToastHandlers,
): { stop: () => void } {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
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
    while (active.filter((c) => !c.leaving).length > RAID_TOAST_MAX_VISIBLE) {
      const oldest = active.find((c) => !c.leaving);
      if (!oldest) {
        return;
      }
      dismiss(oldest);
    }
  };

  const show = async (raw: unknown): Promise<void> => {
    if (stopped) {
      return;
    }
    const payload = raidToastPayloadFromEvent(raw);
    if (!payload) {
      return;
    }
    dismissDuplicate(payload.msgId);

    const hideCount =
      isStreamerModeActive() && streamerModeState().hideViewerCountAndDuration;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "raid-toast";
    card.setAttribute(
      "aria-label",
      hideCount
        ? `${t("raidToast.raid")} ${payload.displayName} #${payload.channel}`
        : `${t("raidToast.raid")} ${payload.displayName} +${payload.viewerCount} #${payload.channel}`,
    );

    const avatarWrap = document.createElement("span");
    avatarWrap.className = "raid-toast-avatar-wrap";
    const avatar = document.createElement("img");
    avatar.className = "raid-toast-avatar";
    avatar.alt = "";
    avatar.hidden = true;
    const letter = document.createElement("span");
    letter.className = "raid-toast-avatar-letter";
    letter.textContent = payload.displayName.charAt(0).toUpperCase();
    avatarWrap.append(avatar, letter);

    const meta = document.createElement("span");
    meta.className = "raid-toast-meta";
    const label = document.createElement("span");
    label.className = "raid-toast-label";
    label.textContent = t("raidToast.raid");
    const login = document.createElement("span");
    login.className = "raid-toast-login";
    login.textContent = payload.displayName;
    meta.append(label, login);

    card.append(avatarWrap, meta);

    if (!hideCount) {
      const count = document.createElement("span");
      count.className = "raid-toast-count";
      const plus = document.createElement("span");
      plus.className = "raid-toast-plus";
      plus.textContent = `+${payload.viewerCount.toLocaleString()}`;
      const viewers = document.createElement("span");
      viewers.className = "raid-toast-viewers";
      viewers.textContent = t("raidToast.viewers");
      count.append(plus, viewers);
      card.append(count);
    }

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
    }, RAID_TOAST_DURATION_MS);

    card.addEventListener("click", (ev) => {
      ev.preventDefault();
      dismiss(item);
      void handlers.onFocusChannel(payload.channel);
    });

    void Promise.resolve(handlers.resolveAvatar(payload.login)).then((url) => {
      if (!url || item.leaving) {
        return;
      }
      avatar.src = url;
      avatar.hidden = false;
      letter.hidden = true;
    });
  };

  void listen<RaidToastPayload>(CHAT_RAID_EVENT, (ev) => {
    void show(ev.payload);
  }).then((fn) => {
    if (stopped) {
      fn();
      return;
    }
    unlisten = fn;
  });

  return {
    stop: () => {
      stopped = true;
      for (const card of [...active]) {
        dismiss(card);
      }
      unlisten?.();
      unlisten = null;
    },
  };
}
