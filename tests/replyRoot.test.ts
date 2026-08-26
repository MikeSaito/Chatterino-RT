import {
  collectReplyThread,
  isInReplyThread,
  resolveReplyRoot,
} from "../src/shell/replyRoot.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const chain = [
  { id: "a", login: "root", text: "root msg" },
  { id: "b", login: "mid", text: "mid msg", replyToId: "a" },
  { id: "c", login: "leaf", text: "leaf msg", replyToId: "b" },
  { id: "d", login: "other", text: "other branch", replyToId: "a" },
];

assert(resolveReplyRoot(chain, "c")?.id === "a", "walk chain to root");
assert(resolveReplyRoot(chain, "a")?.id === "a", "root stays root");
assert(resolveReplyRoot(chain, "missing") === null, "unknown seed");

const trimmed = [
  { id: "b", login: "mid", text: "mid msg", replyToId: "a" },
  { id: "c", login: "leaf", text: "leaf msg", replyToId: "b" },
];
assert(resolveReplyRoot(trimmed, "c")?.id === "b", "trimmed scrollback stops at b");

const collected = collectReplyThread(chain, "c");
assert(collected.map((m) => m.id).join(",") === "a,b,c,d", "collect thread DFS from root");
assert(collectReplyThread(chain, "b").map((m) => m.id).join(",") === "a,b,c,d", "seed mid resolves to same root");

assert(isInReplyThread(chain, "a", "c"), "leaf in thread");
assert(isInReplyThread(chain, "a", "d"), "sibling reply in thread");
assert(!isInReplyThread(chain, "a", "missing"), "unknown not in thread");

const unrelated = [
  { id: "x", login: "x", text: "x" },
  { id: "y", login: "y", text: "y", replyToId: "x" },
];
assert(!isInReplyThread(chain, "a", "y"), "other thread not in chain");

console.log("replyRoot.test.ts ok");
