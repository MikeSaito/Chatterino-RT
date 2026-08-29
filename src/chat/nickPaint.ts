/**
 * 7TV LINEAR_GRADIENT nick paints → canvas texture (Chatterino7 / Extension subset).
 * Color packing is AARRGGBB (alpha in high byte), same as theme.ts parseArgb.
 */

export type NickPaintStop = {
  at: number;
  color: number;
};

export type NickPaintShadow = {
  xTenths: number;
  yTenths: number;
  radiusTenths: number;
  color: number;
};

export type NickPaint = {
  id: string;
  name?: string;
  angle: number;
  repeat: boolean;
  stops: NickPaintStop[];
  color?: number;
  shadow?: NickPaintShadow;
};

/** Unpack 7TV AARRGGBB u32 → CSS rgba. */
export function argbToCss(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  return `rgba(${r},${g},${b},${a})`;
}

/** Solid tint for mentions / cache when gradient present (drop alpha byte). */
export function paintRepresentativeRgb(paint: NickPaint): number {
  const packed =
    paint.color ??
    paint.stops[Math.floor(paint.stops.length / 2)]?.color ??
    paint.stops[0]?.color;
  if (packed === undefined) {
    return 0xffffff;
  }
  return packed & 0xffffff;
}

export function paintCacheKey(
  paint: NickPaint,
  text: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: string | number,
): string {
  return `${paint.id}|${fontSize}|${fontFamily}|${fontWeight}|${text}`;
}

/**
 * Rasterize nick with linear gradient.
 * Returns { canvas, pad } — layout width must stay BitmapText width; pad is
 * shadow bleed drawn outside the nick column (sprite.x = nick.x - pad).
 */
export function rasterizeNickPaint(opts: {
  paint: NickPaint;
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight?: string | number;
}): { canvas: HTMLCanvasElement; pad: number } | null {
  const text = opts.text;
  if (!text) {
    return null;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const weight = opts.fontWeight ?? 600;
  const font = `${weight} ${opts.fontSize}px ${opts.fontFamily}`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const w = Math.max(1, Math.ceil(metrics.width));
  const ascent =
    typeof metrics.actualBoundingBoxAscent === "number"
      ? metrics.actualBoundingBoxAscent
      : opts.fontSize * 0.8;
  const descent =
    typeof metrics.actualBoundingBoxDescent === "number"
      ? metrics.actualBoundingBoxDescent
      : opts.fontSize * 0.2;
  const h = Math.max(1, Math.ceil(ascent + descent + 2));
  const pad = opts.paint.shadow
    ? Math.max(
        2,
        Math.ceil(
          Math.abs(opts.paint.shadow.xTenths) / 10 +
            Math.abs(opts.paint.shadow.yTenths) / 10 +
            opts.paint.shadow.radiusTenths / 10 +
            2,
        ),
      )
    : 1;
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const x0 = pad;
  const y0 = pad + ascent;

  if (opts.paint.shadow) {
    const s = opts.paint.shadow;
    ctx.shadowOffsetX = s.xTenths / 10;
    ctx.shadowOffsetY = s.yTenths / 10;
    ctx.shadowBlur = Math.max(0, s.radiusTenths / 10);
    ctx.shadowColor = argbToCss(s.color);
  }

  const stops = opts.paint.stops;
  if (stops.length >= 2) {
    const rad = (opts.paint.angle * Math.PI) / 180;
    const cx = x0 + w / 2;
    const cy = y0 - ascent / 2;
    const len = Math.max(w, h);
    const dx = Math.cos(rad) * len;
    const dy = Math.sin(rad) * len;
    const grad = ctx.createLinearGradient(cx - dx / 2, cy - dy / 2, cx + dx / 2, cy + dy / 2);
    for (const stop of stops) {
      const t = Math.min(1, Math.max(0, stop.at / 10_000));
      grad.addColorStop(t, argbToCss(stop.color));
    }
    ctx.fillStyle = grad;
  } else {
    const packed = opts.paint.color ?? stops[0]?.color ?? 0xffffffff;
    ctx.fillStyle = argbToCss(packed);
  }
  ctx.fillText(text, x0, y0);
  return { canvas, pad };
}
