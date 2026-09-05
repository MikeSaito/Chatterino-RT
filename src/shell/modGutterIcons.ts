/** Canvas-rasterized ban/clock icons for the Pixi mod gutter. */

import { Texture } from "pixi.js";
import { isRenderableTexture } from "../chat/textureGuards";

const cache = new Map<string, Texture>();

export function modGutterIconTexture(
  kind: "ban" | "clock",
  size: number,
  color: string,
): Texture {
  const key = `${kind}:${size}:${color}`;
  const hit = cache.get(key);
  if (hit && isRenderableTexture(hit)) {
    return hit;
  }
  if (hit) {
    cache.delete(key);
  }
  const px = Math.max(12, Math.round(size));
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Texture.EMPTY;
  }
  ctx.clearRect(0, 0, px, px);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, px / 14);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const s = px / 24;
  ctx.save();
  ctx.scale(s, s);
  if (kind === "ban") {
    ctx.beginPath();
    ctx.arc(12, 12, 9, 0, Math.PI * 2);
    ctx.moveTo(5, 5);
    ctx.lineTo(19, 19);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(12, 12, 9, 0, Math.PI * 2);
    ctx.moveTo(12, 7);
    ctx.lineTo(12, 12);
    ctx.lineTo(15, 14);
    ctx.stroke();
  }
  ctx.restore();
  const tex = Texture.from(canvas);
  cache.set(key, tex);
  return tex;
}
