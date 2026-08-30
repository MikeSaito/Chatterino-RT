import {
  RAID_TOAST_DURATION_MS,
  RAID_TOAST_MAX_VISIBLE,
  raidToastPayloadFromEvent,
} from "../src/shell/raidToast.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const payload = raidToastPayloadFromEvent({
  channel: "#xqc",
  msgId: "raid-1",
  login: "BusterBroid",
  displayName: "busterbroid",
  viewerCount: 428.9,
});

assert(payload !== null, "valid raid accepted");
if (!payload) {
  throw new Error("valid raid accepted");
}
assert(payload.channel === "xqc", "channel normalized");
assert(payload.login === "busterbroid", "login normalized");
assert(payload.displayName === "busterbroid", "display name preserved");
assert(payload.viewerCount === 428, "viewer count floored");

assert(
  raidToastPayloadFromEvent({
    channel: "xqc",
    msgId: "raid-2",
    login: "ann",
    displayName: "Ann",
    viewerCount: 0,
  }) === null,
  "zero-viewer raid rejected",
);
assert(
  raidToastPayloadFromEvent({
    channel: "xqc",
    msgId: "raid-3",
    login: "",
    displayName: "Ann",
    viewerCount: 10,
  }) === null,
  "missing login rejected",
);
assert(RAID_TOAST_DURATION_MS === 10_000, "duration 10s");
assert(RAID_TOAST_MAX_VISIBLE === 4, "max visible 4");

console.log("raid toast tests ok");
