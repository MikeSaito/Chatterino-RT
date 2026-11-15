import { invoke } from "@tauri-apps/api/core";
import { isAllowedEmoteCdnUrl } from "../chat/emoteCdnAllowlist";
import { isSettingsWindowOpen } from "./settings/settingsWindowState";
import { closeModal, prepareModalOpen } from "./modalClose";
import { bindFocusTrap } from "./focusTrap";
import { t, type MessageKey } from "../i18n";
import { formatInvokeError, type InvokeErrorShape } from "../i18n/formatError";

type EmotePopupTab =
  | "favourite"
  | "subs"
  | "channel"
  | "global"
  | "emojis"
  | "gifs";

type EmotePopupItem = {
  code: string;
  url?: string | null;
  kind: string;
  favourite: boolean;
};

type GifChoice = { messageId?: string | null; sourceChannel?: string | null; gifId: string; title: string; url: string; previewUrl?: string | null };
type GifPage = { items: GifChoice[]; nextOffset: number | null };

const TABS: EmotePopupTab[] = ["favourite", "subs", "channel", "global", "emojis", "gifs"];

const EMPTY_KEY: Record<EmotePopupTab, MessageKey> = {
  favourite: "emotes.empty.favourite",
  subs: "emotes.empty.subs",
  channel: "emotes.empty.channel",
  global: "emotes.empty.global",
  emojis: "emotes.empty.emojis",
  gifs: "emotes.gifs.empty",
};

const VIEWPORT_PAD = 8;
const ANCHOR_GAP = 6;
const RECENT_GIF_IDS_KEY = "crt-recent-gif-ids-v1";
const RECENT_GIF_LIMIT = 24;
const validRecentGifId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9]{1,128}$/.test(id);

function readRecentGifIds(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_GIF_IDS_KEY) ?? "[]");
    if (Array.isArray(saved)) return [...new Set(saved.filter(validRecentGifId))].slice(0, RECENT_GIF_LIMIT);
  } catch {
    // The picker still works without persistent browser storage.
  }
  return [];
}

/**
 * SPA EmotePopup: вкладки Favourite/Subs/Channel/Global/Emojis, поиск, insert, Ctrl+favourite.
 * Якорь над кнопкой эмоутов в composer, не центрированный модал.
 */
export function bindEmotePopup(opts: {
  modal: HTMLElement;
  anchor: HTMLElement;
  insertEmote: (code: string, url?: string | null) => void;
  activeChannel: () => string | null;
  canSend: () => boolean;
  onGifSent: (channel: string) => void;
  onGifError: (error: unknown) => void;
}): { open: () => void; close: () => void; toggle: () => void; relabel: () => void; contextChanged: () => void } {
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
  const gifTab = tabButtons.find((btn) => btn.dataset.tab === "gifs");
  const gifSources = modal.querySelector<HTMLElement>("#emotepopup-gif-sources");
  const giphyLogo = modal.querySelector<HTMLElement>("#emotepopup-giphy-logo");
  if (!dialog || !backdrop || !closeBtn || !title || !search || !view || !gifTab || !gifSources || !giphyLogo) {
    return {
      open: () => undefined,
      close: () => undefined,
      toggle: () => undefined,
      relabel: () => undefined,
      contextChanged: () => undefined,
    };
  }

  let timer = 0;
  let seq = 0;
  let gifAccessSeq = 0;
  let tab: EmotePopupTab = "subs";
  let gifSource: "catalog" | "recent" = "recent";
  let busyFav = false;
  let sendingGif = false;
  let preferredGifIds = readRecentGifIds();
  let recentChoices: Promise<GifChoice[]> | undefined;

  const labelSearch = () => {
    search.placeholder = t(tab === "gifs"
      ? gifSource === "catalog" ? "emotes.gifs.catalog.search" : "emotes.gifs.search"
      : "emotes.search.placeholder");
    search.setAttribute("aria-label", search.placeholder);
    gifSources.hidden = tab !== "gifs";
    giphyLogo.hidden = tab !== "gifs";
  };

  const setTab = (next: EmotePopupTab): void => {
    tab = next;
    if (next !== "gifs") recentChoices = undefined;
    labelSearch();
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
    gifAccessSeq += 1;
    recentChoices = undefined;
    trap.deactivate();
    void closeModal(modal);
    anchor.setAttribute("aria-expanded", "false");
    search.value = "";
    view.replaceChildren();
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
    prepareModalOpen(modal);
    trap.activate();
    anchor.setAttribute("aria-expanded", "true");
    positionNearAnchor();
    search.focus();
    contextChanged();
  };

  const toggle = (): void => {
    if (modal.hidden || modal.classList.contains("is-closing")) {
      open();
    } else {
      close();
    }
  };

  const emptyMessage = (query: string): string => {
    if (query.trim()) {
      return t("emotes.empty.query");
    }
    return t(EMPTY_KEY[tab]);
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
      btn.title = item.favourite
        ? t("emotes.item.favouriteSuffix", { code: item.code })
        : item.code;
      btn.dataset.code = item.code;
      btn.dataset.kind = item.kind;
      btn.dataset.favourite = item.favourite ? "1" : "0";
      if (item.url && isAllowedEmoteCdnUrl(item.url)) {
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
        ph.title = t("emotes.item.unavailable");
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
            : t("emotes.error.favourite");
        btn.title = msg;
      } finally {
        busyFav = false;
      }
      return;
    }
    if (!item.url && item.kind === "emote") {
      return;
    }
    insertEmote(item.code, item.url);
    close();
  };

  const paintGifNotice = (text: string): void => {
    const notice = document.createElement("div");
    notice.className = "emotepopup-empty";
    notice.setAttribute("role", "status");
    notice.textContent = text;
    view.replaceChildren(notice);
  };

  const rememberGif = (id: string): void => {
    if (!validRecentGifId(id) || preferredGifIds[0] === id) return;
    preferredGifIds = [id, ...preferredGifIds.filter((previous) => previous !== id)].slice(0, RECENT_GIF_LIMIT);
    try { localStorage.setItem(RECENT_GIF_IDS_KEY, JSON.stringify(preferredGifIds)); } catch { /* keep the order for this session */ }
  };

  const paintGifs = (items: GifChoice[], channel: string, token: number, query: string): void => {
    if (!items.length) {
      paintGifNotice(t(gifSource === "catalog" ? "emotes.gifs.catalog.empty" : "emotes.gifs.empty"));
      return;
    }
    const grid = document.createElement("div");
    grid.className = "emotepopup-grid emotepopup-gif-grid";
    const send = document.createElement("button");
    send.type = "button";
    send.className = "btn btn-primary emotepopup-gif-send";
    send.textContent = t("emotes.gifs.send", { channel });
    send.disabled = true;
    let selected: GifChoice | undefined;
    for (const item of items) {
      const previewUrl = item.previewUrl ?? item.url;
      if (!isAllowedEmoteCdnUrl(previewUrl)) {
        continue;
      }
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "emotepopup-item emotepopup-gif-item";
      tile.setAttribute("aria-pressed", "false");
      tile.title = item.title || "GIF";
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = tile.title;
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      tile.append(img);
      tile.addEventListener("click", () => {
        if (sendingGif) return;
        grid.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
        tile.setAttribute("aria-pressed", "true");
        selected = item;
        rememberGif(item.gifId);
        send.disabled = false;
      });
      grid.append(tile);
    }
    if (!grid.childElementCount) {
      paint([]);
      return;
    }
    send.addEventListener("click", () => {
      if (!selected || sendingGif || token !== seq) {
        return;
      }
      if (activeChannel()?.trim() !== channel) {
        void reload();
        return;
      }
      const { messageId, sourceChannel, gifId, url } = selected;
      const accessToken = gifAccessSeq;
      sendingGif = true;
      send.disabled = true;
      send.textContent = t("emotes.gifs.sending");
      void invoke<string>("chat_send_gif", messageId
        ? { channel, messageId, gifId, sourceChannel }
        : { channel, gifId, originalUrl: url, searchTerm: query }).then(
        () => {
          if (token === seq) close();
          opts.onGifSent(channel);
        },
        (error: unknown) => {
          opts.onGifError(error);
          if (accessToken === gifAccessSeq && (error as InvokeErrorShape | null)?.code === "error.gif.unavailable") {
            hideGifTabAndReload();
          }
        },
      ).finally(() => {
        sendingGif = false;
        send.disabled = false;
        send.textContent = t("emotes.gifs.send", { channel });
      });
    });
    view.replaceChildren(grid, send);
  };

  const paintPages = (offsets: number[], nextOffset: number | null): void => {
    const navigation = document.createElement("div");
    navigation.className = "emotepopup-tabs";
    const pageButton = (label: MessageKey, pages: number[]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emotepopup-tab";
      button.textContent = t(label);
      button.addEventListener("click", () => { if (!sendingGif) void reload(pages); });
      navigation.append(button);
    };
    if (offsets.length > 1) pageButton("emotes.gifs.catalog.previous", offsets.slice(0, -1));
    if (nextOffset !== null) pageButton("emotes.gifs.catalog.next", [...offsets, nextOffset]);
    if (navigation.childElementCount) view.append(navigation);
  };

  const reload = async (offsets: number[] = [0]): Promise<void> => {
    const token = ++seq;
    const query = search.value.trim();
    const channel = activeChannel()?.trim() || "";
    if (tab === "gifs") {
      const catalog = gifSource === "catalog";
      const gifQuery = catalog ? Array.from(query).slice(0, 50).join("") : query;
      paintGifNotice(t("emotes.gifs.catalog.loading"));
      try {
        const page = catalog
          ? await invoke<GifPage>("chat_catalog_gifs", { query: gifQuery, offset: offsets[offsets.length - 1] })
          : { items: await (recentChoices ??= invoke<GifChoice[]>("chat_recent_gifs", { channel, preferredIds: preferredGifIds })), nextOffset: null };
        if (token === seq && (activeChannel()?.trim() || "") === channel) {
          const needle = query.toLowerCase();
          const items = catalog || !needle ? page.items : page.items.filter((item) =>
            item.title.toLowerCase().includes(needle) || item.gifId.toLowerCase().includes(needle));
          paintGifs(items, channel, token, catalog ? gifQuery : "");
          if (catalog) {
            paintPages(offsets, page.nextOffset);
            view.scrollTop = 0;
            positionNearAnchor();
          }
        }
      } catch (error) {
        if (token === seq) paintGifNotice(formatInvokeError(error));
      }
      return;
    }
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

  const hideGifTabAndReload = (): void => {
    gifTab.hidden = true;
    recentChoices = undefined;
    if (tab === "gifs") {
      setTab("subs");
      view.replaceChildren();
      if (dialog.contains(document.activeElement)) search.focus();
    }
    void reload().then(() => {
      if (!modal.hidden) positionNearAnchor();
    });
  };

  const contextChanged = (): void => {
    const accessToken = ++gifAccessSeq;
    if (modal.hidden || modal.classList.contains("is-closing")) return;
    window.clearTimeout(timer);
    relabel();
    hideGifTabAndReload();
    const channel = activeChannel()?.trim();
    if (!channel || !opts.canSend()) return;
    void invoke<boolean>("chat_gif_available", { channel }).then((available) => {
      if (available === true && accessToken === gifAccessSeq && activeChannel()?.trim() === channel && opts.canSend()) {
        gifTab.hidden = false;
        positionNearAnchor();
      }
    }, () => undefined);
  };

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tab as EmotePopupTab | undefined;
      if (!id || btn.hidden || !TABS.includes(id) || id === tab) {
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

  for (const button of gifSources.querySelectorAll<HTMLButtonElement>("[data-gif-source]")) {
    button.addEventListener("click", () => {
      const source = button.dataset.gifSource;
      if (tab !== "gifs" || (source !== "catalog" && source !== "recent") || source === gifSource) return;
      gifSource = source;
      recentChoices = undefined;
      gifSources.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      window.clearTimeout(timer);
      labelSearch();
      void reload();
    });
  }

  search.addEventListener("input", (event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    window.clearTimeout(timer);
    const catalogSearch = tab === "gifs" && gifSource === "catalog";
    if (catalogSearch) {
      seq += 1;
      paintGifNotice(t("emotes.gifs.catalog.loading"));
    }
    timer = window.setTimeout(() => {
      void reload().then(() => {
        if (!modal.hidden) {
          positionNearAnchor();
        }
      });
    }, catalogSearch ? 350 : 100);
  });

  closeBtn.addEventListener("click", () => {
    close();
  });
  backdrop.addEventListener("click", () => {
    close();
  });
  window.addEventListener("resize", () => {
    if (!modal.hidden) {
      positionNearAnchor();
    }
  });

  const relabel = (): void => {
    labelSearch();
    if (modal.hidden) {
      return;
    }
    const channel = activeChannel()?.trim() || "";
    title.textContent = channel
      ? t("emotes.title.channel", { channel })
      : t("emotes.title");
  };

  setTab("subs");
  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "false");
  anchor.setAttribute("aria-controls", "emotepopup-dialog");

  return { open, close, toggle, relabel, contextChanged };
}
