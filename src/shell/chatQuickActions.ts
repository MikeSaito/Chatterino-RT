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

  const hide = (): void => {
    if (pinned) {
      return;
    }
    hover = null;
    bar.hidden = true;
    bar.classList.remove("is-visible");
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
    bar.hidden = false;
    bar.style.top = `${Math.max(4, anchor.top - hostRect.top)}px`;
    bar.style.right = "28px";
    requestAnimationFrame(() => {
      if (hover?.msgId === anchor.msgId) {
        bar.classList.add("is-visible");
      }
    });
  };

  const onHostMove = (ev: PointerEvent): void => {
    paint(ev.clientX, ev.clientY);
  };

  const onHostLeave = (ev: PointerEvent): void => {
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
