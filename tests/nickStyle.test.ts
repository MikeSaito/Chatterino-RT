import {
  formatUsername,
  parseBoldScale,
  parseUsernameDisplayMode,
  randomNickColor,
  resolveNickColor,
  TWITCH_USERNAME_COLORS,
} from "../src/shell/nickStyle.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(TWITCH_USERNAME_COLORS.length === 15, "palette size");
assert(randomNickColor("123") === randomNickColor("123"), "stable");

assert(
  formatUsername({
    login: "xqc",
    displayName: "xQc",
    mode: "Username",
  }) === "xQc",
  "Username casing",
);
assert(
  formatUsername({
    login: "korean",
    displayName: "한글",
    mode: "LocalizedName",
  }) === "한글",
  "Localized",
);
assert(
  formatUsername({
    login: "korean",
    displayName: "한글",
    mode: "UsernameAndLocalizedName",
  }) === "korean(한글)",
  "And",
);
assert(
  formatUsername({
    login: "bob",
    displayName: "Bob",
    mode: "UsernameAndLocalizedName",
  }) === "Bob",
  "And same → display casing",
);

assert(
  resolveNickColor({
    color: "#ff69b4",
    userId: "1",
    colorize: true,
    fallback: 0x888888,
  }) === 0xff69b4,
  "explicit color",
);
assert(
  resolveNickColor({
    color: "",
    userId: "1",
    colorize: true,
    fallback: 0x888888,
  }) === randomNickColor("1"),
  "colorize empty",
);
assert(
  resolveNickColor({
    color: "",
    userId: "1",
    colorize: false,
    fallback: 0x888888,
  }) === 0x888888,
  "no colorize → fallback",
);

assert(parseUsernameDisplayMode("Username") === "Username", "mode parse");
assert(parseBoldScale("100") === 100, "bold 100");
assert(parseBoldScale(63) === 63, "bold 63");
assert(randomNickColor("2147483648") === randomNickColor("2147483648"), "big id stable");

console.log("nickStyle tests ok");
