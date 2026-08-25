import {
  expandModAction,
  modActionLabel,
  parseModActions,
} from "../src/shell/modActions.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(modActionLabel("/timeout {user.name} 30") === "30s", "30s");
assert(modActionLabel("/timeout {user.name} 300") === "5m", "5m");
assert(modActionLabel("/timeout {user.name} 5m") === "5m", "5m unit");
assert(modActionLabel("/timeout {user.name} 2h") === "2h", "2h");
assert(modActionLabel("/timeout {user.name} 1d") === "1d", "1d");
assert(modActionLabel("/timeout {user.name} 1w") === "1w", "1w");
assert(modActionLabel("/ban {user.name}") === "Ban", "ban");
assert(modActionLabel("/delete {msg.id}") === "Del", "del");
assert(modActionLabel("/w {user.name} hi") === "wuse", "custom");

const parsed = parseModActions([
  { action: "/timeout {user.name} 300", icon: "" },
  { action: "  ", icon: "" },
  { action: "/ban {user.name}", icon: "x" },
]);
assert(parsed.length === 2, "skip empty");
assert(parsed[0]!.label === "5m", "p0");
assert(parsed[1]!.label === "Ban", "p1");

const many = parseModActions(
  Array.from({ length: 12 }, (_, i) => ({
    action: `/timeout {user.name} ${i + 1}`,
  })),
);
assert(many.length === 8, "cap 8");

const ctx = {
  userName: "Viewer",
  msgId: "abc-123",
  channel: "xqc",
};
assert(
  expandModAction("/timeout {user.name} 300", ctx) === "/timeout Viewer 300",
  "expand user",
);
assert(
  expandModAction("/delete {msg.id}", ctx) === "/delete abc-123",
  "expand msg",
);
assert(
  expandModAction("/ban {user}", ctx) === "/ban Viewer",
  "expand user alias",
);
assert(expandModAction("hi {channel.name}", ctx) === "hi xqc", "expand channel");
assert(
  expandModAction("hi {channel.name}", { ...ctx, channel: "" }) === null,
  "no channel",
);
assert(expandModAction("/timeout {user.name} 1", { ...ctx, userName: "" }) === null, "no user");
assert(expandModAction("/delete {msg.id}", { ...ctx, msgId: "" }) === null, "no msg");
assert(expandModAction("", ctx) === null, "empty");
assert(expandModAction("a\nb", ctx) === null, "newline");

console.log("modActions tests ok");
