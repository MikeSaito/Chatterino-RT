import {
  durationSeconds,
  formatTimeoutLabel,
  moderationSlashCommand,
  parseTimeoutButtons,
} from "../src/shell/timeoutButtons.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(durationSeconds(1, "s") === 1, "1s");
assert(durationSeconds(30, "s") === 30, "30s");
assert(durationSeconds(1, "m") === 60, "1m");
assert(durationSeconds(5, "m") === 300, "5m");
assert(durationSeconds(1, "h") === 3600, "1h");
assert(durationSeconds(1, "d") === 86400, "1d");
assert(durationSeconds(1, "w") === 604800, "1w");
assert(durationSeconds(0, "s") === null, "zero");
assert(durationSeconds(1, "x") === null, "bad unit");
assert(durationSeconds(100, "s") === null, "over 99");

assert(formatTimeoutLabel(30, "m") === "30m", "label");

const defaults = parseTimeoutButtons({});
assert(defaults.length === 8, "default count");
assert(defaults[0]!.label === "1s" && defaults[0]!.seconds === 1, "def0");
assert(defaults[7]!.label === "1w" && defaults[7]!.seconds === 604800, "def7");

const custom = parseTimeoutButtons({
  "timeouts.button1.duration": 2,
  "timeouts.button1.unit": "m",
  "timeouts.button2.duration": 0,
  "timeouts.button2.unit": "s",
});
assert(custom[0]!.seconds === 120, "custom 2m");
assert(custom.every((b) => b.seconds >= 1), "skip invalid");

assert(moderationSlashCommand("timeout", "Bob", 60) === "/timeout bob 60", "to");
assert(moderationSlashCommand("ban", "bob") === "/ban bob", "ban");
assert(moderationSlashCommand("unban", "bob") === "/unban bob", "unban");
assert(moderationSlashCommand("timeout", "", 1) === null, "empty");
assert(moderationSlashCommand("timeout", "bad name", 1) === null, "space");
assert(moderationSlashCommand("timeout", "bob", 0) === null, "secs");
assert(moderationSlashCommand("mod", "bob") === "/mod bob", "mod");
assert(moderationSlashCommand("unmod", "bob") === "/unmod bob", "unmod");
assert(moderationSlashCommand("vip", "bob") === "/vip bob", "vip");
assert(moderationSlashCommand("unvip", "bob") === "/unvip bob", "unvip");

console.log("timeoutButtons tests ok");
