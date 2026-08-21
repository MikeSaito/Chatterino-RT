/** Last-read indicator knobs (Messages / appearance). */

export type LastReadPattern = "Solid" | "Dotted";

export const DEFAULT_LAST_READ_COLOR = "#7f2026";

export function parseLastReadPattern(raw: unknown): LastReadPattern {
  return String(raw ?? "Solid") === "Dotted" ? "Dotted" : "Solid";
}

/** `#RRGGBB` or `#AARRGGBB` → rgb number; invalid → default. */
export function parseLastReadColor(raw: unknown): number {
  const s = String(raw ?? DEFAULT_LAST_READ_COLOR).trim();
  const hex = s.startsWith("#") ? s.slice(1) : s;
  if (hex.length === 6) {
    const n = parseInt(hex, 16);
    return Number.isFinite(n) ? n : parseInt(DEFAULT_LAST_READ_COLOR.slice(1), 16);
  }
  if (hex.length === 8) {
    const n = parseInt(hex.slice(2), 16);
    return Number.isFinite(n) ? n : parseInt(DEFAULT_LAST_READ_COLOR.slice(1), 16);
  }
  return parseInt(DEFAULT_LAST_READ_COLOR.slice(1), 16);
}
