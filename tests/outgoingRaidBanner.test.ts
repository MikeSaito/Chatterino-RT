import {
  OUTGOING_RAID_DURATION_MS,
  formatRaidCountdown,
  outgoingRaidPayloadFromEvent,
  parseOutgoingRaidIntent,
} from "../src/shell/outgoingRaidBanner.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const intent = parseOutgoingRaidIntent("MyChannel", "/raid TargetUser", 1_000);
assert(intent !== null, "raid intent parsed");
if (!intent) {
  throw new Error("raid intent parsed");
}
assert(intent.channel === "mychannel", "intent channel lower");
assert(intent.login === "targetuser", "intent login lower");
assert(intent.displayName === "TargetUser", "intent display preserved");
assert(parseOutgoingRaidIntent("x", "/me hi") === null, "non-raid ignored");
assert(parseOutgoingRaidIntent("x", "/unraid") === null, "unraid not intent");
assert(
  parseOutgoingRaidIntent("x", ".raid Other", 2_000)?.login === "other",
  "dot-raid intent",
);

const active = outgoingRaidPayloadFromEvent(
  {
    channel: "#Mine",
    active: true,
    targetLogin: "TargetUser",
    targetDisplayName: "TargetUser",
    startedAtMs: 5_000,
    durationMs: 90_000,
  },
  intent,
  5_500,
);
assert(active !== null, "active payload accepted");
if (!active) {
  throw new Error("active payload accepted");
}
assert(active.channel === "mine", "channel normalized");
assert(active.targetLogin === "targetuser", "login normalized");
assert(active.durationMs === OUTGOING_RAID_DURATION_MS, "duration kept");

assert(
  outgoingRaidPayloadFromEvent({ channel: "mine", active: false }) === null,
  "inactive payload rejected",
);
assert(
  outgoingRaidPayloadFromEvent({
    channel: "mine",
    active: true,
    targetLogin: "",
  }) === null,
  "missing target rejected",
);

assert(formatRaidCountdown(90_000) === "1:30", "90s format");
assert(formatRaidCountdown(5_100) === "0:06", "ceil seconds");
assert(formatRaidCountdown(0) === "0:00", "zero format");

console.log("outgoing raid banner tests ok");
