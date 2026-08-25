import { resolveReplyRoot } from "../src/shell/replyRoot.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const chain = [
  { id: "a", login: "root", text: "root msg" },
  { id: "b", login: "mid", text: "mid msg", replyToId: "a" },
  { id: "c", login: "leaf", text: "leaf msg", replyToId: "b" },
];

assert(resolveReplyRoot(chain, "c")?.id === "a", "walk chain to root");
assert(resolveReplyRoot(chain, "a")?.id === "a", "root stays root");
assert(resolveReplyRoot(chain, "missing") === null, "unknown seed");

const trimmed = [
  { id: "b", login: "mid", text: "mid msg", replyToId: "a" },
  { id: "c", login: "leaf", text: "leaf msg", replyToId: "b" },
];
assert(resolveReplyRoot(trimmed, "c")?.id === "b", "trimmed scrollback stops at b");

console.log("replyRoot.test.ts ok");
