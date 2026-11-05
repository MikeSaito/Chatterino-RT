import assert from "node:assert/strict";
import { MediaLoadQueue } from "../src/chat/mediaLoadQueue.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

{
  const queue = new MediaLoadQueue<number>(2, 2);
  const gates = Array.from({ length: 4 }, () => deferred<number>());
  const started: number[] = [];
  const jobs = gates.map((gate, i) => queue.enqueue(String(i), () => { started.push(i); return gate.promise; }));
  assert.deepEqual(started, [0, 1]);
  assert.equal(queue.enqueue("overflow", async () => 5), null);
  gates[1].resolve(1);
  assert.equal(await jobs[1], 1);
  assert.deepEqual(started, [0, 1, 2], "pending work starts in FIFO order");
  gates[0].reject(new Error("fixture failure"));
  await assert.rejects(jobs[0]!, /fixture failure/);
  assert.deepEqual(started, [0, 1, 2, 3], "a failure releases its permit");
  gates[2].resolve(2); gates[3].resolve(3);
  assert.deepEqual(await Promise.all([jobs[2], jobs[3]]), [2, 3]);
  assert.deepEqual(queue.diagnostics(), { loading: 0, queued: 0 });
}

{
  const queue = new MediaLoadQueue<number>(1, 1);
  const active = deferred<number>();
  const first = queue.enqueue("active", () => active.promise);
  const old = queue.enqueue("same", async () => { throw new Error("superseded work ran"); });
  const replacement = queue.enqueue("same", async () => 2);
  assert.equal(await old, null, "a queued replacement settles the previous request");
  queue.cancelPending();
  assert.equal(await replacement, null);
  assert.deepEqual(queue.diagnostics(), { loading: 1, queued: 0 }, "clear cannot release an active permit");
  const afterClear = queue.enqueue("new", async () => 3);
  assert.equal(queue.enqueue("overflow", async () => 4), null);
  active.resolve(1);
  assert.equal(await first, 1);
  assert.equal(await afterClear, 3, "new work progresses after the old active request completes");
  assert.deepEqual(queue.diagnostics(), { loading: 0, queued: 0 });
}

{
  const queue = new MediaLoadQueue<number>(1, 0);
  const failure = queue.enqueue("throws", () => { throw new Error("synchronous failure"); });
  await assert.rejects(failure!, /synchronous failure/);
  assert.equal(await queue.enqueue("recovers", async () => 1), 1);
}

console.log("media load queue tests ok");
