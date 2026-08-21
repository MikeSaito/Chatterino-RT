import {
  defaultComposerChrome,
  parseMessageOverflow,
  MAX_CHAT_CHARS,
} from "../src/shell/composerUi.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(parseMessageOverflow("Prevent") === "Prevent", "Prevent");
assert(parseMessageOverflow("Allow") === "Allow", "Allow");
assert(parseMessageOverflow("Highlight") === "Highlight", "Highlight");
assert(parseMessageOverflow("nope") === "Highlight", "default");
assert(MAX_CHAT_CHARS === 500, "500");
const d = defaultComposerChrome();
assert(d.showEmptyInput === true, "empty default");
assert(d.overflow === "Highlight", "overflow default");

console.log("composerUi tests ok");
