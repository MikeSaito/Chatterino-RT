import {
  MODAL_CLOSE_MS,
  modalCloseDecision,
  modalCloseFallbackMs,
} from "../src/shell/modalClose.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(MODAL_CLOSE_MS === 120, "close 120ms");
assert(modalCloseDecision(true, false) === "instant", "hidden instant");
assert(modalCloseDecision(false, true) === "instant", "reduced instant");
assert(modalCloseDecision(true, true) === "instant", "both instant");
assert(modalCloseDecision(false, false) === "animate", "animate");
assert(modalCloseFallbackMs(120) === 140, "fallback 140");
assert(modalCloseFallbackMs(200) === 220, "fallback duration+20");

console.log("modalClose tests ok");
