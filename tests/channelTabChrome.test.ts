import {
  normalizeTabLive,
  tabAvatarLetter,
  tabLiveVisible,
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
assert(tabLiveVisible(true, true) === true, "live + knob on");
assert(tabLiveVisible(true, false) === false, "live + knob off");
assert(tabLiveVisible(false, true) === false, "offline + knob on");
assert(tabLiveVisible(undefined, true) === false, "unknown + knob on");

console.log("channelTabChrome.test.ts: ok");
