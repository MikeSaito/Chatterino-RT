/** Twitch: animate off → static CDN path. */
export function resolveEmoteUrl(url: string, animate: boolean): string {
  if (animate) {
    return url;
  }
  if (!url.includes("static-cdn.jtvnw.net/emoticons/v2/")) {
    return url;
  }
  return url.replace("/default/", "/static/").replace("/animated/", "/static/");
}
