import {
  deriveEmoteScaleUrls,
  emoteScaleLinkLabel,
} from "../src/chat/emoteImageLinks.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function factors(url: string, opts?: Parameters<typeof deriveEmoteScaleUrls>[1]): number[] {
  return deriveEmoteScaleUrls(url, opts).map((l) => l.factor);
}

const TWITCH =
  "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0";
assert(factors(TWITCH).join(",") === "1,2,3", "twitch emote factors");
assert(
  deriveEmoteScaleUrls(TWITCH)[1]?.url.endsWith("/2.0"),
  "twitch 2x suffix",
);

const BTTV = "https://cdn.betterttv.net/emote/abc123/1x";
assert(factors(BTTV).join(",") === "1,2,3", "bttv factors");
assert(
  deriveEmoteScaleUrls(BTTV)[2]?.url.endsWith("/3x"),
  "bttv 3x suffix",
);

const FFZ = "https://cdn.frankerfacez.com/emote/42/1";
assert(factors(FFZ).join(",") === "1,2,4", "ffz factors");
assert(
  deriveEmoteScaleUrls(FFZ)[2]?.url.endsWith("/4"),
  "ffz 4x suffix",
);

const SEVEN =
  "https://cdn.7tv.app/emote/60ae9a57ac03cad60771b2d8/1x.webp";
assert(factors(SEVEN).join(",") === "1,2,3,4", "7tv factors");
assert(
  deriveEmoteScaleUrls(SEVEN)[3]?.url.includes("/4x.webp"),
  "7tv 4x suffix",
);

const SEVEN_STATIC =
  "https://cdn.7tv.app/emote/abc/1x_static.avif";
assert(
  deriveEmoteScaleUrls(SEVEN_STATIC)[2]?.url.includes("/3x_static.avif"),
  "7tv static stem",
);

const CHEER =
  "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/static/1/1.gif";
assert(factors(CHEER).join(",") === "1,2,4", "cheer factors");
assert(
  deriveEmoteScaleUrls(CHEER)[1]?.url.includes("/static/2/"),
  "cheer 2x path",
);

const BADGE = "https://static-cdn.jtvnw.net/badges/v1/broadcaster/1";
assert(
  factors(BADGE, { kind: "badge" }).join(",") === "1,2,4",
  "twitch badge factors",
);

const BADGE_NO_KIND = "https://static-cdn.jtvnw.net/badges/v1/broadcaster/1";
assert(
  factors(BADGE_NO_KIND).join(",") === "1",
  "badge without kind stays 1x",
);

assert(
  factors("https://cdn.jsdelivr.net/npm/emoji-datasource-twitter/img/twitter/1f600.png").join(
    ",",
  ) === "1",
  "emoji single scale",
);

assert(
  factors("https://example.com/emote/1x").join(",") === "1",
  "unknown host single scale",
);

assert(emoteScaleLinkLabel(2) === "2x link", "label");

console.log("emote-image-links.test.ts ok");
