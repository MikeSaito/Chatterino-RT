import { TEXTURE_LRU_LIMIT } from "../constants.ts";

/** Full HD CSS-pixel baseline for LRU scaling. */
export const TEXTURE_LRU_AREA_BASELINE = 1920 * 1080;

/** Soft ceiling: never unbounded. */
export const TEXTURE_LRU_LIMIT_MAX = 512;

/**
 * Emote texture LRU capacity from display size.
 * Scales from {@link TEXTURE_LRU_LIMIT} by (cssArea × dpr) / Full HD, clamped [base, max].
 */
export function textureLruLimitForDisplay(opts: {
  dpr: number;
  width: number;
  height: number;
  base?: number;
  max?: number;
}): number {
  const base = opts.base ?? TEXTURE_LRU_LIMIT;
  const max = opts.max ?? TEXTURE_LRU_LIMIT_MAX;
  const dpr = Number.isFinite(opts.dpr) && opts.dpr > 0 ? opts.dpr : 1;
  const w = Number.isFinite(opts.width) && opts.width > 0 ? opts.width : 1;
  const h = Number.isFinite(opts.height) && opts.height > 0 ? opts.height : 1;
  const scale = (w * h * dpr) / TEXTURE_LRU_AREA_BASELINE;
  const raw = Math.round(base * Math.max(1, scale));
  return Math.min(max, Math.max(base, raw));
}
