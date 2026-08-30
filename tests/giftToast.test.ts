import {
  GIFT_TOAST_DURATION_MS,
  GIFT_TOAST_MAX_VISIBLE,
  giftToastPayloadFromEvent,
} from "../src/shell/giftToast.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const payload = giftToastPayloadFromEvent({
  channel: "#bratishkinoff",
  msgId: "gift-1",
  login: "Skufishkinoff",
  displayName: "skufishkinoff",
  count: 25.7,
  anon: false,
});

assert(payload !== null, "valid gift accepted");
if (!payload) {
  throw new Error("valid gift accepted");
}
assert(payload.channel === "bratishkinoff", "channel normalized");
assert(payload.login === "skufishkinoff", "login normalized");
assert(payload.displayName === "skufishkinoff", "display name preserved");
assert(payload.count === 25, "count floored");
assert(payload.anon === false, "anon flag");

assert(
  giftToastPayloadFromEvent({
    channel: "x",
    msgId: "gift-2",
    login: "",
    displayName: "Anon",
    count: 10,
    anon: true,
  }) !== null,
  "anon gift without login accepted",
);
assert(
  giftToastPayloadFromEvent({
    channel: "x",
    msgId: "gift-3",
    login: "a",
    displayName: "A",
    count: 0,
    anon: false,
  }) === null,
  "zero count rejected",
);
assert(
  giftToastPayloadFromEvent({
    channel: "x",
    msgId: "gift-4",
    login: "",
    displayName: "A",
    count: 5,
    anon: false,
  }) === null,
  "missing login rejected for non-anon",
);
assert(GIFT_TOAST_DURATION_MS === 10_000, "duration 10s");
assert(GIFT_TOAST_MAX_VISIBLE === 4, "max visible 4");

console.log("gift toast tests ok");
