/** CDN scale links for emote/badge context menu (stock addEmoteContextMenuItems). */

export type EmoteImageLink = {
  factor: number;
  url: string;
};

export type DeriveEmoteScaleUrlsOpts = {
  provider?: string;
  kind?: "emote" | "badge";
};

function safeDerivedUrl(base: URL, nextPath: string): string | null {
  if (nextPath.includes("..")) {
    return null;
  }
  if (base.protocol !== "https:") {
    return null;
  }
  if (base.username || base.password) {
    return null;
  }
  try {
    const out = new URL(nextPath, base);
    if (out.protocol !== "https:") {
      return null;
    }
    if (out.host !== base.host) {
      return null;
    }
    if (out.pathname.includes("..")) {
      return null;
    }
    return out.href;
  } catch {
    return null;
  }
}

function dedupeLinks(links: EmoteImageLink[]): EmoteImageLink[] {
  const seen = new Set<string>();
  const out: EmoteImageLink[] = [];
  for (const link of links.sort((a, b) => a.factor - b.factor)) {
    if (seen.has(link.url)) {
      continue;
    }
    seen.add(link.url);
    out.push(link);
  }
  return out;
}

function twitchEmoteLinks(url: URL): EmoteImageLink[] | null {
  const m = url.pathname.match(/^(\/emoticons\/v2\/[^/]+\/[^/]+\/[^/]+\/)([\d.]+)$/);
  if (!m) {
    return null;
  }
  const [, prefix, scale] = m;
  if (scale !== "1.0") {
    return null;
  }
  const links: EmoteImageLink[] = [{ factor: 1, url: url.href }];
  for (const [factor, nextScale] of [
    [2, "2.0"],
    [3, "3.0"],
  ] as const) {
    const next = safeDerivedUrl(url, `${prefix}${nextScale}`);
    if (next) {
      links.push({ factor, url: next });
    }
  }
  return links.length > 1 ? links : null;
}

function bttvEmoteLinks(url: URL): EmoteImageLink[] | null {
  const m = url.pathname.match(/^(\/emote\/[^/]+\/)(1x)$/);
  if (!m) {
    return null;
  }
  const [, prefix] = m;
  const links: EmoteImageLink[] = [{ factor: 1, url: url.href }];
  for (const factor of [2, 3] as const) {
    const next = safeDerivedUrl(url, `${prefix}${factor}x`);
    if (next) {
      links.push({ factor, url: next });
    }
  }
  return links.length > 1 ? links : null;
}

function ffzEmoteLinks(url: URL): EmoteImageLink[] | null {
  const m = url.pathname.match(/^(\/emote\/[^/]+\/)(1)$/);
  if (!m) {
    return null;
  }
  const [, prefix] = m;
  const links: EmoteImageLink[] = [{ factor: 1, url: url.href }];
  for (const factor of [2, 4] as const) {
    const next = safeDerivedUrl(url, `${prefix}${factor}`);
    if (next) {
      links.push({ factor, url: next });
    }
  }
  return links.length > 1 ? links : null;
}

function seventvEmoteLinks(url: URL): EmoteImageLink[] | null {
  const file = url.pathname.split("/").pop() ?? "";
  const m = file.match(/^(1x(?:_static)?)(\.[^/]+)$/);
  if (!m) {
    return null;
  }
  const [, oneX, suffix] = m;
  const dir = url.pathname.slice(0, url.pathname.length - file.length);
  const links: EmoteImageLink[] = [{ factor: 1, url: url.href }];
  for (const factor of [2, 3, 4] as const) {
    const stem = oneX.replace(/^1x/, `${factor}x`);
    const next = safeDerivedUrl(url, `${dir}${stem}${suffix}`);
    if (next) {
      links.push({ factor, url: next });
    }
  }
  return links.length > 1 ? links : null;
}

function cheerLinks(url: URL): EmoteImageLink[] | null {
  const m = url.pathname.match(/^(.+\/static\/)(1)(\/[^/]+)$/);
  if (!m) {
    return null;
  }
  const [, prefix, , tail] = m;
  const links: EmoteImageLink[] = [{ factor: 1, url: url.href }];
  for (const factor of [2, 4] as const) {
    const next = safeDerivedUrl(url, `${prefix}${factor}${tail}`);
    if (next) {
      links.push({ factor, url: next });
    }
  }
  return links.length > 1 ? links : null;
}

function twitchBadgeLinks(url: URL): EmoteImageLink[] | null {
  const m = url.pathname.match(/^(\/badges\/v1\/[^/]+\/)(1)$/);
  if (!m) {
    return null;
  }
  const [, prefix] = m;
  const links: EmoteImageLink[] = [{ factor: 1, url: url.href }];
  for (const factor of [2, 4] as const) {
    const next = safeDerivedUrl(url, `${prefix}${factor}`);
    if (next) {
      links.push({ factor, url: next });
    }
  }
  return links.length > 1 ? links : null;
}

function deriveByHost(url: URL, opts?: DeriveEmoteScaleUrlsOpts): EmoteImageLink[] | null {
  const host = url.host;
  if (host === "static-cdn.jtvnw.net") {
    if (url.pathname.includes("/emoticons/v2/")) {
      return twitchEmoteLinks(url);
    }
    if (opts?.kind === "badge" && url.pathname.includes("/badges/v1/")) {
      return twitchBadgeLinks(url);
    }
    return null;
  }
  if (host === "cdn.betterttv.net" && url.pathname.startsWith("/emote/")) {
    return bttvEmoteLinks(url);
  }
  if (
    (host === "cdn.frankerfacez.com" || host === "cdn.frankerfacez.net") &&
    url.pathname.startsWith("/emote/")
  ) {
    return ffzEmoteLinks(url);
  }
  if (host === "cdn.7tv.app" && url.pathname.startsWith("/emote/")) {
    return seventvEmoteLinks(url);
  }
  if (host.endsWith("cloudfront.net") && url.pathname.includes("/static/")) {
    return cheerLinks(url);
  }
  return null;
}

/** Derive 1x–4x CDN links from the loaded image URL (stock ImageSet submenu). */
export function deriveEmoteScaleUrls(
  rawUrl: string,
  opts?: DeriveEmoteScaleUrlsOpts,
): EmoteImageLink[] {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [{ factor: 1, url: trimmed }];
  }
  if (parsed.protocol !== "https:") {
    return [{ factor: 1, url: trimmed }];
  }
  const derived = deriveByHost(parsed, opts);
  if (!derived || derived.length === 0) {
    return [{ factor: 1, url: parsed.href }];
  }
  return dedupeLinks(derived);
}

/** Stock submenu label: `1x link`, `2x link`, … */
export function emoteScaleLinkLabel(factor: number): string {
  return `${factor}x link`;
}
