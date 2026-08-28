import { normalizeChannelInput } from "../src/shell/channelName.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(normalizeChannelInput("  Mike_Saito  ") === "mike_saito", "trim+lower");
assert(normalizeChannelInput("#XQC") === "xqc", "strip one #");
assert(normalizeChannelInput("##foo_bar") === "foo_bar", "strip many #");
assert(normalizeChannelInput("") === "", "empty");
assert(normalizeChannelInput("   ") === "", "whitespace only");
assert(normalizeChannelInput("#") === "", "only hash");

console.log("channelName.test.ts ok");
