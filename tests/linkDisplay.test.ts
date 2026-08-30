import {
  applyLinkTitlesToBody,
  hostLabelFromUrl,
  isTwitchClipUrl,
  titleFromLinkTooltip,
} from "../src/chat/linkDisplay.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(hostLabelFromUrl("https://www.Example.COM/a") === "example.com", "host");
assert(isTwitchClipUrl("https://clips.twitch.tv/Cool-Clip_1"), "clip host");
assert(
  isTwitchClipUrl("https://www.twitch.tv/xqc/clip/CoolClip"),
  "channel clip",
);
assert(!isTwitchClipUrl("https://twitch.tv/xqc"), "channel not clip");

assert(
  titleFromLinkTooltip("Невероятный камбэк\nhttps://x", "clip.twitch.tv") ===
    "Невероятный камбэк",
  "tooltip title",
);
assert(
  titleFromLinkTooltip("https://clips.twitch.tv/x", "clip.twitch.tv") === null,
  "url tooltip ignored",
);

const applied = applyLinkTitlesToBody(
  "see https://clips.twitch.tv/Abc now",
  [{ start: 4, end: 31, url: "https://clips.twitch.tv/Abc" }],
  [
    {
      url: "https://clips.twitch.tv/Abc",
      title: "Title",
      host: "clip.twitch.tv",
    },
  ],
  [],
);
assert(applied.body === "see Title (clip.twitch.tv) now", "body rewrite");
assert(applied.links.length === 1, "one link");
assert(applied.links[0].start === 4 && applied.links[0].end === 9, "title span");
assert(applied.hosts.length === 1, "host span");
assert(
  applied.body.slice(applied.hosts[0].start, applied.hosts[0].end) ===
    " (clip.twitch.tv)",
  "host text",
);

console.log("linkDisplay.test.ts: ok");
