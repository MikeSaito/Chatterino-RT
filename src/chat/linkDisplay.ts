/** Display transform for chat links (stock Chatterino lowercaseDomains + titles). */

export type LinkSpanRange = {
  start: number;
  end: number;
  url?: string;
};

export type HostSpanRange = {
  start: number;
  end: number;
};

export type LinkTitleSpec = {
  url: string;
  title: string;
  host: string;
};

/**
 * Lowercase only the authority/host of a single link display string.
 * Protocol casing preserved; path/query/fragment unchanged.
 * Returns null if unchanged or if UTF-16 length would change.
 */
export function lowercaseHostInLinkText(text: string): string | null {
  if (!text) {
    return null;
  }
  const protoMatch = /^(https?:\/\/)/i.exec(text);
  if (protoMatch) {
    const proto = protoMatch[1];
    const after = text.slice(proto.length);
    const cut = after.search(/[/?#]/);
    const authority = cut === -1 ? after : after.slice(0, cut);
    const rest = cut === -1 ? "" : after.slice(cut);
    if (!authority) {
      return null;
    }
    const lowerAuth = authority.toLowerCase();
    if (lowerAuth === authority) {
      return null;
    }
    if (lowerAuth.length !== authority.length) {
      return null;
    }
    return proto + lowerAuth + rest;
  }
  // Bare host (no scheme): lowercase authority only.
  const cut = text.search(/[/?#]/);
  const authority = cut === -1 ? text : text.slice(0, cut);
  const rest = cut === -1 ? "" : text.slice(cut);
  if (!authority || (!authority.includes(".") && !authority.includes(":"))) {
    return null;
  }
  const lowerAuth = authority.toLowerCase();
  if (lowerAuth === authority || lowerAuth.length !== authority.length) {
    return null;
  }
  return lowerAuth + rest;
}

/** Apply host lowercasing to all link spans in `text` (end→start). */
export function lowercaseLinkHosts(
  text: string,
  spans: LinkSpanRange[],
): string {
  if (!text || spans.length === 0) {
    return text;
  }
  let out = text;
  for (const span of spans.slice().sort((a, b) => b.start - a.start)) {
    if (
      span.start < 0 ||
      span.end > out.length ||
      span.start >= span.end
    ) {
      continue;
    }
    const slice = out.slice(span.start, span.end);
    const lowered = lowercaseHostInLinkText(slice);
    if (!lowered || lowered.length !== slice.length) {
      continue;
    }
    out = out.slice(0, span.start) + lowered + out.slice(span.end);
  }
  return out;
}

/** Host label for dimmed `(host)` suffix. */
export function hostLabelFromUrl(url: string): string {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, "").toLowerCase() || "link";
  } catch {
    return "link";
  }
}

/** First plain-text line from Chatterino link resolver tooltip. */
export function titleFromLinkTooltip(tooltip: string, fallbackHost: string): string | null {
  const lines = tooltip
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const first = lines[0] ?? "";
  if (!first) {
    return null;
  }
  const clipped = first.length > 160 ? first.slice(0, 160) : first;
  const lower = clipped.toLowerCase();
  if (
    lower === fallbackHost.toLowerCase() ||
    lower.startsWith("http://") ||
    lower.startsWith("https://")
  ) {
    return null;
  }
  return clipped;
}

export type LinkTitleApplyResult = {
  body: string;
  links: Array<{ start: number; end: number; url: string }>;
  hosts: HostSpanRange[];
};

/**
 * Replace link URL text with `title (host)` (title clickable, host dimmed).
 * Remaps later spans by UTF-16 delta (process end→start).
 */
export function applyLinkTitlesToBody(
  source: string,
  links: Array<{ start: number; end: number; url: string }>,
  titles: LinkTitleSpec[],
  remap: Array<{ start: number; end: number }>,
): LinkTitleApplyResult {
  const byUrl = new Map(titles.map((t) => [t.url, t]));
  let body = source;
  const nextLinks: Array<{ start: number; end: number; url: string }> = [];
  const hosts: HostSpanRange[] = [];
  const ordered = links
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => b.start - a.start);

  for (const span of ordered) {
    const spec = byUrl.get(span.url);
    if (!spec || !spec.title) {
      nextLinks.push({ start: span.start, end: span.end, url: span.url });
      continue;
    }
    if (span.start < 0 || span.end > body.length || span.start >= span.end) {
      continue;
    }
    const hostPart = ` (${spec.host})`;
    const replacement = `${spec.title}${hostPart}`;
    const oldLen = span.end - span.start;
    const delta = replacement.length - oldLen;
    body = body.slice(0, span.start) + replacement + body.slice(span.end);
    const titleEnd = span.start + spec.title.length;
    nextLinks.push({ start: span.start, end: titleEnd, url: span.url });
    hosts.push({
      start: titleEnd,
      end: span.start + replacement.length,
    });
    if (delta !== 0) {
      for (const s of remap) {
        if (s.start >= span.end) {
          s.start += delta;
          s.end += delta;
        }
      }
      for (const s of nextLinks) {
        if (s !== nextLinks[nextLinks.length - 1] && s.start >= span.end) {
          s.start += delta;
          s.end += delta;
        }
      }
      for (const s of hosts) {
        if (s !== hosts[hosts.length - 1] && s.start >= span.end) {
          s.start += delta;
          s.end += delta;
        }
      }
    }
  }

  nextLinks.sort((a, b) => a.start - b.start);
  hosts.sort((a, b) => a.start - b.start);
  return { body, links: nextLinks, hosts };
}

export function isTwitchClipUrl(url: string): boolean {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "clips.twitch.tv") {
      return u.pathname.length > 1;
    }
    if (host === "twitch.tv" || host === "m.twitch.tv") {
      return /\/clip\//i.test(u.pathname);
    }
    return false;
  } catch {
    return false;
  }
}
