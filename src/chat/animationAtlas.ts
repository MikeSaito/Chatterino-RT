import { MAX_GIF_FRAMES } from "../constants.ts";

export const ANIMATION_ATLAS_MAX_SIDE = 2048;
export const ANIMATION_ATLAS_MAX_PIXELS = 1024 * 1024;

export type AnimationAtlasLayout = {
  width: number;
  height: number;
  columns: number;
  cellWidth: number;
  cellHeight: number;
};

/** One extruded pixel per edge preserves independent-frame filtering. */
export function animationAtlasLayout(width: number, height: number, count: number): AnimationAtlasLayout | null {
  if (![width, height, count].every(Number.isSafeInteger) || width < 1 || height < 1 || count < 2 || count > MAX_GIF_FRAMES) return null;
  const cellWidth = width + 2, cellHeight = height + 2;
  let best: AnimationAtlasLayout | null = null;
  for (let columns = 1; columns <= count; columns++) {
    const pageWidth = columns * cellWidth, pageHeight = Math.ceil(count / columns) * cellHeight;
    if (pageWidth > ANIMATION_ATLAS_MAX_SIDE || pageHeight > ANIMATION_ATLAS_MAX_SIDE || pageWidth * pageHeight > ANIMATION_ATLAS_MAX_PIXELS) continue;
    if (!best || pageWidth * pageHeight < best.width * best.height ||
        (pageWidth * pageHeight === best.width * best.height && Math.max(pageWidth, pageHeight) < Math.max(best.width, best.height))) {
      best = { width: pageWidth, height: pageHeight, columns, cellWidth, cellHeight };
    }
  }
  return best;
}
