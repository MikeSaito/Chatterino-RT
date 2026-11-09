import { Rectangle, Texture, TextureSource } from "pixi.js";
import { animationAtlasLayout } from "./animationAtlas.ts";
import { destroyTextureFrames } from "./textureFrames.ts";

function ownedBitmapSource(bitmap: ImageBitmap): TextureSource {
  try {
    const source = TextureSource.from(bitmap);
    source.once("destroy", () => bitmap.close());
    return source;
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

export function ownedBitmapTexture(bitmap: ImageBitmap): Texture {
  const source = ownedBitmapSource(bitmap);
  try {
    return new Texture({ source });
  } catch (error) {
    source.destroy();
    throw error;
  }
}

/** The input bitmaps stay owned by the caller, including on a packing failure. */
export async function packAnimationFrames(bitmaps: readonly ImageBitmap[]): Promise<Texture[] | null> {
  const first = bitmaps[0];
  if (!first) return null;
  const layout = animationAtlasLayout(first.width, first.height, bitmaps.length);
  if (!layout || bitmaps.some((bitmap) => bitmap.width !== first.width || bitmap.height !== first.height)) return null;
  let canvas: HTMLCanvasElement | undefined;
  let source: TextureSource | undefined;
  const frames: Texture[] = [];
  try {
    canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingEnabled = false;
    const w = first.width, h = first.height;
    for (let i = 0; i < bitmaps.length; i++) {
      const x = (i % layout.columns) * layout.cellWidth + 1;
      const y = Math.floor(i / layout.columns) * layout.cellHeight + 1;
      const bitmap = bitmaps[i];
      context.drawImage(bitmap, x, y);
      context.drawImage(bitmap, 0, 0, w, 1, x, y - 1, w, 1);
      context.drawImage(bitmap, 0, h - 1, w, 1, x, y + h, w, 1);
      context.drawImage(bitmap, 0, 0, 1, h, x - 1, y, 1, h);
      context.drawImage(bitmap, w - 1, 0, 1, h, x + w, y, 1, h);
      context.drawImage(bitmap, 0, 0, 1, 1, x - 1, y - 1, 1, 1);
      context.drawImage(bitmap, w - 1, 0, 1, 1, x + w, y - 1, 1, 1);
      context.drawImage(bitmap, 0, h - 1, 1, 1, x - 1, y + h, 1, 1);
      context.drawImage(bitmap, w - 1, h - 1, 1, 1, x + w, y + h, 1, 1);
    }
    source = ownedBitmapSource(await createImageBitmap(canvas));
    for (let i = 0; i < bitmaps.length; i++) {
      const frame = new Rectangle((i % layout.columns) * layout.cellWidth + 1,
        Math.floor(i / layout.columns) * layout.cellHeight + 1, w, h);
      frames.push(new Texture({ source, frame }));
    }
    return frames;
  } catch {
    if (frames.length) destroyTextureFrames(frames);
    else source?.destroy();
    return null;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
