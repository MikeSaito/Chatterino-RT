import { hasIcon, iconSvg } from "../src/shell/icons.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(hasIcon("settings"), "settings icon");
assert(hasIcon("more"), "more icon");
assert(hasIcon("emote"), "emote icon");
assert(hasIcon("send"), "send icon");
assert(hasIcon("close"), "close icon");
assert(hasIcon("arrow-down"), "arrow-down icon");
assert(!hasIcon("not-a-real-icon"), "unknown rejected");

const svg = iconSvg("settings", 16);
assert(svg.includes('viewBox="0 0 24 24"'), "viewBox");
assert(svg.includes('stroke="currentColor"'), "currentColor");
assert(svg.includes('width="16"'), "size");
assert(svg.includes("ui-icon"), "class");

const send = iconSvg("send", 20);
assert(send.includes('width="20"'), "send size");
assert(send.includes("<path"), "send path");

console.log("icons.test.ts ok");
