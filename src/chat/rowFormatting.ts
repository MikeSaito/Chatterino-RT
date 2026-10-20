import type { Badge, ChatEvent } from "./types";

export function clampEmoteScale(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.min(2, Math.max(0.5, raw));
}

export function parseCheerColor(raw: string | undefined): number | null {
  const hex = (raw ?? "").trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (m) {
    return Number.parseInt(m[1], 16);
  }
  return null;
}

export function eventLogin(event: ChatEvent): string {
  if (event.kind === "privmsg") {
    return event.login.toLowerCase();
  }
  if (event.kind === "automodHeld") {
    return event.authorLogin.toLowerCase();
  }
  if (event.kind === "usernotice") {
    if (event.login) {
      return event.login.toLowerCase();
    }
    if (event.privmsg && event.privmsg.kind === "privmsg") {
      return event.privmsg.login.toLowerCase();
    }
  }
  return "";
}

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function normalizeEmojiSet(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key === "facebook") {
    return "Facebook";
  }
  if (key === "apple") {
    return "Apple";
  }
  if (key === "google") {
    return "Google";
  }
  return "Twitter";
}

export function shiftSpans<T extends { start: number; end: number }>(spans: T[], shift: number): T[] {
  if (shift === 0) {
    return spans;
  }
  return spans.map((span) => ({
    ...span,
    start: span.start + shift,
    end: span.end + shift,
  }));
}

export function badgesWithUrl(badges: Badge[]): Badge[] {
  const out: Badge[] = [];
  for (const badge of badges) {
    if (!badge.url) {
      continue;
    }
    out.push(badge);
  }
  return out;
}

export function parseHighlight(raw: string): { color: number; alpha: number } | undefined {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(raw);
  if (!m) {
    return undefined;
  }
  const color = Number.parseInt(m[1], 16);
  const alpha = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
  return { color, alpha };
}

export function badgeTooltipText(set: string): string {
  return set
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function clipReplyHeaderToWidth(
  text: string,
  maxPx: number,
  measure: (s: string) => number,
): string {
  const limit = Math.max(4, Math.floor(maxPx));
  if (measure(text) <= limit) {
    return text;
  }
  const ellipsis = "...";
  const ellipsisW = measure(ellipsis);
  const budget = Math.max(0, limit - ellipsisW);
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  let best = ellipsis;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = chars.slice(0, mid).join("");
    if (measure(candidate) <= budget) {
      best = `${candidate}${ellipsis}`;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
