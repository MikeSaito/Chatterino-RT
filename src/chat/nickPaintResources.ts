import { Texture, type Sprite, type BitmapText } from "pixi.js";
import { paintCacheKey, rasterizeNickPaint } from "./nickPaint";
import { isRenderableTexture } from "./textures";
import type { NickPaint } from "./types";

type NickPaintSlot = {
  root: { visible: boolean }; nick: BitmapText; nickPaintSpr: Sprite;
  nickPaint: NickPaint | null; nickPaintKey: string;
};

/** Owns nickname paint textures, their LRU and detachment before GPU destruction. */
export class NickPaintResources {
  private textures = new Map<string, Texture>();
  private order: string[] = [];
  private slots: () => readonly NickPaintSlot[];
  private limit: number;
  constructor(slots: () => readonly NickPaintSlot[], limit = 64) { this.slots = slots; this.limit = limit; }
  /** Show gradient Sprite or keep BitmapText; returns nick column width (BitmapText). */
  apply(slot: NickPaintSlot, contentY: number, options: {
    fontFamily: string; fontWeight: number; fontSize: number; measure: (text: string) => number;
  }): number {
    const text = slot.nick.text;
    const baseW = Math.max(
      options.measure(text),
      8,
    );
    if (!slot.nickPaint || !text) {
      slot.nick.visible = true;
      slot.nickPaintSpr.visible = false;
      slot.nickPaintSpr.texture = Texture.EMPTY;
      slot.nickPaintKey = "";
      return baseW;
    }
    const family = options.fontFamily || "Segoe UI";
    const weight = options.fontWeight;
    const key = paintCacheKey(
      slot.nickPaint,
      text,
      options.fontSize,
      family,
      weight,
    );
    if (
      key === slot.nickPaintKey &&
      slot.nickPaintSpr.visible &&
      isRenderableTexture(slot.nickPaintSpr.texture)
    ) {
      this.touch(key);
      const pad =
        (slot.nickPaintSpr.texture as Texture & { __crtPad?: number })
          .__crtPad ?? 1;
      slot.nickPaintSpr.x = slot.nick.x - pad;
      slot.nickPaintSpr.y = contentY - pad;
      slot.nick.visible = false;
      return baseW;
    }
    let tex = this.textures.get(key);
    if (tex && !isRenderableTexture(tex)) {
      this.textures.delete(key);
      const stale = this.order.indexOf(key);
      if (stale >= 0) {
        this.order.splice(stale, 1);
      }
      tex = undefined;
    }
    let pad = 1;
    if (!tex) {
      const raster = rasterizeNickPaint({
        paint: slot.nickPaint,
        text,
        fontSize: options.fontSize,
        fontFamily: family,
        fontWeight: weight,
      });
      if (!raster) {
        slot.nick.visible = true;
        slot.nickPaintSpr.visible = false;
        slot.nickPaintSpr.texture = Texture.EMPTY;
        slot.nickPaintKey = "";
        return baseW;
      }
      pad = raster.pad;
      tex = Texture.from(raster.canvas);
      (tex as Texture & { __crtPad?: number }).__crtPad = pad;
      this.textures.set(key, tex);
      this.order.push(key);
      this.evict();
    } else {
      pad = (tex as Texture & { __crtPad?: number }).__crtPad ?? 1;
      this.touch(key);
    }
    if (!isRenderableTexture(tex)) {
      slot.nick.visible = true;
      slot.nickPaintSpr.visible = false;
      slot.nickPaintSpr.texture = Texture.EMPTY;
      slot.nickPaintKey = "";
      return baseW;
    }
    slot.nickPaintKey = key;
    slot.nickPaintSpr.texture = tex;
    slot.nickPaintSpr.x = slot.nick.x - pad;
    slot.nickPaintSpr.y = contentY - pad;
    slot.nickPaintSpr.visible = true;
    slot.nick.visible = false;
    return baseW;
  }

  touch(key: string): void {
    const at = this.order.indexOf(key);
    if (at >= 0) {
      this.order.splice(at, 1);
    }
    this.order.push(key);
  }

  private evict(): void {
    let guard = this.order.length;
    while (
      this.order.length > this.limit &&
      guard > 0
    ) {
      guard -= 1;
      const old = this.order.shift();
      if (!old) {
        break;
      }
      let pinnedVisible = false;
      for (const slot of this.slots()) {
        if (
          slot.nickPaintKey === old &&
          slot.nickPaintSpr.visible &&
          slot.root.visible
        ) {
          pinnedVisible = true;
          break;
        }
      }
      if (pinnedVisible) {
        this.order.push(old);
        continue;
      }
      const doomed = this.textures.get(old);
      this.textures.delete(old);
      for (const slot of this.slots()) {
        if (slot.nickPaintKey !== old && slot.nickPaintSpr.texture !== doomed) {
          continue;
        }
        slot.nickPaintKey = "";
        slot.nickPaintSpr.visible = false;
        slot.nickPaintSpr.texture = Texture.EMPTY;
        if (slot.nick.text) {
          slot.nick.visible = true;
        }
      }
      if (doomed && doomed !== Texture.EMPTY) {
        try {
          doomed.destroy(true);
        } catch {
          /* already gone */
        }
      }
    }
  }

  clear(): void {
    for (const slot of this.slots()) {
      slot.nickPaintKey = "";
      slot.nickPaintSpr.visible = false;
      slot.nickPaintSpr.texture = Texture.EMPTY;
      slot.nick.visible = true;
    }
    for (const tex of this.textures.values()) {
      if (tex !== Texture.EMPTY) {
        try {
          tex.destroy(true);
        } catch {
          /* */
        }
      }
    }
    this.textures.clear();
    this.order.length = 0;
  }

}
