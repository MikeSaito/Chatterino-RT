import assert from "node:assert/strict";
import { ViewPool } from "../src/chat/viewPool.ts";

let created = 0;
const events: string[] = [];
const destroyed = new Set<number>();
const pool = new ViewPool<string, { id: number }>({
  create: () => ({ id: ++created }),
  bind: (owner) => { events.push(`bind:${owner}`); },
  unbind: (owner, view) => {
    assert.equal(pool.get(owner), undefined, "cleanup sees an invalidated binding");
    assert.equal(pool.ownerOf(view), undefined, "pointer events cannot resolve a released owner");
    events.push(`unbind:${owner}`);
  },
  destroy: (view) => { assert.ok(!destroyed.has(view.id)); destroyed.add(view.id); },
});
assert.equal(pool.get("a"), undefined);
assert.equal(created, 0, "looking up offscreen data does not allocate a view");
pool.sync(["a", "b"], 0);
const first = pool.get("a")!;
const token = pool.tokenOf("a")!;
assert.ok(pool.owns("a", first, token));
events.length = 0;
pool.sync(["b", "c"], 0);
assert.deepEqual(events, ["unbind:a", "bind:c"], "old views are released before new rows are bound");
assert.equal(pool.get("c"), first);
assert.equal(created, 2, "moving the viewport reuses the released view");
assert.ok(!pool.owns("a", first, token), "late work cannot target a new owner");
pool.sync(["b", "a"], 0);
assert.equal(pool.get("a"), first);
assert.ok(!pool.owns("a", first, token), "returning to the same owner still invalidates its previous lease");

for (let start = 0; start < 200; start += 1) {
  pool.sync(Array.from({ length: 10 }, (_, i) => `row-${start + i}`), 0);
  assert.equal(pool.bindings.size, 10);
  assert.equal(pool.views.size, 10, "display capacity follows the viewport, not retained history");
}
assert.equal(created, 10);
pool.sync(["row-200", "row-201"], 1);
assert.equal(pool.views.size, 3, "shrinking the viewport trims spare views");
assert.equal(destroyed.size, 7);
assert.ok(pool.get("row-200") && pool.get("row-201"), "trimming preserves all active owners");
pool.clear(1);
assert.equal(pool.bindings.size, 0);
assert.equal(pool.views.size, 1);
pool.destroy();
assert.equal(pool.views.size, 0);
assert.equal(destroyed.size, created, "destroy releases every allocated view exactly once");
let fail = true;
let cleanups = 0;
const retry = new ViewPool<string, object>({
  create: () => ({}),
  bind: () => { if (fail) throw new Error("binding failed"); },
  unbind: () => { cleanups += 1; },
  destroy: () => {},
});
assert.throws(() => retry.sync(["a"]), /binding failed/);
assert.equal(retry.get("a"), undefined, "failed initialization publishes no stale owner");
assert.equal(cleanups, 1, "failed initialization releases partially acquired resources");
fail = false;
retry.sync(["a"]);
assert.equal(retry.views.size, 1, "retry can reuse the cleaned display object");
retry.destroy();
console.log("view pool tests ok");
