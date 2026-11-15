import { readFileSync } from "node:fs";
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
assert(
  isAllowedEmoteCdnUrl(
    "https://static-cdn.jtvnw.net/twitch-video-assets/fixture/landscape/thumb/thumb-0000000000-480x272.jpg",
  ),
  "twitch video assets thumbnail",
);
assert(
  !isAllowedEmoteCdnUrl("https://static-cdn.jtvnw.net/twitch-video-assets/fixture/landscape/other.jpg"),
  "non-thumbnail clip asset denied",
);
assert(!isAllowedEmoteCdnUrl("https://evil.example/emote/x.png"), "foreign host");
assert(!isAllowedEmoteCdnUrl("http://cdn.betterttv.net/emote/abc/1x"), "http denied");
const { csp, devCsp } = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).app.security;
for (const host of ["clips-media-assets.twitch.tv", "clips-media-assets2.twitch.tv"]) {
  assert(isAllowedEmoteCdnUrl(`https://${host}/fixture-preview-480x272.jpg`), "clip thumbnail");
  for (const policy of [csp, devCsp]) {
    for (const directive of ["connect-src", "img-src"]) {
      assert(policy[directive].split(" ").includes(`https://${host}`), `${directive} allows ${host}`);
    }
  }
}
assert(
  !isAllowedEmoteCdnUrl("https://clips-media-assets.twitch.tv.evil.example/fixture.jpg"),
  "foreign clip host denied",
);
assert(
  isAllowedEmoteCdnUrl(
    "https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=abc",
  ),
  "twitch chat gif giphy",
);
assert(
  isAllowedEmoteCdnUrl("https://i.giphy.com/media/xYz9AbCdEfGhIjKl/giphy.webp"),
  "twitch chat gif i.giphy",
);
assert(
  !isAllowedEmoteCdnUrl("https://media9.giphy.com/media/x/giphy.gif"),
  "giphy media9 denied",
);
assert(
  !isAllowedEmoteCdnUrl("https://yandy.com/gif/valentine.gif"),
  "yandy host denied",
);

console.log("emoteCdnAllowlist.test.ts ok");
