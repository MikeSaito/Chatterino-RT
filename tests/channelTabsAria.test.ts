import { channelTabAttrs } from "../src/shell/channelTabAria.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const on = channelTabAttrs("beta", "beta");
assert(on.role === "tab", "role tab");
assert(on.ariaSelected === "true", "selected");
assert(on.className === "channel-item is-active", "active class");

const off = channelTabAttrs("alpha", "beta");
assert(off.ariaSelected === "false", "not selected");
assert(off.className === "channel-item", "inactive class");

console.log("channelTabsAria tests ok");
