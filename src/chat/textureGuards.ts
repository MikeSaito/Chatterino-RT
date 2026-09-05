import { BitmapText, Container, Sprite, Texture } from "pixi.js";

type TextureSourceLike = {
  destroyed?: boolean;
  alphaMode?: unknown;
  style?: { destroyed?: boolean } | null;
};

/** То же поле, что читает Pixi Batcher (`texture._source`). */
function textureBatchSource(
  tex: Texture,
): TextureSourceLike | null | undefined {
  return (tex as Texture & { _source?: TextureSourceLike | null })._source;
}

/** True when a Pixi texture is safe to assign to a Sprite (avoids alphaMode crash). */
export function isRenderableTexture(
  tex: Texture | null | undefined,
): tex is Texture {
  if (!tex || tex === Texture.EMPTY) {
    return false;
  }
  const t = tex as Texture & { destroyed?: boolean };
  if (t.destroyed === true) {
    return false;
  }
  const src = textureBatchSource(tex);
  if (!src || src.destroyed === true) {
    return false;
  }
  if (src.style?.destroyed === true) {
    return false;
  }
  // Batcher reads source.alphaMode during break; null source => crash.
  if (src.alphaMode == null) {
    return false;
  }
  return true;
}

/** Detach dead GPU texture refs before Pixi collectRenderables (owner destroys). */
export function cleanseSpriteTexture(spr: Sprite): void {
  if (spr.texture === Texture.EMPTY) {
    return;
  }
  if (!isRenderableTexture(spr.texture)) {
    spr.visible = false;
    spr.texture = Texture.EMPTY;
  }
}

/** Обход всего дерева stage: Pixi батчит все visible Sprite, не только viewport. */
export function sanitizeStageSprites(root: Container): void {
  for (const child of root.children) {
    if (child instanceof Sprite) {
      cleanseSpriteTexture(child);
    }
    if (child instanceof Container) {
      sanitizeStageSprites(child);
    }
  }
}

type BitmapTextGpu = BitmapText & {
  _didTextUpdate?: boolean;
  _gpuData?: Record<number, { destroy?: () => void }>;
};

/** Сброс proxy Graphics после BitmapFont.uninstall (glyph textures в batch). */
export function resetBitmapTextGpu(bt: BitmapText, rendererUid: number): void {
  const node = bt as BitmapTextGpu;
  const proxy = node._gpuData?.[rendererUid];
  if (proxy) {
    try {
      proxy.destroy?.();
    } catch {
      /* already gone */
    }
    delete node._gpuData![rendererUid];
  }
  node._didTextUpdate = true;
}

export function resetBitmapTextGpuTree(
  root: Container,
  rendererUid: number,
): void {
  for (const child of root.children) {
    if (child instanceof BitmapText) {
      resetBitmapTextGpu(child, rendererUid);
    }
    if (child instanceof Container) {
      resetBitmapTextGpuTree(child, rendererUid);
    }
  }
}

/** Снять dead Texture со всех Sprite, которые держат один из doomed. */
export function cleanseSpritesUsingTextures(
  root: Container,
  doomed: ReadonlySet<Texture>,
): void {
  for (const child of root.children) {
    if (child instanceof Sprite) {
      if (doomed.has(child.texture)) {
        cleanseSpriteTexture(child);
      }
    }
    if (child instanceof Container) {
      cleanseSpritesUsingTextures(child, doomed);
    }
  }
}