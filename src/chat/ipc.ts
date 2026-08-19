import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CHAT_EVENT } from "../constants";
import type { ChatBatch } from "./types";
import type { MessageRing } from "./ring";

export type ChatIpc = {
  join: (channel: string) => Promise<string>;
  part: () => Promise<void>;
  stop: () => void;
};

export function bindChatIpc(ring: MessageRing): ChatIpc {
  let lastSeq = 0;
  let active = "";
  let unlisten: UnlistenFn | undefined;
  let joining = false;
  let handling = false;
  const queued: ChatBatch[] = [];

  const applySnapshot = async (channel: string) => {
    const snap = await invoke<ChatBatch>("chat_snapshot", { channel });
    lastSeq = snap.seq;
    ring.applySnapshot(snap.events);
  };

  const handle = async (batch: ChatBatch) => {
    if (batch.channelId !== active) {
      return;
    }
    if (batch.seq <= lastSeq) {
      return;
    }
    const gapped = lastSeq !== 0 && batch.seq !== lastSeq + 1;
    if (gapped || batch.dropped > 0) {
      queued.length = 0;
      await applySnapshot(active);
      return;
    }
    lastSeq = batch.seq;
    for (const event of batch.events) {
      ring.push(event);
    }
  };

  const pump = async () => {
    if (handling) {
      return;
    }
    handling = true;
    while (queued.length > 0) {
      const next = queued.shift();
      if (!next) {
        break;
      }
      try {
        await handle(next);
      } catch {
        lastSeq = 0;
      }
    }
    handling = false;
  };

  return {
    async join(channel: string) {
      if (joining) {
        return active;
      }
      joining = true;
      const prev = unlisten;
      try {
        const joined = await invoke<string>("chat_join", { channel });
        active = joined;
        lastSeq = 0;
        ring.reset();
        queued.length = 0;
        const next = await listen<ChatBatch>(CHAT_EVENT, (ev) => {
          queued.push(ev.payload);
          void pump();
        });
        unlisten = next;
        if (prev) {
          prev();
        }
        try {
          await applySnapshot(joined);
        } catch {
          lastSeq = 0;
        }
        void pump();
        return joined;
      } catch (err) {
        unlisten = prev;
        throw err;
      } finally {
        joining = false;
      }
    },
    async part() {
      if (unlisten) {
        unlisten();
        unlisten = undefined;
      }
      active = "";
      lastSeq = 0;
      queued.length = 0;
      ring.reset();
      await invoke("chat_part");
    },
    stop() {
      if (unlisten) {
        unlisten();
        unlisten = undefined;
      }
    },
  };
}
