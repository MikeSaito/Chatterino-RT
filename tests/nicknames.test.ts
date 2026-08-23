import {
  applyNickname,
  matchNickname,
  normalizeNicknameRules,
} from "../src/shell/nicknames.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const rules = normalizeNicknameRules([
  { username: "xqc", nickname: "King", regex: false, caseSensitive: false },
  { username: "FoO", nickname: "Bar", regex: false, caseSensitive: true },
]);

assert(rules.length === 2, "normalize");
assert(matchNickname("xQc", rules) === "King", "literal CI first");
assert(
  matchNickname("FoO", [
    { username: "FoO", nickname: "Bar", regex: false, caseSensitive: true },
  ]) === "Bar",
  "literal CS",
);
assert(
  matchNickname("foo", [
    { username: "FoO", nickname: "Bar", regex: false, caseSensitive: true },
  ]) === null,
  "literal CS miss",
);

const multi = normalizeNicknameRules([
  {
    username: "foo",
    nickname: "X",
    regex: true,
    caseSensitive: false,
  },
]);
assert(matchNickname("foo_foo", multi) === "X_X", "regex all matches");

assert(
  matchNickname("hello_world", normalizeNicknameRules([
    {
      username: "world",
      nickname: "planet",
      regex: true,
      caseSensitive: false,
    },
  ])) === "hello_planet",
  "regex replace",
);

assert(
  matchNickname(
    "abc",
    normalizeNicknameRules([
      { username: "", nickname: "x", regex: true, caseSensitive: false },
    ]),
  ) === null,
  "empty regex skip",
);

assert(
  matchNickname(
    "abc",
    normalizeNicknameRules([
      { username: "(", nickname: "x", regex: true, caseSensitive: false },
    ]),
  ) === null,
  "invalid regex skip",
);

assert(
  matchNickname("a", [
    { username: "a", nickname: "1", regex: false, caseSensitive: false },
    { username: "a", nickname: "2", regex: false, caseSensitive: false },
  ]) === "1",
  "first wins",
);

assert(applyNickname("plain", []) === "plain", "apply noop");
assert(
  applyNickname(
    "xqc",
    normalizeNicknameRules([
      { username: "xqc", nickname: "K", regex: false, caseSensitive: false },
    ]),
  ) === "K",
  "apply hit",
);

assert(
  matchNickname(
    "xqc(XQC)",
    normalizeNicknameRules([
      {
        username: "xqc(XQC)",
        nickname: "King",
        regex: false,
        caseSensitive: false,
      },
    ]),
  ) === "King",
  "formatted UsernameAndLocalizedName",
);

console.log("nicknames.test.ts: ok");
