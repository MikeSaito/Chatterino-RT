import {
  DEFAULT_LAST_READ_COLOR,
  parseLastReadColor,
  parseLastReadPattern,
} from "../src/shell/lastRead.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(parseLastReadPattern("Solid") === "Solid", "Solid");
assert(parseLastReadPattern("Dotted") === "Dotted", "Dotted");
assert(parseLastReadPattern("x") === "Solid", "default pattern");
assert(parseLastReadColor("#7f2026") === 0x7f2026, "rgb");
assert(parseLastReadColor("7f2026") === 0x7f2026, "no hash");
assert(parseLastReadColor("#ff7f2026") === 0x7f2026, "argb");
assert(parseLastReadColor("nope") === 0x7f2026, "fallback");
assert(DEFAULT_LAST_READ_COLOR === "#7f2026", "default hex");

console.log("lastRead tests ok");
