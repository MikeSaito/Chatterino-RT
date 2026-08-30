import {
  indexAtContentX,
  moveOpenTab,
  orderAtDragTarget,
} from "../src/shell/channelTabOrder.ts";

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

const start = ["a", "b", "c", "d", "e"];
assert(
  JSON.stringify(orderAtDragTarget(start, 0, 4)) ===
    JSON.stringify(["b", "c", "d", "e", "a"]),
  "absolute drag: first → last slot",
);
assert(
  JSON.stringify(orderAtDragTarget(start, 4, 1)) ===
    JSON.stringify(["a", "e", "b", "c", "d"]),
  "absolute drag: last → second slot",
);
assert(
  JSON.stringify(orderAtDragTarget(start, 2, 2)) === JSON.stringify(start),
  "absolute drag: back to start index restores order",
);
// Incremental neighbor swaps must not be required for a far drop:
assert(
  JSON.stringify(orderAtDragTarget(start, 0, 4)) !==
    JSON.stringify(orderAtDragTarget(start, 0, 1)),
  "far target is not a single neighbor step",
);

const boxes = [
  { left: 0, width: 40 },
  { left: 40, width: 40 },
  { left: 80, width: 40 },
  { left: 120, width: 40 },
  { left: 160, width: 40 },
];
assert(indexAtContentX(boxes, 10) === 0, "left of first mid");
assert(indexAtContentX(boxes, 19) === 0, "just before first mid");
assert(indexAtContentX(boxes, 20) === 1, "at/after first mid → second");
assert(indexAtContentX(boxes, 60) === 2, "at/after second mid → third");
assert(indexAtContentX(boxes, 170) === 4, "over last tab → last index");
assert(indexAtContentX(boxes, 200) === 4, "past end → last");
assert(indexAtContentX([], 0) === -1, "empty boxes");

// Frozen-layout far hit: pointer over last mid maps to last index in one shot.
assert(indexAtContentX(boxes, 165) === 4, "far X → drop index 4");
assert(
  JSON.stringify(
    orderAtDragTarget(start, 0, indexAtContentX(boxes, 165)),
  ) === JSON.stringify(["b", "c", "d", "e", "a"]),
  "frozen hit + absolute order = full transfer",
);

console.log("channels.test.ts: ok");
