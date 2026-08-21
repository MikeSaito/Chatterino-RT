import { invoke } from "@tauri-apps/api/core";

/**
 * SPA EmotePopup (~300×500): поиск по каталогу через chat_complete.
 */
export function bindEmotePopup(opts: {
  modal: HTMLElement;
  settingsModal: HTMLElement;
  insertEmote: (code: string) => void;
}): { open: () => void; close: () => void } {
  const { modal, settingsModal, insertEmote } = opts;
  const dialog = modal.querySelector<HTMLElement>("#emotepopup-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#emotepopup-backdrop");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#emotepopup-close");
  const search = modal.querySelector<HTMLInputElement>("#emotepopup-search");
  const view = modal.querySelector<HTMLElement>("#emotepopup-view");
  if (!dialog || !backdrop || !closeBtn || !search || !view) {
    return { open: () => undefined, close: () => undefined };
  }

  let timer = 0;
  let seq = 0;

  const close = (): void => {
    window.clearTimeout(timer);
    seq += 1;
    modal.hidden = true;
    search.value = "";
    view.replaceChildren();
  };

  const open = (): void => {
    if (!settingsModal.hidden) {
      return;
    }
    modal.hidden = false;
    search.focus();
    void runSearch();
  };

  const paint = (items: string[]): void => {
    view.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "emotepopup-empty";
      empty.textContent = search.value.trim()
        ? "No emotes match."
        : "Type to search emotes.";
      view.append(empty);
      return;
    }
    for (const code of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emotepopup-item";
      btn.textContent = code;
      btn.title = code;
      btn.addEventListener("click", () => {
        insertEmote(code);
        close();
      });
      view.append(btn);
    }
  };

  const runSearch = async (): Promise<void> => {
    const token = ++seq;
    const query = search.value.trim();
    if (query.length < 2) {
      paint([]);
      return;
    }
    try {
      const items = await invoke<string[]>("chat_complete", {
        token: query,
        firstWord: false,
      });
      if (token !== seq) {
        return;
      }
      paint(Array.isArray(items) ? items.slice(0, 80) : []);
    } catch {
      if (token !== seq) {
        return;
      }
      paint([]);
    }
  };

  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void runSearch();
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

  return { open, close };
}
