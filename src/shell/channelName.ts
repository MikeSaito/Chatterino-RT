/** Mirror Rust normalize_channel for client-side join UX (trim, #, lower). */
export function normalizeChannelInput(raw: string): string {
  return raw.trim().replace(/^#+/, "").toLowerCase();
}
