import {
  cycleChannelIndex,
  cycleFocusIndex,
} from "../src/shell/focusTrap.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(cycleFocusIndex(-1, 3, false) === 0, "tab empty focus -> first");
assert(cycleFocusIndex(-1, 3, true) === 2, "shift-tab empty -> last");
assert(cycleFocusIndex(0, 3, false) === 1, "tab mid");
assert(cycleFocusIndex(2, 3, false) === 0, "tab wrap");
assert(cycleFocusIndex(0, 3, true) === 2, "shift wrap");
assert(cycleFocusIndex(1, 3, true) === 0, "shift mid");
assert(cycleFocusIndex(0, 0, false) === -1, "empty list");
assert(cycleFocusIndex(5, 3, false) === 0, "out of range forward");
assert(cycleFocusIndex(5, 3, true) === 2, "out of range back");

assert(cycleChannelIndex(0, 3, false) === 1, "ctrl-tab next");
assert(cycleChannelIndex(2, 3, false) === 0, "ctrl-tab wrap");
assert(cycleChannelIndex(0, 3, true) === 2, "ctrl-shift-tab wrap");
assert(cycleChannelIndex(1, 3, true) === 0, "ctrl-shift-tab prev");
assert(cycleChannelIndex(0, 1, false) === 0, "single channel");
assert(cycleChannelIndex(0, 0, false) === -1, "no channels");
assert(cycleChannelIndex(4, 3, false) === 2, "large index mod");

console.log("focusTrap tests ok");
