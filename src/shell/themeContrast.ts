/** WCAG contrast helpers for theme token audit. */

const AA_TEXT = 4.5;
const AA_UI = 3.0;

export function parseHexRgb(hex: string): { r: number; g: number; b: number } {
  const raw = hex.trim().replace(/^#/, "");
  if (raw.length !== 6) {
    throw new Error(`expected #RRGGBB, got ${hex}`);
  }
  const n = parseInt(raw, 16);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid hex ${hex}`);
  }
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

/** #RRGGBB → Pixi 0xRRGGBB integer. */
export function hexToPixi(hex: string): number {
  const { r, g, b } = parseHexRgb(hex);
  return (r << 16) | (g << 8) | b;
}

function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance (WCAG 2.x), 0–1. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexRgb(hex);
  const R = srgbChannelToLinear(r);
  const G = srgbChannelToLinear(g);
  const B = srgbChannelToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** Contrast ratio of two #RRGGBB colors (≥ 1). */
export function contrastRatio(fg: string, bg: string): number {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function passesAaText(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= AA_TEXT;
}

export function passesAaUi(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= AA_UI;
}

export const WCAG_AA_TEXT = AA_TEXT;
export const WCAG_AA_UI = AA_UI;
