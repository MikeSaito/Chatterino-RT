import {
  clampRatio,
  clampRatioForStage,
  DEFAULT_PLAYER_CHAT_SPLIT,
  MAX_PLAYER_CHAT_SPLIT,
  MIN_PLAYER_CHAT_SPLIT,
  MIN_PLAYER_PX,
  parsePlayerChatSplit,
  ratioBounds,
  ratioFromPlayerWidth,
} from "../src/shell/stageSplit.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(parsePlayerChatSplit(undefined) === DEFAULT_PLAYER_CHAT_SPLIT, "default");
assert(parsePlayerChatSplit("0.58") === 0.58, "string");
assert(parsePlayerChatSplit(0.1) === MIN_PLAYER_CHAT_SPLIT, "clamp low");
assert(parsePlayerChatSplit(0.99) === MAX_PLAYER_CHAT_SPLIT, "clamp high");
assert(clampRatio(0.5) === 0.5, "mid");

const r = ratioFromPlayerWidth(1000, 580);
assert(Math.abs(r - 580 / 994) < 0.001, `ratio from width ${r}`);

const wide = ratioBounds(2000);
assert(wide.min === MIN_PLAYER_CHAT_SPLIT, `wide min ${wide.min}`);
assert(wide.max === MAX_PLAYER_CHAT_SPLIT, `wide max ${wide.max}`);

const narrow = ratioBounds(800);
assert(narrow.min >= MIN_PLAYER_PX / (800 - 6) - 0.001, `narrow min ${narrow.min}`);
assert(clampRatioForStage(2000, 0.1) === MIN_PLAYER_CHAT_SPLIT, "stage clamp low");
assert(clampRatioForStage(2000, 0.9) === MAX_PLAYER_CHAT_SPLIT, "stage clamp high");

console.log("stageSplit.test.ts: ok");
