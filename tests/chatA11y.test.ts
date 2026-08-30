import {
  A11Y_PENDING_THROTTLE_MS,
  A11Y_READBACK_LIMIT,
  formatA11yLine,
  formatA11yReadback,
  pendingAnnounceLabel,
  shouldAnnouncePending,
  type A11yPlainLine,
} from "../src/chat/chatA11y.ts";
import { setLocale } from "../src/i18n/index.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(A11Y_READBACK_LIMIT === 6, "readback limit");
assert(A11Y_PENDING_THROTTLE_MS === 2500, "throttle");

assert(formatA11yLine({ nick: "alice", text: "hi", system: false }) === "alice: hi", "privmsg");
assert(formatA11yLine({ nick: "", text: "Chat cleared", system: true }) === "Chat cleared", "system");
assert(formatA11yLine({ nick: "bob", text: "  ", system: false }) === "", "blank");

const lines: A11yPlainLine[] = [
  { nick: "a", text: "one", system: false },
  { nick: "", text: "joined", system: true },
];
assert(
  formatA11yReadback(lines, "empty") === "a: one. joined",
  "readback join",
);
assert(formatA11yReadback([], "empty") === "empty", "readback empty");

assert(shouldAnnouncePending(0, 1) === true, "grow from 0");
assert(shouldAnnouncePending(2, 5) === true, "grow");
assert(shouldAnnouncePending(5, 5) === false, "same");
assert(shouldAnnouncePending(5, 3) === false, "shrink");
assert(shouldAnnouncePending(0, 0) === false, "zero");

setLocale("en");
assert(pendingAnnounceLabel(0) === "", "pending 0");
assert(pendingAnnounceLabel(3) === "3 new below", "pending n");
assert(pendingAnnounceLabel(100) === "99+ new below", "pending max");

setLocale("ru");
assert(pendingAnnounceLabel(2) === "Ниже новых: 2", "pending ru");

setLocale("en");
console.log("chatA11y tests ok");
