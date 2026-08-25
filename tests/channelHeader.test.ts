import {
  effectiveHeaderKnobs,
  formatChannelTitle,
  parseHeaderKnobs,
  parseThumbnailSizeStream,
  streamPreviewUrl,
  type HeaderKnobs,
} from "../src/shell/channelHeader.ts";
import type { ChannelLive } from "../src/chat/types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const allOn: HeaderKnobs = {
  uptime: true,
  viewerCount: true,
  game: true,
  streamTitle: true,
};

assert(
  parseHeaderKnobs({
    "appearance.headerUptime": true,
    "appearance.headerViewerCount": true,
  }).uptime === true,
  "parse uptime",
);

const plain = effectiveHeaderKnobs(allOn, {
  streamerActive: false,
  hideViewerCountAndDuration: true,
});
assert(plain.uptime && plain.viewerCount, "inactive streamer keeps meta");

const knobOff = effectiveHeaderKnobs(allOn, {
  streamerActive: true,
  hideViewerCountAndDuration: false,
});
assert(knobOff.uptime && knobOff.viewerCount, "knob off keeps meta");

const hidden = effectiveHeaderKnobs(allOn, {
  streamerActive: true,
  hideViewerCountAndDuration: true,
});
assert(!hidden.uptime && !hidden.viewerCount, "hide uptime+viewers");
assert(hidden.game && hidden.streamTitle, "keep game/title");

const live: ChannelLive = {
  channel: "xqc",
  live: true,
  viewerCount: 1234,
  gameName: "Just Chatting",
  streamTitle: "hi",
  startedAt: new Date(Date.now() - 3661_000).toISOString(),
};

const full = formatChannelTitle("xqc", live, allOn);
const fullDigits = full.replace(/\D/g, "");
assert(fullDigits.includes("1234"), `viewers digits in ${full}`);
assert(/\d+h \d+m/.test(full), `uptime in ${full}`);

const stripped = formatChannelTitle("xqc", live, hidden);
const strippedDigits = stripped.replace(/\D/g, "");
assert(!strippedDigits.includes("1234"), `no viewers ${stripped}`);
assert(!/\d+h \d+m/.test(stripped), `no uptime ${stripped}`);
assert(stripped.includes("Just Chatting"), "game remains");

assert(parseThumbnailSizeStream("2") === 2, "stream thumb default medium");
assert(parseThumbnailSizeStream(0) === 0, "stream thumb off");
assert(parseThumbnailSizeStream("9") === 2, "stream thumb bad → medium");
assert(streamPreviewUrl("XQC", 0) === null, "off → null url");
assert(
  streamPreviewUrl("XQC", 2) ===
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_xqc-160x90.jpg",
  "medium preview url",
);
assert(streamPreviewUrl("bad name!", 1) === null, "invalid login");

console.log("channelHeader.test.ts: ok");
