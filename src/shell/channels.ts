import { setButtonIcon } from "./icons";
import { channelTabAttrs } from "./channelTabAria";
import { moveOpenTab } from "./channelTabOrder";
import { t } from "../i18n";

export { moveOpenTab } from "./channelTabOrder";

export type ChannelList = {
  hydrate: (recents: string[], open: string[], active: string) => void;
  remember: (login: string, makeActive?: boolean) => void;
  remove: (login: string) => void;
  syncOpen: (open: string[], active: string) => void;
  paint: (active: string) => void;
  joined: () => string[];
  setShowRecents: (show: boolean) => void;
  isReordering: () => boolean;
  /** Move open tab fromIndex → toIndex; returns new order or null if unchanged. */
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
  /** Stable open-tab order (left→right). */
  const open: string[] = [];
  let activeLogin = "";
  let showRecents = false;

  let drag: {
    pointerId: number;
    login: string;
    fromIndex: number;
    startX: number;
    armed: boolean;
    row: HTMLElement;
  } | null = null;
  let suppressNextClick = false;

  const openIndex = (login: string): number => open.indexOf(login);

  const clearDrag = (): void => {
    if (!drag) {
      list.classList.remove("is-reordering");
      return;
    }
    const row = drag.row;
    row.removeEventListener("pointermove", onTabPointerMove);
    row.removeEventListener("pointerup", onTabPointerUp);
    row.removeEventListener("pointercancel", onTabPointerUp);
    row.removeEventListener("lostpointercapture", onTabLostCapture);
    row.classList.remove("is-dragging");
    list.classList.remove("is-reordering");
    drag = null;
  };

  const finishDrag = (commit: boolean): void => {
    if (!drag) {
      return;
    }
    const didReorder = commit && drag.armed;
    clearDrag();
    if (didReorder) {
      suppressNextClick = true;
      window.setTimeout(() => {
        suppressNextClick = false;
      }, 0);
      onReorder?.([...open]);
    }
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
      btn.addEventListener("click", () => {
        if (suppressNextClick) {
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
        item.appendChild(leave);
        item.addEventListener("pointerdown", (ev) => {
          onTabPointerDown(ev, item, login);
        });
      }
      list.appendChild(item);
    }
  };

  const tabAtPoint = (clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!(el instanceof Element)) {
      return null;
    }
    const row = el.closest(".channel-row") as HTMLElement | null;
    if (!row || !list.contains(row)) {
      return null;
    }
    return row.dataset.channel ?? null;
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
    const fromIndex = openIndex(login);
    if (fromIndex < 0) {
      return;
    }
    drag = {
      pointerId: ev.pointerId,
      login,
      fromIndex,
      startX: ev.clientX,
      armed: false,
      row: item,
    };
    item.setPointerCapture(ev.pointerId);
    item.addEventListener("pointermove", onTabPointerMove);
    item.addEventListener("pointerup", onTabPointerUp);
    item.addEventListener("pointercancel", onTabPointerUp);
    item.addEventListener("lostpointercapture", onTabLostCapture);
  };

  const onTabPointerMove = (ev: PointerEvent): void => {
    if (!drag || drag.pointerId !== ev.pointerId) {
      return;
    }
    if (!drag.armed) {
      if (Math.abs(ev.clientX - drag.startX) < 6) {
        return;
      }
      drag.armed = true;
      drag.row.classList.add("is-dragging");
      list.classList.add("is-reordering");
    }
    const over = tabAtPoint(ev.clientX, ev.clientY);
    if (!over || over === drag.login) {
      return;
    }
    const toIndex = openIndex(over);
    if (toIndex < 0 || toIndex === drag.fromIndex) {
      return;
    }
    const fromIndex = drag.fromIndex;
    const next = moveOpenTab(open, fromIndex, toIndex);
    if (!next) {
      return;
    }
    open.length = 0;
    open.push(...next);
    drag.fromIndex = toIndex;
    const overRow = list.querySelector<HTMLElement>(
      `.channel-row[data-channel="${CSS.escape(over)}"]`,
    );
    if (!overRow || overRow === drag.row) {
      return;
    }
    // Live DOM reorder without paint (keeps pointer capture).
    if (toIndex > fromIndex) {
      list.insertBefore(drag.row, overRow.nextSibling);
    } else {
      list.insertBefore(drag.row, overRow);
    }
  };

  const onTabLostCapture = (): void => {
    finishDrag(true);
  };

  const onTabPointerUp = (ev: PointerEvent): void => {
    if (!drag || drag.pointerId !== ev.pointerId) {
      return;
    }
    try {
      drag.row.releasePointerCapture(ev.pointerId);
    } catch {
      finishDrag(true);
    }
    // Successful release fires lostpointercapture → finishDrag.
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
      open.length = 0;
      for (const login of nextOpen) {
        if (!open.includes(login)) {
          open.push(login);
        }
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
