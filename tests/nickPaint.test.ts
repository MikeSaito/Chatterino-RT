import assert from "node:assert/strict";
import {
  argbToCss,
  paintCacheKey,
  paintRepresentativeRgb,
  type NickPaint,
} from "../src/chat/nickPaint.ts";

const paint: NickPaint = {
  id: "p1",
  angle: 90,
  repeat: false,
  stops: [
    { at: 0, color: 0xffff0000 },
    { at: 10_000, color: 0xff00ff00 },
  ],
  color: 0xff7f7f7f,
};

assert.equal(argbToCss(0xffff0000), "rgba(255,0,0,1)");
assert.equal(argbToCss(0xff000000), "rgba(0,0,0,1)");
assert.equal(paintRepresentativeRgb(paint), 0x7f7f7f);
assert.equal(
  paintCacheKey(paint, "Nick", 14, "Segoe UI", 600),
  "p1|14|Segoe UI|600|Nick",
);

const noColor: NickPaint = {
  id: "p2",
  angle: 0,
  repeat: false,
  stops: [
    { at: 0, color: 0xffff0000 },
    { at: 10_000, color: 0xff0000ff },
  ],
};
assert.equal(paintRepresentativeRgb(noColor), 0x0000ff);

console.log("nickPaint.test.ts: ok");
