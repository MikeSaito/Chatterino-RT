import { lruVictimsToSize } from "../src/chat/textureLruPolicy.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

{
  const pinned = new Set(["b"]);
  const victims = lruVictimsToSize(["a", "b"], (key) => pinned.has(key), 1);
  assert(victims.join(",") === "a", "insert at cap evicts oldest unpinned key");
}

{
  const victims = lruVictimsToSize(["a", "b"], () => true, 1);
  assert(victims.length === 0, "full pinned cache has no victim");
}

{
  const pinned = new Set(["a"]);
  const victims = lruVictimsToSize(
    ["a", "b", "c", "d"],
    (key) => pinned.has(key),
    2,
  );
  assert(victims.join(",") === "b,c", "eviction preserves LRU order and pinned key");
}

console.log("texture LRU eviction tests ok");
