import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CHAT_PIPE_EVENT, IPC_QUEUE_MAX } from "../constants";
import { decodeBatch } from "./batchDecode";
import type { ChatBatch } from "./types";
import type { MessageRing } from "./ring";
import { notifyHighlightSounds } from "../shell/highlightSound";
import { notifyHighlightFlash } from "../shell/highlightFlash";

export type ChatIpc = {
  join: (channel: string, focus?: boolean) => Promise<string>;
  leave: (channel: string) => Promise<string | null>;
  syncActive: (channel: string | null) => Promise<void>;
  part: () => Promise<void>;
  stop: () => void;
  active: () => string;
};

type Op =
  | {
      kind: "join";
      channel: string;
      focus: boolean;
      resolve: (v: string) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: "leave";
      channel: string;
      resolve: (v: string | null) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: "sync";
      channel: string | null;
      resolve: () => void;
      reject: (e: unknown) => void;
    };

export function bindChatIpc(ring: MessageRing): ChatIpc {
  let lastSeq = 0;
  let active = "";
  let epoch = 0;
  let pipeEpoch = 0;
  let stopped = false;
  let handling = false;
  let snapshotQueued = false;
  let retryTimer: number | undefined;
  let resubscribing = false;
  let opBusy = false;
  let unlistenPipe: (() => void) | null = null;
  const queued: ChatBatch[] = [];
  const ops: Op[] = [];

  const applySnapshot = async (channel: string, expected: number): Promise<boolean> => {
    const snap = await invoke<ChatBatch>("chat_snapshot", { channel });
    if (expected !== epoch || channel !== active || stopped) {
      return false;
    }
    lastSeq = snap.seq;
    ring.applySnapshot(snap.events);
    return true;
  };

  const recoverSnapshot = async (): Promise<boolean> => {
    if (!active || stopped) {
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
    if (expected !== epoch || batch.channelId !== active || stopped) {
      return;
    }
    lastSeq = batch.seq;
    ring.pushMany(batch.events);
    notifyHighlightSounds(batch.events);
    notifyHighlightFlash(batch.events);
  };

  const scheduleRetry = () => {
    if (retryTimer !== undefined || stopped) {
      return;
    }
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void pump();
    }, 250);
  };

  const pump = async () => {
    if (handling || stopped) {
      return;
    }
    handling = true;
    while (queued.length > 0 || snapshotQueued) {
      if (stopped) {
        break;
      }
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
    if (stopped) {
      return;
    }
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
    if (stopped) {
      return;
    }
    queued.length = 0;
    snapshotQueued = true;
    void resubscribe();
    void pump();
  };

  const attachChannel = async (): Promise<void> => {
    const my = ++pipeEpoch;
    const channel = new Channel<unknown>();
    channel.onmessage = (payload) => {
      if (my !== pipeEpoch || stopped) {
        return;
      }
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
    if (resubscribing || stopped) {
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

  const mountActive = async (joined: string): Promise<string> => {
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
  };

  const clearActive = (): void => {
    epoch += 1;
    active = "";
    lastSeq = 0;
    queued.length = 0;
    snapshotQueued = false;
    ring.reset();
  };

  const runOps = async (): Promise<void> => {
    if (opBusy) {
      return;
    }
    opBusy = true;
    while (ops.length > 0 && !stopped) {
      const op = ops.shift();
      if (!op) {
        break;
      }
      try {
        if (op.kind === "join") {
          await attachChannel();
          const joined = await invoke<string>("chat_join", {
            channel: op.channel,
            focus: op.focus,
          });
          if (op.focus) {
            await mountActive(joined);
          }
          op.resolve(joined);
        } else if (op.kind === "leave") {
          const next = await invoke<string | null>("chat_leave", { channel: op.channel });
          if (!next) {
            clearActive();
            op.resolve(null);
          } else if (next === active) {
            op.resolve(next);
          } else {
            await attachChannel();
            await mountActive(next);
            op.resolve(next);
          }
        } else if (!op.channel) {
          clearActive();
          op.resolve();
        } else if (op.channel === active) {
          op.resolve();
        } else {
          await attachChannel();
          await mountActive(op.channel);
          op.resolve();
        }
      } catch (err) {
        op.reject(err);
      }
    }
    opBusy = false;
    if (ops.length > 0 && !stopped) {
      void runOps();
    }
  };

  void listen(CHAT_PIPE_EVENT, () => {
    onBadPipe();
  }).then((unlisten) => {
    if (stopped) {
      unlisten();
      return;
    }
    unlistenPipe = unlisten;
  });

  return {
    join(channel: string, focus = true) {
      return new Promise<string>((resolve, reject) => {
        ops.push({ kind: "join", channel, focus, resolve, reject });
        void runOps();
      });
    },
    leave(channel: string) {
      return new Promise<string | null>((resolve, reject) => {
        ops.push({ kind: "leave", channel, resolve, reject });
        void runOps();
      });
    },
    syncActive(channel: string | null) {
      return new Promise<void>((resolve, reject) => {
        ops.push({ kind: "sync", channel, resolve, reject });
        void runOps();
      });
    },
    async part() {
      clearActive();
      await invoke("chat_part");
    },
    stop() {
      stopped = true;
      epoch += 1;
      pipeEpoch += 1;
      ops.length = 0;
      queued.length = 0;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (unlistenPipe) {
        unlistenPipe();
        unlistenPipe = null;
      }
    },
    active: () => active,
  };
}
