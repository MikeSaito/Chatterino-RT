/** Display transform for chat links (stock Chatterino lowercaseDomains). */

export type LinkSpanRange = {
  start: number;
  end: number;
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
  const ordered = spans
    .slice()
    .sort((a, b) => b.start - a.start);
  for (const span of ordered) {
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
