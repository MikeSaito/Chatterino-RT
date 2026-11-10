import assert from "node:assert/strict";
import { TauriEvent } from "@tauri-apps/api/event";
import { watchWindowMinimized } from "../src/pixi/windowMinimized.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const listeners = new Map<TauriEvent, () => void>();
const queries: ReturnType<typeof deferred<boolean>>[] = [];
const changes: boolean[] = [];
const stop = watchWindowMinimized({
  isMinimized() {
    const query = deferred<boolean>();
    queries.push(query);
    return query.promise;
  },
  async listen(event, handler) {
    listeners.set(event, handler);
    return () => { listeners.delete(event); };
  },
}, (value) => changes.push(value));

await settle();
assert.equal(listeners.size, 3);
assert.equal(queries.length, 1);
queries[0].resolve(false);
await settle();
assert.deepEqual(changes, []);

listeners.get(TauriEvent.WINDOW_BLUR)!();
listeners.get(TauriEvent.WINDOW_RESIZED)!();
listeners.get(TauriEvent.WINDOW_FOCUS)!();
assert.equal(queries.length, 2, "window events share an in-flight query");
queries[1].resolve(true);
await settle();
assert.equal(queries.length, 3);
assert.deepEqual(changes, [], "late minimize result cannot pause a restored window");
queries[2].resolve(false);
await settle();

listeners.get(TauriEvent.WINDOW_RESIZED)!();
queries[3].resolve(true);
await settle();
assert.deepEqual(changes, [true]);
listeners.get(TauriEvent.WINDOW_FOCUS)!();
queries[4].reject(new Error("window query unavailable"));
await settle();
assert.deepEqual(changes, [true, false], "a failed query releases a paused renderer");

listeners.get(TauriEvent.WINDOW_BLUR)!();
stop();
queries[5].resolve(true);
await settle();
assert.equal(listeners.size, 0);
assert.deepEqual(changes, [true, false], "destroyed renderer never receives a late result");

const late = deferred<() => void>();
let removed = 0;
const stopBeforeListen = watchWindowMinimized({
  async isMinimized() { assert.fail("disposed watcher cannot query the window"); },
  async listen() { return late.promise; },
}, () => assert.fail("disposed watcher cannot change state"));
stopBeforeListen();
late.resolve(() => { removed++; });
await settle();
assert.equal(removed, 3, "late subscriptions are removed");

let partial = 0;
watchWindowMinimized({
  async isMinimized() { assert.fail("partially subscribed watcher cannot pause rendering"); },
  async listen(event) {
    if (event === TauriEvent.WINDOW_FOCUS) throw new Error("listener unavailable");
    return () => { partial++; };
  },
}, () => assert.fail("partially subscribed watcher cannot change state"));
await settle();
assert.equal(partial, 2);
console.log("window minimize watcher tests ok");
