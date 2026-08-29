import { moveOpenTab } from "../src/shell/channelTabOrder.ts";

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

console.log("channels.test.ts: ok");
