import { Container, Sprite, Texture } from "pixi.js";
import {
  isRenderableTexture,
  sanitizeStageSprites,
} from "../src/chat/textureGuards.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(!isRenderableTexture(null), "null");
assert(!isRenderableTexture(undefined), "undefined");
assert(!isRenderableTexture(Texture.EMPTY), "EMPTY");

const destroyedTex = { destroyed: true } as Texture;
assert(!isRenderableTexture(destroyedTex), "destroyed texture");

const noSource = {} as Texture;
assert(!isRenderableTexture(noSource), "missing source");

const deadSource = { _source: { destroyed: true } } as unknown as Texture;
assert(!isRenderableTexture(deadSource), "destroyed source");

const live = {
  _source: { alphaMode: "premultiply-alpha-on-upload" },
} as unknown as Texture;
assert(isRenderableTexture(live), "live mock texture");

const noAlpha = {
  _source: { alphaMode: null },
} as unknown as Texture;
assert(!isRenderableTexture(noAlpha), "missing alphaMode");

const stage = new Container();
const liveSpr = new Sprite({
  texture: live,
  visible: true,
} as unknown as ConstructorParameters<typeof Sprite>[0]);
const deadSpr = new Sprite({
  texture: deadSource,
  visible: true,
} as unknown as ConstructorParameters<typeof Sprite>[0]);
stage.addChild(liveSpr, deadSpr);
sanitizeStageSprites(stage);
assert(deadSpr.texture === Texture.EMPTY, "dead sprite cleansed");
assert(!deadSpr.visible, "dead sprite hidden");
assert(liveSpr.texture === live, "live sprite untouched");

console.log("isRenderableTexture tests ok");
