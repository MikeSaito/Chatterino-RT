/** Qt QFont weight (1–99, Normal=50) → CSS numeric weight. */
export function qtWeightToCss(qtWeight: number): number {
  const w = Number.isFinite(qtWeight) ? qtWeight : 50;
  const clamped = Math.min(99, Math.max(1, w));
  return Math.min(900, Math.max(100, Math.round(clamped * 8)));
}

/** Pixi TextStyleFontWeight token. */
export function qtWeightToPixi(qtWeight: number):
  | "100"
  | "200"
  | "300"
  | "400"
  | "500"
  | "600"
  | "700"
  | "800"
  | "900" {
  const n = qtWeightToCss(qtWeight);
  const bucket = Math.min(900, Math.max(100, Math.round(n / 100) * 100));
  return String(bucket) as
    | "100"
    | "200"
    | "300"
    | "400"
    | "500"
    | "600"
    | "700"
    | "800"
    | "900";
}

export function clampChatFontSize(size: number): number {
  if (!Number.isFinite(size)) {
    return 10;
  }
  return Math.min(96, Math.max(1, Math.round(size)));
}

export function clampChatFontWeight(weight: number): number {
  if (!Number.isFinite(weight)) {
    return 50;
  }
  return Math.min(999, Math.max(1, Math.round(weight)));
}

export function sanitizeFontFamily(family: string): string {
  const t = family.trim();
  return t.length > 0 ? t : "Segoe UI";
}

export type FontMetrics = {
  charWidth: number;
  lineHeight: number;
};

/** Minimum row height / font size (Chatterino 22px at 15px). Tight actualBoundingBox of "M" clips Й/Ё/g. */
export const LINE_HEIGHT_MIN_RATIO = 22 / 15;

/** Quote CSS font-family for canvas measure (match Pixi non-generic quoting). */
export function cssFontFamily(family: string): string {
  return family
    .split(",")
    .map((part) => {
      const p = part.trim();
      if (!p) {
        return "";
      }
      if (
        /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-monospace)$/i.test(
          p,
        )
      ) {
        return p;
      }
      if (
        (p.startsWith('"') && p.endsWith('"')) ||
        (p.startsWith("'") && p.endsWith("'"))
      ) {
        return p;
      }
      return `"${p.replace(/"/g, "")}"`;
    })
    .filter(Boolean)
    .join(", ");
}

/** Measure wrap metrics for a CSS font at pixel size (canvas). */
export function measureFontMetrics(
  family: string,
  cssWeight: number,
  fontSizePx: number,
): FontMetrics {
  const size = Math.max(1, fontSizePx);
  if (typeof document === "undefined") {
    return {
      charWidth: size * 0.56,
      lineHeight: defaultChatLineHeight(size),
    };
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      charWidth: size * 0.56,
      lineHeight: defaultChatLineHeight(size),
    };
  }
  ctx.font = `${cssWeight} ${size}px ${cssFontFamily(family)}`;
  const latin = ctx.measureText("M");
  // Cyrillic chat: "Ш" is often wider than "M"; underestimating columns skips wrap.
  const cyr = ctx.measureText("Ш");
  const charWidth = Math.max(latin.width, cyr.width, size * 0.56);
  const tall = ctx.measureText("ÉЙЁÅgj|Ш");
  return { charWidth, lineHeight: lineHeightFromMetrics(size, tall) };
}

/** Wrap row without canvas (Chatterino 22px at 15px). Message gap is separate. */
export function defaultChatLineHeight(size: number): number {
  return chatTextRowHeight(size);
}

/** Emote box and wrap row: Chatterino text metrics, no per-line pad. */
export function chatTextRowHeight(size: number): number {
  return Math.max(1, Math.ceil(size * LINE_HEIGHT_MIN_RATIO));
}

function metricBox(m: TextMetrics, size: number): number {
  const fontAscent = m.fontBoundingBoxAscent;
  const fontDescent = m.fontBoundingBoxDescent;
  if (typeof fontAscent === "number" && typeof fontDescent === "number") {
    return fontAscent + fontDescent;
  }
  const ascent =
    typeof m.actualBoundingBoxAscent === "number"
      ? m.actualBoundingBoxAscent
      : size * 0.8;
  const descent =
    typeof m.actualBoundingBoxDescent === "number"
      ? m.actualBoundingBoxDescent
      : size * 0.2;
  return ascent + descent;
}

function lineHeightFromMetrics(size: number, m: TextMetrics): number {
  const floor = Math.ceil(size * LINE_HEIGHT_MIN_RATIO);
  const box = Math.ceil(metricBox(m, size));
  return Math.max(1, Math.max(floor, box));
}

/** Canvas advance for an arbitrary string (column widths; not M-grid). */
export function measureTextWidth(
  family: string,
  cssWeight: number,
  fontSizePx: number,
  text: string,
): number {
  if (!text) {
    return 0;
  }
  const size = Math.max(1, fontSizePx);
  if (typeof document === "undefined") {
    return text.length * size * 0.56;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return text.length * size * 0.56;
  }
  ctx.font = `${cssWeight} ${size}px ${cssFontFamily(family)}`;
  const w = ctx.measureText(text).width;
  return w > 0 ? w : text.length * size * 0.56;
}

/** Atlas raster size: base size at max zoom (4x). */
export function atlasFontSize(baseSize: number): number {
  return Math.max(8, Math.ceil(clampChatFontSize(baseSize) * 4));
}
