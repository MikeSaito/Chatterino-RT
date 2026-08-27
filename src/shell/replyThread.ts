import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent } from "../chat/types";
import { formatTime } from "../chat/ring";
import { collectReplyThread, isInReplyThread } from "./replyRoot";
import { isSettingsWindowOpen } from "./settings/settingsWindowState";

type Priv = Extract<ChatEvent, { kind: "privmsg" }>;

export type ReplyThreadOpen = {
  rootId: string;
  login: string;
  text: string;
  /** Preloaded privmsgs; skips chat_snapshot in loadThread when set. */
  events?: Priv[];
};

type ReplyTarget = { id: string; login: string; text: string };

/**
 * SPA ReplyThreadPopup: ветка ответов (DOM), inline send, live append.
 */
export function bindReplyThread(opts: {
  modal: HTMLElement;
  activeChannel: () => string;
  autoClose: () => boolean;
  getCanSend: () => boolean;
  getSelfLogin: () => string | null;
  getShowTimestamps: () => boolean;
  getTimestampFormat: () => string;
  getHideTimestampsWhenLive: () => boolean;
  getChannelLive: () => boolean;
  onStatus?: (message: string) => void;
}): {
  open: (info: ReplyThreadOpen) => void;
  beginOpen: (info: ReplyThreadOpen) => void;
  completeOpen: (info: ReplyThreadOpen) => void;
  close: () => void;
  ingestLive: (events: ChatEvent[]) => void;
  isOpen: () => boolean;
  syncComposer: () => void;
  repaint: () => void;
} {
  const {
    modal,
    activeChannel,
    autoClose,
    getCanSend,
    getSelfLogin,
    getShowTimestamps,
    getTimestampFormat,
    getHideTimestampsWhenLive,
    getChannelLive,
    onStatus,
  } = opts;
  const dialog = modal.querySelector<HTMLElement>("#replythread-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#replythread-backdrop");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#replythread-close");
  const pinBtn = modal.querySelector<HTMLButtonElement>("#replythread-pin");
  const titleEl = modal.querySelector<HTMLElement>("#replythread-title");
  const view = modal.querySelector<HTMLElement>("#replythread-view");
  const input = modal.querySelector<HTMLTextAreaElement>("#replythread-input");
  const sendBtn = modal.querySelector<HTMLButtonElement>("#replythread-send");
  if (!dialog || !backdrop || !closeBtn || !titleEl || !view || !input || !sendBtn) {
    return {
      open: () => undefined,
      beginOpen: () => undefined,
      completeOpen: () => undefined,
      close: () => undefined,
      ingestLive: () => undefined,
      isOpen: () => false,
      syncComposer: () => undefined,
      repaint: () => undefined,
    };
  }

  let current: ReplyThreadOpen | null = null;
  let openChannel = "";
  let replyTarget: ReplyTarget | null = null;
  let threadMessages: Priv[] = [];
  let pendingLive: Priv[] = [];
  let pinned = false;
  let sending = false;
  let loading = false;
  let loadSeq = 0;

  const isOpen = (): boolean => !modal.hidden;

  const channelMatches = (): boolean =>
    openChannel !== "" && openChannel === activeChannel().trim();

  const scrollToBottom = (): void => {
    view.scrollTop = view.scrollHeight;
  };

  const syncPinVisibility = (): void => {
    if (pinBtn) {
      pinBtn.hidden = !autoClose();
    }
  };

  const syncComposer = (): void => {
    const canSend = getCanSend() && channelMatches();
    input.disabled = !canSend || sending;
    sendBtn.disabled = !canSend || sending || !input.value.trim();
    const login = getSelfLogin();
    if (!getCanSend()) {
      input.placeholder = "Log in to send messages...";
    } else if (!channelMatches()) {
      input.placeholder = "Channel changed — close thread";
    } else if (login) {
      input.placeholder = `Reply as ${login}...`;
    } else {
      input.placeholder = "Reply...";
    }
    syncPinVisibility();
  };

  const selectRow = (row: HTMLElement, target: ReplyTarget): void => {
    replyTarget = target;
    view.querySelectorAll(".replythread-msg").forEach((el) => {
      el.classList.toggle("is-selected", el === row);
    });
  };

  const shouldShowTimestamps = (): boolean =>
    getShowTimestamps() &&
    getTimestampFormat() !== "Disable" &&
    !(getHideTimestampsWhenLive() && getChannelLive());

  const paintRow = (ev: Priv, rootId: string): HTMLButtonElement => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = ev.id === rootId ? "replythread-msg is-root" : "replythread-msg";
    row.dataset.msgId = ev.id;

    const showTs = shouldShowTimestamps();
    if (showTs) {
      const time = document.createElement("span");
      time.className = "replythread-msg-time";
      time.textContent = formatTime(ev.timestampMs, getTimestampFormat());
      row.append(time);
    }

    const nick = document.createElement("span");
    nick.className = "replythread-msg-nick";
    nick.textContent = ev.displayName?.trim() || ev.login;
    if (ev.color) {
      nick.style.color = ev.color;
    }

    const body = document.createElement("span");
    body.className = "replythread-msg-text";
    body.textContent = ev.text;

    row.append(nick, body);
    row.addEventListener("click", () => {
      selectRow(row, { id: ev.id, login: ev.login, text: ev.text });
    });
    return row;
  };

  const applySelection = (messages: Priv[], preferredId?: string): void => {
    const pick =
      (preferredId && messages.find((m) => m.id === preferredId)) ||
      messages[messages.length - 1];
    if (!pick) {
      return;
    }
    replyTarget = { id: pick.id, login: pick.login, text: pick.text };
    view.querySelectorAll(".replythread-msg").forEach((el) => {
      el.classList.toggle(
        "is-selected",
        (el as HTMLElement).dataset.msgId === pick.id,
      );
    });
  };

  const paintThread = (messages: Priv[], rootId: string, preferredId?: string): void => {
    view.replaceChildren();
    if (messages.length === 0 && current) {
      const fallback = document.createElement("div");
      fallback.className = "replythread-msg is-root";
      if (shouldShowTimestamps()) {
        const time = document.createElement("span");
        time.className = "replythread-msg-time";
        time.textContent = "—";
        fallback.append(time);
      }
      const nick = document.createElement("span");
      nick.className = "replythread-msg-nick";
      nick.textContent = current.login;
      const body = document.createElement("span");
      body.className = "replythread-msg-text";
      body.textContent = current.text;
      fallback.append(nick, body);
      view.append(fallback);
      replyTarget = {
        id: current.rootId,
        login: current.login,
        text: current.text,
      };
      scrollToBottom();
      return;
    }
    for (const ev of messages) {
      view.append(paintRow(ev, rootId));
    }
    applySelection(messages, preferredId);
    scrollToBottom();
  };

  const mergePrivmsgs = (base: Priv[], extra: Priv[]): Priv[] => {
    const byId = new Map(base.map((m) => [m.id, m]));
    for (const ev of extra) {
      if (!byId.has(ev.id)) {
        byId.set(ev.id, ev);
      }
    }
    return [...byId.values()];
  };

  const close = (): void => {
    modal.hidden = true;
    current = null;
    openChannel = "";
    replyTarget = null;
    threadMessages = [];
    pendingLive = [];
    loading = false;
    pinned = false;
    if (pinBtn) {
      pinBtn.classList.remove("is-pinned");
      pinBtn.title = "Pin";
      pinBtn.setAttribute("aria-label", "Pin");
    }
    input.value = "";
    view.replaceChildren();
    syncComposer();
  };

  const mountOpen = (info: ReplyThreadOpen): void => {
    if (isSettingsWindowOpen()) {
      return;
    }
    const channel = activeChannel().trim();
    openChannel = channel;
    current = info;
    replyTarget = { id: info.rootId, login: info.login, text: info.text };
    threadMessages = [];
    pendingLive = [];
    pinned = false;
    if (pinBtn) {
      pinBtn.classList.remove("is-pinned");
      pinBtn.title = "Pin";
      pinBtn.setAttribute("aria-label", "Pin");
    }
    titleEl.textContent = channel
      ? `Reply Thread - @${info.login} in #${channel}`
      : `Reply Thread - @${info.login}`;
    input.value = "";
    modal.hidden = false;
    syncComposer();
    syncPinVisibility();
  };

  const beginOpen = (info: ReplyThreadOpen): void => {
    mountOpen(info);
    loading = true;
  };

  const completeOpen = (info: ReplyThreadOpen): void => {
    if (!current) {
      return;
    }
    current = info;
    replyTarget = { id: info.rootId, login: info.login, text: info.text };
    const channel = openChannel || activeChannel().trim();
    titleEl.textContent = channel
      ? `Reply Thread - @${info.login} in #${channel}`
      : `Reply Thread - @${info.login}`;
    void loadThread(info);
  };

  const open = (info: ReplyThreadOpen): void => {
    mountOpen(info);
    void loadThread(info);
  };

  const flushPendingLive = (info: ReplyThreadOpen, events: Priv[]): Priv[] => {
    const merged = mergePrivmsgs(events, pendingLive);
    pendingLive = [];
    return collectReplyThread(merged, info.rootId);
  };

  const loadThread = async (info: ReplyThreadOpen): Promise<void> => {
    const token = ++loadSeq;
    const selectedId = replyTarget?.id;
    loading = true;
    const channel = openChannel || activeChannel();
    if (!channel) {
      loading = false;
      paintThread([], info.rootId, selectedId);
      return;
    }
    try {
      let events: Priv[];
      if (info.events) {
        events = info.events;
      } else {
        const snap = await invoke<{ events: ChatEvent[] }>("chat_snapshot", { channel });
        if (token !== loadSeq || !current || current.rootId !== info.rootId) {
          return;
        }
        events = (Array.isArray(snap.events) ? snap.events : []).filter(
          (ev): ev is Priv => ev.kind === "privmsg",
        );
      }
      if (token !== loadSeq || !current || current.rootId !== info.rootId) {
        return;
      }
      const related = flushPendingLive(info, events);
      threadMessages = related;
      const rootId = related[0]?.id ?? info.rootId;
      paintThread(related, rootId, selectedId);
    } catch {
      if (token !== loadSeq || !current) {
        return;
      }
      paintThread([], info.rootId, selectedId);
    } finally {
      if (token === loadSeq) {
        loading = false;
      }
    }
  };

  const appendLive = (ev: Priv): void => {
    if (!current || !channelMatches()) {
      return;
    }
    if (threadMessages.some((m) => m.id === ev.id)) {
      return;
    }
    if (loading) {
      if (!pendingLive.some((p) => p.id === ev.id)) {
        pendingLive.push(ev);
      }
      return;
    }
    const pool = [...threadMessages, ev];
    if (!isInReplyThread(pool, current.rootId, ev.id)) {
      return;
    }
    threadMessages.push(ev);
    const rootId = threadMessages[0]?.id ?? current.rootId;
    view.append(paintRow(ev, rootId));
    applySelection(threadMessages, ev.id);
    scrollToBottom();
  };

  const ingestLive = (events: ChatEvent[]): void => {
    if (modal.hidden || !current || !channelMatches()) {
      return;
    }
    for (const ev of events) {
      if (ev.kind === "privmsg") {
        appendLive(ev);
      }
    }
  };

  const sendReply = async (): Promise<void> => {
    if (!replyTarget || sending || !getCanSend()) {
      return;
    }
    if (!channelMatches()) {
      onStatus?.("Channel changed; close and reopen the thread.");
      return;
    }
    const text = input.value.trim();
    if (!text) {
      return;
    }
    sending = true;
    syncComposer();
    try {
      await invoke("chat_send", { text, replyToId: replyTarget.id });
      input.value = "";
      onStatus?.("");
      input.focus();
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Send failed";
      onStatus?.(msg);
    } finally {
      sending = false;
      syncComposer();
    }
  };

  closeBtn.addEventListener("click", () => {
    close();
  });
  backdrop.addEventListener("click", () => {
    if (!autoClose() || pinned) {
      return;
    }
    close();
  });

  if (pinBtn) {
    pinBtn.addEventListener("click", () => {
      pinned = !pinned;
      pinBtn.classList.toggle("is-pinned", pinned);
      pinBtn.title = pinned ? "Unpin" : "Pin";
      pinBtn.setAttribute("aria-label", pinned ? "Unpin" : "Pin");
    });
  }

  sendBtn.addEventListener("click", () => {
    void sendReply();
  });

  input.addEventListener("input", () => {
    syncComposer();
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void sendReply();
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden && !pinned) {
      ev.preventDefault();
      close();
    }
  });

  document.addEventListener("pointerdown", (ev) => {
    if (modal.hidden || !autoClose() || pinned) {
      return;
    }
    const t = ev.target as Node;
    if (dialog.contains(t)) {
      return;
    }
    close();
  });

  syncPinVisibility();

  const repaint = (): void => {
    if (modal.hidden || !current) {
      return;
    }
    const rootId = threadMessages[0]?.id ?? current.rootId;
    paintThread(threadMessages, rootId, replyTarget?.id);
  };

  return { open, beginOpen, completeOpen, close, ingestLive, isOpen, syncComposer, repaint };
}
