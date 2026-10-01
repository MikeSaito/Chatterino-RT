import assert from "node:assert/strict";
import { encode } from "@msgpack/msgpack";
import { bindChatIpc, type BindChatIpcOpts } from "../src/chat/ipc.ts";
import { CHAT_PIPE_EVENT } from "../src/constants.ts";
import type { ChatBatch, ChatEvent } from "../src/chat/types.ts";

const timers = new Map<number, () => void>();
let timerId = 0;
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
  clearTimeout: (id: number) => { timers.delete(id); },
} });
async function settle() { for (let i = 0; i < 40; i += 1) await Promise.resolve(); }
async function fireTimers() {
  const callbacks = [...timers.values()];
  timers.clear();
  for (const callback of callbacks) callback();
  await settle();
}
function notice(id: string): ChatEvent { return { kind: "notice", id, timestampMs: 1, text: id }; }

function harness() {
  const channels: MockChannel[] = [];
  class MockChannel {
    onmessage: (payload: unknown) => void = () => undefined;
    constructor() { channels.push(this); }
  }
  const listeners = new Map<string, () => void>();
  let failures = 0;
  let subscriptions = 0;
  let history: ChatBatch = { channelId: "alpha", seq: 1, dropped: 0, events: [notice("initial")] };
  let snapshotHook: (() => Promise<ChatBatch>) | null = null;
  let rows: ChatEvent[] = [];
  const ipc = bindChatIpc({
    reset: () => { rows = []; },
    applySnapshot: (events) => { rows = [...events]; },
    pushMany: (events) => { rows.push(...events); },
  }, {
    Channel: MockChannel as unknown as NonNullable<BindChatIpcOpts["Channel"]>,
    listen: (async (event: string, callback: () => void) => {
      listeners.set(event, callback);
      return () => { listeners.delete(event); };
    }) as unknown as NonNullable<BindChatIpcOpts["listen"]>,
    invoke: (async (command: string) => {
      if (command === "chat_subscribe") {
        subscriptions += 1;
        if (failures > 0) { failures -= 1; throw new Error("pipe temporarily unavailable"); }
        return subscriptions;
      }
      if (command === "chat_join") return "alpha";
      if (command === "chat_snapshot") return snapshotHook ? snapshotHook() : history;
      if (command === "chat_unsubscribe") return;
      throw new Error(`Unexpected command: ${command}`);
    }) as NonNullable<BindChatIpcOpts["invoke"]>,
  });
  return {
    ipc, channels, listeners,
    fail: (count: number) => { failures = count; },
    history: (batch: ChatBatch) => { history = batch; },
    snapshotHook: (hook: (() => Promise<ChatBatch>) | null) => { snapshotHook = hook; },
    subscriptions: () => subscriptions,
    rows: () => rows.map((event) => event.id),
  };
}

{
  const h = harness();
  await h.ipc.join("alpha");
  await settle();
  h.fail(2);
  h.listeners.get(CHAT_PIPE_EVENT)!();
  await settle();
  assert.equal(h.subscriptions(), 2);
  assert.equal(timers.size, 1, "failed pipe installation schedules a retry");
  await fireTimers();
  assert.equal(h.subscriptions(), 3);
  assert.equal(timers.size, 1, "repeated failure keeps retrying");
  h.history({ channelId: "alpha", seq: 2, dropped: 0, events: [notice("initial"), notice("missed")] });
  await fireTimers();
  assert.equal(h.subscriptions(), 4);
  assert.deepEqual(h.rows(), ["initial", "missed"], "new pipe recovers history missed during outage");
  assert.equal(timers.size, 0);
  h.channels[h.channels.length - 1]!.onmessage(encode({ channelId: "alpha", seq: 3, dropped: 0, events: [notice("live")] }));
  await settle();
  assert.deepEqual(h.rows(), ["initial", "missed", "live"], "live processing resumes");
  h.ipc.stop();
}
{
  const h = harness();
  await h.ipc.join("alpha");
  h.fail(1);
  h.listeners.get(CHAT_PIPE_EVENT)!();
  await settle();
  assert.equal(timers.size, 1);
  const count = h.subscriptions();
  h.ipc.stop();
  assert.equal(timers.size, 0, "stop cancels retry timers");
  await fireTimers();
  assert.equal(h.subscriptions(), count, "stopped IPC does not subscribe again");
}
{
  const h = harness();
  let resolveSnapshot!: (batch: ChatBatch) => void;
  h.snapshotHook(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
  const joined = h.ipc.join("alpha");
  await settle();
  h.channels[h.channels.length - 1]!.onmessage(encode({ channelId: "alpha", seq: 2, dropped: 0, events: [notice("live")] }));
  await settle();
  assert.deepEqual(h.rows(), [], "production IPC holds live messages during bootstrap");
  resolveSnapshot({ channelId: "alpha", seq: 1, dropped: 0, events: [notice("initial")] });
  await joined;
  await settle();
  assert.deepEqual(h.rows(), ["initial", "live"], "bootstrap snapshot cannot overwrite buffered live messages");
  h.ipc.stop();
}
console.log("ipcRecovery tests ok");
