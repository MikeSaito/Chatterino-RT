/** Как Chatterino GIF_FRAME_LENGTH (мс). */
export const GIF_FRAME_LENGTH = 20;

/**
 * Frame delay ms from ImageDecoder/QImageReader, matching Chatterino Image.cpp:
 * browsers use 100 ms when delay ≤ 10 ms; then clamp to ≥ GIF_FRAME_LENGTH.
 * @param durationUs - VideoFrame.duration in microseconds (WebCodecs).
 */
export function gifFrameDelayMs(durationUs: number | undefined | null): number {
  let ms = Math.round((durationUs ?? 0) / 1000);
  if (!Number.isFinite(ms) || ms < 0) {
    ms = 0;
  }
  if (ms <= 10) {
    ms = 100;
  }
  return Math.max(GIF_FRAME_LENGTH, ms);
}
