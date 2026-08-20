import { tokenAtCursor } from "../src/chat/token.ts";

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

console.log("token tests ok");
