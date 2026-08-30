import { setLocale } from "../src/i18n/index.ts";
import {
  channelMetaParts,
  formatUptime,
} from "../src/shell/channelHeader.ts";
import type { ChannelRoomState } from "../src/shell/chatModes.ts";
import { t } from "../src/i18n/index.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function modeChipCount(modes: ChannelRoomState): number {
  let n = 0;
  if (modes.emoteOnly) n += 1;
  if (modes.subsOnly) n += 1;
  if (modes.followersOnly >= 0) n += 1;
  if (modes.slowSec > 0) n += 1;
  return n;
}

setLocale("en");
assert(
  formatUptime(new Date(Date.now() - 80 * 60 * 1000).toISOString()).includes(
    "h",
  ),
  "en uptime",
);

setLocale("ru");
assert(
  formatUptime(new Date(Date.now() - 80 * 60 * 1000).toISOString()).includes(
    "ч",
  ),
  "ru uptime",
);

const liveParts = channelMetaParts(
  "xqc",
  {
    channel: "xqc",
    live: true,
    viewerCount: 2094,
    gameName: "Just Chatting",
    streamTitle: "Hello",
    tags: ["should-not-appear-in-parts"],
  },
  { uptime: false, viewerCount: true, game: true, streamTitle: true },
);
assert(liveParts.viewers === "2\u00a0094" || liveParts.viewers === "2 094", `viewers ${liveParts.viewers}`);
assert(liveParts.game === "Just Chatting", "game");

assert(
  modeChipCount({
    channel: "xqc",
    emoteOnly: false,
    subsOnly: false,
    slowSec: 0,
    followersOnly: -1,
  }) === 0,
  "no chips",
);
assert(
  modeChipCount({
    channel: "xqc",
    emoteOnly: true,
    subsOnly: true,
    slowSec: 10,
    followersOnly: 10,
  }) === 4,
  "four chips",
);

setLocale("en");
assert(t("chat.modes.slowShort", { seconds: 10 }) === "10s", "slow short");
assert(t("chat.modes.followersShort", { minutes: 10 }) === "10m", "fol short");

console.log("header meta tests ok");
