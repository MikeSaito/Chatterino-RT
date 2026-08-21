import {
  modifierHeld,
  parseUsernameRclickAction,
  parseUsernameRclickModifier,
  resolveUsernameRightClick,
} from "../src/shell/usernameRclick.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(parseUsernameRclickAction("Reply") === "Reply", "Reply");
assert(parseUsernameRclickAction("nope") === "Mention", "default action");
assert(parseUsernameRclickModifier("Control") === "Control", "Control");
assert(parseUsernameRclickModifier("x") === "Shift", "default mod");

assert(
  resolveUsernameRightClick({
    behavior: "Mention",
    modBehavior: "Reply",
    modifier: "Shift",
    keys: { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false },
  }) === "Mention",
  "no mod → behavior",
);

assert(
  resolveUsernameRightClick({
    behavior: "Reply",
    modBehavior: "Mention",
    modifier: "Shift",
    keys: { shiftKey: true, ctrlKey: false, altKey: false, metaKey: false },
  }) === "Mention",
  "Shift → modBehavior",
);

assert(
  resolveUsernameRightClick({
    behavior: "Ignore",
    modBehavior: "Reply",
    modifier: "Control",
    keys: { shiftKey: false, ctrlKey: true, altKey: false, metaKey: false },
  }) === "Reply",
  "Control → modBehavior",
);

assert(
  !modifierHeld("Shift", {
    shiftKey: true,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
  }),
  "Shift+Ctrl not exact Shift",
);

assert(
  resolveUsernameRightClick({
    behavior: "Ignore",
    modBehavior: "Mention",
    modifier: "Shift",
    keys: { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false },
  }) === "Ignore",
  "Ignore primary",
);

console.log("usernameRclick tests ok");
