import { Channel, invoke } from "@tauri-apps/api/core";
import { IPC_QUEUE_MAX } from "../constants";
import { decodeBatch } from "./batchDecode";
import type { ChatBatch } from "./types";
import type { MessageRing } from "./ring";

export type ChatIpc = {
  join: (channel: string) => Promise<string>;
  part: () => Promise<void>;
  stop: () => void;
  active: () => string;
};

export function bindChatIpc(ring: MessageRing): ChatIpc {
  let lastSeq = 0;
  let active = "";
  let epoch = 0;
  let joining = false;
  let handling = false;
  let snapshotQueued = false;
  let retryTimer: number | undefined;
  let resubscribing = false;
  const queued: ChatBatch[] = [];

  const applySnapshot = async (channel: string, expected: number): Promise<boolean> => {
    const snap = await invoke<ChatBatch>("chat_snapshot", { channel });
    if (expected !== epoch || channel !== active) {
      return false;
    }
    lastSeq = snap.seq;
    ring.applySnapshot(snap.events);
    return true;
  };

  const recoverSnapshot = async (): Promise<boolean> => {
    if (!active) {
      return true;
    }
    const expected = epoch;
    const channel = active;
    try {
      return await applySnapshot(channel, expected);
    } catch {
      return false;
    }
  };

  const handle = async (batch: ChatBatch) => {
    const expected = epoch;
    if (batch.channelId !== active) {
      return;
    }
    if (batch.seq <= lastSeq) {
      return;
    }
    const gapped = lastSeq !== 0 && batch.seq !== lastSeq + 1;
    if (gapped || batch.dropped > 0) {
      queued.length = 0;
      const ok = await applySnapshot(active, expected);
      if (!ok && expected === epoch) {
        snapshotQueued = true;
      }
      return;
    }
    if (expected !== epoch || batch.channelId !== active) {
      return;
    }
    lastSeq = batch.seq;
    ring.pushMany(batch.events);
  };

  const scheduleRetry = () => {
    if (retryTimer !== undefined) {
      return;
    }
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void pump();
    }, 250);
  };

  const pump = async () => {
    if (handling) {
      return;
    }
    handling = true;
    while (queued.length > 0 || snapshotQueued) {
      if (snapshotQueued) {
        queued.length = 0;
        const ok = await recoverSnapshot();
        if (ok) {
          snapshotQueued = false;
          continue;
        }
        snapshotQueued = true;
        handling = false;
        scheduleRetry();
        return;
      }
      const next = queued.shift();
      if (!next) {
        break;
      }
      try {
        await handle(next);
      } catch {
        snapshotQueued = !(await recoverSnapshot());
      }
    }
    handling = false;
  };

  const onBatch = (batch: ChatBatch) => {
    if (snapshotQueued) {
      void pump();
      return;
    }
    if (queued.length >= IPC_QUEUE_MAX) {
      queued.length = 0;
      snapshotQueued = true;
    } else {
      queued.push(batch);
    }
    void pump();
  };

  const onBadPipe = () => {
    queued.length = 0;
    snapshotQueued = true;
    void resubscribe();
    void pump();
  };

  const attachChannel = async (): Promise<void> => {
    const channel = new Channel<unknown>();
    channel.onmessage = (payload) => {
      const batch = decodeBatch(payload);
      if (batch) {
        onBatch(batch);
      } else {
        onBadPipe();
      }
    };
    await invoke("chat_subscribe", { channel });
  };

  const resubscribe = async (): Promise<void> => {
    if (resubscribing) {
      return;
    }
    resubscribing = true;
    try {
      await attachChannel();
    } catch {
      /* next join/pump retries */
    } finally {
      resubscribing = false;
    }
  };

  return {
    async join(channel: string) {
      if (joining) {
        return active;
      }
      joining = true;
      try {
        await attachChannel();
        const joined = await invoke<string>("chat_join", { channel });
        const same = joined === active;
        if (same) {
          return joined;
        }
        epoch += 1;
        const expected = epoch;
        active = joined;
        lastSeq = 0;
        ring.reset();
        queued.length = 0;
        snapshotQueued = false;
        try {
          const applied = await applySnapshot(joined, expected);
          if (!applied && expected === epoch) {
            lastSeq = 0;
          }
        } catch {
          if (expected === epoch) {
            lastSeq = 0;
          }
        }
        void pump();
        return joined;
      } finally {
        joining = false;
      }
    },
    async part() {
      epoch += 1;
      active = "";
      lastSeq = 0;
      queued.length = 0;
      snapshotQueued = false;
      ring.reset();
      await invoke("chat_part");
    },
    stop() {
      epoch += 1;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    },
    active: () => active,
  };
}
