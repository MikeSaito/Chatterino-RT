import { setButtonIcon } from "./icons";
import { channelTabAttrs } from "./channelTabAria";
import { indexAtContentX, moveOpenTab } from "./channelTabOrder";
import { t } from "../i18n";

export { moveOpenTab, indexAtContentX } from "./channelTabOrder";

const DRAG_ARM_PX = 5;
const EDGE_SCROLL_PX = 28;
const EDGE_SCROLL_STEP = 14;

export type ChannelList = {
  hydrate: (recents: string[], open: string[], active: string) => void;
  remember: (login: string, makeActive?: boolean) => void;
  remove: (login: string) => void;
  syncOpen: (open: string[], active: string) => void;
  paint: (active: string) => void;
  joined: () => string[];
  setShowRecents: (show: boolean) => void;
  isReordering: () => boolean;
  reorderOpen: (fromIndex: number, toIndex: number) => string[] | null;
};

export function bindChannelList(
  list: HTMLUListElement,
  onSelect: (login: string) => void,
  onLeave: (login: string) => void,
  onReorder?: (open: string[]) => void,
): ChannelList {
  list.setAttribute("role", "tablist");
  list.setAttribute("aria-label", t("sidebar.channels.aria"));
  const recents: string[] = [];
  const open: string[] = [];
  let activeLogin = "";
  let showRecents = false;
  let suppressNextClick = false;

  let drag: {
    pointerId: number;
    login: string;
    fromIndex: number;
    startIndex: number;
    startX: number;
    armed: boolean;
    row: HTMLElement;
  } | null = null;

  const clearDragChrome = (): void => {
    list.classList.remove("is-reordering");
    for (const el of list.querySelectorAll(".channel-row.is-dragging")) {
      el.classList.remove("is-dragging");
    }
  };

  const unbindDragWindow = (): void => {
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    window.removeEventListener("pointercancel", onWindowPointerUp);
  };

  const clearDrag = (): void => {
    if (!drag) {
      clearDragChrome();
      return;
    }
    try {
      if (drag.row.hasPointerCapture(drag.pointerId)) {
        drag.row.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* released */
    }
    unbindDragWindow();
    clearDragChrome();
    drag = null;
  };

  const finishDrag = (): void => {
    if (!drag) {
      return;
    }
    const shouldPersist = drag.armed && drag.fromIndex !== drag.startIndex;
    clearDrag();
    if (!shouldPersist) {
      return;
    }
    suppressNextClick = true;
    window.setTimeout(() => {
      suppressNextClick = false;
    }, 0);
    onReorder?.([...open]);
  };

  const readTabBoxes = (): { left: number; width: number }[] => {
    const boxes: { left: number; width: number }[] = [];
    for (const node of list.children) {
      if (!(node instanceof HTMLElement) || !node.classList.contains("channel-row")) {
        continue;
      }
      boxes.push({ left: node.offsetLeft, width: node.offsetWidth });
    }
    return boxes;
  };

  const contentX = (clientX: number): number => {
    const rect = list.getBoundingClientRect();
    return clientX - rect.left + list.scrollLeft;
  };

  const autoScroll = (clientX: number): void => {
    const rect = list.getBoundingClientRect();
    if (clientX < rect.left + EDGE_SCROLL_PX) {
      list.scrollLeft = Math.max(0, list.scrollLeft - EDGE_SCROLL_STEP);
    } else if (clientX > rect.right - EDGE_SCROLL_PX) {
      list.scrollLeft += EDGE_SCROLL_STEP;
    }
  };

  const syncDomToOpen = (dragLogin: string): void => {
    const rows = new Map<string, HTMLElement>();
    for (const node of [...list.children]) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const login = node.dataset.channel;
      if (login) {
        rows.set(login, node);
      }
    }
    for (const login of open) {
      const row = rows.get(login);
      if (row) {
        list.appendChild(row);
      }
    }
    const active = list.querySelector<HTMLElement>(
      `.channel-row[data-channel="${CSS.escape(dragLogin)}"]`,
    );
    active?.classList.add("is-dragging");
  };

  const applyDragIndex = (toIndex: number): void => {
    if (!drag || toIndex === drag.fromIndex) {
      return;
    }
    const next = moveOpenTab(open, drag.fromIndex, toIndex);
    if (!next) {
      return;
    }
    open.length = 0;
    open.push(...next);
    drag.fromIndex = toIndex;
    syncDomToOpen(drag.login);
  };

  const onWindowPointerMove = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.armed) {
      if (Math.abs(ev.clientX - drag.startX) < DRAG_ARM_PX) {
        return;
      }
      drag.armed = true;
      drag.row.classList.add("is-dragging");
      list.classList.add("is-reordering");
      ev.preventDefault();
    }
    autoScroll(ev.clientX);
    const boxes = readTabBoxes();
    const to = indexAtContentX(boxes, contentX(ev.clientX));
    if (to < 0) {
      return;
    }
    applyDragIndex(to);
  };

  const onWindowPointerUp = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) {
      return;
    }
    finishDrag();
    // Channel select stays on the button click (keyboard + mouse).
    // Reorder path sets suppressNextClick inside finishDrag when order changed.
  };

  const onTabPointerDown = (
    ev: PointerEvent,
    item: HTMLElement,
    login: string,
  ): void => {
    if (ev.button !== 0 || showRecents || drag) {
      return;
    }
    const target = ev.target;
    if (target instanceof Element && target.closest(".channel-leave")) {
      return;
    }
    const fromIndex = open.indexOf(login);
    if (fromIndex < 0) {
      return;
    }
    drag = {
      pointerId: ev.pointerId,
      login,
      fromIndex,
      startIndex: fromIndex,
      startX: ev.clientX,
      armed: false,
      row: item,
    };
    try {
      item.setPointerCapture(ev.pointerId);
    } catch {
      /* capture optional */
    }
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);
  };

  const paint = (active: string): void => {
    clearDrag();
    activeLogin = active;
    list.setAttribute("aria-label", t("sidebar.channels.aria"));
    list.replaceChildren();
    const order = showRecents
      ? [
          ...[...open].sort((a, b) => a.localeCompare(b)),
          ...recents.filter((login) => !open.includes(login)),
        ]
      : [...open];
    const seen = new Set<string>();
    for (const login of order) {
      if (seen.has(login)) {
        continue;
      }
      seen.add(login);
      const item = document.createElement("li");
      item.className = "channel-row";
      item.dataset.channel = login;
      const btn = document.createElement("button");
      btn.type = "button";
      const aria = channelTabAttrs(login, active);
      btn.className = aria.className;
      btn.setAttribute("role", aria.role);
      btn.setAttribute("aria-selected", aria.ariaSelected);
      btn.textContent = `#${login}`;
      btn.addEventListener("click", (ev) => {
        if (suppressNextClick) {
          ev.preventDefault();
          return;
        }
        onSelect(login);
      });
      item.appendChild(btn);
      if (open.includes(login)) {
        const leave = document.createElement("button");
        leave.type = "button";
        leave.className = "channel-leave btn-icon";
        setButtonIcon(leave, "close", {
          size: 12,
          label: t("sidebar.channel.leave"),
        });
        leave.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onLeave(login);
        });
        leave.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
        });
        item.appendChild(leave);
        item.addEventListener("pointerdown", (ev) => {
          onTabPointerDown(ev, item, login);
        });
      }
      list.appendChild(item);
    }
  };

  return {
    hydrate(nextRecents, nextOpen, active) {
      recents.length = 0;
      for (const login of nextRecents) {
        if (!recents.includes(login)) {
          recents.push(login);
        }
      }
      open.length = 0;
      for (const login of nextOpen) {
        if (!open.includes(login)) {
          open.push(login);
        }
      }
      paint(active);
    },
    remember(login, makeActive = true) {
      if (!open.includes(login)) {
        open.push(login);
      }
      const at = recents.indexOf(login);
      if (at >= 0) {
        recents.splice(at, 1);
      }
      recents.unshift(login);
      paint(makeActive ? login : activeLogin);
    },
    remove(login) {
      const atOpen = open.indexOf(login);
      if (atOpen >= 0) {
        open.splice(atOpen, 1);
      }
      const at = recents.indexOf(login);
      if (at >= 0) {
        recents.splice(at, 1);
      }
      paint(activeLogin === login ? "" : activeLogin);
    },
    syncOpen(nextOpen, active) {
      if (drag) {
        return;
      }
      const same =
        nextOpen.length === open.length &&
        nextOpen.every((login, i) => open[i] === login);
      open.length = 0;
      for (const login of nextOpen) {
        if (!open.includes(login)) {
          open.push(login);
        }
      }
      if (same && active === activeLogin) {
        // Still refresh aria/active chrome.
        for (const node of list.children) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          const login = node.dataset.channel ?? "";
          const btn = node.querySelector<HTMLButtonElement>(".channel-item");
          if (!btn) {
            continue;
          }
          const aria = channelTabAttrs(login, active);
          btn.className = aria.className;
          btn.setAttribute("aria-selected", aria.ariaSelected);
        }
        activeLogin = active;
        return;
      }
      paint(active);
    },
    paint,
    joined: () => [...open],
    setShowRecents(show) {
      showRecents = show;
      paint(activeLogin);
    },
    isReordering: () => drag != null,
    reorderOpen(fromIndex, toIndex) {
      const next = moveOpenTab(open, fromIndex, toIndex);
      if (!next) {
        return null;
      }
      open.length = 0;
      open.push(...next);
      paint(activeLogin);
      onReorder?.([...open]);
      return [...open];
    },
  };
}
