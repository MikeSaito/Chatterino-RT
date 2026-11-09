import { Sprite, type Renderer } from "pixi.js";
import { ownedBitmapTexture, packAnimationFrames } from "../src/chat/packAnimationFrames";
import { destroyTextureFrames } from "../src/chat/textureFrames";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeBitmap(width: number, height: number, color: string): Promise<ImageBitmap> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return createImageBitmap(canvas);
}

export async function checkAnimationAtlas(renderer: Renderer): Promise<void> {
  const colors = ["rgba(230, 40, 20, 0.5)", "rgb(20, 190, 120)"];
  const inputs = await Promise.all(colors.map((color) => makeBitmap(1, 1, color)));
  const frames = await packAnimationFrames(inputs);
  check(frames?.length === 2, "small frames fit one atlas");
  const source = frames[0].source;
  const page = source.resource as ImageBitmap;
  try {
    check(frames.every((frame) => frame.source === source && frame.orig.width === 1 && frame.orig.height === 1),
      "atlas frames share a source and keep their original dimensions");
    for (let i = 0; i < frames.length; i++) {
      const standalone = ownedBitmapTexture(await makeBitmap(1, 1, colors[i]));
      const before = new Sprite(standalone);
      const after = new Sprite(frames[i]);
      before.scale.set(8);
      after.scale.set(8);
      try {
        const expected = renderer.extract.pixels({ target: before, resolution: 2 });
        const actual = renderer.extract.pixels({ target: after, resolution: 2 });
        check(expected.width === actual.width && expected.height === actual.height, "atlas preserves rendered size");
        check(expected.pixels.some((value) => value !== 0), "pixel comparison renders the fixture");
        check(expected.pixels.every((value, index) => Math.abs(value - actual.pixels[index]) <= 1),
          "scaled atlas frames match independent textures, including alpha and edges");
      } finally {
        before.destroy();
        after.destroy();
        destroyTextureFrames([standalone]);
      }
    }
    check(inputs.every((bitmap) => bitmap.width === 1), "packing leaves input bitmaps owned by the caller");
  } finally {
    destroyTextureFrames(frames);
    for (const bitmap of inputs) bitmap.close();
  }
  check(source.destroyed && page.width === 0, "releasing the atlas closes its bitmap");

  const large = await Promise.all(colors.map((color) => makeBitmap(2048, 1, color)));
  try {
    check(await packAnimationFrames(large) === null, "frames that exceed the atlas limit use the fallback");
    check(large.every((bitmap) => bitmap.width === 2048), "fallback can still use the original bitmaps");
  } finally {
    for (const bitmap of large) bitmap.close();
  }
}
