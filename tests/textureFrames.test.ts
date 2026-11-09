import assert from "node:assert/strict";
import { Rectangle, Texture, TextureSource } from "pixi.js";
import { destroyTextureFrames } from "../src/chat/textureFrames.ts";

const source = new TextureSource({ width: 64, height: 32 });
const first = new Texture({ source, frame: new Rectangle(0, 0, 32, 32) });
const second = new Texture({ source, frame: new Rectangle(32, 0, 32, 32) });
let destroyed = 0;
source.on("destroy", () => destroyed++);
destroyTextureFrames([first, first], [second], (doomed) => {
  assert.deepEqual(doomed, [first]);
  assert.equal(first.destroyed, false);
  assert.equal(source.destroyed, false);
});
assert.equal(first.destroyed, true);
assert.equal(source.destroyed, false);
destroyTextureFrames([first, second, Texture.EMPTY]);
assert.equal(second.destroyed, true);
assert.equal(destroyed, 1);
assert.equal(Texture.EMPTY.destroyed, false);

const oldSource = new TextureSource({ width: 4, height: 4 });
const a = new Texture({ source: oldSource });
const b = new Texture({ source: oldSource });
a.destroy(true);
destroyTextureFrames([a, b]);
assert.equal(b.destroyed, true);

const failingSource = new TextureSource({ width: 4, height: 4 });
const failing = new Texture({ source: failingSource });
const sibling = new Texture({ source: failingSource });
failing.on("destroy", () => { throw new Error("consumer listener"); });
destroyTextureFrames([failing, sibling]);
assert.equal(sibling.destroyed, true);
assert.equal(failingSource.destroyed, true);
console.log("texture frame disposal tests ok");
