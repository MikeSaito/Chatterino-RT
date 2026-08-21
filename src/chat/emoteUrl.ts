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

const EMOJI_CDN_TWITTER =
  "https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/img/twitter/64";
const EMOJI_CDN_FACEBOOK =
  "https://cdn.jsdelivr.net/npm/emoji-datasource-facebook@15.1.2/img/facebook/64";
const EMOJI_CDN_APPLE =
  "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64";
const EMOJI_CDN_GOOGLE =
  "https://cdn.jsdelivr.net/npm/emoji-datasource-google@15.1.2/img/google/64";

/** emoji-datasource@15.1.2: twitter yes, facebook no. */
const FACEBOOK_MISSING = new Set([
  "0023-fe0f-20e3",
  "002a-fe0f-20e3",
  "0030-fe0f-20e3",
  "0031-fe0f-20e3",
  "0032-fe0f-20e3",
  "0033-fe0f-20e3",
  "0034-fe0f-20e3",
  "0035-fe0f-20e3",
  "0036-fe0f-20e3",
  "0037-fe0f-20e3",
  "0038-fe0f-20e3",
  "0039-fe0f-20e3",
  "00a9-fe0f",
  "00ae-fe0f",
  "1f3cb-fe0f-200d-2640-fe0f",
  "1f3cb-fe0f-200d-2642-fe0f",
  "1f3cc-fe0f-200d-2640-fe0f",
  "1f3cc-fe0f-200d-2642-fe0f",
  "1f3f3-fe0f-200d-26a7-fe0f",
  "1f441-fe0f-200d-1f5e8-fe0f",
  "1f575-fe0f-200d-2640-fe0f",
  "1f575-fe0f-200d-2642-fe0f",
  "26f9-fe0f-200d-2640-fe0f",
  "26f9-fe0f-200d-2642-fe0f",
]);

/** emoji-datasource@15.1.2: twitter yes, apple no. */
const APPLE_MISSING = new Set(["2640-fe0f", "2642-fe0f", "2695-fe0f"]);

function emojiCdnPrefix(set: string): string {
  const key = set.trim().toLowerCase();
  if (key === "facebook") {
    return EMOJI_CDN_FACEBOOK;
  }
  if (key === "apple") {
    return EMOJI_CDN_APPLE;
  }
  if (key === "google") {
    return EMOJI_CDN_GOOGLE;
  }
  return EMOJI_CDN_TWITTER;
}

/** Unicode emoji PNG URL for Settings `emotes.emojiSet` (jsdelivr emoji-datasource). */
export function resolveEmojiUrl(unified: string, set: string): string {
  const id = unified.trim().toLowerCase();
  let prefix = emojiCdnPrefix(set);
  if (prefix === EMOJI_CDN_FACEBOOK && FACEBOOK_MISSING.has(id)) {
    prefix = EMOJI_CDN_TWITTER;
  } else if (prefix === EMOJI_CDN_APPLE && APPLE_MISSING.has(id)) {
    prefix = EMOJI_CDN_TWITTER;
  }
  return `${prefix}/${id}.png`;
}
