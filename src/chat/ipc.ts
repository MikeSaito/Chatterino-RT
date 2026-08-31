import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CHAT_HISTORY_LOADED_EVENT, CHAT_PIPE_EVENT, IPC_QUEUE_MAX } from "../constants";
import { decodeBatch } from "./batchDecode";
import type { ChatBatch, ChatEvent } from "./types";
import type { MessageRing } from "./ring";
import { notifyHighlightSounds } from "../shell/highlightSound";
import { notifyHighlightFlash } from "../shell/highlightFlash";
import { createMountBootstrapGate, liveBatchAction } from "./ipcMountGate";

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

/** Ring surface used by IPC (MessageRing satisfies this). */
export type ChatIpcRing = {
  reset(): void;
  setBoundChannel?(channel: string): void;
  applySnapshot(events: ChatEvent[]): void;
  pushMany(events: ChatEvent[]): void;
};

export type BindChatIpcOpts = {
  afterBatch?: (events: ChatEvent[]) => void;
  /** Cancel in-flight link enrichment / similar work on channel mount reset. */
  onMountReset?: () => void;
  /** Optional platform hooks for unit tests. */
  invoke?: typeof invoke;
  listen?: typeof listen;
  Channel?: typeof Channel;
};

export function bindChatIpc(
  ring: ChatIpcRing | MessageRing,
  opts?: BindChatIpcOpts,
): ChatIpc {
  const afterBatch = opts?.afterBatch;
  const onMountReset = opts?.onMountReset;
  const invokeFn = opts?.invoke ?? invoke;
  const listenFn = opts?.listen ?? listen;
  const ChannelCtor = opts?.Channel ?? Channel;
  let lastSeq = 0;
  let active = "";
  let epoch = 0;
  let pipeEpoch = 0;
  let stopped = false;
  let handling = false;
  const mountGate = createMountBootstrapGate();
  let snapshotQueued = false;
  let overflowDuringSnapshot = false;
  let retryTimer: number | undefined;
  let resubscribing = false;
  let opBusy = false;
  let unlistenPipe: (() => void) | null = null;
  let unlistenHistory: (() => void) | null = null;
  let activePipe: Channel<unknown> | null = null;
  let pipeGeneration: number | null = null;
  const queued: ChatBatch[] = [];
  const ops: Op[] = [];

  const applySnapshot = async (channel: string, expected: number): Promise<boolean> => {
    if (stopped || expected !== epoch) {
      return false;
    }
    const snap = await invokeFn<ChatBatch>("chat_snapshot", { channel });
    if (expected !== epoch || channel !== active || stopped) {
      return false;
    }
    lastSeq = snap.seq;
    ring.setBoundChannel?.(channel);
    ring.applySnapshot(snap.events);
    afterBatch?.(snap.events);
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
    const action = liveBatchAction(lastSeq, batch.seq, batch.dropped);
    if (action === "stale") {
      return;
    }
    if (action === "gap") {
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
    afterBatch?.(batch.events);
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
      // Hold live batches until mount bootstrap snapshot finishes (P1 race).
      if (mountGate.isHolding()) {
        handling = false;
        return;
      }
      if (snapshotQueued) {
        // Keep buffered live; after snapshot, handle() applies or gap→resnapshot.
        const ok = await recoverSnapshot();
        if (ok) {
          snapshotQueued = false;
          if (overflowDuringSnapshot) {
            overflowDuringSnapshot = false;
            queued.length = 0;
            snapshotQueued = true;
          }
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
      // Buffer live (incl. CLEARCHAT/CLEARMSG) during recover — do not drop silently.
      if (queued.length >= IPC_QUEUE_MAX) {
        queued.length = 0;
        overflowDuringSnapshot = true;
      } else {
        queued.push(batch);
      }
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

  const dropPipe = (): void => {
    pipeEpoch += 1;
    if (activePipe) {
      activePipe.onmessage = () => undefined;
      activePipe = null;
    }
  };

  const unsubscribePipe = (generation: number | null): void => {
    void invokeFn("chat_unsubscribe", { generation }).catch(() => undefined);
  };

  const attachChannel = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const my = ++pipeEpoch;
    if (activePipe) {
      activePipe.onmessage = () => undefined;
      activePipe = null;
    }
    const channel = new ChannelCtor<unknown>();
    activePipe = channel;
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
    let generation: number;
    try {
      generation = await invokeFn<number>("chat_subscribe", { channel });
    } catch (err) {
      if (my === pipeEpoch && activePipe === channel) {
        activePipe.onmessage = () => undefined;
        activePipe = null;
      }
      throw err;
    }
    if (stopped || my !== pipeEpoch) {
      channel.onmessage = () => undefined;
      if (activePipe === channel) {
        activePipe = null;
      }
      // Clear only this install; a newer attach keeps its generation.
      unsubscribePipe(generation);
      return;
    }
    pipeGeneration = generation;
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
    ring.setBoundChannel?.(joined);
    queued.length = 0;
    snapshotQueued = false;
    overflowDuringSnapshot = false;
    onMountReset?.();
    mountGate.begin();
    try {
      const applied = await applySnapshot(joined, expected);
      if (!applied && expected === epoch) {
        lastSeq = 0;
        snapshotQueued = true;
      }
    } catch {
      if (expected === epoch) {
        lastSeq = 0;
        snapshotQueued = true;
      }
    } finally {
      if (expected === epoch) {
        mountGate.end();
      }
    }
    void pump();
    return joined;
  };

  const clearActive = (): void => {
    epoch += 1;
    active = "";
    lastSeq = 0;
    mountGate.clear();
    queued.length = 0;
    snapshotQueued = false;
    overflowDuringSnapshot = false;
    ring.reset();
    onMountReset?.();
  };

  const rejectQueuedOps = (): void => {
    const pending = ops.splice(0);
    for (const op of pending) {
      op.reject(new Error("chat ipc stopped"));
    }
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
          if (stopped) {
            op.reject(new Error("chat ipc stopped"));
            break;
          }
          const joined = await invokeFn<string>("chat_join", {
            channel: op.channel,
            focus: op.focus,
          });
          if (stopped) {
            op.reject(new Error("chat ipc stopped"));
            break;
          }
          if (op.focus) {
            await mountActive(joined);
          }
          op.resolve(joined);
        } else if (op.kind === "leave") {
          const next = await invokeFn<string | null>("chat_leave", {
            channel: op.channel,
          });
          if (stopped) {
            op.reject(new Error("chat ipc stopped"));
            break;
          }
          if (!next) {
            clearActive();
            op.resolve(null);
          } else if (next === active) {
            op.resolve(next);
          } else {
            await attachChannel();
            if (stopped) {
              op.reject(new Error("chat ipc stopped"));
              break;
            }
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
          if (stopped) {
            op.reject(new Error("chat ipc stopped"));
            break;
          }
          await mountActive(op.channel);
          op.resolve();
        }
      } catch (err) {
        if (stopped) {
          op.reject(new Error("chat ipc stopped"));
        } else {
          op.reject(err);
        }
      }
    }
    opBusy = false;
    if (ops.length > 0 && !stopped) {
      void runOps();
    }
  };

  void listenFn(CHAT_PIPE_EVENT, () => {
    onBadPipe();
  }).then((unlisten) => {
    if (stopped) {
      unlisten();
      return;
    }
    unlistenPipe = unlisten;
  });

  void listenFn<{ channelId: string }>(CHAT_HISTORY_LOADED_EVENT, (ev) => {
    if (stopped || ev.payload.channelId !== active) {
      return;
    }
    snapshotQueued = true;
    void pump();
  }).then((unlisten) => {
    if (stopped) {
      unlisten();
      return;
    }
    unlistenHistory = unlisten;
  });

  return {
    join(channel: string, focus = true) {
      if (stopped) {
        return Promise.reject(new Error("chat ipc stopped"));
      }
      return new Promise<string>((resolve, reject) => {
        ops.push({ kind: "join", channel, focus, resolve, reject });
        void runOps();
      });
    },
    leave(channel: string) {
      if (stopped) {
        return Promise.reject(new Error("chat ipc stopped"));
      }
      return new Promise<string | null>((resolve, reject) => {
        ops.push({ kind: "leave", channel, resolve, reject });
        void runOps();
      });
    },
    syncActive(channel: string | null) {
      if (stopped) {
        return Promise.reject(new Error("chat ipc stopped"));
      }
      return new Promise<void>((resolve, reject) => {
        ops.push({ kind: "sync", channel, resolve, reject });
        void runOps();
      });
    },
    async part() {
      if (stopped) {
        return;
      }
      clearActive();
      await invokeFn("chat_part");
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      epoch += 1;
      mountGate.clear();
      const generation = pipeGeneration;
      pipeGeneration = null;
      dropPipe();
      rejectQueuedOps();
      queued.length = 0;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (unlistenPipe) {
        unlistenPipe();
        unlistenPipe = null;
      }
      if (unlistenHistory) {
        unlistenHistory();
        unlistenHistory = null;
      }
      unsubscribePipe(generation);
    },
    active: () => active,
  };
}
