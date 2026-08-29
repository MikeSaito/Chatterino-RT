import type { MessageRing, SlotContext } from "../chat/ring";
import { setButtonIcon } from "./icons";

export type ChatQuickActions = {
  hide: () => void;
  dispose: () => void;
  syncOnScroll: (pointerY: number) => void;
  isHoveringBar: () => boolean;
};

/** Hover toolbar: reply / copy / more over chat rows. */
export function bindChatQuickActions(opts: {
  host: HTMLElement;
  ring: MessageRing;
  bar: HTMLElement;
  replyBtn: HTMLButtonElement;
  copyBtn: HTMLButtonElement;
  moreBtn: HTMLButtonElement;
  onReply: (msgId: string, login: string, text: string) => void;
  onCopy: (text: string) => void;
  onMore: (ctx: SlotContext) => void;
}): ChatQuickActions {
  const { host, ring, bar, replyBtn, copyBtn, moreBtn } = opts;
  let hover: {
    msgId: string;
    login: string;
    text: string;
    canReply: boolean;
  } | null = null;
  let lastY = 0;
  let lastX = 0;
  let pinned = false;
  let overBar = false;

  setButtonIcon(replyBtn, "reply", { size: 14, label: "Ответить" });
  setButtonIcon(copyBtn, "copy", { size: 14, label: "Копировать" });
  setButtonIcon(moreBtn, "more", { size: 14, label: "Ещё" });

  let hideTimer = 0;

  const hide = (): void => {
    if (hoverRaf !== 0) {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    }
    if (pinned) {
      return;
    }
    hover = null;
    bar.classList.remove("is-visible");
    window.clearTimeout(hideTimer);
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      bar.hidden = true;
      return;
    }
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      if (!bar.classList.contains("is-visible")) {
        bar.hidden = true;
      }
    }, 100);
  };

  const paint = (clientX: number, clientY: number): void => {
    lastX = clientX;
    lastY = clientY;
    if (pinned) {
      return;
    }
    const anchor = ring.messageAnchorAt(clientX, clientY);
    if (!anchor) {
      hide();
      return;
    }
    hover = {
      msgId: anchor.msgId,
      login: anchor.login,
      text: anchor.text,
      canReply: anchor.canReply,
    };
    replyBtn.hidden = !anchor.canReply;
    const hostRect = host.getBoundingClientRect();
    window.clearTimeout(hideTimer);
    hideTimer = 0;
    bar.hidden = false;
    bar.style.top = `${Math.max(4, anchor.top - hostRect.top)}px`;
    bar.style.right = "28px";
    bar.classList.add("is-visible");
  };

  let hoverRaf = 0;
  let pendingX = 0;
  let pendingY = 0;

  const onHostMove = (ev: PointerEvent): void => {
    pendingX = ev.clientX;
    pendingY = ev.clientY;
    if (hoverRaf !== 0) {
      return;
    }
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      paint(pendingX, pendingY);
    });
  };

  const onHostLeave = (ev: PointerEvent): void => {
    if (hoverRaf !== 0) {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    }
    const related = ev.relatedTarget;
    if (related instanceof Node && bar.contains(related)) {
      return;
    }
    hide();
    if (!overBar) {
      ring.clearHover();
    }
  };

  const onBarEnter = (): void => {
    overBar = true;
  };

  const onBarLeave = (ev: PointerEvent): void => {
    overBar = false;
    const related = ev.relatedTarget;
    if (related instanceof Node && host.contains(related)) {
      return;
    }
    hide();
    ring.clearHover();
  };

  const onReplyClick = (ev: MouseEvent): void => {
    ev.stopPropagation();
    if (!hover?.canReply) {
      return;
    }
    opts.onReply(hover.msgId, hover.login, hover.text);
    hide();
  };

  const onCopyClick = (ev: MouseEvent): void => {
    ev.stopPropagation();
    if (!hover) {
      return;
    }
    opts.onCopy(hover.text);
    hide();
  };

  const onMoreClick = (ev: MouseEvent): void => {
    ev.stopPropagation();
    if (!hover) {
      return;
    }
    const ctx = ring.contextForMsgId(hover.msgId, lastX, lastY);
    if (!ctx) {
      return;
    }
    pinned = true;
    opts.onMore(ctx);
    pinned = false;
    hide();
  };

  host.addEventListener("pointermove", onHostMove);
  host.addEventListener("pointerleave", onHostLeave);
  bar.addEventListener("pointerenter", onBarEnter);
  bar.addEventListener("pointerleave", onBarLeave);
  replyBtn.addEventListener("click", onReplyClick);
  copyBtn.addEventListener("click", onCopyClick);
  moreBtn.addEventListener("click", onMoreClick);

  return {
    hide: () => {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
      pinned = false;
      overBar = false;
      hover = null;
      bar.hidden = true;
      bar.classList.remove("is-visible");
    },
    isHoveringBar: () => overBar,
    syncOnScroll: (pointerY: number) => {
      if (bar.hidden || !hover) {
        return;
      }
      paint(lastX, pointerY);
    },
    dispose: () => {
      if (hoverRaf !== 0) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
      }
      host.removeEventListener("pointermove", onHostMove);
      host.removeEventListener("pointerleave", onHostLeave);
      bar.removeEventListener("pointerenter", onBarEnter);
      bar.removeEventListener("pointerleave", onBarLeave);
      replyBtn.removeEventListener("click", onReplyClick);
      copyBtn.removeEventListener("click", onCopyClick);
      moreBtn.removeEventListener("click", onMoreClick);
    },
  };
}
