import { isAtUserToken, isColonEmoteToken, tokenAtCursor } from "../src/chat/token.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

{
  const t = tokenAtCursor("hello Kappa", 11);
  assert(t.token === "Kappa" && t.start === 6 && !t.firstWord, `end token ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("Ka", 2);
  assert(t.token === "Ka" && t.firstWord && t.start === 0, `first word ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("/m", 2);
  assert(t.token === "/m" && t.firstWord, `command ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("hi @xq", 6);
  assert(t.token === "@xq" && t.start === 3 && !t.firstWord, `mention ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("hello Kappa extra", 11);
  assert(t.token === "Kappa" && t.end === 11, `mid ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("", 0);
  assert(t.token === "" && t.firstWord, `empty ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("  /m", 4);
  assert(t.token === "/m" && !t.firstWord, `leading space ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("hello", 5);
  assert(t.token === "hello" && t.firstWord, `single word ${JSON.stringify(t)}`);
}

{
  const t = tokenAtCursor("hello\n/m", 8);
  assert(t.token === "hello\n/m" && t.firstWord, `newline token ${JSON.stringify(t)}`);
}

{
  assert(isColonEmoteToken(":K"), ":K is colon emote");
  assert(isColonEmoteToken(":Kappa"), ":Kappa is colon emote");
  assert(isColonEmoteToken(":"), "lone colon opens emote popup");
  assert(!isColonEmoteToken("Kappa"), "plain token is not colon");
  assert(!isColonEmoteToken("http://x"), "url mid colon is not colon emote token");
  const mid = tokenAtCursor("say :Ka", 7);
  assert(mid.token === ":Ka" && isColonEmoteToken(mid.token), `colon mid ${JSON.stringify(mid)}`);
  const url = tokenAtCursor("http://x", 8);
  assert(url.token === "http://x" && !isColonEmoteToken(url.token), `url ${JSON.stringify(url)}`);
}

{
  assert(isAtUserToken("@xq"), "@xq is at user");
  assert(!isAtUserToken("Kappa"), "plain token is not at user");
  assert(!isAtUserToken(":K"), "colon token is not at user");
  const at = tokenAtCursor("hi @xq", 6);
  assert(at.token === "@xq" && isAtUserToken(at.token), `at mid ${JSON.stringify(at)}`);
}

console.log("token tests ok");
