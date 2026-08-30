import {
  openUrlForChatLink,
  rememberResolvedUrl,
} from "../src/shell/emoteTooltip.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const short = "https://t.co/abc";
const resolved = "https://example.com/full";

assert(
  openUrlForChatLink(short, false) === short,
  "knob off keeps original",
);
assert(
  openUrlForChatLink(short, true) === short,
  "knob on without cache keeps original",
);

rememberResolvedUrl(short, resolved);
assert(
  openUrlForChatLink(short, true) === resolved,
  "knob on with cache uses resolved",
);
assert(
  openUrlForChatLink(short, false) === short,
  "knob off ignores warm cache",
);
rememberResolvedUrl(short, "javascript:alert(1)");
assert(
  openUrlForChatLink(short, true) === resolved,
  "rejects non-http seed, keeps prior",
);

console.log("unshortLinks.test.ts: ok");
