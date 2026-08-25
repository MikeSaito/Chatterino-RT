import { findEventByMsgId } from "../src/shell/eventLookup.ts";
import type { ChatEvent } from "../src/chat/types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const privmsg: ChatEvent = {
  kind: "privmsg",
  id: "msg-1",
  timestampMs: 1000,
  userId: "u1",
  login: "user",
  displayName: "User",
  color: "#fff",
  badges: [],
  text: "hello",
  emoteSpans: [],
  action: false,
};

const usernotice: ChatEvent = {
  kind: "usernotice",
  id: "un-1",
  timestampMs: 2000,
  systemText: "subscribed",
  privmsg: {
    kind: "privmsg",
    id: "msg-2",
    timestampMs: 2000,
    userId: "u2",
    login: "sub",
    displayName: "Sub",
    color: "#fff",
    badges: [],
    text: "sub msg",
    emoteSpans: [],
    action: false,
  },
};

const clearchat: ChatEvent = {
  kind: "clearchat",
  id: "cc-1",
  timestampMs: 3000,
  targetLogin: "bad",
};

const notice: ChatEvent = {
  kind: "notice",
  id: "n-1",
  timestampMs: 4000,
  text: "joined channel",
};

const events = [privmsg, usernotice, clearchat, notice];

assert(findEventByMsgId(events, "msg-1") === privmsg, "privmsg by id");
assert(findEventByMsgId(events, "msg-2") === usernotice, "usernotice by nested privmsg id");
assert(findEventByMsgId(events, "cc-1") === clearchat, "clearchat by id");
assert(findEventByMsgId(events, "n-1") === notice, "notice by id");
assert(findEventByMsgId(events, "missing") === null, "unknown id");
assert(findEventByMsgId(events, "") === null, "empty id");

console.log("eventLookup.test.ts ok");
