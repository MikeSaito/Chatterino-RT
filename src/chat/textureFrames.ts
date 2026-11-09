import { Texture } from "pixi.js";

/** Detach all consumers before releasing frame views and their unshared sources. */
export function destroyTextureFrames(frames: readonly Texture[], keep: readonly Texture[] = [], beforeDestroy?: (textures: Texture[]) => void): void {
  const kept = new Set(keep);
  const keptSources = new Set(keep.map((texture) => texture.source));
  const doomed = [...new Set(frames)].filter((texture) => texture !== Texture.EMPTY && !kept.has(texture));
  if (!doomed.length) return;
  const sources = new Set(doomed.map((texture) => texture.source).filter((source) => source && !keptSources.has(source)));
  beforeDestroy?.(doomed);
  for (const texture of doomed) {
    try { if (!texture.destroyed) texture.destroy(false); } catch { /* Release the remaining owners even if a listener fails. */ }
  }
  for (const source of sources) {
    try { if (!source.destroyed) source.destroy(); } catch { /* Continue releasing other sources. */ }
  }
}
