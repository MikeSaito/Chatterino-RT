import {
  snapshotModChannel,
  userCardModChannelMatches,
} from "../src/shell/modChannelBind.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(snapshotModChannel("  #FooBar  ") === "foobar", "normalize");
assert(snapshotModChannel("") === "", "empty");
assert(userCardModChannelMatches("alpha", "alpha"), "match");
assert(userCardModChannelMatches("#Alpha", "ALPHA"), "case");
assert(!userCardModChannelMatches("alpha", "beta"), "mismatch");
assert(!userCardModChannelMatches("", "alpha"), "no open");
assert(!userCardModChannelMatches("alpha", ""), "no active");

console.log("modChannelBind.test.ts ok");
