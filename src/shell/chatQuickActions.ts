import type { MessageRing, SlotContext } from "../chat/ring";
import { setButtonIcon } from "./icons";
import { t } from "../i18n";

export type ChatQuickActions = {
  hide: () => void;
  dispose: () => void;
  syncOnScroll: () => void;
  isHoveringBar: () => boolean;
};

/** Actions docked beside the hovered message. */
export function bindChatQuickActions(opts: {
  host: HTMLElement;
  renderHost: HTMLElement;
  ring: MessageRing;
  bar: HTMLElement;
  replyBtn: HTMLButtonElement;
  copyBtn: HTMLButtonElement;
  moreBtn: HTMLButtonElement;
  onReply: (msgId: string, login: string, text: string) => void;
  onCopy: (text: string) => void;
  onMore: (ctx: SlotContext) => void;
}): ChatQuickActions {
  const { host, renderHost, ring, bar, replyBtn, copyBtn, moreBtn } = opts;
  let hover: {
    msgId: string;
    login: string;
    text: string;
    canReply: boolean;
  } | null = null;
  let overBar = false;
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
    hover = null;
    overBar = false;
    bar.hidden = true;
  };

  const paint = (): void => {
    if (overBar) {
      return;
    }
    const rect = renderHost.getBoundingClientRect();
    if (pointerY < rect.top || pointerY >= rect.bottom || pointerX < rect.left) {
      hide();
      return;
    }
    // Keep the message selected while the pointer crosses the rail to the buttons.
    if (pointerX >= rect.right) {
      return;
    }
    const anchor = ring.messageAnchorAt(pointerX, pointerY);
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
    if (replyBtn.hidden === anchor.canReply) {
      replyBtn.hidden = !anchor.canReply;
    }
    bar.style.setProperty("--action-row-top", `${anchor.top - rect.top}px`);
    bar.style.setProperty("--action-host-height", `${rect.height}px`);
    bar.hidden = false;
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
  bar.addEventListener("pointerenter", onBarEnter);
  bar.addEventListener("pointerleave", onBarLeave);
  replyBtn.addEventListener("click", onReplyClick);
  copyBtn.addEventListener("click", onCopyClick);
  moreBtn.addEventListener("click", onMoreClick);

  return {
    hide,
    isHoveringBar: () => overBar,
    syncOnScroll: () => {
      if (bar.hidden || !hover) {
        return;
      }
      if (overBar || pointerX >= renderHost.getBoundingClientRect().right) {
        onHostLeave();
        return;
      }
      paint();
    },
    dispose: () => {
      hide();
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
