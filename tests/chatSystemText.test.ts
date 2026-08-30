import {
  formatDuration,
  formatBitsThreshold,
  clearchatText,
  usernoticeFormatted,
  noticeFormatted,
} from "../src/chat/chatSystemText.ts";
import { setLocale } from "../src/i18n/index.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(formatDuration(60) === "1m", "60s");
assert(formatDuration(3661) === "1h 1m 1s", "3661");
assert(formatDuration(90_000) === "1d 1h", "90000");
assert(formatBitsThreshold(1000) === "1K", "bits");
assert(formatBitsThreshold(5000) === "5K", "bits5");
assert(formatBitsThreshold(999) === "0K", "bits under 1K");
assert(formatBitsThreshold(0) === "0K", "bits zero");

setLocale("en");
assert(
  clearchatText("bob", 60) === "bob timed out for 1m",
  `clearchat en got ${clearchatText("bob", 60)}`,
);
assert(
  noticeFormatted({
    text: "You are timed out for 10m.",
    msgId: "msg_timedout",
    timeoutRemainingSec: 600,
  }).text === "You are timed out for 10m.",
  "notice timedout",
);

const gift = usernoticeFormatted({
  systemText: "fallback",
  login: "gifter",
  msgId: "subgift",
  params: {
    displayName: "Gifter",
    login: "gifter",
    giftMonths: 3,
    plan: "1000",
    recipientDisplayName: "Bob",
    recipientLogin: "bob",
    senderCount: 10,
  },
});
assert(
  gift.text ===
    "Gifter gifted 3 months of a Tier 1 sub to Bob! They've gifted 10 months in the channel.",
  `gift text: ${gift.text}`,
);
assert(gift.mentions.some((m) => m.login === "gifter"), "gifter mention");
assert(gift.mentions.some((m) => m.login === "bob"), "bob mention");

const bits = usernoticeFormatted({
  systemText: "x",
  login: "ann",
  msgId: "bitsbadgetier",
  params: { displayName: "Ann", login: "ann", bitsThreshold: 1000 },
});
assert(
  bits.text === "Ann just earned a new 1K Bits badge!",
  `bits: ${bits.text}`,
);

const multi = usernoticeFormatted({
  systemText: "x",
  login: "ann",
  msgId: "sub",
  params: {
    displayName: "Ann",
    login: "ann",
    plan: "1000",
    multimonthTenure: 0,
    multimonthDuration: 3,
  },
});
assert(
  multi.text === "Ann subscribed at Tier 1 for 3 months in advance!",
  `multi: ${multi.text}`,
);

setLocale("ru");
assert(
  clearchatText("bob", 60) === "bob тайм-аут 1m",
  `clearchat ru: ${clearchatText("bob", 60)}`,
);

setLocale("en");
console.log("chatSystemText tests ok");
