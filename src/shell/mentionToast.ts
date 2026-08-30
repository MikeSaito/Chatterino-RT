/** Cross-channel self-mention toast: slides in under the header, auto-hides. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CHAT_CROSS_MENTION_EVENT } from "../constants";
import { t } from "../i18n";
import { iconEl, setButtonIcon } from "./icons";
import { isStreamerModeActive, streamerModeState } from "./streamerMode";
import { playHighlightSound } from "./highlightSound";

export { CHAT_CROSS_MENTION_EVENT };
export const MENTION_TOAST_DURATION_MS = 8000;

export type CrossMentionPayload = {
  channel: string;
  msgId: string;
  login: string;
  displayName: string;
  color: string;
  text: string;
  selfLogin: string;
  highlightSound: boolean;
  highlightSoundPath?: string | null;
};

export type MentionToastHandlers = {
  /** Switch to channel and open reply; return true if handled. */
  onReply: (payload: CrossMentionPayload) => void | Promise<void>;
  /** Resolve cached/profile avatar URL for login. */
  resolveAvatar: (login: string) => string | null | Promise<string | null>;
};

type ActiveCard = {
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  leaving: boolean;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Highlight @self / bare self login in message body (HTML). */
export function formatMentionBody(text: string, selfLogin: string): string {
  const me = selfLogin.trim();
  if (!me) {
    return escapeHtml(text);
  }
  const escaped = escapeHtml(text);
  const re = new RegExp(
    `(@?${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
    "gi",
  );
  return escaped.replace(re, '<span class="mention-toast-hit">$1</span>');
}

export function bindMentionToast(
  host: HTMLElement,
  handlers: MentionToastHandlers,
): { stop: () => void } {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
  let active: ActiveCard | null = null;

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
      if (active === card) {
        active = null;
      }
    };
    card.el.addEventListener("transitionend", done);
    window.setTimeout(done, 280);
  };

  const dismissActive = (): void => {
    if (active) {
      dismiss(active);
    }
  };

  const show = async (payload: CrossMentionPayload): Promise<void> => {
    if (stopped) {
      return;
    }
    if (isStreamerModeActive() && streamerModeState().muteMentions) {
      return;
    }
    const channel = payload.channel.trim().replace(/^#/, "");
    if (!channel || !payload.msgId || !payload.login) {
      return;
    }
    dismissActive();

    const card = document.createElement("article");
    card.className = "mention-toast";
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-icon mention-toast-close";
    closeBtn.title = t("toast.close");
    closeBtn.setAttribute("aria-label", t("toast.close"));
    setButtonIcon(closeBtn, "close", { size: 14, label: t("toast.close") });

    const title = document.createElement("div");
    title.className = "mention-toast-title";
    title.textContent = t("mentionToast.title");

    const row = document.createElement("div");
    row.className = "mention-toast-row";

    const avatar = document.createElement("img");
    avatar.className = "mention-toast-avatar";
    avatar.alt = "";
    avatar.hidden = true;
    const letter = document.createElement("span");
    letter.className = "mention-toast-avatar-letter";
    letter.textContent = (payload.displayName || payload.login)
      .charAt(0)
      .toUpperCase();

    const meta = document.createElement("div");
    meta.className = "mention-toast-meta";

    const nickRow = document.createElement("div");
    nickRow.className = "mention-toast-nick-row";
    const nick = document.createElement("span");
    nick.className = "mention-toast-nick";
    nick.textContent = payload.displayName || payload.login;
    if (payload.color?.trim()) {
      nick.style.color = payload.color.trim();
    }
    const chPill = document.createElement("span");
    chPill.className = "mention-toast-channel";
    chPill.textContent = `#${channel}`;
    nickRow.append(nick, chPill);

    const body = document.createElement("p");
    body.className = "mention-toast-body";
    body.innerHTML = formatMentionBody(payload.text, payload.selfLogin);

    meta.append(nickRow, body);
    row.append(avatar, letter, meta);

    const actions = document.createElement("div");
    actions.className = "mention-toast-actions";
    const replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "mention-toast-reply";
    replyBtn.append(iconEl("reply", 14), document.createTextNode(t("mentionToast.reply")));
    actions.append(replyBtn);

    const progress = document.createElement("div");
    progress.className = "mention-toast-progress";
    progress.style.animationDuration = `${MENTION_TOAST_DURATION_MS}ms`;

    card.append(title, closeBtn, row, actions, progress);
    host.append(card);

    const item: ActiveCard = { el: card, timer: null, leaving: false };
    active = item;

    requestAnimationFrame(() => {
      card.classList.add("is-visible");
    });

    item.timer = setTimeout(() => {
      dismiss(item);
    }, MENTION_TOAST_DURATION_MS);

    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      dismiss(item);
    });

    const goReply = (ev: Event): void => {
      ev.preventDefault();
      ev.stopPropagation();
      dismiss(item);
      void handlers.onReply(payload);
    };
    replyBtn.addEventListener("click", goReply);
    card.addEventListener("click", goReply);

    if (payload.highlightSound) {
      void playHighlightSound(payload.highlightSoundPath ?? undefined, {
        ignoreFocus: true,
      });
    }

    void Promise.resolve(handlers.resolveAvatar(payload.login)).then((url) => {
      if (!url || item.leaving || stopped) {
        return;
      }
      avatar.src = url;
      avatar.hidden = false;
      letter.hidden = true;
    });
  };

  void listen<CrossMentionPayload>(CHAT_CROSS_MENTION_EVENT, (ev) => {
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
      dismissActive();
      unlisten?.();
      unlisten = null;
    },
  };
}
