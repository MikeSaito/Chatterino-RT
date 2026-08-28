import { invoke } from "@tauri-apps/api/core";
import { isSettingsWindowOpen } from "./settings/settingsWindowState";

type EmotePopupTab = "favourite" | "subs" | "channel" | "global" | "emojis";

type EmotePopupItem = {
  code: string;
  url?: string | null;
  kind: string;
  favourite: boolean;
};

const TABS: EmotePopupTab[] = ["favourite", "subs", "channel", "global", "emojis"];

const EMPTY_BY_TAB: Record<EmotePopupTab, string> = {
  favourite: "Нет избранных эмодзи. Ctrl+клик по эмодзи добавляет в избранное.",
  subs: "Нет subscriber emotes.",
  channel: "Нет эмодзи канала.",
  global: "Нет global emotes.",
  emojis: "Нет эмодзи.",
};

const VIEWPORT_PAD = 8;
const ANCHOR_GAP = 6;

/**
 * SPA EmotePopup: вкладки Favourite/Subs/Channel/Global/Emojis, поиск, insert, Ctrl+favourite.
 * Якорь над кнопкой эмоутов в composer, не центрированный модал.
 */
export function bindEmotePopup(opts: {
  modal: HTMLElement;
  anchor: HTMLElement;
  insertEmote: (code: string) => void;
  activeChannel: () => string | null;
}): { open: () => void; close: () => void; toggle: () => void } {
  const { modal, anchor, insertEmote, activeChannel } = opts;
  const dialog = modal.querySelector<HTMLElement>("#emotepopup-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#emotepopup-backdrop");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#emotepopup-close");
  const title = modal.querySelector<HTMLElement>("#emotepopup-title");
  const search = modal.querySelector<HTMLInputElement>("#emotepopup-search");
  const view = modal.querySelector<HTMLElement>("#emotepopup-view");
  const tabButtons = Array.from(
    modal.querySelectorAll<HTMLButtonElement>(".emotepopup-tab[data-tab]"),
  );
  if (!dialog || !backdrop || !closeBtn || !title || !search || !view || tabButtons.length === 0) {
    return {
      open: () => undefined,
      close: () => undefined,
      toggle: () => undefined,
    };
  }

  let timer = 0;
  let seq = 0;
  let tab: EmotePopupTab = "subs";
  let busyFav = false;

  const setTab = (next: EmotePopupTab): void => {
    tab = next;
    for (const btn of tabButtons) {
      const id = btn.dataset.tab as EmotePopupTab | undefined;
      const on = id === next;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  };

  const positionNearAnchor = (): void => {
    const rect = anchor.getBoundingClientRect();
    const dw = dialog.offsetWidth || 320;
    const dh = dialog.offsetHeight || 420;
    let left = rect.left;
    let top = rect.top - dh - ANCHOR_GAP;
    if (top < VIEWPORT_PAD) {
      top = rect.bottom + ANCHOR_GAP;
    }
    left = Math.max(
      VIEWPORT_PAD,
      Math.min(left, window.innerWidth - dw - VIEWPORT_PAD),
    );
    top = Math.max(
      VIEWPORT_PAD,
      Math.min(top, window.innerHeight - dh - VIEWPORT_PAD),
    );
    dialog.style.left = `${Math.round(left)}px`;
    dialog.style.top = `${Math.round(top)}px`;
  };

  const close = (): void => {
    window.clearTimeout(timer);
    seq += 1;
    modal.hidden = true;
    anchor.setAttribute("aria-expanded", "false");
    search.value = "";
    view.replaceChildren();
  };

  const open = (): void => {
    if (isSettingsWindowOpen()) {
      return;
    }
    const channel = activeChannel()?.trim() || "";
    title.textContent = channel ? `Emotes in #${channel}` : "Emotes";
    modal.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    positionNearAnchor();
    search.focus();
    void reload().then(() => {
      if (!modal.hidden) {
        positionNearAnchor();
      }
    });
  };

  const toggle = (): void => {
    if (modal.hidden) {
      open();
    } else {
      close();
    }
  };

  const emptyMessage = (query: string): string => {
    if (query.trim()) {
      return "Нет эмодзи по запросу.";
    }
    return EMPTY_BY_TAB[tab];
  };

  const paint = (items: EmotePopupItem[]): void => {
    view.replaceChildren();
    const query = search.value.trim();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "emotepopup-empty";
      empty.textContent = emptyMessage(query);
      view.append(empty);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "emotepopup-grid";
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emotepopup-item";
      if (item.favourite) {
        btn.classList.add("is-favourite");
      }
      btn.title = item.favourite ? `${item.code} (favourite)` : item.code;
      btn.dataset.code = item.code;
      btn.dataset.kind = item.kind;
      btn.dataset.favourite = item.favourite ? "1" : "0";
      if (item.url) {
        const img = document.createElement("img");
        img.src = item.url;
        img.alt = item.code;
        img.loading = "lazy";
        img.decoding = "async";
        img.draggable = false;
        btn.append(img);
      } else {
        const ph = document.createElement("span");
        ph.className = "emotepopup-item-ph";
        ph.textContent = "?";
        ph.title = "Unavailable";
        btn.append(ph);
        btn.classList.add("is-unavailable");
      }
      const label = document.createElement("span");
      label.className = "emotepopup-item-code";
      label.textContent = item.code;
      btn.append(label);
      btn.addEventListener("click", (ev) => {
        void onItemClick(ev, item, btn);
      });
      grid.append(btn);
    }
    view.append(grid);
  };

  const onItemClick = async (
    ev: MouseEvent,
    item: EmotePopupItem,
    btn: HTMLButtonElement,
  ): Promise<void> => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      if (busyFav) {
        return;
      }
      busyFav = true;
      const add = !item.favourite;
      try {
        await invoke("chat_toggle_favourite_emote", {
          code: item.code,
          isEmoji: item.kind === "emoji",
          add,
        });
        await reload();
        if (!modal.hidden) {
          positionNearAnchor();
        }
      } catch (err) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Could not update favourite";
        btn.title = msg;
      } finally {
        busyFav = false;
      }
      return;
    }
    if (!item.url && item.kind === "emote") {
      return;
    }
    insertEmote(item.code);
    close();
  };

  const reload = async (): Promise<void> => {
    const token = ++seq;
    const query = search.value.trim();
    const channel = activeChannel()?.trim() || "";
    try {
      const items = await invoke<EmotePopupItem[]>("chat_emote_popup_list", {
        channel,
        tab,
        query,
      });
      if (token !== seq) {
        return;
      }
      paint(Array.isArray(items) ? items : []);
    } catch {
      if (token !== seq) {
        return;
      }
      paint([]);
    }
  };

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tab as EmotePopupTab | undefined;
      if (!id || !TABS.includes(id) || id === tab) {
        return;
      }
      setTab(id);
      void reload().then(() => {
        if (!modal.hidden) {
          positionNearAnchor();
        }
      });
    });
  }

  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void reload().then(() => {
        if (!modal.hidden) {
          positionNearAnchor();
        }
      });
    }, 100);
  });

  closeBtn.addEventListener("click", () => {
    close();
  });
  backdrop.addEventListener("click", () => {
    close();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden) {
      ev.preventDefault();
      close();
    }
  });
  window.addEventListener("resize", () => {
    if (!modal.hidden) {
      positionNearAnchor();
    }
  });

  setTab("subs");
  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "false");
  anchor.setAttribute("aria-controls", "emotepopup-dialog");

  return { open, close, toggle };
}
