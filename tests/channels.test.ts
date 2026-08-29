import { indexAtContentX, moveOpenTab } from "../src/shell/channelTabOrder.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(
  JSON.stringify(moveOpenTab(["a", "b", "c"], 0, 2)) === JSON.stringify(["b", "c", "a"]),
  "move first to last",
);
assert(
  JSON.stringify(moveOpenTab(["a", "b", "c"], 2, 0)) === JSON.stringify(["c", "a", "b"]),
  "move last to first",
);
assert(
  JSON.stringify(moveOpenTab(["a", "b", "c"], 1, 2)) === JSON.stringify(["a", "c", "b"]),
  "swap middle right",
);
assert(moveOpenTab(["a", "b"], 0, 0) === null, "same index");
assert(moveOpenTab(["a"], 0, 1) === null, "oob");
assert(moveOpenTab([], 0, 0) === null, "empty");

const boxes = [
  { left: 0, width: 40 },
  { left: 40, width: 40 },
  { left: 80, width: 40 },
];
assert(indexAtContentX(boxes, 10) === 0, "left of first mid");
assert(indexAtContentX(boxes, 19) === 0, "just before first mid");
assert(indexAtContentX(boxes, 20) === 1, "at/after first mid → second");
assert(indexAtContentX(boxes, 60) === 2, "at/after second mid → third");
assert(indexAtContentX(boxes, 200) === 2, "past end → last");
assert(indexAtContentX([], 0) === -1, "empty boxes");

console.log("channels.test.ts: ok");
