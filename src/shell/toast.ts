/** In-app toast stack: bottom-right, max 3 visible, FIFO queue. */

import { iconEl, setButtonIcon, type IconName } from "./icons";
import {
  TOAST_QUEUE_CAP,
  defaultToastDuration,
  remainingAfterPause,
  toastAdmission,
  type ToastKind,
} from "./toastLogic";

export type { ToastKind } from "./toastLogic";
export {
  TOAST_MAX_VISIBLE,
  TOAST_QUEUE_CAP,
  TOAST_DURATION_OK_MS,
  TOAST_DURATION_DANGER_MS,
  defaultToastDuration,
  toastAdmission,
  clampToastQueueLength,
  remainingAfterPause,
} from "./toastLogic";

export type ToastPushOpts = {
  kind: ToastKind;
  text: string;
  durationMs?: number;
};

const KIND_ICON: Record<ToastKind, IconName> = {
  success: "check",
  danger: "warning",
  info: "info",
};

type Queued = ToastPushOpts;

type Active = {
  el: HTMLElement;
  remainingMs: number;
  deadline: number;
  paused: boolean;
  leaving: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export type ToastHost = {
  push: (opts: ToastPushOpts) => void;
  dismissAll: () => void;
};

export function bindToastHost(host: HTMLElement): ToastHost {
  const queue: Queued[] = [];
  const active: Active[] = [];
  let seq = 0;

  const clearTimer = (item: Active): void => {
    if (item.timer !== null) {
      clearTimeout(item.timer);
      item.timer = null;
    }
  };

  const removeCard = (item: Active): void => {
    if (item.leaving) {
      return;
    }
    item.leaving = true;
    clearTimer(item);
    const el = item.el;
    el.classList.add("is-leaving");
    let finished = false;
    const done = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      el.removeEventListener("transitionend", done);
      const at = active.indexOf(item);
      if (at >= 0) {
        active.splice(at, 1);
      }
      el.remove();
      pump();
    };
    el.addEventListener("transitionend", done);
    window.setTimeout(done, 220);
  };

  const armTimer = (item: Active): void => {
    clearTimer(item);
    if (item.paused || item.leaving || item.remainingMs <= 0) {
      if (!item.leaving && item.remainingMs <= 0) {
        removeCard(item);
      }
      return;
    }
    item.deadline = Date.now() + item.remainingMs;
    item.timer = setTimeout(() => {
      item.timer = null;
      removeCard(item);
    }, item.remainingMs);
  };

  const pauseItem = (item: Active): void => {
    if (item.paused || item.leaving) {
      return;
    }
    item.paused = true;
    if (item.timer !== null) {
      item.remainingMs = remainingAfterPause(item.deadline, Date.now());
      clearTimer(item);
    }
    if (item.remainingMs <= 0) {
      removeCard(item);
    }
  };

  const shouldStayPaused = (el: HTMLElement): boolean => {
    if (el.matches(":hover")) {
      return true;
    }
    const focus = document.activeElement;
    return focus instanceof Node && el.contains(focus);
  };

  const resumeItem = (item: Active): void => {
    if (!item.paused || item.leaving) {
      return;
    }
    if (shouldStayPaused(item.el)) {
      return;
    }
    item.paused = false;
    if (item.remainingMs <= 0) {
      removeCard(item);
      return;
    }
    armTimer(item);
  };

  const mountCard = (opts: Queued): void => {
    const id = ++seq;
    const duration = opts.durationMs ?? defaultToastDuration(opts.kind);
    const el = document.createElement("div");
    el.className = `toast toast-${opts.kind}`;
    el.dataset.toastId = String(id);
    el.setAttribute("role", opts.kind === "danger" ? "alert" : "status");
    el.setAttribute("aria-live", opts.kind === "danger" ? "assertive" : "polite");

    const iconWrap = document.createElement("span");
    iconWrap.className = "toast-icon";
    iconWrap.setAttribute("aria-hidden", "true");
    iconWrap.append(iconEl(KIND_ICON[opts.kind], 16));

    const text = document.createElement("p");
    text.className = "toast-text";
    text.textContent = opts.text;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn-icon toast-close";
    setButtonIcon(close, "close", { size: 14, label: "Закрыть" });

    el.append(iconWrap, text, close);
    host.append(el);
    void el.offsetWidth;
    el.classList.add("is-visible");

    const item: Active = {
      el,
      remainingMs: duration,
      deadline: 0,
      paused: false,
      leaving: false,
      timer: null,
    };
    active.push(item);
    armTimer(item);

    el.addEventListener("pointerenter", () => {
      pauseItem(item);
    });
    el.addEventListener("pointerleave", () => {
      resumeItem(item);
    });
    el.addEventListener("focusin", () => {
      pauseItem(item);
    });
    el.addEventListener("focusout", (ev) => {
      const next = ev.relatedTarget;
      if (next instanceof Node && el.contains(next)) {
        return;
      }
      resumeItem(item);
    });
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeCard(item);
    });
  };

  const pump = (): void => {
    while (queue.length > 0 && toastAdmission(active.length) === "show") {
      const next = queue.shift();
      if (next) {
        mountCard(next);
      }
    }
  };

  const push = (opts: ToastPushOpts): void => {
    const text = opts.text.trim();
    if (!text) {
      return;
    }
    const payload: Queued = {
      kind: opts.kind,
      text,
      durationMs: opts.durationMs,
    };
    if (toastAdmission(active.length) === "show") {
      mountCard(payload);
    } else {
      queue.push(payload);
      while (queue.length > TOAST_QUEUE_CAP) {
        queue.shift();
      }
    }
  };

  const dismissAll = (): void => {
    queue.length = 0;
    for (const item of [...active]) {
      clearTimer(item);
      item.leaving = true;
      item.el.remove();
    }
    active.length = 0;
  };

  return { push, dismissAll };
}
