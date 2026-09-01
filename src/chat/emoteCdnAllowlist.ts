/**
 * Defense-in-depth CDN allowlist mirroring Rust `allowed_emote_cdn_url`.
 * Real gate remains Rust + CSP; this blocks obvious bad URLs before fetch/invoke.
 */

const EMOJI_SETS = ["twitter", "facebook", "apple", "google"] as const;

function hasUserinfo(u: URL): boolean {
  return Boolean(u.username || u.password);
}

function pathOk(path: string): boolean {
  return !path.includes("..");
}

function allowedJsdelivrEmoji(path: string): boolean {
  for (const set of EMOJI_SETS) {
    const prefix = `/npm/emoji-datasource-${set}@15.1.2/img/${set}/64/`;
    if (!path.startsWith(prefix)) {
      continue;
    }
    const rest = path.slice(prefix.length);
    if (!rest || rest.includes("/") || !rest.endsWith(".png")) {
      return false;
    }
    const id = rest.slice(0, -".png".length);
    return /^[0-9a-f-]+$/i.test(id);
  }
  return false;
}

/** True when URL matches the emote/badge/cheer/clip CDN allowlist used by Rust. */
export function isAllowedEmoteCdnUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") {
    return false;
  }
  if (hasUserinfo(u)) {
    return false;
  }
  const host = u.hostname;
  const path = u.pathname;
  if (!pathOk(path)) {
    return false;
  }
  if (host === "cdn.betterttv.net") {
    return path.startsWith("/emote/") || path.startsWith("/badge/");
  }
  if (host === "cdn.frankerfacez.com" || host === "cdn.frankerfacez.net") {
    return (
      path.startsWith("/emote/") ||
      path.startsWith("/badge/") ||
      path.startsWith("/room-badge/")
    );
  }
  if (host === "cdn.7tv.app") {
    return path.startsWith("/emote/") || path.startsWith("/badge/");
  }
  if (host === "fourtf.com") {
    return (
      path.startsWith("/chatterino/badges/") &&
      path.toLowerCase().endsWith(".png") &&
      !(path.split("/").pop() ?? "").includes("..")
    );
  }
  if (host === "static-cdn.jtvnw.net") {
    return path.startsWith("/badges/") || path.startsWith("/emoticons/");
  }
  if (host === "d3aqoihi2n8ty8.cloudfront.net") {
    return path.startsWith("/actions/");
  }
  if (host === "cdn.jsdelivr.net") {
    return allowedJsdelivrEmoji(path);
  }
  if (host === "clips-media-assets2.twitch.tv") {
    const lower = path.toLowerCase();
    return (
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".png") ||
      lower.endsWith(".webp") ||
      lower.includes("-preview-")
    );
  }
  if (host.startsWith("media") && host.endsWith(".giphy.com")) {
    const mid = host.slice("media".length, -".giphy.com".length);
    if (/^[0-4]$/.test(mid) && path.startsWith("/media/")) {
      const lower = path.toLowerCase();
      return (
        lower.endsWith(".gif") ||
        lower.includes(".gif?") ||
        lower.endsWith(".webp")
      );
    }
  }
  if (host === "i.giphy.com" && path.startsWith("/media/")) {
    return true;
  }
  return false;
}
