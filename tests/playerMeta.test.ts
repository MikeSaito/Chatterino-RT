import { setLocale } from "../src/i18n/index.ts";
import { channelMetaParts } from "../src/shell/channelHeader.ts";
import type { ChannelRoomState } from "../src/shell/chatModes.ts";
import { t } from "../src/i18n/index.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

/** Same chip rules as paintChatModes, without DOM. */
function modeLabels(modes: ChannelRoomState): string[] {
  const chips: string[] = [];
  if (modes.emoteOnly) {
    chips.push(t("chat.modes.emoteOnly"));
  }
  if (modes.subsOnly) {
    chips.push(t("chat.modes.subsOnly"));
  }
  if (modes.followersOnly >= 0) {
    if (modes.followersOnly === 0) {
      chips.push(t("chat.modes.followers"));
    } else {
      chips.push(t("chat.modes.followersMin", { minutes: modes.followersOnly }));
    }
  }
  if (modes.slowSec > 0) {
    chips.push(t("chat.modes.slow", { seconds: modes.slowSec }));
  }
  return chips;
}

setLocale("en");

const offlineParts = channelMetaParts(
  "xqc",
  { channel: "xqc", live: false },
  { uptime: true, viewerCount: true, game: true, streamTitle: true },
);
assert(Object.keys(offlineParts).length === 0, "offline no meta parts");

const liveParts = channelMetaParts(
  "xqc",
  {
    channel: "xqc",
    live: true,
    viewerCount: 42,
    gameName: "Just Chatting",
    streamTitle: "Hello",
  },
  { uptime: false, viewerCount: true, game: true, streamTitle: true },
);
assert(liveParts.viewers === "42", "viewers");
assert(liveParts.game === "Just Chatting", "game");
assert(liveParts.streamTitle === "Hello", "title");

assert(
  modeLabels({
    channel: "xqc",
    emoteOnly: false,
    subsOnly: false,
    slowSec: 0,
    followersOnly: -1,
  }).length === 0,
  "no chips",
);

const chips = modeLabels({
  channel: "xqc",
  emoteOnly: true,
  subsOnly: true,
  slowSec: 30,
  followersOnly: 10,
});
assert(chips.length === 4, `chips ${chips.length}`);
assert(chips.some((c) => c.includes("30")), "slow");

console.log("playerMeta/chatModes tests ok");
