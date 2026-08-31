import { isAllowedEmoteCdnUrl } from "../src/chat/emoteCdnAllowlist.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(
  isAllowedEmoteCdnUrl(
    "https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/img/twitter/64/1f600.png",
  ),
  "jsdelivr emoji png",
);
assert(
  !isAllowedEmoteCdnUrl(
    "https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/package.json",
  ),
  "jsdelivr package.json denied",
);
assert(
  isAllowedEmoteCdnUrl("https://cdn.betterttv.net/emote/abc/1x"),
  "bttv emote",
);
assert(!isAllowedEmoteCdnUrl("https://cdn.betterttv.net/other/x"), "bttv other");
assert(
  isAllowedEmoteCdnUrl("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0"),
  "twitch emote",
);
assert(
  !isAllowedEmoteCdnUrl("https://static-cdn.jtvnw.net/jtv_user_pictures/x.png"),
  "profile pic denied",
);
assert(!isAllowedEmoteCdnUrl("https://evil.example/emote/x.png"), "foreign host");
assert(!isAllowedEmoteCdnUrl("http://cdn.betterttv.net/emote/abc/1x"), "http denied");

console.log("emoteCdnAllowlist.test.ts ok");
