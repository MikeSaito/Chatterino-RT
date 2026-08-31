import { GIF_FRAME_LENGTH, gifFrameDelayMs } from "../src/chat/gifFrameDelay.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(GIF_FRAME_LENGTH === 20, "GIF_FRAME_LENGTH");

// Missing / zero / ≤10 ms → Chrome/Chatterino 100 ms (WebKit 36082)
assert(gifFrameDelayMs(undefined) === 100, "undefined → 100");
assert(gifFrameDelayMs(null) === 100, "null → 100");
assert(gifFrameDelayMs(0) === 100, "0 µs → 100");
assert(gifFrameDelayMs(1_000) === 100, "1 ms → 100");
assert(gifFrameDelayMs(8_000) === 100, "8 ms → 100");
assert(gifFrameDelayMs(10_000) === 100, "10 ms → 100");
assert(gifFrameDelayMs(Number.NaN) === 100, "NaN → 100");
assert(gifFrameDelayMs(Number.POSITIVE_INFINITY) === 100, "Infinity → 100");

// >10 ms: value clamped to ≥ GIF_FRAME_LENGTH
assert(gifFrameDelayMs(11_000) === 20, "11 ms → 20 clamp");
assert(gifFrameDelayMs(20_000) === 20, "20 ms");
assert(gifFrameDelayMs(50_000) === 50, "50 ms");
assert(gifFrameDelayMs(100_000) === 100, "100 ms");
assert(gifFrameDelayMs(250_000) === 250, "250 ms");

console.log("gifFrameDelay.test.ts ok");
