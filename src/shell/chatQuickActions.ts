import type { MessageRing, SlotContext } from "../chat/ring";
import { setButtonIcon } from "./icons";
import { t } from "../i18n";

export type ChatQuickActions = {
  hide: () => void;
  dispose: () => void;
  syncOnScroll: () => void;
  isHoveringBar: () => boolean;
};

/** DOM buttons occupy the footer reserved in the Pixi message stack. */
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
  let overBar = false;
  let opening = false;
  let height = 0;
  let hoverRaf = 0;
  let pointerX = 0;
  let pointerY = 0;

  setButtonIcon(replyBtn, "reply", { size: 14, label: t("chat.qa.reply") });
  setButtonIcon(copyBtn, "copy", { size: 14, label: t("chat.qa.copy") });
  setButtonIcon(moreBtn, "more", { size: 14, label: t("chat.qa.more") });

  const cancelPaint = (): void => {
    if (hoverRaf !== 0) {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    }
  };

  const hide = (): void => {
    cancelPaint();
    const hadMessage = hover !== null;
    hover = null;
    overBar = false;
    bar.hidden = true;
    if (hadMessage) {
      ring.setMessageActions(null);
    }
  };

  const syncOnScroll = (): void => {
    if (!hover || opening) {
      return;
    }
    const top = ring.messageActionsTop(hover.msgId);
    if (top === null || top < 0 || top + height > host.clientHeight + 0.5) {
      hide();
      return;
    }
    bar.style.transform = `translateY(${top}px)`;
  };

  const paint = (): void => {
    if (overBar) {
      return;
    }
    const rect = host.getBoundingClientRect();
    if (pointerY < rect.top || pointerY >= rect.bottom || pointerX < rect.left || pointerX >= rect.right) {
      hide();
      return;
    }
    const anchor = ring.messageAnchorAt(pointerX, pointerY);
    if (!anchor || anchor.bottom > rect.bottom + 0.5) {
      hide();
      return;
    }
    const sameMessage = hover?.msgId === anchor.msgId;
    hover = {
      msgId: anchor.msgId,
      login: anchor.login,
      text: anchor.text,
      canReply: anchor.canReply,
    };
    replyBtn.hidden = !anchor.canReply;
    if (!sameMessage) {
      opening = true;
      bar.hidden = false;
      height = bar.offsetHeight;
      try {
        ring.setMessageActions(anchor.msgId, height);
      } finally {
        opening = false;
      }
      syncOnScroll();
    }
  };

  const onHostMove = (ev: PointerEvent): void => {
    pointerX = ev.clientX;
    pointerY = ev.clientY;
    if (overBar || hoverRaf !== 0) {
      return;
    }
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      paint();
    });
  };

  const onHostLeave = (): void => {
    hide();
    ring.clearHover();
  };

  const onBarEnter = (): void => {
    overBar = true;
    cancelPaint();
  };

  const onBarLeave = (): void => {
    overBar = false;
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
    const rect = moreBtn.getBoundingClientRect();
    const ctx = ring.contextForMsgId(hover.msgId, rect.left, rect.bottom);
    if (!ctx) {
      return;
    }
    hide();
    opts.onMore(ctx);
  };

  host.addEventListener("pointermove", onHostMove);
  host.addEventListener("pointerleave", onHostLeave);
  host.addEventListener("wheel", onHostLeave, { capture: true, passive: true });
  bar.addEventListener("pointerenter", onBarEnter);
  bar.addEventListener("pointerleave", onBarLeave);
  replyBtn.addEventListener("click", onReplyClick);
  copyBtn.addEventListener("click", onCopyClick);
  moreBtn.addEventListener("click", onMoreClick);

  return {
    hide,
    isHoveringBar: () => overBar,
    syncOnScroll,
    dispose: () => {
      hide();
      host.removeEventListener("pointermove", onHostMove);
      host.removeEventListener("pointerleave", onHostLeave);
      host.removeEventListener("wheel", onHostLeave, true);
      bar.removeEventListener("pointerenter", onBarEnter);
      bar.removeEventListener("pointerleave", onBarLeave);
      replyBtn.removeEventListener("click", onReplyClick);
      copyBtn.removeEventListener("click", onCopyClick);
      moreBtn.removeEventListener("click", onMoreClick);
    },
  };
}
