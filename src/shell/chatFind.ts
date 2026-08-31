import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/index.ts";
import { clearchatText } from "../chat/chatSystemText";
import type { MessageRing } from "../chat/ring";
import { isSettingsWindowOpen } from "./settings/settingsWindowState";
import { closeModal, prepareModalOpen } from "./modalClose";
import { bindFocusTrap } from "./focusTrap";
import { iconEl } from "./icons";

/** Hit row for SearchPopup-like list (Chatterino ChannelView filter). */
export type SearchHit = {
  id: string;
  timestampMs: number;
  nick: string;
  login: string;
  text: string;
  color: string;
  clearLogin?: string | null;
  clearDurationSec?: number | null;
  clearStackCount?: number | null;
  clearSourceLogin?: string | null;
  clearModeratorLogin?: string | null;
};

function hitDisplayText(hit: SearchHit): string {
  if (hit.clearStackCount != null) {
    return clearchatText(
      hit.clearLogin ?? undefined,
      hit.clearDurationSec ?? undefined,
      hit.clearStackCount,
      hit.clearSourceLogin ?? undefined,
      hit.clearModeratorLogin ?? undefined,
    );
  }
  return hit.text;
}

type SearchResult = { hits: SearchHit[] };

function formatTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return "--:--";
  }
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * SPA SearchPopup: поле сверху + отфильтрованный список сообщений
 * (как Chatterino SearchPopup / ChannelView Context::Search).
 */
export function bindSearchPopup(opts: {
  ring: MessageRing;
  modal: HTMLElement;
  activeChannel: () => string;
  onOpen?: () => void;
}): {
  onChannelChanged: () => void;
  open: () => void;
  close: () => void;
  relabel: () => void;
} {
  const { ring, modal, activeChannel, onOpen } = opts;
  const appRoot = document.querySelector<HTMLElement>("#app");
  const dialog = modal.querySelector<HTMLElement>("#search-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#search-backdrop");
  const titleEl = modal.querySelector<HTMLElement>("#search-title");
  const input = modal.querySelector<HTMLInputElement>("#search-input");
  const clearBtn = modal.querySelector<HTMLButtonElement>("#search-clear");
  const view = modal.querySelector<HTMLElement>("#search-view");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#search-close");
  if (!dialog || !backdrop || !titleEl || !input || !clearBtn || !view || !closeBtn) {
    return {
      onChannelChanged: () => undefined,
      open: () => undefined,
      close: () => undefined,
      relabel: () => undefined,
    };
  }

  let hits: SearchHit[] = [];
  let activeId = "";
  let timer = 0;
  let seq = 0;
  let boundChannel = "";
  let hasQuery = false;
  let restoreFocus: HTMLElement | null = null;

  const setAppInert = (inert: boolean): void => {
    if (!appRoot) {
      return;
    }
    if (inert) {
      appRoot.setAttribute("inert", "");
    } else {
      appRoot.removeAttribute("inert");
    }
  };

  const paintTitle = (): void => {
    const ch = activeChannel();
    // SearchPopup::updateWindowTitle — "Searching in {name}'s history"
    titleEl.textContent = ch
      ? t("find.title.channel", { ch })
      : t("find.title");
  };

  const setActiveRow = (id: string): void => {
    activeId = id;
    for (const el of view.querySelectorAll<HTMLElement>(".search-hit")) {
      el.classList.toggle("is-active", el.dataset.id === id);
    }
  };

  const paintHits = (scrollToEnd: boolean): void => {
    const keepTop = view.scrollTop;
    view.replaceChildren();
    if (hits.length === 0) {
      if (hasQuery) {
        const empty = document.createElement("div");
        empty.className = "search-hit-empty";
        const iconWrap = document.createElement("span");
        iconWrap.className = "search-hit-empty-icon";
        iconWrap.append(iconEl("search", 40));
        const text = document.createElement("p");
        text.textContent = t("find.empty");
        empty.append(iconWrap, text);
        view.append(empty);
      }
      return;
    }
    const frag = document.createDocumentFragment();
    for (const hit of hits) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = hit.id === activeId ? "search-hit is-active" : "search-hit";
      row.dataset.id = hit.id;
      row.setAttribute("role", "listitem");
      row.title = t("find.hit.go");
      const time = document.createElement("span");
      time.className = "search-hit-time";
      time.textContent = formatTime(hit.timestampMs);
      const body = document.createElement("span");
      body.className = "search-hit-body";
      const nick = document.createElement("span");
      nick.className = "search-hit-nick";
      nick.textContent = hit.nick || "*";
      if (hit.color && /^#[0-9a-fA-F]{6}$/.test(hit.color)) {
        nick.style.color = hit.color;
      }
      const text = document.createElement("span");
      text.className = "search-hit-text";
      text.textContent = hitDisplayText(hit);
      body.append(nick, document.createTextNode(" "), text);
      row.append(time, body);
      frag.append(row);
    }
    view.append(frag);
    if (scrollToEnd) {
      view.scrollTop = view.scrollHeight;
    } else {
      view.scrollTop = keepTop;
    }
  };

  const syncClear = (): void => {
    clearBtn.hidden = input.value.trim().length === 0;
  };

  const runSearch = async (raw: string): Promise<void> => {
    const q = raw.trim();
    hasQuery = q.length > 0;
    syncClear();
    const channel = activeChannel();
    boundChannel = channel;
    paintTitle();
    if (!channel) {
      hits = [];
      activeId = "";
      ring.clearFindHit();
      paintHits(true);
      return;
    }
    const token = ++seq;
    try {
      const result = await invoke<SearchResult>("chat_search", {
        channel,
        query: q,
      });
      if (token !== seq) {
        return;
      }
      hits = Array.isArray(result.hits) ? result.hits : [];
      activeId = "";
      ring.clearFindHit();
      paintHits(true);
    } catch {
      if (token !== seq) {
        return;
      }
      hits = [];
      activeId = "";
      ring.clearFindHit();
      paintHits(true);
    }
  };

  const scheduleSearch = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void runSearch(input.value);
    }, 120);
  };

  const close = (): void => {
    window.clearTimeout(timer);
    seq += 1;
    hits = [];
    activeId = "";
    hasQuery = false;
    boundChannel = "";
    input.value = "";
    syncClear();
    view.replaceChildren();
    ring.clearFindHit();
    trap.deactivate();
    const focusBack = restoreFocus;
    restoreFocus = null;
    const closeToken = seq;
    void closeModal(modal).then(() => {
      if (closeToken !== seq || !modal.hidden) {
        return;
      }
      setAppInert(false);
      if (focusBack && document.contains(focusBack)) {
        focusBack.focus();
      }
    });
  };

  const trap = bindFocusTrap(dialog, {
    isActive: () => modal.hidden === false,
    onEscape: () => {
      close();
      return true;
    },
  });

  const open = (): void => {
    if (isSettingsWindowOpen()) {
      return;
    }
    onOpen?.();
    if (!modal.hidden && !modal.classList.contains("is-closing")) {
      input.focus();
      input.select();
      return;
    }
    const active = document.activeElement;
    restoreFocus =
      active instanceof HTMLElement && active !== document.body ? active : null;
    paintTitle();
    prepareModalOpen(modal);
    setAppInert(true);
    trap.activate();
    syncClear();
    input.focus();
    input.select();
    void runSearch(input.value);
  };

  const onChannelChanged = (): void => {
    const channel = activeChannel();
    if (modal.hidden) {
      boundChannel = channel;
      return;
    }
    if (channel === boundChannel) {
      return;
    }
    if (!channel) {
      close();
      return;
    }
    seq += 1;
    hits = [];
    activeId = "";
    ring.clearFindHit();
    paintHits(true);
    void runSearch(input.value);
  };

  closeBtn.addEventListener("click", () => {
    close();
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    syncClear();
    window.clearTimeout(timer);
    void runSearch("");
    input.focus();
  });

  backdrop.addEventListener("click", () => {
    close();
  });

  view.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".search-hit");
    if (!row || !view.contains(row) || !row.dataset.id) {
      return;
    }
    const id = row.dataset.id;
    setActiveRow(id);
    if (!ring.scrollToMsgId(id)) {
      row.title = t("find.hit.notInFeed");
    } else {
      row.title = t("find.hit.go");
    }
  });

  input.addEventListener("input", () => {
    syncClear();
    scheduleSearch();
  });

  return {
    onChannelChanged,
    open,
    close,
    relabel: () => {
      paintTitle();
      paintHits(false);
    },
  };
}
