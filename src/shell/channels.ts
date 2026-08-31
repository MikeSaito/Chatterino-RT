import { setButtonIcon } from "./icons";
import { channelTabAttrs } from "./channelTabAria";
import {
  indexAtContentX,
  moveOpenTab,
  orderAtDragTarget,
  type TabLayoutBox,
} from "./channelTabOrder";
import { normalizeTabLive, tabAvatarLetter } from "./channelTabChrome";
import { t } from "../i18n";

export { moveOpenTab, indexAtContentX, orderAtDragTarget } from "./channelTabOrder";

const DRAG_ARM_PX = 8;
const EDGE_SCROLL_PX = 28;
const EDGE_SCROLL_STEP = 14;

export type ChannelListHooks = {
  /** Broken CDN URL — clear host-side avatar cache. */
  onAvatarBroken?: (login: string) => void;
};

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
  /** Profile image URL for a tab avatar (CDN). Null clears to letter fallback. */
  setAvatar: (login: string, url: string | null) => void;
  /** Live ring on tab avatar (same chrome as header). */
  setLive: (login: string, live: boolean) => void;
};

function paintTabAvatarHost(
  host: HTMLElement,
  login: string,
  url: string | undefined,
  live: boolean,
): void {
  const img = host.querySelector<HTMLImageElement>(".channel-tab-avatar-img");
  const letter = host.querySelector<HTMLElement>(".channel-tab-avatar-letter");
  if (!img || !letter) {
    return;
  }
  if (url) {
    letter.hidden = true;
    letter.textContent = "";
    img.hidden = false;
    img.dataset.expect = url;
    if (img.getAttribute("src") !== url) {
      img.src = url;
    }
  } else {
    img.hidden = true;
    img.removeAttribute("src");
    img.removeAttribute("data-expect");
    letter.hidden = false;
    letter.textContent = tabAvatarLetter(login);
  }
  host.classList.toggle("is-live", normalizeTabLive(live));
}

function buildTabAvatar(
  login: string,
  url: string | undefined,
  live: boolean,
  onBroken: ((login: string) => void) | undefined,
  clearCachedUrl: (login: string) => void,
): HTMLSpanElement {
  const host = document.createElement("span");
  host.className = "channel-tab-avatar";
  host.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.className = "channel-tab-avatar-img";
  img.alt = "";
  img.width = 18;
  img.height = 18;
  img.hidden = true;
  img.addEventListener("error", () => {
    const expect = img.dataset.expect;
    if (!expect || img.getAttribute("src") !== expect) {
      return;
    }
    clearCachedUrl(login);
    onBroken?.(login);
    img.hidden = true;
    img.removeAttribute("src");
    img.removeAttribute("data-expect");
    const letterEl = host.querySelector<HTMLElement>(".channel-tab-avatar-letter");
    if (letterEl) {
      letterEl.hidden = false;
      letterEl.textContent = tabAvatarLetter(login);
    }
  });
  const letter = document.createElement("span");
  letter.className = "channel-tab-avatar-letter";
  letter.setAttribute("aria-hidden", "true");
  letter.hidden = true;
  host.appendChild(img);
  host.appendChild(letter);
  paintTabAvatarHost(host, login, url, live);
  return host;
}

export function bindChannelList(
  list: HTMLUListElement,
  onSelect: (login: string) => void,
  onLeave: (login: string) => void,
  onReorder?: (open: string[]) => void,
  hooks?: ChannelListHooks,
): ChannelList {
  list.setAttribute("role", "tablist");
  list.setAttribute("aria-label", t("sidebar.channels.aria"));
  const recents: string[] = [];
  const open: string[] = [];
  let activeLogin = "";
  let showRecents = false;
  let suppressNextClick = false;
  const avatarUrlByLogin = new Map<string, string>();
  const liveByLogin = new Map<string, boolean>();

  const isOpen = (login: string): boolean => {
    const key = login.toLowerCase();
    return open.some((row) => row.toLowerCase() === key);
  };

  let drag: {
    pointerId: number;
    login: string;
    fromIndex: number;
    startIndex: number;
    startX: number;
    lastClientX: number;
    /** Open order frozen when the drag arms (absolute target base). */
    startOpen: string[];
    /** Tab boxes in content coords at arm time. */
    frozenBoxes: TabLayoutBox[];
    armed: boolean;
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
    window.removeEventListener("pointercancel", onWindowPointerCancel);
  };

  const clearDrag = (): void => {
    if (!drag) {
      clearDragChrome();
      return;
    }
    list.removeEventListener("lostpointercapture", onLostPointerCapture);
    try {
      if (list.hasPointerCapture(drag.pointerId)) {
        list.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* released */
    }
    unbindDragWindow();
    clearDragChrome();
    drag = null;
  };

  /** Abort gesture before paint/hydrate; persist live reorder if any. */
  const abortDragForPaint = (): void => {
    if (drag?.armed && drag.fromIndex !== drag.startIndex) {
      onReorder?.([...open]);
    }
    clearDrag();
  };

  /**
   * Own activation on pointerup: capture / is-dragging break the synthetic click.
   * activate=false for cancel / lost capture (rollback preview, no persist / join).
   * Armed drag that returned to startIndex is not a select.
   */
  const finishPointer = (activate: boolean, clientX?: number): void => {
    if (!drag) {
      return;
    }
    if (typeof clientX === "number") {
      drag.lastClientX = clientX;
    }
    if (!activate) {
      if (
        drag.armed &&
        drag.fromIndex !== drag.startIndex &&
        drag.startOpen.length > 0
      ) {
        open.length = 0;
        open.push(...drag.startOpen);
        syncDomToOpen(drag.login, false);
      }
      clearDrag();
      suppressNextClick = true;
      window.setTimeout(() => {
        suppressNextClick = false;
      }, 0);
      return;
    }
    // Final hit-test from frozen geometry so a fast flick still lands on the
    // slot under the pointer, not the last neighbor-only live step.
    if (drag.armed && drag.frozenBoxes.length > 0) {
      const to = indexAtContentX(drag.frozenBoxes, contentX(drag.lastClientX));
      if (to >= 0) {
        applyDragIndex(to);
      }
    }
    const login = drag.login;
    const reordered = drag.armed && drag.fromIndex !== drag.startIndex;
    const wasArmed = drag.armed;
    clearDrag();
    suppressNextClick = true;
    window.setTimeout(() => {
      suppressNextClick = false;
    }, 0);
    if (reordered) {
      onReorder?.([...open]);
      return;
    }
    if (!wasArmed) {
      onSelect(login);
    }
  };

  /** Content-coordinate boxes (scroll-aware); offsetLeft is wrong when offsetParent is the host. */
  const readTabBoxes = (): TabLayoutBox[] => {
    const listRect = list.getBoundingClientRect();
    const boxes: TabLayoutBox[] = [];
    for (const node of list.children) {
      if (!(node instanceof HTMLElement) || !node.classList.contains("channel-row")) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      boxes.push({
        left: rect.left - listRect.left + list.scrollLeft,
        width: rect.width,
      });
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

  const syncDomToOpen = (dragLogin: string, showDragging: boolean): void => {
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
    clearDragChrome();
    if (showDragging) {
      list.classList.add("is-reordering");
      const active = list.querySelector<HTMLElement>(
        `.channel-row[data-channel="${CSS.escape(dragLogin)}"]`,
      );
      active?.classList.add("is-dragging");
    }
  };

  const applyDragIndex = (toIndex: number): void => {
    if (!drag || toIndex === drag.fromIndex) {
      return;
    }
    const next = orderAtDragTarget(drag.startOpen, drag.startIndex, toIndex);
    if (!next) {
      return;
    }
    open.length = 0;
    open.push(...next);
    drag.fromIndex = toIndex;
    // Keep grabbing chrome for the whole armed gesture, even at startIndex.
    syncDomToOpen(drag.login, true);
  };

  const onWindowPointerMove = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) {
      return;
    }
    drag.lastClientX = ev.clientX;
    if (!drag.armed) {
      if (Math.abs(ev.clientX - drag.startX) < DRAG_ARM_PX) {
        return;
      }
      drag.armed = true;
      drag.startOpen = [...open];
      drag.frozenBoxes = readTabBoxes();
      try {
        // Capture on the list, not the row: syncDomToOpen reorders <li> nodes and
        // row pointer-events:none used to fire lostpointercapture mid-gesture.
        list.setPointerCapture(ev.pointerId);
      } catch {
        /* optional */
      }
      list.addEventListener("lostpointercapture", onLostPointerCapture);
      ev.preventDefault();
    }
    autoScroll(ev.clientX);
    const boxes =
      drag.frozenBoxes.length > 0 ? drag.frozenBoxes : readTabBoxes();
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
    finishPointer(true, ev.clientX);
  };

  const onWindowPointerCancel = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) {
      return;
    }
    finishPointer(false, ev.clientX);
  };

  const onLostPointerCapture = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) {
      return;
    }
    finishPointer(false, ev.clientX);
  };

  const onTabPointerDown = (
    ev: PointerEvent,
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
      lastClientX: ev.clientX,
      startOpen: [...open],
      frozenBoxes: [],
      armed: false,
    };
    // Capture arms on #channel-list (not the row) so DOM reorder + opacity chrome
    // cannot drop pointer capture mid-gesture.
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
  };

  const findTabAvatar = (login: string): HTMLElement | null => {
    const key = login.toLowerCase();
    for (const node of list.children) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if ((node.dataset.channel ?? "").toLowerCase() !== key) {
        continue;
      }
      return node.querySelector<HTMLElement>(".channel-tab-avatar");
    }
    return null;
  };

  const clearCachedAvatarUrl = (login: string): void => {
    avatarUrlByLogin.delete(login.toLowerCase());
  };

  const clearChannelChrome = (login: string): void => {
    const key = login.toLowerCase();
    avatarUrlByLogin.delete(key);
    liveByLogin.delete(key);
  };

  const paint = (active: string): void => {
    abortDragForPaint();
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
      const key = login.toLowerCase();
      btn.appendChild(
        buildTabAvatar(
          key,
          avatarUrlByLogin.get(key),
          liveByLogin.get(key) === true,
          hooks?.onAvatarBroken,
          clearCachedAvatarUrl,
        ),
      );
      const label = document.createElement("span");
      label.className = "channel-tab-label";
      label.textContent = `#${login}`;
      btn.appendChild(label);
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
          if (suppressNextClick) {
            ev.preventDefault();
            return;
          }
          onLeave(login);
        });
        leave.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
        });
        item.appendChild(leave);
        item.addEventListener("pointerdown", (ev) => {
          onTabPointerDown(ev, login);
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
      clearChannelChrome(login);
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
      // Only block while an armed reorder is in progress (match isReordering).
      // A live drag object before arm must not drop room sync.
      if (drag?.armed === true) {
        return;
      }
      const same =
        nextOpen.length === open.length &&
        nextOpen.every((login, i) => open[i] === login);
      const dropped = open.filter((login) => !nextOpen.includes(login));
      for (const login of dropped) {
        clearChannelChrome(login);
      }
      open.length = 0;
      for (const login of nextOpen) {
        if (!open.includes(login)) {
          open.push(login);
        }
      }
      if (same && active === activeLogin) {
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
    isReordering: () => drag?.armed === true,
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
    setAvatar(login, url) {
      const key = login.trim().toLowerCase();
      if (!key || !isOpen(key)) {
        return;
      }
      if (url) {
        avatarUrlByLogin.set(key, url);
      } else {
        avatarUrlByLogin.delete(key);
      }
      const host = findTabAvatar(key);
      if (host) {
        paintTabAvatarHost(
          host,
          key,
          avatarUrlByLogin.get(key),
          liveByLogin.get(key) === true,
        );
      }
    },
    setLive(login, live) {
      const key = login.trim().toLowerCase();
      if (!key || !isOpen(key)) {
        return;
      }
      if (live) {
        liveByLogin.set(key, true);
      } else {
        liveByLogin.delete(key);
      }
      const host = findTabAvatar(key);
      if (host) {
        paintTabAvatarHost(
          host,
          key,
          avatarUrlByLogin.get(key),
          liveByLogin.get(key) === true,
        );
      }
    },
  };
}
