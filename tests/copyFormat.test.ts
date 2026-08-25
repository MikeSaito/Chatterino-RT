import { formatFullCopyText } from "../src/shell/copyFormat.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(
  formatFullCopyText({
    time: "12:34",
    nick: "xqc",
    body: "hello world",
    copyText: "hello world",
    system: false,
  }) === "12:34 xqc: hello world",
  "privmsg",
);

assert(
  formatFullCopyText({
    time: "12:34",
    nick: "xqc",
    body: "* waves",
    copyText: "waves",
    system: false,
    isAction: true,
  }) === "12:34 xqc waves",
  "action",
);

assert(
  formatFullCopyText({
    time: "12:34",
    nick: "xqc",
    body: "Whisper: secret",
    copyText: "secret",
    system: false,
    isWhisper: true,
    whisperPeer: "me",
  }) === "12:34 xqc->me: secret",
  "whisper",
);

assert(
  formatFullCopyText({
    time: "",
    nick: "xqc",
    body: "hello",
    copyText: "hello",
    system: false,
  }) === "xqc: hello",
  "empty time",
);

assert(
  formatFullCopyText({
    time: "12:34",
    nick: "*",
    body: "joined channel",
    copyText: "joined channel",
    system: true,
  }) === "12:34 joined channel",
  "system notice",
);

console.log("copyFormat.test.ts ok");
