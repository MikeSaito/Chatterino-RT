import { invoke } from "@tauri-apps/api/core";
import type { MessageRing } from "../chat/ring";

type SearchResult = { ids: string[] };

export function bindChatFind(opts: {
  ring: MessageRing;
  bar: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
  settingsModal: HTMLElement;
  activeChannel: () => string;
}): {
  onChannelChanged: () => void;
} {
  const { ring, bar, input, count, prev, next, close, settingsModal, activeChannel } = opts;

  let ids: string[] = [];
  let index = -1;
  let query = "";
  let timer = 0;
  let seq = 0;
  let boundChannel = "";

  const paintCount = (): void => {
    if (!query.trim()) {
      count.textContent = "";
      return;
    }
    if (ids.length === 0) {
      count.textContent = "0/0";
      return;
    }
    count.textContent = `${index + 1}/${ids.length}`;
  };

  const jumpCurrent = (): void => {
    if (index < 0 || index >= ids.length) {
      ring.clearFindHit();
      paintCount();
      return;
    }
    const id = ids[index];
    if (!ring.scrollToMsgId(id)) {
      ring.clearFindHit();
    }
    paintCount();
  };

  const runSearch = async (raw: string): Promise<void> => {
    const q = raw.trim();
    query = q;
    const channel = activeChannel();
    boundChannel = channel;
    if (!q || !channel) {
      ids = [];
      index = -1;
      ring.clearFindHit();
      paintCount();
      return;
    }
    const token = ++seq;
    try {
      const result = await invoke<SearchResult>("chat_search", { channel, query: q });
      if (token !== seq) {
        return;
      }
      ids = Array.isArray(result.ids) ? result.ids : [];
      index = ids.length > 0 ? ids.length - 1 : -1;
      jumpCurrent();
    } catch {
      if (token !== seq) {
        return;
      }
      ids = [];
      index = -1;
      ring.clearFindHit();
      paintCount();
    }
  };

  const scheduleSearch = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void runSearch(input.value);
    }, 120);
  };

  const open = (): void => {
    if (!settingsModal.hidden) {
      return;
    }
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value.trim()) {
      void runSearch(input.value);
    } else {
      paintCount();
    }
  };

  const hide = (): void => {
    window.clearTimeout(timer);
    seq += 1;
    bar.hidden = true;
    ids = [];
    index = -1;
    query = "";
    boundChannel = "";
    ring.clearFindHit();
    paintCount();
  };

  const onChannelChanged = (): void => {
    const channel = activeChannel();
    if (bar.hidden) {
      boundChannel = channel;
      return;
    }
    if (channel === boundChannel) {
      return;
    }
    if (!channel) {
      hide();
      return;
    }
    void runSearch(input.value);
  };

  const step = (delta: number): void => {
    if (ids.length === 0) {
      return;
    }
    index = (index + delta + ids.length) % ids.length;
    jumpCurrent();
  };

  close.addEventListener("click", () => {
    hide();
  });

  prev.addEventListener("click", () => {
    step(-1);
  });

  next.addEventListener("click", () => {
    step(1);
  });

  input.addEventListener("input", () => {
    scheduleSearch();
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (ev.shiftKey) {
        step(-1);
      } else {
        step(1);
      }
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      hide();
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "f" && ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
      if (!settingsModal.hidden) {
        return;
      }
      ev.preventDefault();
      open();
      return;
    }
    if (ev.key === "Escape" && !bar.hidden && settingsModal.hidden) {
      if (document.activeElement === input || bar.contains(document.activeElement)) {
        ev.preventDefault();
        hide();
      }
    }
  });

  return { onChannelChanged };
}
