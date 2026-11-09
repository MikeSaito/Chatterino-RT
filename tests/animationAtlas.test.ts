import assert from "node:assert/strict";
import { animationAtlasLayout, ANIMATION_ATLAS_MAX_PIXELS, ANIMATION_ATLAS_MAX_SIDE } from "../src/chat/animationAtlas.ts";

for (const [width, height, count] of [[32, 32, 8], [1, 1, 24], [128, 72, 24], [500, 250, 4]]) {
  const page = animationAtlasLayout(width, height, count);
  assert.ok(page);
  assert.ok(page.width <= ANIMATION_ATLAS_MAX_SIDE && page.height <= ANIMATION_ATLAS_MAX_SIDE);
  assert.ok(page.width * page.height <= ANIMATION_ATLAS_MAX_PIXELS);
  const cells = new Set();
  for (let i = 0; i < count; i++) {
    const x: number = (i % page.columns) * page.cellWidth;
    const y: number = Math.floor(i / page.columns) * page.cellHeight;
    assert.ok(x + width + 2 <= page.width && y + height + 2 <= page.height);
    cells.add(`${x}:${y}`);
  }
  assert.equal(cells.size, count);
}
assert.equal(animationAtlasLayout(32, 32, 8)!.width * animationAtlasLayout(32, 32, 8)!.height, 34 * 34 * 8);
for (const input of [[2048, 1, 2], [1024, 1024, 2], [0, 10, 2], [10, -1, 2], [10, 10, 1], [10, 10, 25], [NaN, 10, 2], [1.5, 10, 2]]) {
  assert.equal(animationAtlasLayout(...input as [number, number, number]), null);
}
console.log("animation atlas tests ok");
