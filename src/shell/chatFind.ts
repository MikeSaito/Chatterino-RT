import { invoke } from "@tauri-apps/api/core";
import { iconEl } from "./icons";
import type { MessageRing } from "../chat/ring";
import { isSettingsWindowOpen } from "./settings/settingsWindowState";

/** Hit row for SearchPopup-like list (Chatterino ChannelView filter). */
export type SearchHit = {
  id: string;
  timestampMs: number;
  nick: string;
  login: string;
  text: string;
  color: string;
};

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

function focusables(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return [...nodes].filter((el) => !el.hidden && el.getClientRects().length > 0);
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
      ? `Searching in ${ch}'s history`
      : "Searching in history";
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
        text.textContent = "Ничего не найдено";
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
      row.title = "Перейти к сообщению";
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
      text.textContent = hit.text;
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
    modal.hidden = true;
    setAppInert(false);
    hits = [];
    activeId = "";
    hasQuery = false;
    boundChannel = "";
    input.value = "";
    syncClear();
    view.replaceChildren();
    ring.clearFindHit();
    const focusBack = restoreFocus;
    restoreFocus = null;
    if (focusBack && document.contains(focusBack)) {
      focusBack.focus();
    }
  };

  const open = (): void => {
    if (isSettingsWindowOpen()) {
      return;
    }
    onOpen?.();
    if (!modal.hidden) {
      input.focus();
      input.select();
      return;
    }
    const active = document.activeElement;
    restoreFocus =
      active instanceof HTMLElement && active !== document.body ? active : null;
    paintTitle();
    modal.hidden = false;
    setAppInert(true);
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
      row.title = "Сообщение не в текущей ленте";
    } else {
      row.title = "Перейти к сообщению";
    }
  });

  input.addEventListener("input", () => {
    syncClear();
    scheduleSearch();
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (modal.hidden || isSettingsWindowOpen()) {
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key === "Tab") {
      const items = focusables(dialog);
      if (items.length === 0) {
        ev.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (ev.shiftKey) {
        if (!active || active === first || !dialog.contains(active)) {
          ev.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !dialog.contains(active)) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  return { onChannelChanged, open, close };
}
