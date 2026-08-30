import {
  normalizeTabLive,
  tabAvatarLetter,
} from "../src/shell/channelTabChrome.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(tabAvatarLetter("bratishkinoff") === "B", "letter from login");
assert(tabAvatarLetter("  xqc  ") === "X", "trim + upper");
assert(tabAvatarLetter("") === "", "empty");
assert(normalizeTabLive(true) === true, "live true");
assert(normalizeTabLive(false) === false, "live false");
assert(normalizeTabLive(undefined) === false, "live undefined");
assert(normalizeTabLive(null) === false, "live null");

console.log("channelTabChrome.test.ts: ok");
