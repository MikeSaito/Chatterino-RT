import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent } from "../chat/types";

export type ReplyThreadOpen = {
  rootId: string;
  login: string;
  text: string;
};

type Priv = Extract<ChatEvent, { kind: "privmsg" }>;

/**
 * SPA ReplyThreadPopup: ветка ответов (DOM), без второго PIXI.
 */
export function bindReplyThread(opts: {
  modal: HTMLElement;
  settingsModal: HTMLElement;
  activeChannel: () => string;
  onReply: (id: string, login: string, text: string) => void;
}): { open: (info: ReplyThreadOpen) => void; close: () => void } {
  const { modal, settingsModal, activeChannel, onReply } = opts;
  const dialog = modal.querySelector<HTMLElement>("#replythread-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#replythread-backdrop");
  const closeBtn = modal.querySelector<HTMLButtonElement>("#replythread-close");
  const titleEl = modal.querySelector<HTMLElement>("#replythread-title");
  const view = modal.querySelector<HTMLElement>("#replythread-view");
  const replyBtn = modal.querySelector<HTMLButtonElement>("#replythread-reply");
  if (!dialog || !backdrop || !closeBtn || !titleEl || !view || !replyBtn) {
    return { open: () => undefined, close: () => undefined };
  }

  let current: ReplyThreadOpen | null = null;
  let replyTarget: { id: string; login: string; text: string } | null = null;

  const close = (): void => {
    modal.hidden = true;
    current = null;
    replyTarget = null;
    view.replaceChildren();
  };

  const open = (info: ReplyThreadOpen): void => {
    if (!settingsModal.hidden) {
      return;
    }
    current = info;
    replyTarget = { id: info.rootId, login: info.login, text: info.text };
    titleEl.textContent = `Thread · @${info.login}`;
    view.replaceChildren();
    const root = document.createElement("div");
    root.className = "replythread-msg is-root";
    root.textContent = `${info.login}: ${info.text}`;
    view.append(root);
    modal.hidden = false;
    void loadThread(info);
  };

  const collectThread = (events: Priv[], seedId: string): Priv[] => {
    const byId = new Map(events.map((ev) => [ev.id, ev]));
    let rootId = seedId;
    const seen = new Set<string>();
    while (byId.has(rootId) && !seen.has(rootId)) {
      seen.add(rootId);
      const node = byId.get(rootId);
      if (!node?.replyToId || !byId.has(node.replyToId)) {
        break;
      }
      rootId = node.replyToId;
    }
    const out: Priv[] = [];
    const walk = (id: string): void => {
      const node = byId.get(id);
      if (!node) {
        return;
      }
      out.push(node);
      for (const ev of events) {
        if (ev.replyToId === id) {
          walk(ev.id);
        }
      }
    };
    walk(rootId);
    return out;
  };

  const loadThread = async (info: ReplyThreadOpen): Promise<void> => {
    const channel = activeChannel();
    if (!channel) {
      return;
    }
    try {
      const snap = await invoke<{ events: ChatEvent[] }>("chat_snapshot", { channel });
      if (!current || current.rootId !== info.rootId) {
        return;
      }
      const events = (Array.isArray(snap.events) ? snap.events : []).filter(
        (ev): ev is Priv => ev.kind === "privmsg",
      );
      const related = collectThread(events, info.rootId);
      view.replaceChildren();
      if (related.length === 0) {
        const root = document.createElement("div");
        root.className = "replythread-msg is-root";
        root.textContent = `${info.login}: ${info.text}`;
        view.append(root);
        replyTarget = { id: info.rootId, login: info.login, text: info.text };
        return;
      }
      const rootId = related[0]?.id ?? info.rootId;
      for (const ev of related) {
        const row = document.createElement("button");
        row.type = "button";
        row.className =
          ev.id === rootId ? "replythread-msg is-root" : "replythread-msg";
        row.textContent = `${ev.login}: ${ev.text}`;
        row.addEventListener("click", () => {
          replyTarget = { id: ev.id, login: ev.login, text: ev.text };
          view.querySelectorAll(".replythread-msg").forEach((el) => {
            el.classList.toggle("is-selected", el === row);
          });
        });
        view.append(row);
      }
      const last = related[related.length - 1];
      if (last) {
        replyTarget = { id: last.id, login: last.login, text: last.text };
      }
    } catch {
      /* keep root row */
    }
  };

  closeBtn.addEventListener("click", () => {
    close();
  });
  backdrop.addEventListener("click", () => {
    close();
  });
  replyBtn.addEventListener("click", () => {
    if (!replyTarget) {
      return;
    }
    onReply(replyTarget.id, replyTarget.login, replyTarget.text);
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
