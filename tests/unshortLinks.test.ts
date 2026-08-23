import { openUrlForChatLink } from "../src/shell/emoteTooltip.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const short = "https://t.co/abc";
assert(
  openUrlForChatLink(short, false) === short,
  "knob off keeps original",
);
assert(
  openUrlForChatLink(short, true) === short,
  "knob on without cache keeps original",
);

console.log("unshortLinks.test.ts: ok");
